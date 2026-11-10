import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import * as cheerio from 'cheerio';
import type { Ctx } from '../context.ts';
import { DJINNI_URL, NotLoggedInError, type FormField, type PostResult } from '../http.ts';
import { serializeForm } from '../parsers/form.ts';
import type { ApiJob } from '../parsers/jobs.ts';
import { createDraft, deleteDraft, getDraft } from './drafts.ts';
import { jobId, jobPath } from './jobs.ts';
import { BIN } from '../bin.ts';

// At most this number of successful applications for each calendar day in the Kyiv time zone.
// djinni blocks accounts for spam, so the tool keeps the number of applications low.
export const DAILY_APPLY_LIMIT = 15;
const TIME_ZONE = 'Europe/Kyiv';
const LOG_FILE = 'applications.json';
const DRAFT_KIND = 'application';
const APPLY_FORM = '#apply_form';
const CSRF_FIELD = 'csrfmiddlewaretoken';
const CV_FIELD = 'cv_file_upload_id';
const SALARY_FIELD = 'salary_changed';
// The checkbox saves the cover letter as a template on djinni. The tool never sets it.
const TEMPLATE_FIELD = 'save_msg_template';
const MAX_MESSAGE = 300;
// The lock file that only one submit at a time can hold, also across processes. A lock older than LOCK_STALE_MS is stale.
const LOCK_FILE = 'locks/apply.lock';
const LOCK_STALE_MS = 10 * 60 * 1000;
// The command that the user runs in a terminal to send a sent draft again.
const resendCommand = (draftId: string) => `${BIN} apply submit ${draftId} --resend`;
const checkPage = (path: string) => `The draft is marked as sent. Check the job page ${DJINNI_URL + path} before you send it again.`;
const MAY_HAVE = 'djinni may have got the application.';

// "sent": the POST was sent and its result is not known yet (for example, the process stopped).
// "confirmed": djinni shows the application. "unconfirmed": the result is not clear.
// "rejected": djinni answered the POST with HTTP 4xx and does not show the application.
export type ApplicationStatus = 'sent' | 'confirmed' | 'unconfirmed' | 'rejected';
// One apply POST in the local log. An entry of the first log format has no status and no draft ID, and counts as confirmed.
export type ApplicationRecord = {
  jobId: string;
  title: string;
  company: string;
  cvId: string | null;
  cvName: string | null;
  appliedAt: string;
  status?: ApplicationStatus;
  draftId?: string;
};
export type ApplicationPreview = {
  jobId: string;
  title: string;
  company: string;
  url: string;
  message: string;
  cvId: string | null;
  cvName: string | null;
  salary: number | null;
};
export type ApplicationDraftResult = { draftId: string; expiresAt: string; preview: ApplicationPreview };
// "status" is null when djinni sent no HTTP answer to the POST.
export type ApplicationSubmitResult =
  | { ok: true; jobId: string; messageThreadUrl: string | null }
  | { ok: false; status: number | null; message: string };
export type ApplicationList = { dailyLimit: number; sentToday: number; applications: ApplicationRecord[] };

type Fields = [string, string][];
// "form" is the apply form when the draft was made, without the CSRF token.
type ApplicationPayload = {
  jobId: string;
  path: string;
  title: string;
  company: string;
  message: string;
  cvId: string | null;
  cvName: string | null;
  salary: number | null;
  form: Fields;
};

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
const toCrlf = (s: string) => s.replace(/\r\n|\r|\n/g, '\r\n');

// ---- The local log and the daily limit ----

const readLog = (ctx: Ctx): ApplicationRecord[] => {
  const log = ctx.store.readJson<unknown>(LOG_FILE, []);
  return Array.isArray(log) ? (log as ApplicationRecord[]) : [];
};

// The date and the time of an instant in Kyiv.
function kyivParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find(p => p.type === type)!.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

const kyivDay = (date: Date) => {
  const p = kyivParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};

// The difference between the Kyiv time and UTC at an instant, in milliseconds.
const kyivOffset = (date: Date) => {
  const p = kyivParts(date);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
};

// The next 00:00 in Kyiv after the instant. The second step corrects the offset when the time zone changes the offset that night.
function nextKyivMidnight(now: Date): Date {
  const p = kyivParts(now);
  const local = Date.UTC(p.year, p.month - 1, p.day + 1);
  const guess = local - kyivOffset(now);
  return new Date(local - kyivOffset(new Date(guess)));
}

