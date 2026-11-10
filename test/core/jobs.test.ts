import { statSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Ctx } from '../../src/context.ts';
import {
  companySlug,
  getApplicantStats,
  getCompany,
  getJob,
  getSimilarJobs,
  hideJob,
  jobId,
  listFavoriteJobs,
  saveJob,
  searchJobs,
  unhideJob,
  unsaveJob,
} from '../../src/core/jobs.ts';
import { NotLoggedInError } from '../../src/http.ts';
import type { Store } from '../../src/store.ts';
import { fixture, hiddenJobsPage, loggedInStore, startFakeDjinni, tempStore, type FakeDjinni, type Route } from '../helpers.ts';

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

// The clock of the contexts. A test moves it to pass a cache time.
const START = Date.parse('2026-11-10T12:00:00.000Z');
let clock = START;
beforeEach(() => {
  clock = START;
});
const MINUTE = 60_000;

const jsonRoute = (body: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const apiJobs = () => JSON.parse(fixture('api_jobs_python.json'));
const jobDetail = () => jsonRoute(JSON.parse(fixture('api_job_detail.json')));
// A valid session page and an empty list of hidden jobs.
const profile = { 'GET /my/profile/': fixture('my_profile.html'), 'GET /my/dashboard/hidden/': hiddenJobsPage([]) };

// Starts a fake djinni with a valid session page and returns a context for it.
async function setup(routes: Record<string, Route>, store: Store = loggedInStore()) {
  djinni = await startFakeDjinni({ ...profile, ...routes });
  return new Ctx({ store, baseUrl: djinni.url, minIntervalMs: 0, now: () => new Date(clock) });
}

// The requests to djinni without the session check.
const dataRequests = () => djinni.requests.filter(r => r.url !== '/my/profile/' && !r.url.startsWith('/my/dashboard/hidden/'));
const hiddenRequests = () => djinni.requests.filter(r => r.url.startsWith('/my/dashboard/hidden/')).map(r => r.url);

describe('jobId', () => {
  test.each([
    ['857417', '857417'],
    [' 857417 ', '857417'],
    ['https://djinni.co/jobs/857417-software-engineer-c-python/?ref=shared', '857417'],
    ['/jobs/857417-software-engineer-c-python/', '857417'],
    ['/jobs/857417/', '857417'],
  ])('reads the job ID from %s', (input, id) => {
    expect(jobId(input)).toBe(id);
  });

  test.each([['python developer'], ['857417/../my'], ['/jobs/abc-857417/'], ['']])('rejects %j', input => {
    expect(() => jobId(input)).toThrow('has no djinni job ID');
  });
});

describe('companySlug', () => {
  test.each([
    ['stellar-jet', 'stellar-jet'],
    ['Stellar_Jet2', 'Stellar_Jet2'],
    ['https://djinni.co/jobs/company-stellar-jet/', 'stellar-jet'],
    ['https://djinni.co/jobs/company-stellar-jet/?ref=x', 'stellar-jet'],
    ['/jobs/company-stellar-jet/', 'stellar-jet'],
    ['/jobs/company-stellar-jet', 'stellar-jet'],
  ])('reads the slug from %s', (input, slug) => {
    expect(companySlug(input)).toBe(slug);
  });

  test.each([
    ['..'],
    ['%2F'],
    ['stellar jet'],
    ['stellar/jet'],
    ['https://djinni.co/jobs/company-../'],
    ['https://djinni.co/jobs/company-..%2F..%2Fmy%2Fprofile/'],
    ['https://djinni.co/jobs/company-stellar%2Fjet/'],
    ['/jobs/company-stellar jet/'],
    ['/jobs/company-stellar.jet/'],
    ['/jobs/company-/'],
  ])('rejects %j', input => {
    expect(() => companySlug(input)).toThrow(`"${input}" has no djinni company slug. Use a slug like stellar-jet, or a company URL.`);
  });
});

describe('searchJobs', () => {
  test('sends the filters as the API query and returns the page', async () => {
    const ctx = await setup({ 'GET /api/jobs/': jsonRoute(apiJobs()) });

    const page = await searchJobs(ctx, {
      category: ['python', 'golang'],
      experience: [2, 3],
      language: ['upper'],
      query: 'django',
      full_text: true,
      salary: 2500,
      offset: 10,
    });

    const req = dataRequests()[0]!;
    const url = new URL(req.url, djinni.url);
    expect(url.pathname).toBe('/api/jobs/');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      category: 'python,golang',
      experience: '2,3',
      language: 'upper',
      query: 'django',
      full_text: 'on',
      salary: '2500',
      offset: '10',
    });
    expect(req.headers.cookie).toContain('sessionid=SESS');
    expect(page).toMatchObject({ count: 361, offset: 0, hasNextPage: true });
    expect(page.jobs).toHaveLength(10);
    expect(page.jobs[0]).toMatchObject({ id: '845296', company: 'Sigma Software', canApplyReason: 'requirements_mismatch' });
  });

  test('uses no session cookie when no session is saved', async () => {
    const ctx = await setup({ 'GET /api/jobs/': jsonRoute(apiJobs()) }, tempStore());

    await searchJobs(ctx, { category: ['python'] });

    expect(djinni.requests.map(r => r.url)).toEqual(['/api/jobs/?category=python']);
    expect(djinni.requests[0]!.headers.cookie ?? '').not.toContain('sessionid');
  });

  test('gives no warning when no session is saved', async () => {
    const ctx = await setup({ 'GET /api/jobs/': jsonRoute(apiJobs()) }, tempStore());

    expect(await searchJobs(ctx, {})).not.toHaveProperty('warning');
  });

  test('throws an error that names the path when djinni returns an HTML page', async () => {
    const ctx = await setup({ 'GET /api/jobs/': '<html><body>Maintenance</body></html>' });

    await expect(searchJobs(ctx, { category: ['python'] })).rejects.toThrow('djinni returned no JSON for GET /api/jobs/?category=python');
  });
});

