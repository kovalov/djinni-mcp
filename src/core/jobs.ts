import type { Ctx, HiddenJobsRead, HiddenJobsResult } from '../context.ts';
import { DJINNI_URL, HttpError, type DjinniClient, type PostResult } from '../http.ts';
import {
  buildJobsQuery,
  mapJobDetail,
  parseApplicantStats,
  parseCompany,
  parseHiddenJobsPage,
  parseJobsPage,
  parseSimilarJobs,
  type ApiJob,
  type ApiJobsPage,
  type ApplicantStats,
  type JobFilters,
  type JobsPage,
} from '../parsers/jobs.ts';

// Returns the numeric job ID from an ID, a job URL or a job path.
export function jobId(input: string): string {
  const value = input.trim();
  const id = /^\d+$/.test(value) ? value : /\/jobs\/(\d+)(?:[-/?#]|$)/.exec(value)?.[1];
  if (!id) throw new Error(`"${input}" has no djinni job ID. Use a job ID like 857417, or a job URL.`);
  return id;
}

// The job page path from the slug of the job JSON. djinni answers 404 for /jobs/<id>/ without the slug.
export function jobPath(job: ApiJob, id: string): string {
  const slug = String(job.slug ?? '');
  if (!new RegExp(`^${id}(-[A-Za-z0-9_-]+)?$`).test(slug)) {
    throw new Error(`djinni gave the slug "${slug}" for the job ${id}. The tool cannot make the job page path from it.`);
  }
  return `/jobs/${slug}/`;
}

// Returns the company slug from a slug, a company URL or a company path.
// A slug has only letters, digits, "_" and "-", so it cannot change the request path.
export function companySlug(input: string): string {
  const value = input.trim();
  const slug = /^[A-Za-z0-9_-]+$/.test(value) ? value : /\/jobs\/company-([A-Za-z0-9_-]+)(?:[/?#]|$)/.exec(value)?.[1];
  if (!slug) throw new Error(`"${input}" has no djinni company slug. Use a slug like stellar-jet, or a company URL.`);
  return slug;
}

const search = async (client: DjinniClient, filters: JobFilters) =>
  parseJobsPage(await client.getJson<ApiJobsPage>(`/api/jobs/?${buildJobsQuery(filters)}`));

// Adds the warning about a session that is not valid to a result.
const warn = <T extends object>(result: T, warning: string | undefined): T & { warning?: string } =>
  warning ? { ...result, warning } : result;

// ---- Hidden jobs ----

const HIDDEN_PATH = '/my/dashboard/hidden/';
const MAX_HIDDEN_PAGES = 10;
// The hidden job IDs stay valid for this time, so that a job that the user shows again on the website comes back.
const HIDDEN_TTL_MS = 10 * 60_000;
// After a failed read, the tool does not read the hidden jobs list again for this time.
const HIDDEN_FAILED_TTL_MS = 5 * 60_000;
// The hidden job IDs in the data folder, so that separate CLI processes do not read the list again.
const HIDDEN_FILE = 'hidden-jobs.json';

export const HIDDEN_READ_FAILED_WARNING = 'The tool could not read your hidden jobs, so the list can show them.';
export const MORE_HIDDEN_WARNING = 'You have more hidden jobs than the tool reads, so the list can show some of them.';

// "key" is the session key of the context. The IDs are valid only for the same session.
type HiddenFile = { key: string; at: number; ids: string[]; truncated: boolean };

type HiddenIds = Extract<HiddenJobsResult, { ids: Set<string> }>;

async function readHiddenJobIds(client: DjinniClient): Promise<HiddenIds> {
  const ids = new Set<string>();
  let page: number | null = 1;
  for (let read = 0; page !== null && read < MAX_HIDDEN_PAGES; read++) {
    const parsed = parseHiddenJobsPage(await client.get(page === 1 ? HIDDEN_PATH : `${HIDDEN_PATH}?page=${page}`), page);
    for (const id of parsed.ids) ids.add(id);
    page = parsed.nextPage;
  }
  return { ids, truncated: page !== null };
}

// A read that did not end yet is fresh.
const isFresh = (entry: HiddenJobsRead, now: number) =>
  !entry.result || now - entry.at < ('failed' in entry.result ? HIDDEN_FAILED_TTL_MS : HIDDEN_TTL_MS);

function loadHiddenFile(ctx: Ctx, now: number): HiddenJobsRead | null {
  const key = ctx.sessionKey();
  const file = ctx.store.readJson<HiddenFile | null>(HIDDEN_FILE, null);
  if (!key || !file || file.key !== key || !Array.isArray(file.ids) || typeof file.at !== 'number') return null;
  if (file.at > now || now - file.at >= HIDDEN_TTL_MS) return null;
  const result = { ids: new Set(file.ids.map(String)), truncated: file.truncated === true };
  return { at: file.at, result, read: Promise.resolve(result) };
}

// The file only saves requests of other processes, so a failed write is not an error. The IDs in the context stay valid.
function saveHiddenFile(ctx: Ctx, at: number, result: HiddenIds): void {
  const key = ctx.sessionKey();
  if (!key) return;
  try {
    ctx.store.writeJson(HIDDEN_FILE, { key, at, ids: [...result.ids], truncated: result.truncated } satisfies HiddenFile, 0o600);
  } catch {
    // The next process reads the hidden jobs list from djinni.
  }
}

function startHiddenRead(ctx: Ctx): HiddenJobsRead {
  const entry: HiddenJobsRead = {
    at: ctx.now().getTime(),
    read: readHiddenJobIds(ctx.client()).then(
      result => {
        entry.at = ctx.now().getTime();
        entry.result = result;
        saveHiddenFile(ctx, entry.at, result);
        return result;
      },
      (): HiddenJobsResult => {
        entry.at = ctx.now().getTime();
        entry.result = { failed: true };
        return entry.result;
      },
    ),
  };
  return entry;
}

export type HiddenJobs = { ids: Set<string>; warning?: string };

// Returns the IDs of the jobs that the user hid. The djinni job JSON has no hidden flag, so the IDs come from the hidden jobs page.
// Without a valid session, the set is empty and no request is sent.
// The IDs stay valid for 10 minutes, in the context and in the data folder. A failed read gives an empty set and a warning,
// and the tool does not read the list again for 5 minutes.
export async function hiddenJobs(ctx: Ctx): Promise<HiddenJobs> {
  if (!(await ctx.session())) return { ids: new Set() };
  const now = ctx.now().getTime();
  let entry = ctx.hiddenJobs;
  if (!entry || !isFresh(entry, now)) {
    entry = loadHiddenFile(ctx, now) ?? startHiddenRead(ctx);
    ctx.hiddenJobs = entry;
  }
  const result = await entry.read;
  if ('failed' in result) return { ids: new Set(), warning: HIDDEN_READ_FAILED_WARNING };
  return result.truncated ? { ids: result.ids, warning: MORE_HIDDEN_WARNING } : { ids: result.ids };
}

// Changes the kept hidden job IDs after hideJob or unhideJob, in the context and in the data folder.
// When no IDs are kept, the next read gets the change from djinni.
async function keepHidden(ctx: Ctx, id: string, hidden: boolean): Promise<void> {
  const change = (ids: Set<string>) => (hidden ? ids.add(id) : ids.delete(id));
  const entry = ctx.hiddenJobs ?? loadHiddenFile(ctx, ctx.now().getTime());
  if (!entry) return;
  const result = await entry.read;
  if ('failed' in result) return;
  change(result.ids);
  saveHiddenFile(ctx, entry.at, result);
}

// Joins the warnings of one result.
const joinWarnings = (...warnings: (string | undefined)[]) => warnings.filter(Boolean).join(' ') || undefined;

// Public data does not need a session. With a valid session, djinni adds the fields of the user,
// and the result has no jobs that the user hid. "hiddenOmitted" is the number of hidden jobs that the result does not show.
export async function searchJobs(ctx: Ctx, filters: JobFilters): Promise<JobsPage & { hiddenOmitted?: number; warning?: string }> {
  const { client, warning } = await ctx.readClient();
  const page = await search(client, filters);
  const hidden = await hiddenJobs(ctx);
  const jobs = page.jobs.filter(j => !hidden.ids.has(j.id));
  const omitted = page.jobs.length - jobs.length;
  return warn(omitted > 0 ? { ...page, jobs, hiddenOmitted: omitted } : page, joinWarnings(warning, hidden.warning));
}

export async function getJob(ctx: Ctx, job: string) {
  const id = jobId(job);
  const { client, warning } = await ctx.readClient();
  return warn(mapJobDetail(await client.getJson<ApiJob>(`/api/jobs/${id}/`)), warning);
}

export const NO_APPLICANTS_NOTE = 'This job has no applicants yet, so djinni shows no statistics.';

// Needs a valid session: djinni marks the buckets of the candidate.
// djinni answers HTTP 400 for the statistics of a job that has no applicants. The job JSON tells this case from other errors.
export async function getApplicantStats(ctx: Ctx, job: string): Promise<ApplicantStats & { note?: string }> {
  const id = jobId(job);
  const me = await ctx.me();
  const client = ctx.client();
  let html: string;
  try {
    html = await client.get(`/api/jobs/${id}/?apply_stats&candidate_id=${encodeURIComponent(me.candidateId)}`, { hx: true });
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 400) throw e;
    // A failed read of the job JSON does not tell the case, so the error of the statistics request stays the error.
    const detail = await client.getJson<ApiJob>(`/api/jobs/${id}/`).catch(() => null);
    if (detail?.applications_count !== 0) throw e;
    return { topSkills: [], distributions: [], note: NO_APPLICANTS_NOTE };
  }
  return parseApplicantStats(html);
}

// The similar jobs have no user fields, so the result has no session warning.
// The job page loads this fragment from /jobs/<id>/similar-jobs/ (hx-get). Only the HTML job page itself needs the slug.
export async function getSimilarJobs(ctx: Ctx, job: string) {
  const id = jobId(job);
  const { client } = await ctx.readClient();
  return parseSimilarJobs(await client.get(`/jobs/${id}/similar-jobs/`, { hx: true }));
}

export async function getCompany(ctx: Ctx, company: string) {
  const slug = companySlug(company);
  const { client, warning } = await ctx.readClient();
  const path = `/jobs/company-${encodeURIComponent(slug)}/`;
  const page = parseCompany(await client.get(path));
  if (!page.name) throw new Error(`The djinni page of the company "${slug}" has no company name. Make sure that the company slug is correct.`);
  // The company_name filter of the API is a partial match. Keep only the jobs of this company.
  const sameName = (name: string) => name.trim().toLowerCase() === page.name.trim().toLowerCase();
  const jobs = await search(client, { company_name: page.name });
  return warn(
    {
      slug,
      url: DJINNI_URL + path,
      ...page,
      hasMoreJobs: jobs.hasNextPage,
      jobs: jobs.jobs.filter(j => sameName(j.company)),
    },
    warning,
  );
}

// ---- Favorites and hidden jobs (the JSON API of the logged-in candidate) ----

const FAVORITES_PATH = '/api/jobs/favorites/';
const blockedPath = (id: string) => `/api/jobs/blocked/${id}/`;
// djinni does not document the body of POST /api/jobs/blocked/<id>/. The job ID is in the path, so an empty object is sent.
const HIDE_BODY = {};
const MAX_ERROR_BODY = 200;

// Throws for an HTTP error. The error names the status, the method, the path and the start of the response body.
function checkStatus(res: PostResult, method: string, path: string): void {
  if (res.status < 400) return;
  const body = res.body.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_BODY);
  throw new Error(`djinni returned HTTP ${res.status} for ${method} ${path}${body ? `: ${body}` : '.'}`);
}

export async function saveJob(ctx: Ctx, job: string) {
  const id = jobId(job);
  checkStatus(await ctx.client().postJson(FAVORITES_PATH, { job_id: Number(id), referral: 'detail' }), 'POST', FAVORITES_PATH);
  return { jobId: id, saved: true };
}

export async function unsaveJob(ctx: Ctx, job: string) {
  const id = jobId(job);
  const path = `${FAVORITES_PATH}${id}/`;
  checkStatus(await ctx.client().delete(path), 'DELETE', path);
  return { jobId: id, saved: false };
}

export async function hideJob(ctx: Ctx, job: string) {
  const id = jobId(job);
  const path = blockedPath(id);
  checkStatus(await ctx.client().postJson(path, HIDE_BODY), 'POST', path);
  await keepHidden(ctx, id, true);
  return { jobId: id, hidden: true };
}

export async function unhideJob(ctx: Ctx, job: string) {
  const id = jobId(job);
  const path = blockedPath(id);
  checkStatus(await ctx.client().delete(path), 'DELETE', path);
  await keepHidden(ctx, id, false);
  return { jobId: id, hidden: false };
}

// Returns a page of the saved jobs. A page has at most 10 jobs.
export async function listFavoriteJobs(ctx: Ctx, opts: { offset?: number } = {}) {
  const query = opts.offset ? `?offset=${opts.offset}` : '';
  return parseJobsPage(await ctx.client().getJson<ApiJobsPage>(`${FAVORITES_PATH}${query}`));
}