const statusOf = (a: ApplicationRecord): ApplicationStatus => a.status ?? 'confirmed';
// Only a POST that djinni rejected with HTTP 4xx is not a possible application.
const mayBeSent = (a: ApplicationRecord) => statusOf(a) !== 'rejected';

const sentToday = (ctx: Ctx) => {
  const today = kyivDay(ctx.now());
  return readLog(ctx).filter(a => mayBeSent(a) && !Number.isNaN(Date.parse(a.appliedAt)) && kyivDay(new Date(a.appliedAt)) === today).length;
};

function checkDailyLimit(ctx: Ctx): void {
  const count = sentToday(ctx);
  if (count < DAILY_APPLY_LIMIT) return;
  const reset = nextKyivMidnight(ctx.now());
  throw new Error(
    `You sent ${count} applications today. The limit is ${DAILY_APPLY_LIMIT} applications for each day in the ${TIME_ZONE} time zone. ` +
      `The limit resets at ${kyivDay(reset)} 00:00 Kyiv time (${reset.toISOString()}).`,
  );
}

const alreadyApplied = (id: string) => new Error(`You already applied to the job ${id}. djinni does not accept a second application to the same job.`);

// Refuses a job with a confirmed application in the log. Without "allowUnclear", also refuses a job with a sent or an unconfirmed application.
function checkNotLogged(ctx: Ctx, id: string, opts: { allowUnclear?: boolean } = {}): void {
  const entries = readLog(ctx).filter(a => a.jobId === id && mayBeSent(a));
  if (entries.some(a => statusOf(a) === 'confirmed')) throw alreadyApplied(id);
  const unclear = entries.at(-1);
  if (unclear && !opts.allowUnclear) {
    throw new Error(
      `An application to the job ${id} may be sent already: the log has an unclear result from ${unclear.appliedAt}. ` +
        `Check the job page on djinni. Only the user can send the application again, in a terminal: ${resendCommand(unclear.draftId ?? '<draft-id>')}`,
    );
  }
}

const wasSent = (ctx: Ctx, draftId: string, jobId: string) => readLog(ctx).some(a => a.draftId === draftId && a.jobId === jobId);

const sentBefore = (draftId: string) =>
  new Error(
    `The draft ${draftId} was sent to djinni before, and the application may be sent already. ` +
      `Only the user can send it again, in a terminal: ${resendCommand(draftId)}`,
  );

function writeEntry(ctx: Ctx, entry: ApplicationRecord): void {
  ctx.store.writeJson(LOG_FILE, [...readLog(ctx), entry], 0o600);
}

// Sets the status of the last "sent" entry of the draft.
function setStatus(ctx: Ctx, draftId: string, status: ApplicationStatus): void {
  const log = readLog(ctx);
  const i = log.findLastIndex(a => a.draftId === draftId && a.status === 'sent');
  if (i < 0) return;
  log[i] = { ...log[i]!, status };
  ctx.store.writeJson(LOG_FILE, log, 0o600);
}

// ---- The lock file ----

type LockInfo = { pid: number; createdAt: string };

