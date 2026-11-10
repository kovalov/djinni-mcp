import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { Ctx } from '../../src/context.ts';
import { getDraft, listDrafts } from '../../src/core/drafts.ts';
import { fixture, loggedInStore, startFakeDjinni, tempStore, type FakeDjinni, type Route } from '../helpers.ts';
import { cli, fakeIo } from './helpers.ts';

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

const JOB_ID = '845744';
const API_PATH = `/api/jobs/${JOB_ID}/`;
const PAGE_PATH = '/jobs/845744-link-builder/';
const LETTER = 'Добрий день!\nМаю досвід у SEO.';
const now = () => new Date('2026-11-10T12:00:00.000Z');
const jsonRoute = (body: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const apiJob = (changes: Record<string, unknown> = {}) => ({ ...JSON.parse(fixture('api_job_apply.json')), ...changes });

async function setup(routes: Record<string, Route> = {}) {
  djinni = await startFakeDjinni({
    'GET /my/profile/': fixture('my_profile.html'),
    [`GET ${API_PATH}`]: jsonRoute(apiJob()),
    [`GET ${PAGE_PATH}`]: fixture('job_apply_raw.html'),
    [`POST ${PAGE_PATH}`]: () => {
      djinni.routes.set(`GET ${API_PATH}`, jsonRoute(apiJob({ has_applied: true, messagethread_url: '/my/inbox/777/' })));
      return { status: 302, headers: { location: PAGE_PATH } };
    },
    'GET /api/jobs/favorites/': jsonRoute(JSON.parse(fixture('api_jobs_favorites.json'))),
    'POST /api/jobs/favorites/': { status: 201, ...jsonRoute({}) },
    [`DELETE /api/jobs/favorites/${JOB_ID}/`]: { status: 204 },
    [`POST /api/jobs/blocked/${JOB_ID}/`]: { status: 201, ...jsonRoute({}) },
    [`DELETE /api/jobs/blocked/${JOB_ID}/`]: { status: 204 },
    ...routes,
  });
  return { store: loggedInStore(), baseUrl: djinni.url, minIntervalMs: 0, now };
}

const posts = () => djinni.requests.filter(r => r.method === 'POST');

function letterFile(deps: { store: { dir: string } }, text = LETTER): string {
  const file = join(deps.store.dir, 'letter.txt');
  writeFileSync(file, text);
  return file;
}

async function draftFor(deps: Awaited<ReturnType<typeof setup>>, flags: string[] = []) {
  await cli(['apply', 'prepare', JOB_ID, '--message-file', letterFile(deps), ...flags], deps);
  return listDrafts(new Ctx(deps))[0]!.id;
}

const PREVIEW = [
  'Job: Link builder | Come Back Agency | https://djinni.co/jobs/845744-link-builder/',
  'CV: CV_1.pdf (2705342)',
  'Salary: $3000',
  'Cover letter:',
  'Добрий день!',
  'Маю досвід у SEO.',
];

describe('djinni apply prepare', () => {
  test('prints the full preview and the draft and sends nothing', async () => {
    const deps = await setup();

    const res = await cli(['apply', 'prepare', JOB_ID, '--message-file', letterFile(deps), '--salary', '3000'], deps);

    expect(res.code).toBe(0);
    const id = listDrafts(new Ctx(deps))[0]!.id;
    expect(res.out).toBe(
      [
        ...PREVIEW,
        '',
        `Draft ${id} expires at 2026-11-11T12:00:00.000Z. Nothing was sent to the employer.`,
        `Send it with: npx djinni-mcp apply submit ${id}`,
        '',
      ].join('\n'),
    );
    expect(posts()).toEqual([]);
  });

  test('says that the profile salary stays when --salary is not given, and takes the CV from --cv', async () => {
    const deps = await setup();

    const res = await cli(['apply', 'prepare', JOB_ID, '--message-file', letterFile(deps), '--cv', '2705342'], deps);

    expect(res.out).toContain('Salary: the salary of the profile\n');
  });

  test('exits with 2 without --message-file', async () => {
    const res = await cli(['apply', 'prepare', JOB_ID], await setup());

    expect(res.code).toBe(2);
    expect(res.err).toContain('"npx djinni-mcp apply prepare" needs --message-file.');
  });

  test('exits with 2 for a salary that is not a whole number', async () => {
    const deps = await setup();

    const res = await cli(['apply', 'prepare', JOB_ID, '--message-file', letterFile(deps), '--salary', 'abc'], deps);

    expect(res.code).toBe(2);
    expect(res.err).toContain('--salary must be a positive whole number.');
  });

  test('exits with 1 for a message file that does not exist', async () => {
    const res = await cli(['apply', 'prepare', JOB_ID, '--message-file', '/no/such/letter.txt'], await setup());

    expect(res.code).toBe(1);
    expect(res.err).toContain('Cannot read the message file /no/such/letter.txt');
  });

  test('exits with 1 for a job that the user applied to already', async () => {
    const deps = await setup({ [`GET ${API_PATH}`]: jsonRoute(apiJob({ has_applied: true })) });

    const res = await cli(['apply', 'prepare', JOB_ID, '--message-file', letterFile(deps)], deps);

    expect(res.code).toBe(1);
    expect(res.err).toContain('You already applied to the job 845744.');
  });

  test('strips the control characters of the server text', async () => {
    const deps = await setup({ [`GET ${API_PATH}`]: jsonRoute(apiJob({ title: 'Link\u001b[31m builder' })) });

    const res = await cli(['apply', 'prepare', JOB_ID, '--message-file', letterFile(deps)], deps);

    expect(res.out).toContain('Job: Link[31m builder | Come Back Agency');
  });
});

describe('djinni apply submit', () => {
  test('prints the preview, asks for the approval and sends the application on "y"', async () => {
    const deps = await setup();
    const id = await draftFor(deps, ['--salary', '3000']);
    const io = fakeIo({ prompt: ['y'] });

    const res = await cli(['apply', 'submit', id], deps, io);

    expect(res.code).toBe(0);
    expect(io.questions).toEqual(['Send this application to the employer? [y/N] ']);
    expect(res.out).toBe(
      [...PREVIEW, '', 'djinni shows the application to the job 845744.', 'Chat with the employer: https://djinni.co/my/inbox/777/', ''].join('\n'),
    );
    expect(posts()).toHaveLength(1);
  });

  test.each([[''], ['n'], ['no']])('sends nothing for the answer %j', async answer => {
    const deps = await setup();
    const id = await draftFor(deps);

    const res = await cli(['apply', 'submit', id], deps, fakeIo({ prompt: [answer] }));

    expect(res.code).toBe(1);
    expect(res.err).toBe('Canceled. Nothing was sent to the employer.\n');
    expect(posts()).toEqual([]);
    expect(getDraft(new Ctx(deps), id).id).toBe(id);
  });

  test('--yes sends at once without a question and --json prints the result', async () => {
    const deps = await setup();
    const id = await draftFor(deps);
    const io = fakeIo();

    const res = await cli(['apply', 'submit', id, '--yes', '--json'], deps, io);

    expect(io.questions).toEqual([]);
    expect(JSON.parse(res.out)).toEqual({ ok: true, jobId: JOB_ID, messageThreadUrl: 'https://djinni.co/my/inbox/777/' });
  });

  test('--json without --yes prints the preview to stderr', async () => {
    const deps = await setup();
    const id = await draftFor(deps);

    const res = await cli(['apply', 'submit', id, '--json'], deps, fakeIo({ prompt: ['y'] }));

    expect(res.err).toContain('Cover letter:\n');
    expect(JSON.parse(res.out)).toMatchObject({ ok: true });
  });

  test('exits with 1 and tells to check the job when djinni does not show the application', async () => {
    const deps = await setup({ [`POST ${PAGE_PATH}`]: { status: 200, body: '<title>Link builder</title>' } });
    const id = await draftFor(deps);

    const res = await cli(['apply', 'submit', id, '--yes'], deps);

    expect(res.code).toBe(1);
    expect(res.out).toBe(
      [
        'djinni does not show the application (HTTP 200).',
        `djinni does not show the application after the request. djinni page: Link builder. The draft is marked as sent. Check the job page https://djinni.co${PAGE_PATH} before you send it again.`,
        `To send the draft again after the check, run: npx djinni-mcp apply submit ${id} --resend`,
        '',
      ].join('\n'),
    );
  });

  test('refuses a sent draft without --resend and names the resend command', async () => {
    const deps = await setup({ [`POST ${PAGE_PATH}`]: { status: 200, body: '<title>Link builder</title>' } });
    const id = await draftFor(deps);
    await cli(['apply', 'submit', id, '--yes'], deps);

    const res = await cli(['apply', 'submit', id, '--yes'], deps);

    expect(res.code).toBe(1);
    expect(res.err).toContain(`Only the user can send it again, in a terminal: npx djinni-mcp apply submit ${id} --resend`);
    expect(posts()).toHaveLength(1);
  });

  async function sentDraft() {
    const deps = await setup({ [`POST ${PAGE_PATH}`]: { status: 200, body: '<title>Link builder</title>' } });
    const id = await draftFor(deps);
    await cli(['apply', 'submit', id, '--yes'], deps);
    djinni.routes.set(`POST ${PAGE_PATH}`, () => {
      djinni.routes.set(`GET ${API_PATH}`, jsonRoute(apiJob({ has_applied: true })));
      return { status: 302, headers: { location: PAGE_PATH } };
    });
    return { deps, id };
  }

  test('--resend asks again and sends the application only on "y"', async () => {
    const { deps, id } = await sentDraft();
    const io = fakeIo({ prompt: ['y'] });

    const res = await cli(['apply', 'submit', id, '--resend'], deps, io);

    expect(res.code).toBe(0);
    expect(io.questions).toEqual(['The application may be sent already. Send it again? [y/N] ']);
    expect(res.out).toContain('Cover letter:\n');
    expect(res.out).toContain('djinni shows the application to the job 845744.\n');
    expect(posts()).toHaveLength(2);
  });

  test.each([[''], ['n']])('--resend sends nothing for the answer %j', async answer => {
    const { deps, id } = await sentDraft();

    const res = await cli(['apply', 'submit', id, '--resend'], deps, fakeIo({ prompt: [answer] }));

    expect(res.code).toBe(1);
    expect(res.err).toBe('Canceled. Nothing was sent to the employer.\n');
    expect(posts()).toHaveLength(1);
  });

  test('--resend refuses with no question when djinni shows the job as applied', async () => {
    const { deps, id } = await sentDraft();
    djinni.routes.set(`GET ${API_PATH}`, jsonRoute(apiJob({ has_applied: true })));
    const io = fakeIo({ prompt: ['y'] });

    const res = await cli(['apply', 'submit', id, '--resend'], deps, io);

    expect(res.code).toBe(1);
    expect(res.err).toContain('You already applied to the job 845744.');
    expect(io.questions).toEqual([]);
    expect(posts()).toHaveLength(1);
  });

  test('--resend refuses without a question when stdin or stdout is not a terminal', async () => {
    const { deps, id } = await sentDraft();
    const before = djinni.requests.length;
    const io = fakeIo({ prompt: ['y'], interactive: false });

    const res = await cli(['apply', 'submit', id, '--resend'], deps, io);

    expect(res.code).toBe(1);
    expect(res.err).toBe(
      '--resend works only in an interactive terminal. Only a person can approve a resend: run the command in a terminal window, not through a pipe or an agent.\n',
    );
    expect(io.questions).toEqual([]);
    expect(djinni.requests.length).toBe(before);
  });

  test('--resend does not work with --yes', async () => {
    const { deps, id } = await sentDraft();

    const res = await cli(['apply', 'submit', id, '--resend', '--yes'], deps);

    expect(res.code).toBe(2);
    expect(res.err).toContain('--resend does not work with --yes. The command always asks before it sends an application again.');
    expect(posts()).toHaveLength(1);
  });
});

describe('djinni applications', () => {
  test('prints the log with the count of today', async () => {
    const deps = await setup();
    const id = await draftFor(deps);
    await cli(['apply', 'submit', id, '--yes'], deps);

    const res = await cli(['applications'], deps);

    expect(res.out).toBe(
      ['Applications today: 1 of 15 (Europe/Kyiv time).', '2026-11-10T12:00:00.000Z  845744  Link builder | Come Back Agency | CV_1.pdf | confirmed', ''].join('\n'),
    );
  });

  test('says that the log is empty', async () => {
    const res = await cli(['applications'], { store: tempStore(), now });

    expect(res.out).toBe('Applications today: 0 of 15 (Europe/Kyiv time).\nNo applications in the log.\n');
  });
});

describe('djinni jobs save, unsave, hide, unhide and favorites', () => {
  test.each([
    ['save', 'Saved the job 845744.\n', `POST /api/jobs/favorites/`],
    ['unsave', 'Removed the job 845744 from the saved jobs.\n', `DELETE /api/jobs/favorites/${JOB_ID}/`],
    ['hide', 'Hid the job 845744.\n', `POST /api/jobs/blocked/${JOB_ID}/`],
    ['unhide', 'The job 845744 is not hidden now.\n', `DELETE /api/jobs/blocked/${JOB_ID}/`],
  ])('jobs %s prints the result', async (command, out, request) => {
    const deps = await setup();

    const res = await cli(['jobs', command, JOB_ID], deps);

    expect(res.code).toBe(0);
    expect(res.out).toBe(out);
    expect(djinni.requests.map(r => `${r.method} ${r.url}`)).toContain(request);
  });

  test('jobs favorites prints a page of the saved jobs with the offset', async () => {
    const favorites = JSON.parse(fixture('api_jobs_favorites.json'));
    const deps = await setup({ 'GET /api/jobs/favorites/': jsonRoute({ ...favorites, offset: 10, results: favorites.results.slice(0, 5) }) });

    const res = await cli(['jobs', 'favorites', '--offset', '10'], deps);

    expect(res.code).toBe(0);
    expect(res.out).toMatch(/^15 jobs\. Jobs 11-15:\n/);
    expect(djinni.requests.at(-1)!.url).toBe('/api/jobs/favorites/?offset=10');
  });

  test('jobs favorites exits with 2 for a bad offset', async () => {
    const res = await cli(['jobs', 'favorites', '--offset', 'abc'], await setup());

    expect(res.code).toBe(2);
    expect(res.err).toContain('--offset must be a whole number of 0 or more.');
  });
});

describe('djinni drafts list', () => {
  test('shows the job of an application draft', async () => {
    const deps = await setup();
    const id = await draftFor(deps);

    const res = await cli(['drafts', 'list'], deps);

    expect(res.out).toBe(`${id}  application | expires 2026-11-11T12:00:00.000Z | Link builder | Come Back Agency\n`);
  });
});
