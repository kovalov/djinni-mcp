import { afterEach, describe, expect, test } from 'vitest';
import { Ctx } from '../../src/context.ts';
import { DOCTOR_STEPS, runDoctor } from '../../src/core/doctor.ts';
import type { Store } from '../../src/store.ts';
import { doctorRoutes, fixture, loggedInStore, startFakeDjinni, tempStore, type FakeDjinni, type Route } from '../helpers.ts';

const jsonRoute = (body: string) => ({ headers: { 'content-type': 'application/json' }, body });

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

async function setup(routes: Record<string, Route> = {}, store: Store = loggedInStore()) {
  djinni = await startFakeDjinni({ ...doctorRoutes(), ...routes });
  return new Ctx({ store, baseUrl: djinni.url, minIntervalMs: 0 });
}

const failed = (report: Awaited<ReturnType<typeof runDoctor>>) => report.steps.filter(s => !s.ok).map(s => s.step);

describe('runDoctor', () => {
  test('passes all steps on the fixtures', async () => {
    const ctx = await setup();

    const report = await runDoctor(ctx);

    expect(report.ok).toBe(true);
    expect(report.steps.map(s => s.step)).toEqual([...DOCTOR_STEPS]);
    expect(report.steps.map(s => s.step)).toEqual([
      'session',
      'jobs_api',
      'job_api',
      'candidates',
      'profile_form',
      'account_form',
      'resume',
      'subscriptions',
      'inbox',
    ]);
    expect(report.steps.find(s => s.step === 'session')!.detail).toBe('djinni accepts the saved session (candidate 100001).');
    expect(report.steps.find(s => s.step === 'jobs_api')!.detail).toBe('The API returned 10 jobs of 361.');
    expect(report.steps.find(s => s.step === 'candidates')!.detail).toBe('The page has 10 candidate cards.');
    expect(report.steps.find(s => s.step === 'inbox')!.detail).toBe('The inbox page has 10 conversations.');
  });

  test('sends only GET requests and opens no inbox thread', async () => {
    const ctx = await setup();

    await runDoctor(ctx);

    expect(djinni.requests.every(r => r.method === 'GET')).toBe(true);
    expect(djinni.requests.some(r => /^\/my\/inbox\/\d+/.test(r.url))).toBe(false);
    expect(djinni.requests.map(r => r.url)).toContain('/api/jobs/845296/');
  });

  test('sends the requests through the shared rate limiter', async () => {
    djinni = await startFakeDjinni(doctorRoutes());
    const ctx = new Ctx({ store: loggedInStore(), baseUrl: djinni.url, minIntervalMs: 100 });

    await runDoctor(ctx);

    const times = djinni.requests.map(r => r.at);
    // The server clock sees a request a few milliseconds after the client sends it, so allow 10 ms of jitter.
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(90);
  });

  test('fails only the candidates step for an empty developers page', async () => {
    const ctx = await setup({ 'GET /developers/?keywords=python': '<html><body><main></main></body></html>' });

    const report = await runDoctor(ctx);

    expect(report.ok).toBe(false);
    expect(failed(report)).toEqual(['candidates']);
    expect(report.steps.find(s => s.step === 'candidates')!.detail).toBe('The page has no candidate cards. The page format may have changed.');
  });

  test('fails only the profile step when the profile form has no position field', async () => {
    const html = fixture('my_profile.html').replace(/name="position"/g, 'name="headline"');
    const ctx = await setup({ 'GET /my/profile/': html });

    const report = await runDoctor(ctx);

    expect(failed(report)).toEqual(['profile_form']);
  });

  test('fails only the account step without the email field', async () => {
    const html = fixture('my_account.html').replace(/name="email"/g, 'name="mail"');
    const ctx = await setup({ 'GET /my/account/': html });

    expect(failed(await runDoctor(ctx))).toEqual(['account_form']);
  });

  test('fails a step with the error of the request', async () => {
    const ctx = await setup({ 'GET /my/resume/': { status: 500, body: 'error' } });

    const report = await runDoctor(ctx);

    expect(failed(report)).toEqual(['resume']);
    expect(report.steps.find(s => s.step === 'resume')!.detail).toBe('djinni returned HTTP 500 for GET /my/resume/');
  });

  test('fails the job step and skips the detail step when the jobs API has an unexpected shape', async () => {
    const ctx = await setup({ 'GET /api/jobs/?category=python': jsonRoute('{"items": []}') });

    const report = await runDoctor(ctx);

    expect(failed(report)).toEqual(['jobs_api', 'job_api']);
    expect(report.steps.find(s => s.step === 'jobs_api')!.detail).toBe('The API answer has no count and results fields. The API format may have changed.');
    expect(report.steps.find(s => s.step === 'job_api')!.detail).toBe('Skipped: the jobs_api step gave no job ID.');
  });

  test('skips the session steps without a session and still checks the public API', async () => {
    const ctx = await setup({}, tempStore());

    const report = await runDoctor(ctx);

    expect(report.steps.filter(s => s.ok).map(s => s.step)).toEqual(['jobs_api', 'job_api']);
    expect(report.steps.find(s => s.step === 'session')!.detail).toBe('No djinni session is saved. Run in a separate terminal window: npx djinni-mcp login');
    expect(report.steps.find(s => s.step === 'inbox')!.detail).toBe('Skipped: no valid djinni session.');
    expect(djinni.requests.map(r => r.url)).toEqual(['/api/jobs/?category=python', '/api/jobs/845296/']);
  });

  test('checks the session again with a new request when the cached check says that it is valid', async () => {
    const ctx = await setup();
    expect(await ctx.session()).not.toBeNull();
    djinni.routes.set('GET /my/profile/', { status: 302, headers: { location: '/login' } });

    const report = await runDoctor(ctx);

    expect(report.steps[0]).toMatchObject({ step: 'session', ok: false });
    expect(djinni.requests.filter(r => r.url === '/my/profile/')).toHaveLength(2);
  });

  test('sends one profile request for the session step and one for the profile form', async () => {
    const ctx = await setup();

    await runDoctor(ctx);

    expect(djinni.requests.filter(r => r.url === '/my/profile/')).toHaveLength(2);
  });

  test('fails the resume and subscriptions steps for pages without their sections', async () => {
    const empty = '<html><body><main><h2>Page</h2></main></body></html>';
    const ctx = await setup({ 'GET /my/resume/': empty, 'GET /my/subscriptions/': empty });

    const report = await runDoctor(ctx);

    expect(failed(report)).toEqual(['resume', 'subscriptions']);
    expect(report.steps.find(s => s.step === 'resume')!.detail).toBe('The page has no CV list. The page format may have changed.');
    expect(report.steps.find(s => s.step === 'subscriptions')!.detail).toBe('The page has no subscriptions section. The page format may have changed.');
  });

  test('tells whether the subscriptions section shows no subscriptions', async () => {
    const ctx = await setup();

    const report = await runDoctor(ctx);

    expect(report.steps.find(s => s.step === 'subscriptions')!.detail).toBe('The subscriptions section shows no subscriptions.');
  });

  test('tells the user to log in again when djinni does not accept the session', async () => {
    const ctx = await setup({ 'GET /my/profile/': { status: 302, headers: { location: '/login' } } });

    const report = await runDoctor(ctx);

    expect(report.steps[0]).toEqual({
      step: 'session',
      ok: false,
      detail: 'djinni does not accept the saved session. Run in a separate terminal window: npx djinni-mcp login',
    });
  });
});