const HIDDEN_FAILED = 'The tool could not read your hidden jobs, so the list can show them.';
const MORE_HIDDEN = 'You have more hidden jobs than the tool reads, so the list can show some of them.';

describe('hidden jobs in searchJobs', () => {
  const hidden = (ids: string[], pages: number[] = []) => hiddenJobsPage(ids, pages);
  const search = () => ({ 'GET /api/jobs/': jsonRoute(apiJobs()) });

  test('leaves out the jobs on the hidden jobs page and gives their number', async () => {
    const ctx = await setup({ ...search(), 'GET /my/dashboard/hidden/': hidden(['845296', '857417', '111111']) });

    const page = await searchJobs(ctx, { category: ['python'] });

    expect(page.jobs.map(j => j.id)).toEqual(['856266', '857458', '857443', '849519', '855283', '855073', '857415', '857408']);
    expect(page.hiddenOmitted).toBe(2);
    expect(hiddenRequests()).toEqual(['/my/dashboard/hidden/']);
    expect(djinni.requests.find(r => r.url === '/my/dashboard/hidden/')!.headers.cookie).toContain('sessionid=SESS');
  });

  test('gives no hiddenOmitted field when no job of the page is hidden', async () => {
    const ctx = await setup({ ...search(), 'GET /my/dashboard/hidden/': hidden(['111111']) });

    const page = await searchJobs(ctx, {});

    expect(page.jobs).toHaveLength(10);
    expect(page).not.toHaveProperty('hiddenOmitted');
  });

  test('reads the hidden jobs page once for two searches', async () => {
    const ctx = await setup({ ...search(), 'GET /my/dashboard/hidden/': hidden(['845296']) });

    await searchJobs(ctx, {});
    const second = await searchJobs(ctx, {});

    expect(second.hiddenOmitted).toBe(1);
    expect(hiddenRequests()).toEqual(['/my/dashboard/hidden/']);
  });

  test('reads all pages of the hidden jobs list', async () => {
    const ctx = await setup({
      ...search(),
      'GET /my/dashboard/hidden/': (req: { url: string }) => {
        const n = Number(new URL(req.url, 'https://djinni.co').searchParams.get('page') ?? 1);
        const ids = { 1: ['845296'], 2: ['856266'], 3: ['857458'] }[n] ?? [];
        // Each page links to the pages near it, as the job list does.
        return hidden(ids, [1, 2, 3].filter(p => p !== n));
      },
    });

    const page = await searchJobs(ctx, {});

    expect(hiddenRequests()).toEqual(['/my/dashboard/hidden/', '/my/dashboard/hidden/?page=2', '/my/dashboard/hidden/?page=3']);
    expect(page.hiddenOmitted).toBe(3);
  });

  test('reads at most 10 pages of the hidden jobs list', async () => {
    const ctx = await setup({
      ...search(),
      'GET /my/dashboard/hidden/': (req: { url: string }) => {
        const n = Number(new URL(req.url, 'https://djinni.co').searchParams.get('page') ?? 1);
        return hidden([String(900000 + n)], [n + 1]);
      },
    });

    await searchJobs(ctx, {});

    expect(hiddenRequests()).toHaveLength(10);
    expect(hiddenRequests().at(-1)).toBe('/my/dashboard/hidden/?page=10');
  });

  test('gives a warning when the page limit stops the read of the hidden jobs list', async () => {
    const ctx = await setup({
      ...search(),
      'GET /my/dashboard/hidden/': (req: { url: string }) => {
        const n = Number(new URL(req.url, 'https://djinni.co').searchParams.get('page') ?? 1);
        return hidden([String(900000 + n)], [n + 1]);
      },
    });

    const page = await searchJobs(ctx, {});

    expect(page.warning).toBe(MORE_HIDDEN);
  });

  test('gives no page limit warning when the 10th page is the last page', async () => {
    const ctx = await setup({
      ...search(),
      'GET /my/dashboard/hidden/': (req: { url: string }) => {
        const n = Number(new URL(req.url, 'https://djinni.co').searchParams.get('page') ?? 1);
        return hidden([String(900000 + n)], n < 10 ? [n + 1] : [n - 1]);
      },
    });

    const page = await searchJobs(ctx, {});

    expect(hiddenRequests()).toHaveLength(10);
    expect(page).not.toHaveProperty('warning');
  });

  test('sends no hidden jobs request when no session is saved', async () => {
    const ctx = await setup({ ...search(), 'GET /my/dashboard/hidden/': hidden(['845296']) }, tempStore());

    const page = await searchJobs(ctx, {});

    expect(page.jobs).toHaveLength(10);
    expect(page).not.toHaveProperty('hiddenOmitted');
    expect(hiddenRequests()).toEqual([]);
  });

  test('sends no hidden jobs request when the session is not valid', async () => {
    const ctx = await setup({
      ...search(),
      'GET /my/dashboard/hidden/': hidden(['845296']),
      'GET /my/profile/': { status: 302, headers: { location: '/continue/' } },
    });

    const page = await searchJobs(ctx, {});

    expect(page.jobs).toHaveLength(10);
    expect(hiddenRequests()).toEqual([]);
  });

  test('hideJob and unhideJob change the kept hidden job IDs', async () => {
    const ctx = await setup({
      ...search(),
      'GET /my/dashboard/hidden/': hidden([]),
      'POST /api/jobs/blocked/845296/': { status: 201, ...jsonRoute({}) },
      'DELETE /api/jobs/blocked/845296/': { status: 204 },
    });

    await searchJobs(ctx, {});
    await hideJob(ctx, '845296');
    const afterHide = await searchJobs(ctx, {});
    await unhideJob(ctx, '845296');
    const afterUnhide = await searchJobs(ctx, {});

    expect(afterHide.jobs.map(j => j.id)).not.toContain('845296');
    expect(afterHide.hiddenOmitted).toBe(1);
    expect(afterUnhide.jobs.map(j => j.id)).toContain('845296');
    expect(afterUnhide).not.toHaveProperty('hiddenOmitted');
    expect(hiddenRequests()).toEqual(['/my/dashboard/hidden/']);
  });

  test('a failed hidden jobs request gives all jobs with a warning and is kept for 5 minutes', async () => {
    const ctx = await setup({ ...search(), 'GET /my/dashboard/hidden/': { status: 500, body: 'error' } });

    const failed = await searchJobs(ctx, {});
    djinni.routes.set('GET /my/dashboard/hidden/', hidden(['845296']));
    clock += 4 * MINUTE;
    const kept = await searchJobs(ctx, {});
    clock += 2 * MINUTE;
    const again = await searchJobs(ctx, {});

    expect(failed.jobs).toHaveLength(10);
    expect(failed.warning).toBe(HIDDEN_FAILED);
    expect(failed).not.toHaveProperty('hiddenOmitted');
    expect(kept.warning).toBe(HIDDEN_FAILED);
    expect(again).not.toHaveProperty('warning');
    expect(again.hiddenOmitted).toBe(1);
    expect(hiddenRequests()).toHaveLength(2);
  });

  test('a hidden jobs page that redirects to the login page gives all jobs with a warning', async () => {
    const ctx = await setup({ ...search(), 'GET /my/dashboard/hidden/': { status: 302, headers: { location: '/login?next=/my/dashboard/hidden/' } } });

    const page = await searchJobs(ctx, {});

    expect(page.jobs).toHaveLength(10);
    expect(page.warning).toBe(HIDDEN_FAILED);
  });

  test('reads the hidden jobs page again after 10 minutes', async () => {
    const ctx = await setup({ ...search(), 'GET /my/dashboard/hidden/': hidden(['845296']) });

    const first = await searchJobs(ctx, {});
    // The user shows the job again on the website.
    djinni.routes.set('GET /my/dashboard/hidden/', hidden([]));
    clock += 9 * MINUTE;
    const cached = await searchJobs(ctx, {});
    clock += 2 * MINUTE;
    const fresh = await searchJobs(ctx, {});

    expect(first.hiddenOmitted).toBe(1);
    expect(cached.hiddenOmitted).toBe(1);
    expect(fresh.jobs.map(j => j.id)).toContain('845296');
    expect(fresh).not.toHaveProperty('hiddenOmitted');
    expect(hiddenRequests()).toHaveLength(2);
  });

  test('keeps the hidden job IDs in the data folder for other processes, with mode 0600', async () => {
    const store = loggedInStore();
    const ctx = await setup({ ...search(), 'GET /my/dashboard/hidden/': hidden(['845296']) }, store);
    await searchJobs(ctx, {});

    const other = new Ctx({ store, baseUrl: djinni.url, minIntervalMs: 0, now: () => new Date(clock) });
    const page = await searchJobs(other, {});

    expect(page.hiddenOmitted).toBe(1);
    expect(hiddenRequests()).toHaveLength(1);
    expect(statSync(store.path('hidden-jobs.json')).mode & 0o777).toBe(0o600);
  });

  test('another process reads the hidden jobs page again when the kept IDs are older than 10 minutes', async () => {
    const store = loggedInStore();
    const ctx = await setup({ ...search(), 'GET /my/dashboard/hidden/': hidden(['845296']) }, store);
    await searchJobs(ctx, {});
    djinni.routes.set('GET /my/dashboard/hidden/', hidden([]));
    clock += 11 * MINUTE;

    const other = new Ctx({ store, baseUrl: djinni.url, minIntervalMs: 0, now: () => new Date(clock) });
    const page = await searchJobs(other, {});

    expect(page).not.toHaveProperty('hiddenOmitted');
    expect(hiddenRequests()).toHaveLength(2);
  });

  test('another process does not use the kept IDs of another session', async () => {
    const store = loggedInStore();
    const ctx = await setup({ ...search(), 'GET /my/dashboard/hidden/': hidden(['845296']) }, store);
    await searchJobs(ctx, {});
    store.saveSession({ cookies: [{ name: 'sessionid', value: 'OTHER', domain: '.djinni.co', path: '/' }] });
    djinni.routes.set('GET /my/dashboard/hidden/', hidden([]));

    const other = new Ctx({ store, baseUrl: djinni.url, minIntervalMs: 0, now: () => new Date(clock) });
    const page = await searchJobs(other, {});

    expect(page).not.toHaveProperty('hiddenOmitted');
    expect(hiddenRequests()).toHaveLength(2);
  });

  test('a failed write of the hidden job IDs file does not break the search or hideJob', async () => {
    const store = loggedInStore();
    const writeJson = store.writeJson.bind(store);
    store.writeJson = (name, value, mode) => {
      if (name === 'hidden-jobs.json') throw new Error('EACCES: permission denied');
      writeJson(name, value, mode);
    };
    const ctx = await setup(
      { ...search(), 'GET /my/dashboard/hidden/': hidden(['845296']), 'POST /api/jobs/blocked/856266/': { status: 201, ...jsonRoute({}) } },
      store,
    );

    const first = await searchJobs(ctx, {});
    const second = await searchJobs(ctx, {});
    const hide = await hideJob(ctx, '856266');
    const third = await searchJobs(ctx, {});

    expect(first.hiddenOmitted).toBe(1);
    expect(first).not.toHaveProperty('warning');
    expect(second.hiddenOmitted).toBe(1);
    expect(hide).toEqual({ jobId: '856266', hidden: true });
    expect(third.hiddenOmitted).toBe(2);
    expect(hiddenRequests()).toHaveLength(1);
  });

  test('hideJob and unhideJob in another process change the kept IDs in the data folder', async () => {
    const store = loggedInStore();
    const ctx = await setup(
      {
        ...search(),
        'GET /my/dashboard/hidden/': hidden([]),
        'POST /api/jobs/blocked/856266/': { status: 201, ...jsonRoute({}) },
        'DELETE /api/jobs/blocked/856266/': { status: 204 },
      },
      store,
    );
    await searchJobs(ctx, {});
    const newCtx = () => new Ctx({ store, baseUrl: djinni.url, minIntervalMs: 0, now: () => new Date(clock) });

    await hideJob(newCtx(), '856266');
    const afterHide = await searchJobs(newCtx(), {});
    await unhideJob(newCtx(), '856266');
    const afterUnhide = await searchJobs(newCtx(), {});

    expect(afterHide.jobs.map(j => j.id)).not.toContain('856266');
    expect(afterUnhide.jobs.map(j => j.id)).toContain('856266');
    expect(hiddenRequests()).toHaveLength(1);
  });

  test('reads the hidden jobs page again after a new login', async () => {
    const ctx = await setup({ ...search(), 'GET /my/dashboard/hidden/': hidden(['845296']) });

    await searchJobs(ctx, {});
    ctx.saveLogin({ cookies: [{ name: 'sessionid', value: 'NEW', domain: '.djinni.co', path: '/' }] });
    await searchJobs(ctx, {});

    expect(hiddenRequests()).toEqual(['/my/dashboard/hidden/', '/my/dashboard/hidden/']);
  });
});