// Takes the lock file with O_EXCL. A stale lock is removed and taken. A fresh lock of another submit fails at once.
// Returns the function that removes the lock.
function takeLock(ctx: Ctx): () => void {
  const file = ctx.store.path(LOCK_FILE);
  mkdirSync(ctx.store.path('locks'), { recursive: true, mode: 0o700 });
  const mine: LockInfo = { pid: process.pid, createdAt: ctx.now().toISOString() };
  const create = (): boolean => {
    let fd: number;
    try {
      fd = openSync(file, 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
    try {
      writeSync(fd, JSON.stringify(mine));
    } finally {
      closeSync(fd);
    }
    return true;
  };
  if (!create()) {
    const held = readLock(file);
    const age = held ? ctx.now().getTime() - Date.parse(held.createdAt) : Infinity;
    if (held && !(age > LOCK_STALE_MS)) {
      throw new Error(`Another application submit runs now (process ${held.pid}, since ${held.createdAt}). Try again when it ends. The lock file is ${file}.`);
    }
    rmSync(file, { force: true });
    if (!create()) throw new Error(`Another application submit took the lock file ${file} now. Try again when it ends.`);
  }
  return () => {
    const held = readLock(file);
    if (held && held.pid === mine.pid && held.createdAt === mine.createdAt) rmSync(file, { force: true });
  };
}

// Returns the content of the lock file, or null for a damaged lock file. A damaged lock file counts as stale.
function readLock(file: string): LockInfo | null {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockInfo>;
    return typeof data.pid === 'number' && typeof data.createdAt === 'string' && !Number.isNaN(Date.parse(data.createdAt)) ? (data as LockInfo) : null;
  } catch {
    return null;
  }
}

// Returns the applications of the local log, newest first, and the count of today.
export function listApplications(ctx: Ctx): ApplicationList {
  const applications = [...readLog(ctx)].sort((a, b) => String(b.appliedAt).localeCompare(String(a.appliedAt)));
  return { dailyLimit: DAILY_APPLY_LIMIT, sentToday: sentToday(ctx), applications };
}

// ---- The job and its apply form ----

const apiPath = (id: string) => `/api/jobs/${id}/`;
const readJob = (ctx: Ctx, id: string) => ctx.client().getJson<ApiJob>(apiPath(id));

// Checks the apply status of the job JSON. The user fields need a valid session.
function checkCanApply(job: ApiJob, id: string): void {
  if (job.has_applied) throw alreadyApplied(id);
  if (!job.can_apply) throw new Error(`djinni does not allow an application to the job ${id}: ${collapse(job.can_apply_reason ?? '') || 'djinni gives no reason'}.`);
}

type CvOption = { id: string; name: string };

const cvOptions = ($: cheerio.CheerioAPI): CvOption[] =>
  $(APPLY_FORM)
    .filter('form')
    .first()
    .find(`select[name="${CV_FIELD}"] option`)
    .toArray()
    .map(o => ({ id: $(o).attr('value') ?? collapse($(o).text()), name: collapse($(o).text()) || ($(o).attr('data-cv-name') ?? '') }));

const optionLabel = (o: CvOption) => `${o.id} (${o.name})`;

const numberAttr = (value: string | undefined): number | null => {
  if (value === undefined || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

// Checks the salary against the "min" and "step" attributes of the salary field, as a browser does.
// The step counts from "min". Without "min", it counts from 0.
function checkSalary($: cheerio.CheerioAPI, salary: number): void {
  const input = $(APPLY_FORM).filter('form').first().find(`input[name="${SALARY_FIELD}"]`).first();
  if (input.length === 0) return;
  const min = numberAttr(input.attr('min'));
  const wrong = `The salary ${salary} does not match the apply form:`;
  if (min !== null && salary < min) throw new Error(`${wrong} the minimum is ${min} USD.`);
  const step = numberAttr(input.attr('step'));
  if (step === null || step <= 0) return;
  const base = min ?? 0;
  if ((salary - base) % step === 0) return;
  const lower = base + Math.floor((salary - base) / step) * step;
  const examples = [lower, lower + step].filter(n => n > 0).join(' or ');
  const rule = base === 0 ? `multiples of ${step} USD` : `${base} USD plus multiples of ${step} USD`;
  throw new Error(`${wrong} the form accepts only ${rule}, for example ${examples}.`);
}

// Makes a draft of a job application. Sends nothing to the employer.
export async function prepareApplication(
  ctx: Ctx,
  opts: { job: string; message: string; cvId?: string; salary?: number },
): Promise<ApplicationDraftResult> {
  if (opts.salary !== undefined && !(Number.isInteger(opts.salary) && opts.salary > 0)) {
    throw new Error('The salary must be a positive whole number of USD.');
  }
  const id = jobId(opts.job);
  checkNotLogged(ctx, id);
  checkDailyLimit(ctx);
  await ctx.me();
  const job = await readJob(ctx, id);
  checkCanApply(job, id);
  if (job.requires_cover_letter && opts.message.trim() === '') throw new Error(`The job ${id} requires a cover letter. Write a cover letter.`);
  const path = jobPath(job, id);
  const $ = cheerio.load(await ctx.client().get(path));
  if ($(APPLY_FORM).filter('form').length === 0) throw new Error(`The job page ${path} has no apply form.`);
  if (opts.salary !== undefined) checkSalary($, opts.salary);
  const form = serializeForm($, APPLY_FORM).filter(([name]) => name !== CSRF_FIELD) as Fields;
  // An option without a value is not a CV file that the tool can name, so it is never a CV choice.
  const allOptions = cvOptions($);
  const options = allOptions.filter(o => o.id !== '');
  const list = `The CV files of the form: ${options.length ? options.map(optionLabel).join(', ') : 'none'}.`;
  let cv: CvOption | null;
  if (opts.cvId !== undefined) {
    cv = options.find(o => o.id === opts.cvId) ?? null;
    if (!cv) throw new Error(`The CV ID "${opts.cvId}" is not a CV of the apply form. ${list}`);
  } else {
    const selected = form.find(([name]) => name === CV_FIELD)?.[1];
    if (selected === '') {
      const name = allOptions.find(o => o.id === '')?.name ?? '';
      throw new Error(`The apply form selects the CV file "${name}" without a CV ID. Give a CV ID. ${list}`);
    }
    cv = selected === undefined ? null : (options.find(o => o.id === selected) ?? { id: selected, name: '' });
  }
  const payload: ApplicationPayload = {
    jobId: id,
    path,
    title: collapse(job.title),
    company: collapse(job.company_name),
    message: opts.message,
    cvId: cv?.id ?? null,
    cvName: cv?.name || null,
    salary: opts.salary ?? null,
    form,
  };
  const preview: ApplicationPreview = {
    jobId: id,
    title: payload.title,
    company: payload.company,
    url: DJINNI_URL + path,
    message: payload.message,
    cvId: payload.cvId,
    cvName: payload.cvName,
    salary: payload.salary,
  };
  const draft = createDraft<ApplicationPayload, ApplicationPreview>(ctx, DRAFT_KIND, payload, preview);
  return { draftId: draft.id, expiresAt: draft.expiresAt, preview };
}

// Returns a saved application draft. Sends no request.
export function getApplicationDraft(ctx: Ctx, draftId: string): ApplicationDraftResult {
  const draft = getDraft<ApplicationPayload, ApplicationPreview>(ctx, draftId, DRAFT_KIND);
  return { draftId: draft.id, expiresAt: draft.expiresAt, preview: draft.preview };
}

// The fields that a browser sends when the user writes the cover letter, picks the CV and clicks the submit button.
function applyFields(p: ApplicationPayload): FormField[] {
  const fields: FormField[] = p.form
    .filter(([name]) => name !== TEMPLATE_FIELD)
    .map(([name, value]): FormField => {
      if (name === 'message') return [name, toCrlf(p.message)];
      if (name === CV_FIELD && p.cvId !== null) return [name, p.cvId];
      if (name === SALARY_FIELD && p.salary !== null) return [name, String(p.salary)];
      return [name, value];
    });
  if (!fields.some(([name]) => name === 'message')) fields.push(['message', toCrlf(p.message)]);
  if (p.cvId !== null && !fields.some(([name]) => name === CV_FIELD)) fields.push([CV_FIELD, p.cvId]);
  if (p.salary !== null && !fields.some(([name]) => name === SALARY_FIELD)) fields.push([SALARY_FIELD, String(p.salary)]);
  fields.push(['job_apply', '']);
  return fields;
}

// A short text from the response page: the first error message in the apply form, else the page title.
function responseMessage(body: string): string {
  const $ = cheerio.load(body);
  const error = $(APPLY_FORM)
    .find('.invalid-feedback, .errorlist, .alert')
    .toArray()
    .map(el => collapse($(el).text()))
    .find(t => t !== '');
  return (error ?? collapse($('title').text())).slice(0, MAX_MESSAGE);
}

// The error text without the last period. A fetch error adds its cause, for example "fetch failed (other side closed)".
function errorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause instanceof Error ? ` (${e.cause.message})` : '';
  return `${e.message}${cause}`.replace(/\.$/, '');
}

// The submits of this process run one after the other. So the checks of a submit see the log entry of the submit before it,
// and two concurrent submits for the same job cannot both send the application. The lock file does the same across processes.
let submitQueue: Promise<unknown> = Promise.resolve();

// Sends the application of an approved draft to the employer. An application cannot be taken back.
// Before the POST, the function checks the daily limit and the apply status again, and writes a "sent" log entry.
// After the POST, the job JSON tells if djinni got the application. A draft that was sent once can only be sent again with "resend".
// Only the CLI sets "resend", after the user approves it in the terminal.
export function submitApplication(ctx: Ctx, draftId: string, opts: { resend?: boolean } = {}): Promise<ApplicationSubmitResult> {
  const run = async () => {
    const draft = getDraft<ApplicationPayload, ApplicationPreview>(ctx, draftId, DRAFT_KIND);
    const release = takeLock(ctx);
    try {
      return await submitNow(ctx, draftId, draft.payload, opts.resend === true);
    } finally {
      release();
    }
  };
  const next = submitQueue.then(run, run);
  submitQueue = next.catch(() => undefined);
  return next;
}

// Checks a sent draft before the user approves a resend: the draft was sent, and djinni does not show the application.
export async function checkApplicationResend(ctx: Ctx, draftId: string): Promise<ApplicationDraftResult> {
  const draft = getDraft<ApplicationPayload, ApplicationPreview>(ctx, draftId, DRAFT_KIND);
  await checkBeforePost(ctx, draftId, draft.payload, true);
  return { draftId: draft.id, expiresAt: draft.expiresAt, preview: draft.preview };
}

async function checkBeforePost(ctx: Ctx, draftId: string, p: ApplicationPayload, resend: boolean): Promise<void> {
  const sent = wasSent(ctx, draftId, p.jobId);
  if (sent && !resend) throw sentBefore(draftId);
  if (!sent && resend) throw new Error(`The draft ${draftId} was not sent before, so it needs no resend.`);
  checkNotLogged(ctx, p.jobId, { allowUnclear: resend });
  checkDailyLimit(ctx);
  await ctx.me();
  checkCanApply(await readJob(ctx, p.jobId), p.jobId);
}

async function submitNow(ctx: Ctx, draftId: string, p: ApplicationPayload, resend: boolean): Promise<ApplicationSubmitResult> {
  await checkBeforePost(ctx, draftId, p, resend);
  writeEntry(ctx, { jobId: p.jobId, title: p.title, company: p.company, cvId: p.cvId, cvName: p.cvName, appliedAt: ctx.now().toISOString(), status: 'sent', draftId });
  const unclear = (status: number | null, message: string): ApplicationSubmitResult => {
    setStatus(ctx, draftId, 'unconfirmed');
    return { ok: false, status, message };
  };
  let res: PostResult;
  try {
    res = await ctx.client().postForm(p.path, applyFields(p), { multipart: true });
  } catch (e) {
    // Only a clear HTTP 4xx answer shows that djinni did not take the application. A redirect to the login page is not one.
    if (e instanceof NotLoggedInError) {
      setStatus(ctx, draftId, 'unconfirmed');
      throw e;
    }
    return unclear(null, `The application request failed: ${errorText(e)}. ${MAY_HAVE} ${checkPage(p.path)}`);
  }
  const rejected = res.status >= 400 && res.status < 500;
  const page = responseMessage(res.body);
  const pageText = page ? ` djinni page: ${page}.` : '';
  let after: ApiJob;
  try {
    after = await readJob(ctx, p.jobId);
  } catch (e) {
    if (rejected) return reject(ctx, draftId, res.status, pageText);
    return unclear(res.status, `The application request finished, but the check of the job failed: ${errorText(e)}. ${MAY_HAVE} ${checkPage(p.path)}`);
  }
  if (!after.has_applied) {
    if (rejected) return reject(ctx, draftId, res.status, pageText);
    return unclear(res.status, `djinni does not show the application after the request.${pageText} ${checkPage(p.path)}`);
  }
  setStatus(ctx, draftId, 'confirmed');
  deleteDraft(ctx, draftId);
  const thread = collapse(after.messagethread_url ?? '');
  return { ok: true, jobId: p.jobId, messageThreadUrl: thread ? new URL(thread, DJINNI_URL).toString() : null };
}

function reject(ctx: Ctx, draftId: string, status: number, pageText: string): ApplicationSubmitResult {
  setStatus(ctx, draftId, 'rejected');
  return { ok: false, status, message: `djinni rejected the application with HTTP ${status}.${pageText} Make a new draft to try again.` };
}
