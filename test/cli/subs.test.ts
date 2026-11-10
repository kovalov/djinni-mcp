import { afterEach, describe, expect, test } from 'vitest';
import { Ctx } from '../../src/context.ts';
import { listDrafts } from '../../src/core/drafts.ts';
import { fixture, loggedInStore, startFakeDjinni, type FakeDjinni, type Route } from '../helpers.ts';
import { cli, fakeIo } from './helpers.ts';

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

const now = () => new Date('2026-11-10T12:00:00.000Z');
const jsonRoute = (body: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function setup(routes: Record<string, Route> = {}) {
  djinni = await startFakeDjinni({
    'GET /my/profile/': fixture('my_profile.html'),
    'GET /ajax/jobs_subs/form_modal': fixture('subscription_form.html'),
    'POST /ajax/jobs_subs/create': '<div class="alert">Підписку створено</div>',
    'POST /ajax/jobs_subs/company_subscribe/': '<a>Ви підписані</a>',
    'GET /api/jobs/845744/': jsonRoute(JSON.parse(fixture('api_job_apply.json'))),
    'GET /jobs/845744-link-builder/': fixture('job_apply_raw.html'),
    'GET /my/subscriptions/': fixture('my_subscriptions.html'),
    ...routes,
  });
  return { store: loggedInStore(), baseUrl: djinni.url, minIntervalMs: 0, now };
}

const posts = () => djinni.requests.filter(r => r.method === 'POST');
const draftId = (deps: Awaited<ReturnType<typeof setup>>) => listDrafts(new Ctx(deps))[0]!.id;

describe('djinni subs options', () => {
  test('prints the allowed values of each field with the flag', async () => {
    const res = await cli(['subs', 'options'], await setup());

    expect(res.code).toBe(0);
    expect(res.out).toMatch(/^English level \(--english\):\n  no_eng +No English$/m);
    expect(res.out).toContain('Work format (--format):\n  office  Офіс\n  hybrid  Гібридний формат\n  remote  Віддалена робота\n');
  });
});

describe('djinni subs prepare', () => {
  test('makes a draft from the flags, prints it and sends nothing', async () => {
    const deps = await setup();

    const res = await cli(
      ['subs', 'prepare', '--name', 'Python remote', '--category', 'Python', '--format', 'remote,hybrid', '--location', 'UKR', '--location', 'POL', '--can-apply-only'],
      deps,
    );

    expect(res.code).toBe(0);
    const id = draftId(deps);
    expect(res.out).toBe(
      [
        'Name: Python remote',
        'Category: Python',
        'Work format: Віддалена робота, Гібридний формат',
        'Location: Україна, Польща',
        'Only jobs that I can apply to: yes',
        '',
        `Draft ${id} expires at 2026-11-11T12:00:00.000Z. Nothing was sent to djinni.`,
        `Create it with: npx djinni-mcp subs submit ${id}`,
        '',
      ].join('\n'),
    );
    expect(posts()).toEqual([]);
  });

  test('exits with 2 without --name', async () => {
    const res = await cli(['subs', 'prepare'], await setup());

    expect(res.code).toBe(2);
    expect(res.err).toContain('"npx djinni-mcp subs prepare" needs --name.');
  });

  test('exits with 1 for a value that the form does not allow', async () => {
    const res = await cli(['subs', 'prepare', '--name', 'X', '--english', 'c1'], await setup());

    expect(res.code).toBe(1);
    expect(res.err).toContain('englishLevel "c1" is not an allowed value.');
  });
});

describe('djinni subs prepare-company', () => {
  test('makes a draft for the company of the job', async () => {
    const deps = await setup();

    const res = await cli(['subs', 'prepare-company', '845744'], deps);

    const id = draftId(deps);
    expect(res.out).toBe(
      [
        'Company: Come Back Agency (from the job 845744 Link builder)',
        '',
        `Draft ${id} expires at 2026-11-11T12:00:00.000Z. Nothing was sent to djinni.`,
        `Create it with: npx djinni-mcp subs submit ${id}`,
        '',
      ].join('\n'),
    );
  });
});

describe('djinni subs submit', () => {
  test('asks for the approval and creates the subscription on "y"', async () => {
    const deps = await setup();
    await cli(['subs', 'prepare', '--name', 'Python'], deps);
    const io = fakeIo({ prompt: ['y'] });

    const res = await cli(['subs', 'submit', draftId(deps)], deps, io);

    expect(res.code).toBe(0);
    expect(io.questions).toEqual(['Create this subscription on djinni? [y/N] ']);
    expect(res.out).toBe(
      ['Name: Python', '', 'djinni answered HTTP 200: Підписку створено', 'Check the subscriptions on https://djinni.co/my/subscriptions/', ''].join('\n'),
    );
    expect(posts().map(r => r.url)).toEqual(['/ajax/jobs_subs/create?redirect=1']);
  });

  test('sends a company subscription draft to the company subscribe path with --yes', async () => {
    const deps = await setup();
    await cli(['subs', 'prepare-company', '845744'], deps);
    const io = fakeIo();

    const res = await cli(['subs', 'submit', draftId(deps), '--yes', '--json'], deps, io);

    expect(io.questions).toEqual([]);
    expect(JSON.parse(res.out)).toEqual({ ok: true, status: 200, message: 'Ви підписані' });
    expect(posts().map(r => r.url)).toEqual(['/ajax/jobs_subs/company_subscribe/?job_id=845744']);
  });

  test.each([[''], ['n']])('sends nothing for the answer %j', async answer => {
    const deps = await setup();
    await cli(['subs', 'prepare', '--name', 'Python'], deps);

    const res = await cli(['subs', 'submit', draftId(deps)], deps, fakeIo({ prompt: [answer] }));

    expect(res.code).toBe(1);
    expect(res.err).toBe('Canceled. Nothing was sent to djinni.\n');
    expect(posts()).toEqual([]);
  });

  test('exits with 1 for a draft that is not a subscription draft', async () => {
    const deps = await setup();
    const { createDraft } = await import('../../src/core/drafts.ts');
    const draft = createDraft(new Ctx(deps), 'profile', {}, {});

    const res = await cli(['subs', 'submit', draft.id, '--yes'], deps);

    expect(res.code).toBe(1);
    expect(res.err).toContain(`The draft "${draft.id}" is a profile draft, not a subscription draft.`);
    expect(posts()).toEqual([]);
  });

  test('exits with 1 and prints the status for an HTTP error', async () => {
    const deps = await setup({ 'POST /ajax/jobs_subs/create': { status: 500, body: 'Server Error' } });
    await cli(['subs', 'prepare', '--name', 'Python'], deps);

    const res = await cli(['subs', 'submit', draftId(deps), '--yes'], deps);

    expect(res.code).toBe(1);
    expect(res.out).toContain('djinni answered HTTP 500: Server Error\n');
  });
});

describe('djinni subs list', () => {
  test('prints the note', async () => {
    const res = await cli(['subs', 'list'], await setup());

    expect(res.out).toBe(
      'djinni shows no job subscriptions. The list format of this page is not verified yet. The user can manage the subscriptions on https://djinni.co/my/subscriptions/.\n',
    );
  });
});