describe('getJob', () => {
  test.each([
    ['857417'],
    ['https://djinni.co/jobs/857417-software-engineer-c-python/?ref=shared'],
    ['/jobs/857417-software-engineer-c-python/'],
  ])('reads the job by the numeric ID in %s', async job => {
    const ctx = await setup({ 'GET /api/jobs/857417/': jobDetail() });

    const detail = await getJob(ctx, job);

    expect(dataRequests().map(r => r.url)).toEqual(['/api/jobs/857417/']);
    expect(detail).toMatchObject({ id: '857417', title: 'Software Engineer (C++, Python)', company: 'Stellar Jet' });
    // djinni answers 404 for /jobs/<id>/ without the slug, so the page URL comes from the slug of the API job.
    expect(detail.url).toBe('https://djinni.co/jobs/857417-software-engineer-c-python/');
    expect(detail.skills).toHaveLength(5);
    expect(detail.aboutCompany).toContain('Stellar Jet — це R&D бюро');
  });

  test('builds the API path only from the numeric job ID', async () => {
    const ctx = await setup({ 'GET /api/jobs/857417/': jobDetail() });

    await getJob(ctx, 'https://djinni.co/jobs/857417-x/../../my/profile/');

    expect(dataRequests().map(r => r.url)).toEqual(['/api/jobs/857417/']);
  });

  test('throws for a value without a job ID and sends no request', async () => {
    const ctx = await setup({});

    await expect(getJob(ctx, 'python developer')).rejects.toThrow('python developer');
    expect(djinni.requests).toHaveLength(0);
  });
});

