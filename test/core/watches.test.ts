import { afterEach, describe, expect, test } from 'vitest';
import { Ctx } from '../../src/context.ts';
import { hideJob, unhideJob } from '../../src/core/jobs.ts';
import { checkWatches, createWatch, deleteWatch, listWatches, Watches, type WatchCheck } from '../../src/core/watches.ts';
import type { ApiJob } from '../../src/parsers/jobs.ts';
import type { Store } from '../../src/store.ts';
import { fixture, hiddenJobsPage, loggedInStore, startFakeDjinni, tempStore, type FakeDjinni, type Route } from '../helpers.ts';

const base = (JSON.parse(fixture('api_jobs_python.json')) as { results: ApiJob[] }).results[0]!;
const job = (id: number): ApiJob => ({ ...base, id, slug: `${id}-job-${id}` });
const now = () => new Date('2026-11-10T12:00:00.000Z');

// Returns the result of a successful check. Throws for a failed check.
const ok = (r: WatchCheck | undefined) => {
  if (!r || 'error' in r) throw new Error(`The check failed: ${JSON.stringify(r)}`);
  return r;
};

// A fake GET /api/jobs/ that serves the IDs in pages of the given size and records the requested paths.
function fakeApi(ids: number[], pageSize = 5) {
  const state = { ids, paths: [] as string[] };
  const fetchJson = async (path: string) => {
    state.paths.push(path);
    const offset = Number(new URL(path, 'https://djinni.co').searchParams.get('offset') ?? 0);
    return { count: state.ids.length, offset, limit: pageSize, results: state.ids.slice(offset, offset + pageSize).map(job) };
  };
  return { state, fetchJson };
}

