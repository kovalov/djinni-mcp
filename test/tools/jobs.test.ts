import { afterEach, describe, expect, test } from 'vitest';
import { callTool, callToolJson, connect, fixture, hiddenJobsPage, loggedInStore, startFakeDjinni, tempStore, type FakeDjinni } from '../helpers.ts';

// The MCP contract of the job tools: names, annotations, input validation and output shape.
// The behavior of the operations is in test/core/jobs.test.ts and test/core/watches.test.ts.

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

const jsonRoute = (body: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const apiJobs = () => JSON.parse(fixture('api_jobs_python.json'));
const now = () => new Date('2026-11-10T12:00:00.000Z');

async function setup(routes: Parameters<typeof startFakeDjinni>[0], store = loggedInStore()) {
  djinni = await startFakeDjinni({ 'GET /my/profile/': fixture('my_profile.html'), 'GET /my/dashboard/hidden/': hiddenJobsPage([]), ...routes });
  return connect({ store, baseUrl: djinni.url, minIntervalMs: 0, now });
}

const JOB_TOOLS = [
  'search_jobs',
  'get_job',
  'get_job_applicant_stats',
  'get_similar_jobs',
  'get_company',
  'create_watch',
  'list_watches',
  'delete_watch',
  'check_watches',
];

describe('job tool list', () => {
  test('registers the job and watch tools', async () => {
    const client = await setup({});
    const { tools } = await client.listTools();

    expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(JOB_TOOLS));
  });

  test('marks the djinni tools as read-only and the watch writers as local', async () => {
    const client = await setup({});
    const { tools } = await client.listTools();
    const hints = Object.fromEntries(tools.map(t => [t.name, t.annotations]));

    for (const name of ['search_jobs', 'get_job', 'get_job_applicant_stats', 'get_similar_jobs', 'get_company']) {
      expect(hints[name]).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    }
    for (const name of ['create_watch', 'delete_watch']) {
      expect(hints[name]).toMatchObject({ readOnlyHint: false, openWorldHint: false });
    }
    expect(hints['list_watches']).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(hints['check_watches']).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
  });

  test('tells the agent that the first check returns at most 50 newest jobs', async () => {
    const client = await setup({});
    const { tools } = await client.listTools();

    expect(tools.find(t => t.name === 'check_watches')?.description).toContain('the newest jobs, at most 50');
    expect(tools.find(t => t.name === 'check_watches')?.description).toContain('the result of that watch has an error field');
  });

  test('lists the allowed filter values in the search_jobs input schema', async () => {
    const client = await setup({});
    const { tools } = await client.listTools();
    const props = tools.find(t => t.name === 'search_jobs')!.inputSchema.properties as Record<string, any>;

    expect(props.experience.items.enum).toEqual([0, 1, 2, 3, 5]);
    expect(props.salary.enum).toEqual([1500, 2500, 3500, 4500, 5500]);
    expect(props.language.items.enum).toEqual(['no_eng', 'has_eng', 'pre', 'intermediate', 'upper', 'fluent']);
    expect(props.editorial.enum).toContain('has_public_salary');
    expect(props.experience.description).toContain('Allowed values: 0, 1, 2, 3, 5.');
  });
});

describe('search_jobs', () => {
  test('passes the filters to djinni and returns the page as JSON', async () => {
    const client = await setup({ 'GET /api/jobs/': jsonRoute(apiJobs()) });

    const page = await callToolJson(client, 'search_jobs', { category: ['python'], experience: [2], offset: 10 });

    expect(djinni.requests.map(r => r.url)).toContain('/api/jobs/?category=python&experience=2&offset=10');
    expect(page).toMatchObject({ count: 361, offset: 0, hasNextPage: true });
    expect(page.jobs).toHaveLength(10);
  });

  test('adds the session warning to the JSON result when the saved session is not valid', async () => {
    const client = await setup({
      'GET /api/jobs/': jsonRoute(apiJobs()),
      'GET /my/profile/': { status: 302, headers: { location: '/continue/' } },
    });

    const page = await callToolJson(client, 'search_jobs', {});

    expect(page.warning).toContain('The saved djinni session is not valid.');
    expect(page.jobs).toHaveLength(10);
  });

  test.each([[{ experience: [4] }], [{ salary: 2000 }], [{ language: ['native'] }], [{ offset: -1 }]])(
    'rejects the input %j and sends no request',
    async args => {
      const client = await setup({});

      const res = await callTool(client, 'search_jobs', args);

      expect(res.isError).toBe(true);
      expect(djinni.requests).toHaveLength(0);
    },
  );
});