describe('getApplicantStats', () => {
  test('sends the HX-Request header and the candidate ID', async () => {
    const ctx = await setup({ 'GET /api/jobs/857417/': fixture('job_apply_stats.html') });

    const stats = await getApplicantStats(ctx, '857417');

    const req = djinni.requests.find(r => r.url.startsWith('/api/jobs/857417/'))!;
    expect(req.url).toBe('/api/jobs/857417/?apply_stats&candidate_id=100001');
    expect(req.headers['hx-request']).toBe('true');
    expect(stats.topSkills[0]).toBe('OOP');
    expect(stats.distributions.map(d => d.key)).toEqual(['experience', 'english']);
  });

  // djinni answers HTTP 400 for the statistics of a job that has no applicants.
  const STATS_PATH = 'GET /api/jobs/857417/?apply_stats&candidate_id=100001';
  const jobWithApplicants = (count: number) => {
    const job = JSON.parse(fixture('api_job_detail.json'));
    job.applications_count = count;
    return jsonRoute(job);
  };

  test('returns a note and no statistics for HTTP 400 when the job has no applicants', async () => {
    const ctx = await setup({ [STATS_PATH]: { status: 400, body: 'Bad Request' }, 'GET /api/jobs/857417/': jobWithApplicants(0) });

    const stats = await getApplicantStats(ctx, '857417');

    expect(stats).toEqual({ topSkills: [], distributions: [], note: 'This job has no applicants yet, so djinni shows no statistics.' });
    expect(dataRequests().map(r => r.url)).toEqual(['/api/jobs/857417/?apply_stats&candidate_id=100001', '/api/jobs/857417/']);
  });

  test('throws for HTTP 400 when the job has applicants', async () => {
    const ctx = await setup({ [STATS_PATH]: { status: 400, body: 'Bad Request' }, 'GET /api/jobs/857417/': jobWithApplicants(3) });

    await expect(getApplicantStats(ctx, '857417')).rejects.toThrow('djinni returned HTTP 400 for GET /api/jobs/857417/?apply_stats&candidate_id=100001');
  });

  test('throws the HTTP 400 error when the job JSON read fails after it', async () => {
    const ctx = await setup({ [STATS_PATH]: { status: 400, body: 'Bad Request' }, 'GET /api/jobs/857417/': { status: 404, body: 'no' } });

    await expect(getApplicantStats(ctx, '857417')).rejects.toThrow('djinni returned HTTP 400 for GET /api/jobs/857417/?apply_stats&candidate_id=100001');
  });

  test('throws for HTTP 500 and does not read the job', async () => {
    const ctx = await setup({ [STATS_PATH]: { status: 500, body: 'error' }, 'GET /api/jobs/857417/': jobWithApplicants(0) });

    await expect(getApplicantStats(ctx, '857417')).rejects.toThrow('djinni returned HTTP 500');
    expect(dataRequests()).toHaveLength(1);
  });

  test('throws NotLoggedInError and sends no request when no session is saved', async () => {
    const ctx = await setup({}, tempStore());

    const err = await getApplicantStats(ctx, '857417').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotLoggedInError);
    expect((err as Error).message).toContain('Run in a separate terminal window: npx djinni-mcp login');
    expect(djinni.requests).toHaveLength(0);
  });
});

