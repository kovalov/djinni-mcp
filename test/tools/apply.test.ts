import { afterEach, describe, expect, test } from 'vitest';
import type { Store } from '../../src/store.ts';
import { callTool, callToolJson, connect, fixture, loggedInStore, startFakeDjinni, type FakeDjinni, type Route } from '../helpers.ts';

// The MCP contract of the apply, favorite, hide and subscription tools: names, annotations, descriptions, input validation and output shape.
// The behavior of the operations is in test/core/apply.test.ts, test/core/jobs.test.ts and test/core/subscriptions.test.ts.

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

const JOB_ID = '845744';
const API_PATH = `/api/jobs/${JOB_ID}/`;
const PAGE_PATH = '/jobs/845744-link-builder/';
const now = () => new Date('2026-11-10T12:00:00.000Z');
const jsonRoute = (body: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const apiJob = (changes: Record<string, unknown> = {}) => ({ ...JSON.parse(fixture('api_job_apply.json')), ...changes });

let store: Store;

async function setup(routes: Record<string, Route> = {}) {
  store = loggedInStore();
  djinni = await startFakeDjinni({
    'GET /my/profile/': fixture('my_profile.html'),
    [`GET ${API_PATH}`]: jsonRoute(apiJob()),
    [`GET ${PAGE_PATH}`]: fixture('job_apply_raw.html'),
    [`POST ${PAGE_PATH}`]: () => {
      djinni.routes.set(`GET ${API_PATH}`, jsonRoute(apiJob({ has_applied: true })));
      return { status: 302, headers: { location: PAGE_PATH } };
    },
    'GET /ajax/jobs_subs/form_modal': fixture('subscription_form.html'),
    'POST /ajax/jobs_subs/create': '<div class="alert">OK</div>',
    'POST /ajax/jobs_subs/company_subscribe/': '<a>Ви підписані</a>',
    'GET /my/subscriptions/': fixture('my_subscriptions.html'),
    'GET /api/jobs/favorites/': jsonRoute(JSON.parse(fixture('api_jobs_favorites.json'))),
    'POST /api/jobs/favorites/': { status: 201, ...jsonRoute({}) },
    [`DELETE /api/jobs/favorites/${JOB_ID}/`]: { status: 204 },
    [`POST /api/jobs/blocked/${JOB_ID}/`]: { status: 201, ...jsonRoute({}) },
    [`DELETE /api/jobs/blocked/${JOB_ID}/`]: { status: 204 },
    ...routes,
  });
  return connect({ store, baseUrl: djinni.url, minIntervalMs: 0, now });
}

const posts = () => djinni.requests.filter(r => r.method === 'POST');
const toolOf = async (client: Awaited<ReturnType<typeof setup>>, name: string) => (await client.listTools()).tools.find(t => t.name === name)!;

const NEW_TOOLS = [
  'prepare_application',
  'submit_application',
  'save_job',
  'unsave_job',
  'hide_job',
  'unhide_job',
  'list_favorite_jobs',
  'list_applications',
  'get_subscription_options',
  'prepare_subscription',
  'submit_subscription',
  'prepare_company_subscription',
  'submit_company_subscription',
  'list_subscriptions',
];
const SUBMIT_TOOLS = ['submit_application', 'submit_subscription', 'submit_company_subscription'];

describe('tool list', () => {
  test('registers every new tool with a description without semicolons', async () => {
    const client = await setup();
    const { tools } = await client.listTools();

    for (const name of NEW_TOOLS) {
      const tool = tools.find(t => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.description, name).not.toContain(';');
    }
  });

  test.each(SUBMIT_TOOLS)('registers %s as a destructive tool that needs draft_id and confirm', async name => {
    const client = await setup();
    const tool = await toolOf(client, name);

    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    expect(tool.inputSchema.required).toEqual(['draft_id', 'confirm']);
  });

  test('prepare_application and submit_application have the exact descriptions', async () => {
    const client = await setup();

    expect((await toolOf(client, 'prepare_application')).description).toBe(
      'Make a draft of a job application. This tool sends nothing. Show the full cover letter, the CV name and the salary to the user and ask for an explicit approval. ' +
        'Write the cover letter only from true facts about the user.',
    );
    expect((await toolOf(client, 'submit_application')).description).toBe(
      'Send an approved application to the employer. Call this tool only after the user approved this exact draft in the chat. An application cannot be taken back.',
    );
  });

  test.each(['prepare_application', 'prepare_subscription', 'prepare_company_subscription'])('registers %s as a tool that is not destructive', async name => {
    const client = await setup();

    expect((await toolOf(client, name)).annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
  });

  test.each(['list_favorite_jobs', 'get_subscription_options', 'list_subscriptions'])('registers %s as a read-only tool', async name => {
    const client = await setup();

    expect((await toolOf(client, name)).annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });

  test('registers list_applications as a local read-only tool', async () => {
    const client = await setup();

    expect((await toolOf(client, 'list_applications')).annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });

  test.each(['save_job', 'unsave_job', 'hide_job', 'unhide_job'])('registers %s as an idempotent tool that is not destructive', async name => {
    const client = await setup();

    expect((await toolOf(client, name)).annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  });
});

describe('application tools', () => {
  test('prepare_application returns the draft with the preview and sends no POST', async () => {
    const client = await setup();

    const draft = await callToolJson(client, 'prepare_application', { job: JOB_ID, message: 'Лист', salary: 3000 });

    expect(draft).toMatchObject({ draftId: expect.any(String), preview: { title: 'Link builder', message: 'Лист', cvName: 'CV_1.pdf', salary: 3000 } });
    expect(posts()).toEqual([]);
  });

  test('prepare_application refuses a salary that is not a whole number', async () => {
    const client = await setup();

    expect((await callTool(client, 'prepare_application', { job: JOB_ID, message: 'Лист', salary: 1.5 })).isError).toBe(true);
    expect(djinni.requests).toEqual([]);
  });

  test.each([[false], [undefined]])('submit_application refuses confirm %j and sends no POST', async confirm => {
    const client = await setup();
    const { draftId } = await callToolJson(client, 'prepare_application', { job: JOB_ID, message: 'Лист' });

    const res = await callTool(client, 'submit_application', { draft_id: draftId, ...(confirm === undefined ? {} : { confirm }) });

    expect(res.isError).toBe(true);
    expect(posts()).toEqual([]);
  });

  test('submit_application sends the draft with confirm true, and list_applications shows it', async () => {
    const client = await setup();
    const { draftId } = await callToolJson(client, 'prepare_application', { job: JOB_ID, message: 'Лист', cv_id: '2705342' });

    expect(await callToolJson(client, 'submit_application', { draft_id: draftId, confirm: true })).toEqual({ ok: true, jobId: JOB_ID, messageThreadUrl: null });
    expect(posts()).toHaveLength(1);
    const list = await callToolJson(client, 'list_applications');
    expect(list).toMatchObject({ dailyLimit: 15, sentToday: 1, applications: [{ jobId: JOB_ID, cvId: '2705342' }] });
  });
});

describe('submit_application after an unclear result', () => {
  test('refuses a second submit of the draft with no POST and says that only the user can send it again', async () => {
    const client = await setup({ [`POST ${PAGE_PATH}`]: { status: 200, body: '<title>Link builder</title>' } });
    const { draftId } = await callToolJson(client, 'prepare_application', { job: JOB_ID, message: 'Лист' });
    expect(await callToolJson(client, 'submit_application', { draft_id: draftId, confirm: true })).toMatchObject({ ok: false, status: 200 });

    const res = await callTool(client, 'submit_application', { draft_id: draftId, confirm: true });

    expect(res.isError).toBe(true);
    expect(res.text).toBe(
      `The draft ${draftId} was sent to djinni before, and the application may be sent already. ` +
        `Only the user can send it again, in a terminal: npx djinni-mcp apply submit ${draftId} --resend`,
    );
    expect(posts()).toHaveLength(1);
  });

  test('has no resend input', async () => {
    const client = await setup();

    expect(Object.keys((await toolOf(client, 'submit_application')).inputSchema.properties as object)).toEqual(['draft_id', 'confirm']);
  });
});

describe('favorite and hide tools', () => {
  test('save_job, unsave_job, hide_job and unhide_job send the JSON API requests', async () => {
    const client = await setup();

    expect(await callToolJson(client, 'save_job', { job: JOB_ID })).toEqual({ jobId: JOB_ID, saved: true });
    expect(await callToolJson(client, 'unsave_job', { job: JOB_ID })).toEqual({ jobId: JOB_ID, saved: false });
    expect(await callToolJson(client, 'hide_job', { job: JOB_ID })).toEqual({ jobId: JOB_ID, hidden: true });
    expect(await callToolJson(client, 'unhide_job', { job: JOB_ID })).toEqual({ jobId: JOB_ID, hidden: false });
    expect(djinni.requests.filter(r => r.url.startsWith('/api/jobs/')).map(r => `${r.method} ${r.url}`)).toEqual([
      'POST /api/jobs/favorites/',
      `DELETE /api/jobs/favorites/${JOB_ID}/`,
      `POST /api/jobs/blocked/${JOB_ID}/`,
      `DELETE /api/jobs/blocked/${JOB_ID}/`,
    ]);
  });

  test('list_favorite_jobs returns a page of the saved jobs with the offset', async () => {
    const client = await setup();

    const page = await callToolJson(client, 'list_favorite_jobs', { offset: 10 });

    expect(page).toMatchObject({ count: 15, hasNextPage: true });
    expect(djinni.requests.at(-1)!.url).toBe('/api/jobs/favorites/?offset=10');
  });
});

describe('subscription tools', () => {
  test('get_subscription_options returns the allowed values', async () => {
    const client = await setup();

    const options = await callToolJson(client, 'get_subscription_options');

    expect(options.englishLevel).toContainEqual({ value: 'upper', label: 'Upper-Intermediate' });
  });

  test('prepare_subscription and submit_subscription create the subscription only with confirm true', async () => {
    const client = await setup();
    const draft = await callToolJson(client, 'prepare_subscription', {
      name: 'Python',
      category: 'Python',
      format: ['remote'],
      exp_years: '3y',
      english_level: 'upper',
      can_apply_only: true,
    });
    expect(draft.preview).toEqual({
      name: 'Python',
      category: 'Python',
      expYears: '3 роки',
      format: ['Віддалена робота'],
      englishLevel: 'Upper-Intermediate',
      canApplyOnly: true,
    });
    expect(posts()).toEqual([]);

    expect((await callTool(client, 'submit_subscription', { draft_id: draft.draftId, confirm: false })).isError).toBe(true);
    expect(posts()).toEqual([]);

    expect(await callToolJson(client, 'submit_subscription', { draft_id: draft.draftId, confirm: true })).toEqual({ ok: true, status: 200, message: 'OK' });
    expect(posts().map(r => r.url)).toEqual(['/ajax/jobs_subs/create?redirect=1']);
  });

  test('prepare_subscription has snake_case input names', async () => {
    const client = await setup();

    expect(Object.keys((await toolOf(client, 'prepare_subscription')).inputSchema.properties as object)).toEqual([
      'name',
      'category',
      'salary',
      'exp_years',
      'format',
      'employment',
      'english_level',
      'location',
      'domain',
      'keywords',
      'can_apply_only',
    ]);
  });

  test('prepare_company_subscription and submit_company_subscription subscribe to the company of the job', async () => {
    const client = await setup();
    const draft = await callToolJson(client, 'prepare_company_subscription', { job: JOB_ID });
    expect(draft.preview).toEqual({ jobId: JOB_ID, title: 'Link builder', company: 'Come Back Agency' });

    expect(await callToolJson(client, 'submit_company_subscription', { draft_id: draft.draftId, confirm: true })).toEqual({
      ok: true,
      status: 200,
      message: 'Ви підписані',
    });
    expect(posts().map(r => r.url)).toEqual([`/ajax/jobs_subs/company_subscribe/?job_id=${JOB_ID}`]);
  });

  test('list_subscriptions returns the empty list with the note', async () => {
    const client = await setup();

    const list = await callToolJson(client, 'list_subscriptions');

    expect(list.subscriptions).toEqual([]);
    expect(list.note).toContain('https://djinni.co/my/subscriptions/');
  });
});
