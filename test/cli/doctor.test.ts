import { afterEach, describe, expect, test } from 'vitest';
import { doctorRoutes, loggedInStore, startFakeDjinni, type FakeDjinni, type Route } from '../helpers.ts';
import { cli } from './helpers.ts';

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

async function run(argv: string[], routes: Record<string, Route> = {}) {
  djinni = await startFakeDjinni({ ...doctorRoutes(), ...routes });
  return cli(argv, { store: loggedInStore(), baseUrl: djinni.url, minIntervalMs: 0 });
}

describe('djinni doctor', () => {
  test('prints one line for each step and exits with 0 when all steps pass', async () => {
    const res = await run(['doctor']);

    expect(res.code).toBe(0);
    expect(res.out).toMatch(/^ok    session        djinni accepts the saved session \(candidate 100001\)\.\nok    jobs_api       The API returned 10 jobs of 361\.\n/);
    expect(res.out).toMatch(/\nok    inbox          The inbox page has 10 conversations\.\n\nAll 9 checks passed\.\n$/);
  });

  test('exits with 1 and names the failed steps', async () => {
    const res = await run(['doctor'], { 'GET /developers/?keywords=python': '<html><body><main></main></body></html>' });

    expect(res.code).toBe(1);
    expect(res.out).toContain('\nFAIL  candidates     The page has no candidate cards. The page format may have changed.\n');
    expect(res.out).toMatch(/\n1 of 9 checks failed: candidates\.\n$/);
  });

  test('prints the report as JSON with --json', async () => {
    const res = await run(['doctor', '--json']);

    expect(JSON.parse(res.out)).toMatchObject({ ok: true, steps: expect.any(Array) });
  });
});