describe('getSimilarJobs', () => {
  test('reads the similar jobs fragment with the HX-Request header', async () => {
    const ctx = await setup({ 'GET /jobs/857417/similar-jobs/': fixture('job_similar.html') });

    const jobs = await getSimilarJobs(ctx, 'https://djinni.co/jobs/857417-software-engineer-c-python/');

    expect(dataRequests().map(r => r.url)).toEqual(['/jobs/857417/similar-jobs/']);
    expect(dataRequests()[0]!.headers['hx-request']).toBe('true');
    expect(jobs.map(j => j.id)).toEqual(['855655', '855113', '853441', '856453', '851764']);
  });
});

describe('getCompany', () => {
  const companyRoutes = (data = apiJobs()) => ({
    'GET /jobs/company-stellar-jet/': fixture('company.html'),
    'GET /api/jobs/': jsonRoute(data),
  });

  test('reads the description from the company page and the jobs from the API', async () => {
    const ctx = await setup(companyRoutes());

    const company = await getCompany(ctx, 'https://djinni.co/jobs/company-stellar-jet/');

    expect(dataRequests().map(r => r.url)).toEqual(['/jobs/company-stellar-jet/', '/api/jobs/?company_name=Stellar+Jet']);
    expect(company).toMatchObject({
      slug: 'stellar-jet',
      name: 'Stellar Jet',
      url: 'https://djinni.co/jobs/company-stellar-jet/',
      facts: { Розмір: '1000+ співробітників' },
      links: [{ label: 'Веб-сайт', url: 'https://www.linkedin.com/company/stellar-jet/?viewAsMember=true' }],
      hasMoreJobs: true,
    });
    expect(company.description!.startsWith('Stellar Jet — це R&D бюро')).toBe(true);
  });

  test('keeps only the jobs of the company because the API name filter is a partial match', async () => {
    const data = apiJobs();
    data.results[1].company_name = '  stellar JET ';
    const ctx = await setup(companyRoutes(data));

    const company = await getCompany(ctx, 'stellar-jet');

    expect(data.results.map((j: { company_name: string }) => j.company_name)).toContain('Sigma Software');
    expect(company.jobs.map(j => j.id)).toEqual(['856266', '857417', '857415']);
  });

  test('throws when the company page has no company name', async () => {
    const ctx = await setup({ 'GET /jobs/company-stellar-jet/': '<html><body><h1> </h1></body></html>' });

    await expect(getCompany(ctx, 'stellar-jet')).rejects.toThrow('stellar-jet');
    expect(dataRequests().map(r => r.url)).toEqual(['/jobs/company-stellar-jet/']);
  });

  test('sends no request for a company URL with a path in the slug', async () => {
    const ctx = await setup(companyRoutes());

    await expect(getCompany(ctx, 'https://djinni.co/jobs/company-..%2F..%2Fmy%2Fprofile/')).rejects.toThrow('has no djinni company slug');
    expect(djinni.requests).toHaveLength(0);
  });

  test('accepts a bare slug and a path', async () => {
    const ctx = await setup(companyRoutes());

    await getCompany(ctx, 'stellar-jet');
    await getCompany(ctx, '/jobs/company-stellar-jet/');

    expect(djinni.requests.filter(r => r.url === '/jobs/company-stellar-jet/')).toHaveLength(2);
  });
});