describe('get_job', () => {
  test('returns the job detail as JSON', async () => {
    const client = await setup({ 'GET /api/jobs/857417/': jsonRoute(JSON.parse(fixture('api_job_detail.json'))) });

    const detail = await callToolJson(client, 'get_job', { job: '857417' });

    expect(detail).toMatchObject({ id: '857417', title: 'Software Engineer (C++, Python)', company: 'Stellar Jet' });
  });

  test('returns an error result for a value without a job ID', async () => {
    const client = await setup({});

    const res = await callTool(client, 'get_job', { job: 'python developer' });

    expect(res.isError).toBe(true);
    expect(res.text).toContain('python developer');
    expect(djinni.requests).toHaveLength(0);
  });
});

describe('get_job_applicant_stats', () => {
  test('returns the statistics as JSON', async () => {
    const client = await setup({ 'GET /api/jobs/857417/': fixture('job_apply_stats.html') });

    const stats = await callToolJson(client, 'get_job_applicant_stats', { job: '857417' });

    expect(stats.topSkills[0]).toBe('OOP');
    expect(stats.distributions.map((d: { key: string }) => d.key)).toEqual(['experience', 'english']);
  });

  test('tells the agent to run djinni login when no session is saved', async () => {
    const client = await setup({}, tempStore());

    const res = await callTool(client, 'get_job_applicant_stats', { job: '857417' });

    expect(res.isError).toBe(true);
    expect(res.text).toContain('Run in a separate terminal window: npx djinni-mcp login');
    expect(djinni.requests).toHaveLength(0);
  });
});

describe('get_similar_jobs', () => {
  test('returns the similar jobs as a JSON list', async () => {
    const client = await setup({ 'GET /jobs/857417/similar-jobs/': fixture('job_similar.html') });

    const jobs = await callToolJson(client, 'get_similar_jobs', { job: '857417' });

    expect(jobs.map((j: { id: string }) => j.id)).toEqual(['855655', '855113', '853441', '856453', '851764']);
  });
});

describe('get_company', () => {
  test('returns the company and its jobs as JSON', async () => {
    const client = await setup({
      'GET /jobs/company-stellar-jet/': fixture('company.html'),
      'GET /api/jobs/': jsonRoute(apiJobs()),
    });

    const company = await callToolJson(client, 'get_company', { company: 'stellar-jet' });

    expect(company).toMatchObject({ slug: 'stellar-jet', name: 'Stellar Jet', hasMoreJobs: true });
    expect(company.jobs.map((j: { id: string }) => j.id)).toEqual(['857417', '857415']);
  });

  test('returns an error result for a bad company value', async () => {
    const client = await setup({});

    const res = await callTool(client, 'get_company', { company: '../my/profile' });

    expect(res.isError).toBe(true);
    expect(res.text).toContain('has no djinni company slug');
    expect(djinni.requests).toHaveLength(0);
  });
});

describe('watch tools', () => {
  test('create_watch, list_watches and delete_watch return the watches as JSON', async () => {
    const client = await setup({});

    const watch = await callToolJson(client, 'create_watch', { name: 'Python Kyiv', filters: { category: ['python'], location: ['kyiv'] } });
    const listed = await callToolJson(client, 'list_watches');
    const deleted = await callToolJson(client, 'delete_watch', { id: watch.id });

    expect(watch).toMatchObject({ name: 'Python Kyiv', filters: { category: ['python'], location: ['kyiv'] }, createdAt: '2026-11-10T12:00:00.000Z' });
    expect(listed).toEqual([watch]);
    expect(deleted).toEqual({ deleted: watch.id });
  });

  test('create_watch rejects a bad filter value', async () => {
    const client = await setup({});

    const res = await callTool(client, 'create_watch', { name: 'X', filters: { experience: [4] } });

    expect(res.isError).toBe(true);
  });

  test('check_watches returns a JSON list with one result for each watch', async () => {
    const client = await setup({ 'GET /api/jobs/': jsonRoute({ ...apiJobs(), count: 10 }) });
    await callToolJson(client, 'create_watch', { name: 'Python', filters: { category: ['python'] } });

    const results = await callToolJson(client, 'check_watches', { markSeen: false });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ firstCheck: true, watch: { name: 'Python' } });
    expect(results[0].newJobs).toHaveLength(10);
  });

  test('check_watches returns an error result for an unknown watch ID', async () => {
    const client = await setup({});

    const res = await callTool(client, 'check_watches', { id: 'nope' });

    expect(res.isError).toBe(true);
    expect(res.text).toContain('List the watches to see the IDs.');
  });
});
