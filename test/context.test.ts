import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'vitest';
import { Ctx } from '../src/context.ts';
import { Store } from '../src/store.ts';
import { INTERVAL_TOLERANCE_MS, recordSendTimes, startFakeDjinni, tempStore, type FakeDjinni } from './helpers.ts';

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

describe('rate limit across processes', () => {
  test('two contexts with separate limiters on the same data folder keep the minimum interval', async () => {
    djinni = await startFakeDjinni({ 'GET /a': 'ok' });
    const dir = tempStore().dir;
    // Two contexts are like two CLI processes: each has its own limiter, and they share only the data folder.
    const first = new Ctx({ store: new Store(dir), baseUrl: djinni.url, minIntervalMs: 200 });
    const second = new Ctx({ store: new Store(dir), baseUrl: djinni.url, minIntervalMs: 200 });
    const times = recordSendTimes();

    await Promise.all([first, second, first, second].map(ctx => ctx.anonymousClient().get('/a')));

    expect(djinni.requests).toHaveLength(4);
    expect(times).toHaveLength(4);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(200 - INTERVAL_TOLERANCE_MS);
  });

  test('waits for the time of the last request that another process wrote', async () => {
    djinni = await startFakeDjinni({ 'GET /a': 'ok' });
    const store = tempStore();
    mkdirSync(store.path('locks'), { recursive: true });
    writeFileSync(store.path('locks', 'last-request'), String(Date.now()));
    const ctx = new Ctx({ store, baseUrl: djinni.url, minIntervalMs: 300 });

    const start = Date.now();
    await ctx.anonymousClient().get('/a');

    expect(djinni.requests[0]!.at - start).toBeGreaterThanOrEqual(250);
    expect(Number(readFileSync(store.path('locks', 'last-request'), 'utf8'))).toBeGreaterThanOrEqual(start);
  });

  test('removes a stale lock file that is older than 30 s', async () => {
    djinni = await startFakeDjinni({ 'GET /a': 'ok' });
    const store = tempStore();
    mkdirSync(store.path('locks'), { recursive: true });
    const lock = store.path('locks', 'last-request.lock');
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 31_000);
    utimesSync(lock, old, old);
    const ctx = new Ctx({ store, baseUrl: djinni.url, minIntervalMs: 100 });

    await ctx.anonymousClient().get('/a');

    expect(djinni.requests).toHaveLength(1);
  });
});