describe('session check', () => {
  const WARNING = 'The saved djinni session is not valid. The results do not show your applications and favorites. Run in a separate terminal window: npx djinni-mcp login.';
  const invalidSession = { 'GET /my/profile/': { status: 302, headers: { location: '/continue/' } } };
  const readRoutes = () => ({
    'GET /api/jobs/': jsonRoute(apiJobs()),
    'GET /api/jobs/857417/': jobDetail(),
    'GET /jobs/company-stellar-jet/': fixture('company.html'),
  });
  const profileRequests = () => djinni.requests.filter(r => r.url === '/my/profile/');

  test('a valid session sends exactly one profile request for two operations', async () => {
    const ctx = await setup(readRoutes());

    const page = await searchJobs(ctx, { category: ['python'] });
    const detail = await getJob(ctx, '857417');

    expect(profileRequests()).toHaveLength(1);
    expect(djinni.requests[0]!.url).toBe('/my/profile/');
    for (const r of dataRequests()) expect(r.headers.cookie).toContain('sessionid=SESS');
    expect(page).not.toHaveProperty('warning');
    expect(detail).not.toHaveProperty('warning');
  });

  test('two applicant stats calls send one profile request', async () => {
    const ctx = await setup({ 'GET /api/jobs/857417/': fixture('job_apply_stats.html') });

    await getApplicantStats(ctx, '857417');
    await getApplicantStats(ctx, '857417');

    expect(profileRequests()).toHaveLength(1);
    expect(dataRequests().map(r => r.url)).toEqual([
      '/api/jobs/857417/?apply_stats&candidate_id=100001',
      '/api/jobs/857417/?apply_stats&candidate_id=100001',
    ]);
  });

  test('an invalid session gives the warning and anonymous requests in searchJobs, getJob and getCompany', async () => {
    const ctx = await setup({ ...readRoutes(), ...invalidSession });

    const page = await searchJobs(ctx, { category: ['python'] });
    const detail = await getJob(ctx, '857417');
    const company = await getCompany(ctx, 'stellar-jet');

    expect(page.warning).toBe(WARNING);
    expect(page.jobs).toHaveLength(10);
    expect(detail.warning).toBe(WARNING);
    expect(detail.id).toBe('857417');
    expect(company.warning).toBe(WARNING);
    expect(profileRequests()).toHaveLength(1);
    expect(dataRequests()).toHaveLength(4);
    for (const r of dataRequests()) expect(r.headers.cookie ?? '').not.toContain('sessionid');
  });

  test('an invalid session makes getApplicantStats throw NotLoggedInError', async () => {
    const ctx = await setup({ 'GET /api/jobs/857417/': fixture('job_apply_stats.html'), ...invalidSession });

    await expect(getApplicantStats(ctx, '857417')).rejects.toBeInstanceOf(NotLoggedInError);
    expect(dataRequests()).toHaveLength(0);
  });

  test('a profile page without a candidate ID counts as an invalid session', async () => {
    const ctx = await setup({ ...readRoutes(), 'GET /my/profile/': '<html><body><h1>Djinni</h1></body></html>' });

    const page = await searchJobs(ctx, {});

    expect(page.warning).toBe(WARNING);
    expect(dataRequests()[0]!.headers.cookie ?? '').not.toContain('sessionid');
  });

  test('a failed profile request fails the operation and is not cached', async () => {
    const ctx = await setup({ ...readRoutes(), 'GET /my/profile/': { status: 500, body: 'error' } });

    await expect(searchJobs(ctx, {})).rejects.toThrow('HTTP 500 for GET /my/profile/');
    djinni.routes.set('GET /my/profile/', fixture('my_profile.html'));
    const page = await searchJobs(ctx, {});

    expect(page).not.toHaveProperty('warning');
    expect(profileRequests()).toHaveLength(2);
  });
});

