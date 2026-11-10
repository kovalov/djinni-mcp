import * as cheerio from 'cheerio';
import type { Ctx } from '../context.ts';
import { LOGIN_HINT, NotLoggedInError } from '../http.ts';
import { parseCandidateList } from '../parsers/candidates.ts';
import { ACCOUNT_FORM, parseResumePage } from '../parsers/cv.ts';
import { serializeForm } from '../parsers/form.ts';
import { parseInboxList } from '../parsers/inbox.ts';
import { parseWhoami } from '../parsers/me.ts';
import { PROFILE_FORM } from '../parsers/profile.ts';
import { subscriptionsSection } from './subscriptions.ts';

// A live self-check of the djinni pages and the API that the tools use.
// The doctor sends only GET requests, through the rate limiter of the context. It never opens an inbox thread,
// because djinni marks a thread as read when it is opened.

export const DOCTOR_STEPS = ['session', 'jobs_api', 'job_api', 'candidates', 'profile_form', 'account_form', 'resume', 'subscriptions', 'inbox'] as const;
export type DoctorStepName = (typeof DOCTOR_STEPS)[number];
export type DoctorStep = { step: DoctorStepName; ok: boolean; detail: string };
export type DoctorReport = { ok: boolean; steps: DoctorStep[] };

const CHANGED = 'The page format may have changed.';
const NO_SESSION = 'Skipped: no valid djinni session.';
// The list of the uploaded CV files on /my/resume/.
const CV_LIST = '#candidate_cv_files_list';

// A failed check. The doctor shows the message as the detail of the step.
class CheckFailed extends Error {}

function fail(message: string): never {
  throw new CheckFailed(message);
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type ApiPage = { count?: unknown; results?: { id?: unknown }[] };

export async function runDoctor(ctx: Ctx): Promise<DoctorReport> {
  const steps: DoctorStep[] = [];
  const run = async (step: DoctorStepName, check: () => Promise<string>) => {
    try {
      steps.push({ step, ok: true, detail: await check() });
    } catch (e) {
      steps.push({ step, ok: false, detail: errorText(e) });
    }
  };
  const skip = (step: DoctorStepName, detail: string) => steps.push({ step, ok: false, detail });

  let loggedIn = false;
  await run('session', async () => {
    if (!ctx.store.loadSession()) fail(`No djinni session is saved. ${LOGIN_HINT}`);
    // A new request, not the cached check of the context: the session can expire after the check.
    const rejected = `djinni does not accept the saved session. ${LOGIN_HINT}`;
    let html: string;
    try {
      html = await ctx.client().get('/my/profile/');
    } catch (e) {
      if (e instanceof NotLoggedInError) fail(rejected);
      throw e;
    }
    const me = parseWhoami(html);
    if (!me) fail(rejected);
    loggedIn = true;
    return `djinni accepts the saved session (candidate ${me.candidateId}).`;
  });

  // The API steps use the session when the session step accepted it. They do not need a session.
  const apiClient = () => (loggedIn ? ctx.client() : ctx.anonymousClient());

  let firstJobId: string | null = null;
  await run('jobs_api', async () => {
    const client = apiClient();
    const page = await client.getJson<ApiPage>('/api/jobs/?category=python');
    if (typeof page?.count !== 'number' || !Array.isArray(page.results)) {
      fail('The API answer has no count and results fields. The API format may have changed.');
    }
    const id = page.results[0]?.id;
    if (typeof id !== 'number' && typeof id !== 'string') fail('The API answer has no job with an ID.');
    firstJobId = String(id);
    return `The API returned ${page.results.length} jobs of ${page.count}.`;
  });

  if (firstJobId === null) skip('job_api', 'Skipped: the jobs_api step gave no job ID.');
  else {
    const id: string = firstJobId;
    await run('job_api', async () => {
      const client = apiClient();
      const job = await client.getJson<{ id?: unknown; title?: unknown }>(`/api/jobs/${encodeURIComponent(id)}/`);
      if (job?.id === undefined || typeof job.title !== 'string') fail('The job answer has no id and title fields. The API format may have changed.');
      return `The API returned the job ${job.id}.`;
    });
  }

  const pages: [DoctorStepName, () => Promise<string>][] = [
    [
      'candidates',
      async () => {
        const count = parseCandidateList(await ctx.client().get('/developers/?keywords=python')).candidates.length;
        if (count === 0) fail(`The page has no candidate cards. ${CHANGED}`);
        return `The page has ${count} candidate cards.`;
      },
    ],
    [
      'profile_form',
      async () => {
        const fields = serializeForm(await ctx.client().get('/my/profile/'), PROFILE_FORM);
        if (!fields.some(([name]) => name === 'position')) fail(`The profile form has no position field. ${CHANGED}`);
        return 'The profile form has the position field.';
      },
    ],
    [
      'account_form',
      async () => {
        const names = serializeForm(await ctx.client().get('/my/account/'), ACCOUNT_FORM).map(([name]) => name);
        const missing = ['name', 'email'].filter(n => !names.includes(n));
        if (missing.length) fail(`The account form has no ${missing.join(' and ')} field. ${CHANGED}`);
        return 'The account form has the name and email fields.';
      },
    ],
    [
      'resume',
      async () => {
        const html = await ctx.client().get('/my/resume/');
        const page = parseResumePage(html);
        if (page.cvs.length === 0 && cheerio.load(html)(CV_LIST).length === 0) fail(`The page has no CV list. ${CHANGED}`);
        return `The page lists ${page.cvs.length} CV files.`;
      },
    ],
    [
      'subscriptions',
      async () => {
        const section = subscriptionsSection(await ctx.client().get('/my/subscriptions/'));
        if (!section) fail(`The page has no subscriptions section. ${CHANGED}`);
        return section.empty ? 'The subscriptions section shows no subscriptions.' : 'The subscriptions section may list subscriptions. The list format is not verified.';
      },
    ],
    [
      'inbox',
      async () => {
        const html = await ctx.client().get('/my/inbox/');
        if (cheerio.load(html)('#inbox_page').length === 0) fail(`The page has no inbox list. ${CHANGED}`);
        return `The inbox page has ${parseInboxList(html).length} conversations.`;
      },
    ],
  ];
  for (const [step, check] of pages) {
    if (loggedIn) await run(step, check);
    else skip(step, NO_SESSION);
  }

  return { ok: steps.every(s => s.ok), steps };
}
