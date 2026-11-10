import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'vitest';
import { Ctx } from '../../src/context.ts';
import { DAILY_APPLY_LIMIT, listApplications, prepareApplication, submitApplication, type ApplicationStatus } from '../../src/core/apply.ts';
import { getDraft, listDrafts } from '../../src/core/drafts.ts';
import { NotLoggedInError } from '../../src/http.ts';
import type { Store } from '../../src/store.ts';
import { fixture, loggedInStore, startFakeDjinni, tempStore, type FakeDjinni, type Recorded, type Route } from '../helpers.ts';

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

const JOB_ID = '845744';
const API_PATH = `/api/jobs/${JOB_ID}/`;
const PAGE_PATH = '/jobs/845744-link-builder/';
const PAGE = fixture('job_apply_raw.html');
const LETTER = 'Добрий день!\nМаю 2 роки досвіду в SEO.';
// 14:00 in Kyiv (UTC+2 in November).
const NOW = new Date('2026-11-10T12:00:00.000Z');

const apiJob = (changes: Record<string, unknown> = {}) => ({ ...JSON.parse(fixture('api_job_apply.json')), ...changes });
const jsonRoute = (body: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// A fake djinni with the job of the raw fixture. A POST to the job page marks the job as applied, as djinni does.
async function setup(opts: { job?: Record<string, unknown>; page?: string; routes?: Record<string, Route>; store?: Store; now?: () => Date } = {}) {
  djinni = await startFakeDjinni({
    'GET /my/profile/': fixture('my_profile.html'),
    [`GET ${API_PATH}`]: jsonRoute(apiJob(opts.job)),
    [`GET ${PAGE_PATH}`]: opts.page ?? PAGE,
    [`POST ${PAGE_PATH}`]: () => {
      djinni.routes.set(`GET ${API_PATH}`, jsonRoute(apiJob({ ...opts.job, has_applied: true, messagethread_url: '/my/inbox/777/' })));
      return { status: 302, headers: { location: PAGE_PATH } };
    },
    ...opts.routes,
  });
  const store = opts.store ?? loggedInStore();
  return new Ctx({ store, baseUrl: djinni.url, minIntervalMs: 0, now: opts.now ?? (() => NOW) });
}

const posts = () => djinni.requests.filter(r => r.method === 'POST');

// The multipart fields of a recorded request. The fake server keeps the body as latin1 text.
async function formOf(req: Recorded): Promise<[string, string][]> {
  const form = await new Response(Buffer.from(req.body, 'latin1'), { headers: { 'content-type': req.headers['content-type']! } }).formData();
  return [...form.entries()].map(([k, v]) => [k, String(v)]);
}

// Writes the local log with applications at the given times. An entry without a status is an entry of the first log format.
const logApplications = (store: Store, times: string[], status?: ApplicationStatus) =>
  store.writeJson(
    'applications.json',
    times.map((appliedAt, i) => ({ jobId: `1${i}`, title: 'Job', company: 'Company', cvId: '1', cvName: 'CV.pdf', appliedAt, ...(status ? { status } : {}) })),
  );

const readLog = (store: Store) => store.readJson<{ status: string; draftId?: string }[]>('applications.json', []);
const PAGE_URL = `https://djinni.co${PAGE_PATH}`;
const CHECK_PAGE = `The draft is marked as sent. Check the job page ${PAGE_URL} before you send it again.`;
const sentBefore = (id: string) =>
  `The draft ${id} was sent to djinni before, and the application may be sent already. Only the user can send it again, in a terminal: npx djinni-mcp apply submit ${id} --resend`;
// A POST answer of djinni that does not show the application.
const UNCLEAR = { status: 200, body: '<html><title>Link builder</title><form id="apply_form"><div class="invalid-feedback">Помилка</div></form></html>' };
const LOCK = 'locks/apply.lock';
const writeLock = (store: Store, createdAt: string, pid = 999999) => {
  mkdirSync(store.path('locks'), { recursive: true });
  writeFileSync(store.path(LOCK), JSON.stringify({ pid, createdAt }));
};

const todayTimes = (n: number) => Array.from({ length: n }, () => '2026-11-10T08:00:00.000Z');

describe('prepareApplication', () => {
  test('makes a draft with the job, the full cover letter, the CV that the form selects and no salary', async () => {
    const ctx = await setup();

    const draft = await prepareApplication(ctx, { job: JOB_ID, message: LETTER });

    expect(draft.preview).toEqual({
      jobId: JOB_ID,
      title: 'Link builder',
      company: 'Come Back Agency',
      url: `https://djinni.co${PAGE_PATH}`,
      message: LETTER,
      cvId: '2705342',
      cvName: 'CV_1.pdf',
      salary: null,
    });
    expect(draft.expiresAt).toBe('2026-11-11T12:00:00.000Z');
    expect(getDraft(ctx, draft.draftId, 'application').payload).toMatchObject({ jobId: JOB_ID, path: PAGE_PATH, cvId: '2705342' });
    expect(posts()).toEqual([]);
  });

  test('builds the job page path from the slug of the job JSON', async () => {
    const ctx = await setup();

    await prepareApplication(ctx, { job: `https://djinni.co/jobs/${JOB_ID}/`, message: LETTER });

    expect(djinni.requests.map(r => `${r.method} ${r.url}`)).toEqual(['GET /my/profile/', `GET ${API_PATH}`, `GET ${PAGE_PATH}`]);
  });

  test('accepts a CV ID from the options of the form and keeps the salary', async () => {
    const page = PAGE.replace('<option value="">CV_2.pdf</option>', '<option value="2800001">CV_3.pdf</option>');
    const ctx = await setup({ page });

    const draft = await prepareApplication(ctx, { job: JOB_ID, message: LETTER, cvId: '2800001', salary: 3000 });

    expect(draft.preview).toMatchObject({ cvId: '2800001', cvName: 'CV_3.pdf', salary: 3000 });
  });

  test('refuses a CV ID that is not an option of the form and names the options', async () => {
    const ctx = await setup();

    await expect(prepareApplication(ctx, { job: JOB_ID, message: LETTER, cvId: '999' })).rejects.toThrow(
      'The CV ID "999" is not a CV of the apply form. The CV files of the form: 2705342 (CV_1.pdf).',
    );
    expect(listDrafts(ctx)).toEqual([]);
  });

  test('refuses an empty CV ID, also when the form has an option without a value', async () => {
    const ctx = await setup();

    await expect(prepareApplication(ctx, { job: JOB_ID, message: LETTER, cvId: '' })).rejects.toThrow(
      'The CV ID "" is not a CV of the apply form. The CV files of the form: 2705342 (CV_1.pdf).',
    );
  });

  test('asks for a CV ID when the form selects a CV option without a value', async () => {
    const ctx = await setup({ page: PAGE.replace('<option value="">CV_2.pdf</option>', '<option value="" selected>CV_2.pdf</option>') });

    await expect(prepareApplication(ctx, { job: JOB_ID, message: LETTER })).rejects.toThrow(
      'The apply form selects the CV file "CV_2.pdf" without a CV ID. Give a CV ID. The CV files of the form: 2705342 (CV_1.pdf).',
    );
    expect(listDrafts(ctx)).toEqual([]);
  });

  test('refuses a job with an unclear application in the local log', async () => {
    const store = loggedInStore();
    store.writeJson('applications.json', [
      { jobId: JOB_ID, title: 'Link builder', company: 'C', cvId: '1', cvName: 'CV', appliedAt: '2026-11-10T10:00:00.000Z', status: 'unconfirmed', draftId: 'abcd1234' },
    ]);
    const ctx = await setup({ store });

    await expect(prepareApplication(ctx, { job: JOB_ID, message: LETTER })).rejects.toThrow(
      'An application to the job 845744 may be sent already: the log has an unclear result from 2026-11-10T10:00:00.000Z. ' +
        'Check the job page on djinni. Only the user can send the application again, in a terminal: npx djinni-mcp apply submit abcd1234 --resend',
    );
  });

  test('the daily limit counts the sent and the unconfirmed applications, but not the rejected ones', async () => {
    const store = loggedInStore();
    const ctx = await setup({ store });

    logApplications(store, todayTimes(DAILY_APPLY_LIMIT), 'unconfirmed');
    await expect(prepareApplication(ctx, { job: JOB_ID, message: LETTER })).rejects.toThrow('You sent 15 applications today.');
    logApplications(store, todayTimes(DAILY_APPLY_LIMIT), 'sent');
    await expect(prepareApplication(ctx, { job: JOB_ID, message: LETTER })).rejects.toThrow('You sent 15 applications today.');
    logApplications(store, todayTimes(DAILY_APPLY_LIMIT), 'rejected');
    await expect(prepareApplication(ctx, { job: JOB_ID, message: LETTER })).resolves.toBeDefined();
  });

  test('refuses a job that the user applied to already, before it reads the job page', async () => {
    const ctx = await setup({ job: { has_applied: true } });

    await expect(prepareApplication(ctx, { job: JOB_ID, message: LETTER })).rejects.toThrow(
      'You already applied to the job 845744. djinni does not accept a second application to the same job.',
    );
    expect(djinni.requests.map(r => r.url)).not.toContain(PAGE_PATH);
    expect(listDrafts(ctx)).toEqual([]);
  });

  test('refuses a job that is in the local application log', async () => {
    const store = loggedInStore();
    store.writeJson('applications.json', [{ jobId: JOB_ID, title: 'Link builder', company: 'C', cvId: '1', cvName: 'CV', appliedAt: '2026-11-01T10:00:00.000Z' }]);
    const ctx = await setup({ store });

    await expect(prepareApplication(ctx, { job: JOB_ID, message: LETTER })).rejects.toThrow('You already applied to the job 845744');
  });

  test('refuses a job when djinni does not allow an application and gives the reason', async () => {
    const ctx = await setup({ job: { can_apply: false, can_apply_reason: 'Вакансія закрита' } });

    await expect(prepareApplication(ctx, { job: JOB_ID, message: LETTER })).rejects.toThrow(
      'djinni does not allow an application to the job 845744: Вакансія закрита',
    );
  });

  test('refuses an empty cover letter when the job requires a cover letter', async () => {
    const ctx = await setup({ job: { requires_cover_letter: true } });

    await expect(prepareApplication(ctx, { job: JOB_ID, message: '  \n ' })).rejects.toThrow('The job 845744 requires a cover letter.');
  });

  test('accepts an empty cover letter when the job does not require one', async () => {
    const ctx = await setup();

    expect((await prepareApplication(ctx, { job: JOB_ID, message: '' })).preview.message).toBe('');
  });

  test('refuses a salary that is not a positive whole number', async () => {
    const ctx = await setup();

    await expect(prepareApplication(ctx, { job: JOB_ID, message: LETTER, salary: -5 })).rejects.toThrow('The salary must be a positive whole number of USD.');
    expect(djinni.requests).toEqual([]);
  });

  test('refuses a salary that is not a multiple of the step of the form and saves no draft', async () => {
    const ctx = await setup();

    await expect(prepareApplication(ctx, { job: JOB_ID, message: LETTER, salary: 3025 })).rejects.toThrow(
      'The salary 3025 does not match the apply form: the form accepts only multiples of 50 USD, for example 3000 or 3050.',
    );
    expect(listDrafts(ctx)).toEqual([]);
  });

  test('refuses a salary below the minimum of the form', async () => {
    const ctx = await setup({ page: PAGE.replace('name="salary_changed" step="50"', 'name="salary_changed" min="1000" step="50"') });

    await expect(prepareApplication(ctx, { job: JOB_ID, message: LETTER, salary: 950 })).rejects.toThrow(
      'The salary 950 does not match the apply form: the minimum is 1000 USD.',
    );
  });

  test('counts the step from the minimum of the form', async () => {
    const ctx = await setup({ page: PAGE.replace('name="salary_changed" step="50"', 'name="salary_changed" min="1025" step="50"') });

    expect((await prepareApplication(ctx, { job: JOB_ID, message: LETTER, salary: 1075 })).preview.salary).toBe(1075);
    await expect(prepareApplication(ctx, { job: JOB_ID, message: LETTER, salary: 1100 })).rejects.toThrow(
      'the form accepts only 1025 USD plus multiples of 50 USD, for example 1075 or 1125.',
    );
  });

  test('refuses a job page without the apply form', async () => {
    const ctx = await setup({ page: '<html><body>no form</body></html>' });

    await expect(prepareApplication(ctx, { job: JOB_ID, message: LETTER })).rejects.toThrow(`The job page ${PAGE_PATH} has no apply form.`);
  });

  test('refuses a slug that does not belong to the job', async () => {
    const ctx = await setup({ job: { slug: '../../my/profile' } });

    await expect(prepareApplication(ctx, { job: JOB_ID, message: LETTER })).rejects.toThrow('djinni gave the slug "../../my/profile" for the job 845744.');
  });

  test('refuses a new draft when the user sent the daily limit of applications today in Kyiv time', async () => {
    const store = loggedInStore();
    logApplications(store, todayTimes(DAILY_APPLY_LIMIT));
    const ctx = await setup({ store });

    await expect(prepareApplication(ctx, { job: JOB_ID, message: LETTER })).rejects.toThrow(
      'You sent 15 applications today. The limit is 15 applications for each day in the Europe/Kyiv time zone. ' +
        'The limit resets at 2026-11-11 00:00 Kyiv time (2026-11-10T22:00:00.000Z).',
    );
    expect(listDrafts(ctx)).toEqual([]);
  });

  test('counts the day in Kyiv time, not in UTC', async () => {
    const store = loggedInStore();
    // 23:30 in Kyiv on the day before: not today. 00:30 in Kyiv today: today.
    logApplications(store, [...todayTimes(DAILY_APPLY_LIMIT - 1), '2026-11-09T21:30:00.000Z', '2026-11-09T22:30:00.000Z']);
    const ctx = await setup({ store });

    await expect(prepareApplication(ctx, { job: JOB_ID, message: LETTER })).rejects.toThrow('You sent 15 applications today.');
    logApplications(store, [...todayTimes(DAILY_APPLY_LIMIT - 1), '2026-11-09T21:30:00.000Z']);
    await expect(prepareApplication(ctx, { job: JOB_ID, message: LETTER })).resolves.toBeDefined();
  });

  test('throws NotLoggedInError when no session is saved', async () => {
    const ctx = await setup({ store: tempStore() });

    await expect(prepareApplication(ctx, { job: JOB_ID, message: LETTER })).rejects.toBeInstanceOf(NotLoggedInError);
    expect(djinni.requests).toEqual([]);
  });
});

describe('submitApplication', () => {
  test('posts the form as multipart data with the cover letter, the CV ID, the salary and the submit button', async () => {
    const ctx = await setup();
    const { draftId } = await prepareApplication(ctx, { job: JOB_ID, message: LETTER, salary: 3000 });

    const result = await submitApplication(ctx, draftId);

    expect(result).toEqual({ ok: true, jobId: JOB_ID, messageThreadUrl: 'https://djinni.co/my/inbox/777/' });
    const [post] = posts();
    expect(post!.url).toBe(PAGE_PATH);
    expect(post!.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(await formOf(post!)).toEqual([
      ['apply', 'true'],
      ['message', LETTER.replace(/\n/g, '\r\n')],
      ['msg_template_name', ''],
      ['linkedin', ''],
      ['cv_file_upload_id', '2705342'],
      ['salary_changed', '3000'],
      ['job_apply', ''],
      ['csrfmiddlewaretoken', 'CSRF'],
    ]);
  });

  test('keeps the empty salary field of the form when no salary is given', async () => {
    const ctx = await setup();
    const { draftId } = await prepareApplication(ctx, { job: JOB_ID, message: LETTER });

    await submitApplication(ctx, draftId);

    expect(await formOf(posts()[0]!)).toContainEqual(['salary_changed', '']);
  });

  test('never sends save_msg_template, also when the page checks it', async () => {
    const page = PAGE.replace('name="save_msg_template" class="form-check-input"', 'name="save_msg_template" checked class="form-check-input"');
    const ctx = await setup({ page });
    const { draftId } = await prepareApplication(ctx, { job: JOB_ID, message: LETTER });

    await submitApplication(ctx, draftId);

    expect((await formOf(posts()[0]!)).map(([k]) => k)).not.toContain('save_msg_template');
  });

  test('logs the application with mode 0600 and deletes the draft', async () => {
    const ctx = await setup();
    const { draftId } = await prepareApplication(ctx, { job: JOB_ID, message: LETTER });

    await submitApplication(ctx, draftId);

    expect(ctx.store.readJson('applications.json', [])).toEqual([
      {
        jobId: JOB_ID,
        title: 'Link builder',
        company: 'Come Back Agency',
        cvId: '2705342',
        cvName: 'CV_1.pdf',
        appliedAt: NOW.toISOString(),
        status: 'confirmed',
        draftId,
      },
    ]);
    expect(listDrafts(ctx)).toEqual([]);
    const { statSync } = await import('node:fs');
    expect(statSync(ctx.store.path('applications.json')).mode & 0o777).toBe(0o600);
  });

  test('refuses the draft and sends no POST when djinni shows the job as applied', async () => {
    const ctx = await setup();
    const { draftId } = await prepareApplication(ctx, { job: JOB_ID, message: LETTER });
    djinni.routes.set(`GET ${API_PATH}`, jsonRoute(apiJob({ has_applied: true })));

    await expect(submitApplication(ctx, draftId)).rejects.toThrow('You already applied to the job 845744.');
    expect(posts()).toEqual([]);
  });

  test('refuses a second submit of the same job', async () => {
    const ctx = await setup();
    const first = await prepareApplication(ctx, { job: JOB_ID, message: LETTER });
    const second = await prepareApplication(ctx, { job: JOB_ID, message: 'Інший лист' });
    await submitApplication(ctx, first.draftId);

    await expect(submitApplication(ctx, second.draftId)).rejects.toThrow('You already applied to the job 845744.');
    expect(posts()).toHaveLength(1);
  });

  test('sends one POST for two concurrent submits of the same job', async () => {
    const ctx = await setup();
    const first = await prepareApplication(ctx, { job: JOB_ID, message: LETTER });
    const second = await prepareApplication(ctx, { job: JOB_ID, message: 'Інший лист' });

    const results = await Promise.allSettled([submitApplication(ctx, first.draftId), submitApplication(ctx, second.draftId)]);

    expect(posts()).toHaveLength(1);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(String((results[1] as PromiseRejectedResult).reason)).toContain('You already applied to the job 845744.');
  });

  test('refuses the draft and sends no POST when the daily limit is reached after the draft', async () => {
    const ctx = await setup();
    const { draftId } = await prepareApplication(ctx, { job: JOB_ID, message: LETTER });
    logApplications(ctx.store, todayTimes(DAILY_APPLY_LIMIT));

    await expect(submitApplication(ctx, draftId)).rejects.toThrow('You sent 15 applications today.');
    expect(posts()).toEqual([]);
    expect(listDrafts(ctx)).toHaveLength(1);
  });

  test('writes a "sent" log entry and holds the lock file before the POST result is known', async () => {
    let atPost: { log: unknown; lock: unknown } | undefined;
    const ctx = await setup({
      routes: {
        [`POST ${PAGE_PATH}`]: () => {
          atPost = { log: readLog(ctx.store), lock: JSON.parse(readFileSync(ctx.store.path(LOCK), 'utf8')) };
          return UNCLEAR;
        },
      },
    });
    const { draftId } = await prepareApplication(ctx, { job: JOB_ID, message: LETTER });

    await submitApplication(ctx, draftId);

    expect(atPost).toEqual({ log: [expect.objectContaining({ jobId: JOB_ID, status: 'sent', draftId })], lock: { pid: process.pid, createdAt: NOW.toISOString() } });
    expect(existsSync(ctx.store.path(LOCK))).toBe(false);
  });

  test('returns ok false, logs an unconfirmed entry and keeps the draft when djinni does not show the application', async () => {
    const ctx = await setup({ routes: { [`POST ${PAGE_PATH}`]: UNCLEAR } });
    const { draftId } = await prepareApplication(ctx, { job: JOB_ID, message: LETTER });

    const result = await submitApplication(ctx, draftId);

    expect(result).toEqual({ ok: false, status: 200, message: `djinni does not show the application after the request. djinni page: Помилка. ${CHECK_PAGE}` });
    expect(readLog(ctx.store)).toEqual([expect.objectContaining({ status: 'unconfirmed', draftId })]);
    expect(listDrafts(ctx)).toHaveLength(1);
  });

  test('an unclear result blocks a second submit of the same draft with no POST', async () => {
    const ctx = await setup({ routes: { [`POST ${PAGE_PATH}`]: UNCLEAR } });
    const { draftId } = await prepareApplication(ctx, { job: JOB_ID, message: LETTER });
    await submitApplication(ctx, draftId);

    await expect(submitApplication(ctx, draftId)).rejects.toThrow(sentBefore(draftId));
    expect(posts()).toHaveLength(1);
  });

  test('returns ok false with a retry warning and logs an unconfirmed entry when the POST gets no answer', async () => {
    const ctx = await setup({ routes: { [`POST ${PAGE_PATH}`]: { closeConnection: true } } });
    const { draftId } = await prepareApplication(ctx, { job: JOB_ID, message: LETTER });

    const result = await submitApplication(ctx, draftId);

    expect(result).toMatchObject({ ok: false, status: null });
    expect((result as { message: string }).message).toMatch(/^The application request failed: .+\. djinni may have got the application\. The draft is marked as sent\. /);
    expect((result as { message: string }).message.endsWith(CHECK_PAGE)).toBe(true);
    expect(readLog(ctx.store)).toEqual([expect.objectContaining({ status: 'unconfirmed' })]);
    await expect(submitApplication(ctx, draftId)).rejects.toThrow(sentBefore(draftId));
  });

  test('returns ok false with a retry warning when the check after the POST fails', async () => {
    const ctx = await setup({
      routes: {
        [`POST ${PAGE_PATH}`]: () => {
          djinni.routes.set(`GET ${API_PATH}`, { status: 500 });
          return { status: 302, headers: { location: PAGE_PATH } };
        },
      },
    });
    const { draftId } = await prepareApplication(ctx, { job: JOB_ID, message: LETTER });

    const result = await submitApplication(ctx, draftId);

    expect(result).toEqual({
      ok: false,
      status: 302,
      message: `The application request finished, but the check of the job failed: djinni returned HTTP 500 for GET ${API_PATH}. djinni may have got the application. ${CHECK_PAGE}`,
    });
    expect(readLog(ctx.store)).toEqual([expect.objectContaining({ status: 'unconfirmed' })]);
  });

  test('an HTTP 4xx answer logs a rejected entry that does not block a new draft, but the draft cannot be sent again', async () => {
    const ctx = await setup({ routes: { [`POST ${PAGE_PATH}`]: { status: 400, body: '<title>Bad request</title>' } } });
    const { draftId } = await prepareApplication(ctx, { job: JOB_ID, message: LETTER });

    const result = await submitApplication(ctx, draftId);

    expect(result).toEqual({ ok: false, status: 400, message: 'djinni rejected the application with HTTP 400. djinni page: Bad request. Make a new draft to try again.' });
    expect(readLog(ctx.store)).toEqual([expect.objectContaining({ status: 'rejected' })]);
    expect(listApplications(ctx).sentToday).toBe(0);
    await expect(submitApplication(ctx, draftId)).rejects.toThrow(sentBefore(draftId));
    await expect(prepareApplication(ctx, { job: JOB_ID, message: LETTER })).resolves.toBeDefined();
  });

  test('resend sends a sent draft again after an unclear result', async () => {
    const ctx = await setup({ routes: { [`POST ${PAGE_PATH}`]: UNCLEAR } });
    const { draftId } = await prepareApplication(ctx, { job: JOB_ID, message: LETTER });
    await submitApplication(ctx, draftId);
    djinni.routes.set(`POST ${PAGE_PATH}`, () => {
      djinni.routes.set(`GET ${API_PATH}`, jsonRoute(apiJob({ has_applied: true })));
      return { status: 302, headers: { location: PAGE_PATH } };
    });

    expect(await submitApplication(ctx, draftId, { resend: true })).toMatchObject({ ok: true });
    expect(posts()).toHaveLength(2);
    expect(readLog(ctx.store).map(e => e.status)).toEqual(['unconfirmed', 'confirmed']);
  });

  test('resend refuses with no POST when djinni shows the job as applied', async () => {
    const ctx = await setup({ routes: { [`POST ${PAGE_PATH}`]: UNCLEAR } });
    const { draftId } = await prepareApplication(ctx, { job: JOB_ID, message: LETTER });
    await submitApplication(ctx, draftId);
    djinni.routes.set(`GET ${API_PATH}`, jsonRoute(apiJob({ has_applied: true })));

    await expect(submitApplication(ctx, draftId, { resend: true })).rejects.toThrow('You already applied to the job 845744.');
    expect(posts()).toHaveLength(1);
  });

  test('resend refuses a draft that was not sent before', async () => {
    const ctx = await setup();
    const { draftId } = await prepareApplication(ctx, { job: JOB_ID, message: LETTER });

    await expect(submitApplication(ctx, draftId, { resend: true })).rejects.toThrow(`The draft ${draftId} was not sent before, so it needs no resend.`);
    expect(posts()).toEqual([]);
  });

  test('a fresh lock file of another submit makes the submit fail at once with no POST', async () => {
    const ctx = await setup();
    const { draftId } = await prepareApplication(ctx, { job: JOB_ID, message: LETTER });
    writeLock(ctx.store, '2026-11-10T11:55:00.000Z');

    await expect(submitApplication(ctx, draftId)).rejects.toThrow(
      `Another application submit runs now (process 999999, since 2026-11-10T11:55:00.000Z). Try again when it ends. The lock file is ${ctx.store.path(LOCK)}.`,
    );
    expect(posts()).toEqual([]);
    expect(readLog(ctx.store)).toEqual([]);
    expect(existsSync(ctx.store.path(LOCK))).toBe(true);
  });

  test('a lock file older than 10 minutes is stale, so the submit takes it', async () => {
    const ctx = await setup();
    const { draftId } = await prepareApplication(ctx, { job: JOB_ID, message: LETTER });
    writeLock(ctx.store, '2026-11-10T11:49:00.000Z');

    expect(await submitApplication(ctx, draftId)).toMatchObject({ ok: true });
    expect(posts()).toHaveLength(1);
    expect(existsSync(ctx.store.path(LOCK))).toBe(false);
  });

  test('the submit removes its lock file also after a refusal', async () => {
    const ctx = await setup();
    const { draftId } = await prepareApplication(ctx, { job: JOB_ID, message: LETTER });
    djinni.routes.set(`GET ${API_PATH}`, jsonRoute(apiJob({ has_applied: true })));

    await expect(submitApplication(ctx, draftId)).rejects.toThrow('You already applied');
    expect(existsSync(ctx.store.path(LOCK))).toBe(false);
  });

  test('refuses a draft of another kind', async () => {
    const ctx = await setup();
    const { createDraft } = await import('../../src/core/drafts.ts');
    const other = createDraft(ctx, 'profile', {}, {});

    await expect(submitApplication(ctx, other.id)).rejects.toThrow('is a profile draft, not a application draft');
    expect(posts()).toEqual([]);
  });
});

describe('listApplications', () => {
  test('returns the logged applications, newest first, with the count of today and the limit', async () => {
    const store = tempStore();
    logApplications(store, ['2026-11-09T10:00:00.000Z', '2026-11-10T10:00:00.000Z']);
    const ctx = new Ctx({ store, now: () => NOW });

    const result = listApplications(ctx);

    expect(result.dailyLimit).toBe(15);
    expect(result.sentToday).toBe(1);
    expect(result.applications.map(a => a.appliedAt)).toEqual(['2026-11-10T10:00:00.000Z', '2026-11-09T10:00:00.000Z']);
  });
});