describe('rate limit', () => {
  test('keeps the minimum interval between the profile request and the next anonymous request', async () => {
    djinni = await startFakeDjinni({ 'GET /api/jobs/': jsonRoute(apiJobs()), 'GET /my/profile/': { status: 302, headers: { location: '/continue/' } } });
    const ctx = new Ctx({ store: loggedInStore(), baseUrl: djinni.url, minIntervalMs: 150 });

    const page = await searchJobs(ctx, {});

    expect(page.warning).toBeDefined();
    expect(djinni.requests.map(r => r.url.split('?')[0])).toEqual(['/my/profile/', '/api/jobs/']);
    // The server clock sees the request a few milliseconds after the client sends it, so allow 5 ms of jitter.
    expect(djinni.requests[1]!.at - djinni.requests[0]!.at).toBeGreaterThanOrEqual(145);
  });

  test('sends two concurrent anonymous reads one after the other', async () => {
    djinni = await startFakeDjinni({ 'GET /api/jobs/': { ...jsonRoute(apiJobs()), delayMs: 100 } });
    const ctx = new Ctx({ store: tempStore(), baseUrl: djinni.url, minIntervalMs: 0 });

    await Promise.all([searchJobs(ctx, { category: ['python'] }), searchJobs(ctx, { category: ['golang'] })]);

    const [first, second] = djinni.requests;
    expect(djinni.requests).toHaveLength(2);
    expect(second!.at).toBeGreaterThanOrEqual(first!.respondedAt!);
  });
});

