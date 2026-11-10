import { afterEach, describe, expect, test } from 'vitest';
import { callToolJson, connect, doctorRoutes, loggedInStore, startFakeDjinni, type FakeDjinni } from '../helpers.ts';

// The MCP contract of djinni_doctor. The behavior of the steps is in test/core/doctor.test.ts.

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

describe('djinni_doctor', () => {
  test('is a read-only tool that returns the report of each step', async () => {
    djinni = await startFakeDjinni(doctorRoutes());
    const client = await connect({ store: loggedInStore(), baseUrl: djinni.url, minIntervalMs: 0 });

    const tool = (await client.listTools()).tools.find(t => t.name === 'djinni_doctor')!;
    const report = await callToolJson(client, 'djinni_doctor');

    expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(tool.description).toContain('sends only GET requests');
    expect(report.ok).toBe(true);
    expect(report.steps[0]).toEqual({ step: 'session', ok: true, detail: 'djinni accepts the saved session (candidate 100001).' });
    expect(djinni.requests.every(r => r.method === 'GET')).toBe(true);
  });
});