describe('Watches', () => {
  test('creates a watch and keeps it in watches.json', () => {
    const store = tempStore();
    const watch = new Watches(store, now).create('Python Kyiv', { category: ['python'], location: ['kyiv'] });

    expect(watch).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}$/),
      name: 'Python Kyiv',
      filters: { category: ['python'], location: ['kyiv'] },
      createdAt: '2026-11-10T12:00:00.000Z',
      lastCheckedAt: null,
    });
    expect(new Watches(store, now).list()).toEqual([watch]);
    expect(store.readJson('watches.json', [])).toEqual([watch]);
  });

  test('deletes a watch and its seen IDs', async () => {
    const store = tempStore();
    const watches = new Watches(store, now);
    const keep = watches.create('Keep', { category: ['golang'] });
    const drop = watches.create('Drop', { category: ['python'] });
    await watches.check(fakeApi([1, 2]).fetchJson, { id: drop.id });

    watches.delete(drop.id);

    expect(watches.list().map(w => w.name)).toEqual([keep.name]);
    expect(Object.keys(store.readJson<Record<string, string[]>>('seen.json', {}))).toEqual([]);
  });

  test('throws for an unknown watch ID', async () => {
    const watches = new Watches(tempStore(), now);
    expect(() => watches.delete('nope')).toThrow('The watch ID "nope" is not known. List the watches to see the IDs.');
    await expect(watches.check(fakeApi([1]).fetchJson, { id: 'nope' })).rejects.toThrow('The watch ID "nope" is not known. List the watches to see the IDs.');
  });

  test('returns all jobs on the first check and reads the next pages', async () => {
    const watches = new Watches(tempStore(), now);
    const watch = watches.create('Python', { category: ['python'], experience: [2, 3] });
    const api = fakeApi([10, 9, 8, 7, 6, 5, 4]);

    const [result] = await watches.check(api.fetchJson);

    expect(ok(result).firstCheck).toBe(true);
    expect(ok(result).newJobs.map(j => j.id)).toEqual(['10', '9', '8', '7', '6', '5', '4']);
    expect(ok(result).newJobs[0]!.url).toBe('https://djinni.co/jobs/10-job-10/');
    expect(ok(result).watch.lastCheckedAt).toBe('2026-11-10T12:00:00.000Z');
    expect(api.state.paths).toEqual([
      '/api/jobs/?category=python&experience=2%2C3&offset=0',
      '/api/jobs/?category=python&experience=2%2C3&offset=5',
    ]);
    expect(watches.list()[0]).toEqual({ ...watch, lastCheckedAt: '2026-11-10T12:00:00.000Z' });
  });

  test('returns only the unseen jobs on the second check and stops at a page of seen jobs', async () => {
    const watches = new Watches(tempStore(), now);
    watches.create('Python', { category: ['python'] });
    const api = fakeApi([10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    await watches.check(api.fetchJson);

    api.state.ids = [12, 11, ...api.state.ids];
    api.state.paths = [];
    const [result] = await watches.check(api.fetchJson);

    expect(ok(result).firstCheck).toBe(false);
    expect(ok(result).newJobs.map(j => j.id)).toEqual(['12', '11']);
    expect(api.state.paths).toEqual(['/api/jobs/?category=python&offset=0', '/api/jobs/?category=python&offset=5']);
  });

  test('does not mark the jobs as seen when markSeen is false', async () => {
    const watches = new Watches(tempStore(), now);
    watches.create('Python', { category: ['python'] });
    const api = fakeApi([3, 2, 1]);

    const [first] = await watches.check(api.fetchJson, { markSeen: false });
    const [second] = await watches.check(api.fetchJson);

    expect(ok(first).newJobs.map(j => j.id)).toEqual(['3', '2', '1']);
    expect(ok(first).watch.lastCheckedAt).toBe('2026-11-10T12:00:00.000Z');
    expect(ok(second).firstCheck).toBe(true);
    expect(ok(second).newJobs.map(j => j.id)).toEqual(['3', '2', '1']);
  });

  test('reads the next page when a page has only new hidden jobs', async () => {
    const watches = new Watches(tempStore(), now);
    watches.create('Python', { category: ['python'] });
    const api = fakeApi([5, 4, 3, 2, 1, 0]);
    const hidden = async () => new Set(['5', '4', '3', '2', '1']);

    const [result] = await watches.check(api.fetchJson, {}, hidden);

    expect(ok(result).newJobs.map(j => j.id)).toEqual(['0']);
    expect(api.state.paths).toHaveLength(2);
  });

  test('does not save a hidden job as seen', async () => {
    const store = tempStore();
    const watches = new Watches(store, now);
    const watch = watches.create('Python', { category: ['python'] });
    const api = fakeApi([3, 2, 1]);

    await watches.check(api.fetchJson, {}, async () => new Set(['2']));
    const seen = store.readJson<Record<string, string[]>>('seen.json', {})[watch.id];
    const [second] = await watches.check(api.fetchJson);

    expect(seen).toEqual(['3', '1']);
    expect(ok(second).newJobs.map(j => j.id)).toEqual(['2']);
  });

  test('reads at most 5 pages in one check', async () => {
    const watches = new Watches(tempStore(), now);
    watches.create('Python', { category: ['python'] });
    const api = fakeApi(Array.from({ length: 100 }, (_, i) => 1000 - i));

    const [result] = await watches.check(api.fetchJson);

    expect(api.state.paths).toHaveLength(5);
    expect(ok(result).newJobs).toHaveLength(25);
  });

  test('keeps at most the 5000 newest seen IDs per watch', async () => {
    const store = tempStore();
    const watches = new Watches(store, now);
    const watch = watches.create('Python', { category: ['python'] });
    store.writeJson('seen.json', { [watch.id]: Array.from({ length: 5000 }, (_, i) => String(i)) });

    await watches.check(fakeApi([90001, 90000]).fetchJson);

    const seen = store.readJson<Record<string, string[]>>('seen.json', {})[watch.id]!;
    expect(seen).toHaveLength(5000);
    expect(seen.slice(0, 3)).toEqual(['90001', '90000', '0']);
    expect(seen.at(-1)).toBe('4997');
  });

  test('checks only the watch with the given ID', async () => {
    const watches = new Watches(tempStore(), now);
    watches.create('A', { category: ['python'] });
    const b = watches.create('B', { category: ['golang'] });
    const api = fakeApi([1]);

    const results = await watches.check(api.fetchJson, { id: b.id });

    expect(results.map(r => r.watch.name)).toEqual(['B']);
    expect(api.state.paths).toEqual(['/api/jobs/?category=golang&offset=0']);
  });

  test('returns an error for a failed watch and keeps the results of the other watches', async () => {
    const watches = new Watches(tempStore(), now);
    watches.create('A', { category: ['python'] });
    watches.create('B', { category: ['golang'] });
    watches.create('C', { category: ['java'] });
    const api = fakeApi([2, 1]);
    const failOnGolang = async (path: string) => {
      if (path.includes('category=golang')) throw new Error('djinni returned HTTP 500 for GET /api/jobs/');
      return api.fetchJson(path);
    };

    const first = await watches.check(failOnGolang);
    const second = await watches.check(api.fetchJson);

    expect(first).toMatchObject([
      { watch: { name: 'A' }, firstCheck: true, newJobs: [{ id: '2' }, { id: '1' }] },
      { watch: { name: 'B', lastCheckedAt: null }, error: 'djinni returned HTTP 500 for GET /api/jobs/' },
      { watch: { name: 'C' }, firstCheck: true, newJobs: [{ id: '2' }, { id: '1' }] },
    ]);
    expect(first[1]).not.toHaveProperty('newJobs');
    expect(second).toMatchObject([
      { watch: { name: 'A' }, firstCheck: false, newJobs: [] },
      { watch: { name: 'B' }, firstCheck: true, newJobs: [{ id: '2' }, { id: '1' }] },
      { watch: { name: 'C' }, firstCheck: false, newJobs: [] },
    ]);
  });
});