describe('expired session', () => {
  test('checks the session again after a request on the session client gives NotLoggedInError', async () => {
    const ctx = await setup({ 'GET /api/jobs/': jsonRoute(apiJobs()), 'GET /api/jobs/857417/': fixture('job_apply_stats.html') });
    await getApplicantStats(ctx, '857417');

    const expired = { status: 302, headers: { location: '/continue/' } };
    djinni.routes.set('GET /api/jobs/857417/', expired);
    djinni.routes.set('GET /my/profile/', expired);
    await expect(getApplicantStats(ctx, '857417')).rejects.toBeInstanceOf(NotLoggedInError);
    const page = await searchJobs(ctx, {});

    expect(page.warning).toBe('The saved djinni session is not valid. The results do not show your applications and favorites. Run in a separate terminal window: npx djinni-mcp login.');
    expect(djinni.requests.filter(r => r.url === '/my/profile/')).toHaveLength(2);
    expect(djinni.requests.at(-1)!.headers.cookie ?? '').not.toContain('sessionid');
  });
});

describe('favorites and hidden jobs', () => {
  const favorites = () => JSON.parse(fixture('api_jobs_favorites.json'));

  test('saveJob sends the job ID as JSON to the favorites API', async () => {
    const ctx = await setup({ 'POST /api/jobs/favorites/': { status: 201, ...jsonRoute({ job_id: 857417 }) } });

    expect(await saveJob(ctx, 'https://djinni.co/jobs/857417-software-engineer/')).toEqual({ jobId: '857417', saved: true });

    const [req] = dataRequests();
    expect(req!.method).toBe('POST');
    expect(req!.url).toBe('/api/jobs/favorites/');
    expect(req!.headers['x-csrftoken']).toBe('CSRF');
    expect(JSON.parse(req!.body)).toEqual({ job_id: 857417, referral: 'detail' });
  });

  test('unsaveJob sends DELETE for the job', async () => {
    const ctx = await setup({ 'DELETE /api/jobs/favorites/857417/': { status: 204 } });

    expect(await unsaveJob(ctx, '857417')).toEqual({ jobId: '857417', saved: false });
    expect(dataRequests().map(r => `${r.method} ${r.url}`)).toEqual(['DELETE /api/jobs/favorites/857417/']);
  });

  test('hideJob sends POST with an empty JSON body to the blocked jobs API', async () => {
    const ctx = await setup({ 'POST /api/jobs/blocked/857417/': { status: 201, ...jsonRoute({}) } });

    expect(await hideJob(ctx, '857417')).toEqual({ jobId: '857417', hidden: true });
    const [req] = dataRequests();
    expect(`${req!.method} ${req!.url}`).toBe('POST /api/jobs/blocked/857417/');
    expect(JSON.parse(req!.body)).toEqual({});
  });

  test('unhideJob sends DELETE to the blocked jobs API', async () => {
    const ctx = await setup({ 'DELETE /api/jobs/blocked/857417/': { status: 204 } });

    expect(await unhideJob(ctx, '857417')).toEqual({ jobId: '857417', hidden: false });
    expect(dataRequests().map(r => `${r.method} ${r.url}`)).toEqual(['DELETE /api/jobs/blocked/857417/']);
  });

  test('an HTTP error of djinni throws an error with the status, the method and the path', async () => {
    const ctx = await setup({ 'POST /api/jobs/favorites/': { status: 400, ...jsonRoute({ job_id: ['bad'] }) } });

    await expect(saveJob(ctx, '857417')).rejects.toThrow('djinni returned HTTP 400 for POST /api/jobs/favorites/: {"job_id":["bad"]}');
  });

  test('the job operations send no request for a value without a job ID', async () => {
    const ctx = await setup({});

    for (const op of [saveJob, unsaveJob, hideJob, unhideJob]) await expect(op(ctx, '../my')).rejects.toThrow('has no djinni job ID');
    expect(djinni.requests).toEqual([]);
  });

  test('the job operations throw NotLoggedInError when no session is saved', async () => {
    const ctx = await setup({}, tempStore());

    await expect(saveJob(ctx, '857417')).rejects.toBeInstanceOf(NotLoggedInError);
    expect(djinni.requests).toEqual([]);
  });

  test('listFavoriteJobs reads a page of the favorites API with the offset', async () => {
    const ctx = await setup({ 'GET /api/jobs/favorites/': jsonRoute(favorites()) });

    const page = await listFavoriteJobs(ctx, { offset: 10 });

    expect(dataRequests().map(r => r.url)).toEqual(['/api/jobs/favorites/?offset=10']);
    expect(page.count).toBe(15);
    expect(page.jobs).toHaveLength(10);
    expect(page.hasNextPage).toBe(true);
    expect(page.jobs[0]!.id).toBe(String(favorites().results[0].id));
  });

  test('listFavoriteJobs reads the first page without an offset', async () => {
    const ctx = await setup({ 'GET /api/jobs/favorites/': jsonRoute(favorites()) });

    await listFavoriteJobs(ctx);

    expect(dataRequests().map(r => r.url)).toEqual(['/api/jobs/favorites/']);
  });
});
