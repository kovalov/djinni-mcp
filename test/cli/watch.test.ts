import { afterEach, describe, expect, test } from 'vitest';
import { createWatch, listWatches } from '../../src/core/watches.ts';
import { Ctx } from '../../src/context.ts';
import { fixture, startFakeDjinni, tempStore, type FakeDjinni } from '../helpers.ts';
import { cli } from './helpers.ts';

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

const jsonRoute = (body: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
// One page with all jobs of the fixture, so that a check reads one page.
const onePage = () => {
  const data = JSON.parse(fixture('api_jobs_python.json'));
  return { ...data, count: data.results.length };
};
const now = () => new Date('2026-11-10T12:00:00.000Z');

describe('djinni watch add', () => {
  test('saves a watch with the filter flags and prints its ID', async () => {
    const store = tempStore();

    const res = await cli(['watch', 'add', 'Python Kyiv', '--category', 'python', '--location', 'kyiv,lviv', '--full-text', '--query', 'django'], { store, now });

    expect(res.code).toBe(0);
    const [watch] = listWatches(new Ctx({ store }));
    expect(watch).toMatchObject({ name: 'Python Kyiv', filters: { category: ['python'], location: ['kyiv', 'lviv'], full_text: true, query: 'django' } });
    expect(res.out).toBe(`Created the watch ${watch!.id} "Python Kyiv".\n`);
  });

  test('--json prints the new watch', async () => {
    const res = await cli(['watch', 'add', 'Go', '--category', 'golang', '--json'], { store: tempStore(), now });

    expect(JSON.parse(res.out)).toMatchObject({ name: 'Go', filters: { category: ['golang'] }, createdAt: '2026-11-10T12:00:00.000Z' });
  });

  test('needs a name', async () => {
    const res = await cli(['watch', 'add', '--category', 'python'], { store: tempStore() });

    expect(res.code).toBe(2);
    expect(res.err).toContain('needs <name>');
  });
});

describe('djinni watch list', () => {
  test('prints one line per watch', async () => {
    const store = tempStore();
    const watch = createWatch(new Ctx({ store, now }), 'Python', { category: ['python'] });

    const res = await cli(['watch', 'list'], { store });

    expect(res.out).toBe(`${watch.id}  Python | category=python | last check: never\n`);
  });

  test('says that there are no watches', async () => {
    const res = await cli(['watch', 'list'], { store: tempStore() });

    expect(res.code).toBe(0);
    expect(res.out).toBe('No watches. Add one with: npx djinni-mcp watch add <name> [filter flags]\n');
  });
});

describe('djinni watch rm', () => {
  test('deletes a watch', async () => {
    const store = tempStore();
    const ctx = new Ctx({ store, now });
    const watch = createWatch(ctx, 'Python', { category: ['python'] });

    const res = await cli(['watch', 'rm', watch.id], { store });

    expect(res.code).toBe(0);
    expect(res.out).toBe(`Deleted the watch ${watch.id}.\n`);
    expect(listWatches(ctx)).toEqual([]);
  });

  test('exits with 1 for an unknown ID', async () => {
    const res = await cli(['watch', 'rm', 'nope'], { store: tempStore() });

    expect(res.code).toBe(1);
    expect(res.err).toContain('The watch ID "nope" is not known. List the watches to see the IDs.');
  });
});

describe('djinni watch check', () => {
  test('prints the new jobs of each watch and marks them as seen', async () => {
    djinni = await startFakeDjinni({ 'GET /api/jobs/': jsonRoute(onePage()) });
    const store = tempStore();
    const watch = createWatch(new Ctx({ store, now }), 'Python', { category: ['python'] });
    const deps = { store, baseUrl: djinni.url, minIntervalMs: 0, now };

    const first = await cli(['watch', 'check'], deps);
    const second = await cli(['watch', 'check', watch.id], deps);

    expect(first.code).toBe(0);
    const lines = first.out.trimEnd().split('\n');
    expect(lines[0]).toBe(`Python (${watch.id}): 10 jobs. This is the first check, so the list has the newest jobs, not only new jobs.`);
    expect(lines[1]).toMatch(/^ {2}845296 {2}Forward AI Deployment Engineer/);
    expect(lines).toHaveLength(11);
    expect(second.out).toBe(`Python (${watch.id}): no new jobs.\n`);
  });

  test('--no-mark-seen keeps the jobs as not seen', async () => {
    djinni = await startFakeDjinni({ 'GET /api/jobs/': jsonRoute(onePage()) });
    const store = tempStore();
    createWatch(new Ctx({ store, now }), 'Python', { category: ['python'] });
    const deps = { store, baseUrl: djinni.url, minIntervalMs: 0, now };

    await cli(['watch', 'check', '--no-mark-seen'], deps);
    const res = await cli(['watch', 'check', '--json'], deps);

    const [result] = JSON.parse(res.out);
    expect(result).toMatchObject({ firstCheck: true });
    expect(result.newJobs).toHaveLength(10);
  });

  test('prints the error of a failed watch and exits with 1', async () => {
    djinni = await startFakeDjinni({ 'GET /api/jobs/': { status: 500, body: 'error' } });
    const store = tempStore();
    const watch = createWatch(new Ctx({ store, now }), 'Python', { category: ['python'] });

    const res = await cli(['watch', 'check'], { store, baseUrl: djinni.url, minIntervalMs: 0, now });

    expect(res.code).toBe(1);
    expect(res.out).toBe(`Python (${watch.id}): the check failed: djinni returned HTTP 500 for GET /api/jobs/?category=python&offset=0\n`);
  });
});