describe('watch operations', () => {
  let djinni: FakeDjinni;
  afterEach(() => djinni?.close());

  const jsonRoute = (body: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const apiJobs = () => JSON.parse(fixture('api_jobs_python.json'));

  async function setup(routes: Record<string, Route>, store: Store = loggedInStore()) {
    djinni = await startFakeDjinni({ 'GET /my/profile/': fixture('my_profile.html'), 'GET /my/dashboard/hidden/': hiddenJobsPage([]), ...routes });
    return new Ctx({ store, baseUrl: djinni.url, minIntervalMs: 0, now });
  }

  const apiRequests = () => djinni.requests.filter(r => r.url.startsWith('/api/')).map(r => r.url);

  test('createWatch, listWatches and deleteWatch keep the watches in the local store and send no request', async () => {
    const ctx = await setup({});

    const watch = createWatch(ctx, 'Python Kyiv', { category: ['python'], location: ['kyiv'] });
    const listed = listWatches(ctx);
    const deleted = deleteWatch(ctx, watch.id);

    expect(watch).toMatchObject({ name: 'Python Kyiv', filters: { category: ['python'], location: ['kyiv'] }, createdAt: '2026-11-10T12:00:00.000Z' });
    expect(listed).toEqual([watch]);
    expect(deleted).toEqual({ deleted: watch.id });
    expect(listWatches(ctx)).toEqual([]);
    expect(djinni.requests).toHaveLength(0);
  });

  test('checkWatches reads the API with the session and returns only the unseen jobs on the second check', async () => {
    const data = apiJobs();
    const ctx = await setup({ 'GET /api/jobs/': jsonRoute({ ...data, count: 10 }) });
    createWatch(ctx, 'Python', { category: ['python'] });

    const [first] = await checkWatches(ctx);
    const newJob = { ...data.results[0], id: 900001, slug: '900001-new-python-job', title: 'New Python Job' };
    djinni.routes.set('GET /api/jobs/', jsonRoute({ ...data, count: 10, results: [newJob, ...data.results.slice(0, 9)] }));
    const [second] = await checkWatches(ctx);

    expect(first).toMatchObject({ firstCheck: true, watch: { name: 'Python', lastCheckedAt: '2026-11-10T12:00:00.000Z' } });
    expect(ok(first).newJobs).toHaveLength(10);
    expect(ok(second).firstCheck).toBe(false);
    expect(ok(second).newJobs.map(j => j.id)).toEqual(['900001']);
    expect(apiRequests()).toEqual(['/api/jobs/?category=python&offset=0', '/api/jobs/?category=python&offset=0']);
    expect(djinni.requests.find(r => r.url.startsWith('/api/'))!.headers.cookie).toContain('sessionid=SESS');
  });

  test('checkWatches leaves out the hidden jobs and reads the hidden jobs page once', async () => {
    const ctx = await setup({
      'GET /api/jobs/': jsonRoute({ ...apiJobs(), count: 10 }),
      'GET /my/dashboard/hidden/': hiddenJobsPage(['845296', '857417']),
    });
    createWatch(ctx, 'A', { category: ['python'] });
    createWatch(ctx, 'B', { category: ['golang'] });

    const [a, b] = await checkWatches(ctx);

    expect(ok(a).newJobs).toHaveLength(8);
    expect(ok(a).newJobs.map(j => j.id)).not.toContain('845296');
    expect(ok(b).newJobs.map(j => j.id)).not.toContain('857417');
    expect(djinni.requests.filter(r => r.url.startsWith('/my/dashboard/hidden/'))).toHaveLength(1);
  });

  test('checkWatches gives a hidden job as new after unhideJob, because the hidden job is not saved as seen', async () => {
    const ctx = await setup({
      'GET /api/jobs/': jsonRoute({ ...apiJobs(), count: 10 }),
      'GET /my/dashboard/hidden/': hiddenJobsPage(['845296']),
      'DELETE /api/jobs/blocked/845296/': { status: 204 },
    });
    createWatch(ctx, 'A', { category: ['python'] });

    const [first] = await checkWatches(ctx);
    await unhideJob(ctx, '845296');
    const [second] = await checkWatches(ctx);

    expect(ok(first).newJobs.map(j => j.id)).not.toContain('845296');
    expect(ok(second).newJobs.map(j => j.id)).toEqual(['845296']);
  });

  test('checkWatches leaves out a job that hideJob hid before the hidden job IDs were read', async () => {
    const ctx = await setup({
      'GET /api/jobs/': jsonRoute({ ...apiJobs(), count: 10 }),
      'POST /api/jobs/blocked/845296/': { status: 201, ...jsonRoute({}) },
      'GET /my/dashboard/hidden/': hiddenJobsPage(['845296']),
    });
    createWatch(ctx, 'A', { category: ['python'] });

    await hideJob(ctx, '845296');
    const [result] = await checkWatches(ctx);

    expect(ok(result).newJobs).toHaveLength(9);
    expect(ok(result).newJobs.map(j => j.id)).not.toContain('845296');
  });

  test('checkWatches with a failed hidden jobs read returns all jobs and gives each result the warning', async () => {
    const ctx = await setup({
      'GET /api/jobs/': jsonRoute({ ...apiJobs(), count: 10 }),
      'GET /my/dashboard/hidden/': { status: 500, body: 'error' },
    });
    createWatch(ctx, 'A', { category: ['python'] });
    createWatch(ctx, 'B', { category: ['golang'] });

    const results = await checkWatches(ctx);

    const warning = 'The tool could not read your hidden jobs, so the list can show them.';
    expect(results).toMatchObject([{ watch: { name: 'A' }, warning }, { watch: { name: 'B' }, warning }]);
    expect(results.map(r => ok(r).newJobs.length)).toEqual([10, 10]);
    expect(djinni.requests.filter(r => r.url.startsWith('/my/dashboard/hidden/'))).toHaveLength(1);
  });

  test('checkWatches sends no hidden jobs request without a session', async () => {
    const ctx = await setup({ 'GET /api/jobs/': jsonRoute({ ...apiJobs(), count: 10 }), 'GET /my/dashboard/hidden/': hiddenJobsPage(['845296']) }, tempStore());
    createWatch(ctx, 'A', { category: ['python'] });

    const [a] = await checkWatches(ctx);

    expect(ok(a).newJobs).toHaveLength(10);
    expect(djinni.requests.filter(r => r.url.startsWith('/my/dashboard/hidden/'))).toHaveLength(0);
  });

  test('checkWatches with markSeen false keeps the jobs unseen', async () => {
    const ctx = await setup({ 'GET /api/jobs/': jsonRoute({ ...apiJobs(), count: 10 }) });
    createWatch(ctx, 'Python', { category: ['python'] });

    await checkWatches(ctx, { markSeen: false });
    const [again] = await checkWatches(ctx);

    expect(ok(again).firstCheck).toBe(true);
    expect(ok(again).newJobs).toHaveLength(10);
  });

  test('checkWatches with an invalid session sends anonymous requests and gives each result the warning', async () => {
    const ctx = await setup({
      'GET /api/jobs/': jsonRoute({ ...apiJobs(), count: 10 }),
      'GET /my/profile/': { status: 302, headers: { location: '/continue/' } },
    });
    createWatch(ctx, 'A', { category: ['python'] });
    createWatch(ctx, 'B', { category: ['golang'] });

    const results = await checkWatches(ctx);

    const warning = 'The saved djinni session is not valid. The results do not show your applications and favorites. Run in a separate terminal window: npx djinni-mcp login.';
    expect(results).toMatchObject([{ watch: { name: 'A' }, warning }, { watch: { name: 'B' }, warning }]);
    expect(djinni.requests.filter(r => r.url === '/my/profile/')).toHaveLength(1);
    for (const r of djinni.requests.filter(r => r.url.startsWith('/api/'))) expect(r.headers.cookie ?? '').not.toContain('sessionid');
  });

  test('checkWatches with a valid session gives no warning and checks the session once', async () => {
    const ctx = await setup({ 'GET /api/jobs/': jsonRoute({ ...apiJobs(), count: 10 }) });
    createWatch(ctx, 'A', { category: ['python'] });
    createWatch(ctx, 'B', { category: ['golang'] });

    const results = await checkWatches(ctx);

    expect(results.map(r => 'warning' in r)).toEqual([false, false]);
    expect(djinni.requests.filter(r => r.url === '/my/profile/')).toHaveLength(1);
  });

  test('checkWatches sends no request when there are no watches', async () => {
    const ctx = await setup({});

    expect(await checkWatches(ctx)).toEqual([]);
    expect(djinni.requests).toHaveLength(0);
  });

  test('checkWatches throws for an unknown watch ID', async () => {
    const ctx = await setup({});

    await expect(checkWatches(ctx, { id: 'nope' })).rejects.toThrow('List the watches to see the IDs.');
    expect(djinni.requests).toHaveLength(0);
  });

  test('checkWatches gives the watch an error when djinni returns no JSON', async () => {
    const ctx = await setup({ 'GET /api/jobs/': '<html><body>Maintenance</body></html>' });
    createWatch(ctx, 'Python', { category: ['python'] });

    const [result] = await checkWatches(ctx);

    expect(result).toMatchObject({ watch: { name: 'Python' }, error: expect.stringContaining('djinni returned no JSON') });
  });
});
