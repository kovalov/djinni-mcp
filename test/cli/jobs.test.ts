import { afterEach, describe, expect, test } from 'vitest';
import { mapJobDetail } from '../../src/parsers/jobs.ts';
import { fixture, hiddenJobsPage, loggedInStore, startFakeDjinni, tempStore, type FakeDjinni, type Route } from '../helpers.ts';
import { cli } from './helpers.ts';

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

const jsonRoute = (body: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const apiJobs = () => JSON.parse(fixture('api_jobs_python.json'));
const detail = () => JSON.parse(fixture('api_job_detail.json'));

async function run(argv: string[], routes: Record<string, Route>, store = tempStore()) {
  djinni = await startFakeDjinni({ 'GET /my/profile/': fixture('my_profile.html'), 'GET /my/dashboard/hidden/': hiddenJobsPage([]), ...routes });
  return cli(argv, { store, baseUrl: djinni.url, minIntervalMs: 0 });
}

const apiRequest = () => djinni.requests.find(r => r.url.startsWith('/api/jobs/'))!;

describe('djinni jobs search', () => {
  test('prints one line per job with the ID, title, company, salary, applicants and URL', async () => {
    const data = apiJobs();
    Object.assign(data.results[1], { public_salary_min: 3000, public_salary_max: 4000 });
    Object.assign(data.results[2], { public_salary_min: null, public_salary_max: 2500 });

    const res = await run(['jobs', 'search', '--category', 'python'], { 'GET /api/jobs/': jsonRoute(data) });

    expect(res.code).toBe(0);
    const lines = res.out.trimEnd().split('\n');
    expect(lines[0]).toBe('361 jobs. Jobs 1-10:');
    expect(lines[1]).toMatch(/^845296 {2}Forward AI Deployment Engineer \(FDE\) \| Sigma Software \| salary hidden \| 21 applicants \| https:\/\/djinni\.co\/jobs\/845296-/);
    expect(lines[2]).toContain(' | $3000-4000 | 23 applicants | ');
    expect(lines[3]).toContain(' | up to $2500 | 0 applicants | ');
    expect(lines).toHaveLength(11 + 1);
    expect(lines[11]).toBe('More jobs: add --offset 10.');
  });

  test('prints the number of hidden jobs that the page does not show', async () => {
    const res = await run(
      ['jobs', 'search'],
      { 'GET /api/jobs/': jsonRoute(apiJobs()), 'GET /my/dashboard/hidden/': hiddenJobsPage(['845296', '856266']) },
      loggedInStore(),
    );

    expect(res.code).toBe(0);
    const lines = res.out.trimEnd().split('\n');
    expect(lines[0]).toBe('361 jobs. Jobs 1-8:');
    expect(lines[9]).toBe('2 hidden jobs not shown.');
    expect(lines[10]).toBe('More jobs: add --offset 10.');
  });

  test('sends every filter flag to the djinni API', async () => {
    const res = await run(
      [
        'jobs', 'search',
        '--category', 'python,golang', '--category', 'ml_ai',
        '--experience', '3', '--location', 'kyiv', '--language', 'upper,fluent',
        '--salary', '2500', '--editorial', 'product', '--company', 'Sigma Software',
        '--query', 'rust', '--full-text', '--domain', 'fintech', '--offset', '10',
      ],
      { 'GET /api/jobs/': jsonRoute(apiJobs()) },
    );

    expect(res.code).toBe(0);
    const params = Object.fromEntries(new URL(apiRequest().url, 'http://x').searchParams);
    expect(params).toEqual({
      category: 'python,golang,ml_ai',
      experience: '3',
      location: 'kyiv',
      language: 'upper,fluent',
      salary: '2500',
      editorial: 'product',
      company_name: 'Sigma Software',
      query: 'rust',
      full_text: 'on',
      domain: 'fintech',
      offset: '10',
    });
  });

  test('--json prints the core result', async () => {
    const res = await run(['jobs', 'search', '--json'], { 'GET /api/jobs/': jsonRoute(apiJobs()) });

    const value = JSON.parse(res.out);
    expect(value).toMatchObject({ count: 361, offset: 0, hasNextPage: true });
    expect(value.jobs).toHaveLength(10);
  });

  test('prints the session warning to stderr when the saved session is not valid', async () => {
    const res = await run(
      ['jobs', 'search'],
      { 'GET /api/jobs/': jsonRoute(apiJobs()), 'GET /my/profile/': { status: 302, headers: { location: '/continue/' } } },
      loggedInStore(),
    );

    expect(res.code).toBe(0);
    expect(res.err).toBe(
      'Warning: The saved djinni session is not valid. The results do not show your applications and favorites. Run in a separate terminal window: npx djinni-mcp login.\n',
    );
  });
});

describe('djinni jobs get', () => {
  test('prints the title, company, salary, the main fields and the description', async () => {
    const res = await run(['jobs', 'get', 'https://djinni.co/jobs/857417-software-engineer-c-python/'], { 'GET /api/jobs/857417/': jsonRoute(detail()) });

    expect(res.code).toBe(0);
    const lines = res.out.split('\n');
    expect(lines[0]).toBe('Software Engineer (C++, Python)');
    expect(lines[1]).toBe('Stellar Jet | salary hidden | https://djinni.co/jobs/857417-software-engineer-c-python/');
    expect(res.out).toContain('Category: Python\n');
    expect(res.out).toContain('Location: Kyiv\n');
    expect(res.out).toContain('Experience: 3 years\n');
    expect(res.out).toContain('English: No English\n');
    expect(res.out).toContain('Applicants: 5\n');
    expect(res.out).toContain('Skills: Python, C/C++, PyTorch, Tensorflow, GIS\n');
    expect(res.out).toContain(mapJobDetail(detail()).description);
  });

  test('--json prints the core result', async () => {
    const res = await run(['jobs', 'get', '857417', '--json'], { 'GET /api/jobs/857417/': jsonRoute(detail()) });

    expect(JSON.parse(res.out)).toEqual(mapJobDetail(detail()));
  });
});

describe('djinni jobs stats', () => {
  test('prints the top skills and the distributions with the bucket of the user', async () => {
    const res = await run(['jobs', 'stats', '857417'], { 'GET /api/jobs/857417/': fixture('job_apply_stats.html') }, loggedInStore());

    expect(res.code).toBe(0);
    expect(res.out).toMatch(/^Top skills: OOP, Docker, Git/);
    expect(res.out).toContain('Досвід:\n');
    expect(res.out).toContain('  5-10 років: 2 (100%) <- you\n');
    expect(res.out).toContain('  2-3 роки: 1 (50%)\n');
  });

  test('prints the note for a job that has no applicants', async () => {
    const job = { ...detail(), applications_count: 0 };
    const res = await run(
      ['jobs', 'stats', '857417'],
      { 'GET /api/jobs/857417/?apply_stats&candidate_id=100001': { status: 400 }, 'GET /api/jobs/857417/': jsonRoute(job) },
      loggedInStore(),
    );

    expect(res.code).toBe(0);
    expect(res.out).toBe('This job has no applicants yet, so djinni shows no statistics.\n');
  });

  test('needs a session', async () => {
    const res = await run(['jobs', 'stats', '857417'], {});

    expect(res.code).toBe(1);
    expect(res.err).toBe('No djinni session. Run in a separate terminal window: npx djinni-mcp login\n');
  });
});

describe('djinni jobs similar', () => {
  test('prints one line per similar job', async () => {
    const res = await run(['jobs', 'similar', '857417'], { 'GET /jobs/857417/similar-jobs/': fixture('job_similar.html') });

    expect(res.code).toBe(0);
    const lines = res.out.trimEnd().split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe(
      '855655  Middle Python Developer in test (QA Server Automation) | Ajax Systems | $$ | https://djinni.co/jobs/855655-middle-python-developer-in-test-qa-server-aut/',
    );
  });
});

describe('djinni company', () => {
  test('prints the company, its facts and its open jobs', async () => {
    const res = await run(['company', 'stellar-jet'], {
      'GET /jobs/company-stellar-jet/': fixture('company.html'),
      'GET /api/jobs/': jsonRoute(apiJobs()),
    });

    expect(res.code).toBe(0);
    const lines = res.out.split('\n');
    expect(lines[0]).toBe('Stellar Jet');
    expect(lines[1]).toBe('https://djinni.co/jobs/company-stellar-jet/');
    expect(res.out).toContain('Розмір: 1000+ співробітників\n');
    expect(res.out).toContain('Веб-сайт: https://www.linkedin.com/company/stellar-jet/?viewAsMember=true\n');
    expect(res.out).toContain('Stellar Jet — це R&D бюро');
    expect(res.out).toMatch(/^Open jobs:$/m);
    expect(res.out).toMatch(/^857417 {2}Software Engineer \(C\+\+, Python\) \| Stellar Jet \| /m);
    expect(res.out).toContain('More jobs: npx djinni-mcp jobs search --company "Stellar Jet"');
  });
});

describe('terminal control characters in server text', () => {
  // ESC [2J clears the screen. U+009B is the one-character CSI.
  const evil = 'Evil\u001b[2J Job\u009b31m\u0007';
  const hasControl = (text: string) => /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text);

  test('the human output removes them and keeps the line breaks', async () => {
    const data = apiJobs();
    data.results[0].title = evil;
    data.results[0].company_name = 'Bad\u001b]0;title\u0007 Co';

    const res = await run(['jobs', 'search'], { 'GET /api/jobs/': jsonRoute(data) });

    expect(hasControl(res.out)).toBe(false);
    expect(res.out).toContain('Evil[2J Job31m | Bad]0;title Co | ');
    expect(res.out.split('\n').length).toBeGreaterThan(10);
  });

  test('the job text removes them from the description and keeps the paragraphs', async () => {
    const job = detail();
    job.title = evil;
    job.long_description = '<p>First\u001b[2J</p><p>Second\u009b</p>';

    const res = await run(['jobs', 'get', '857417'], { 'GET /api/jobs/857417/': jsonRoute(job) });

    expect(hasControl(res.out)).toBe(false);
    expect(res.out).toContain('First[2J\n\nSecond');
  });

  test('the JSON output escapes them and keeps the values', async () => {
    const job = detail();
    job.title = evil;

    const res = await run(['jobs', 'get', '857417', '--json'], { 'GET /api/jobs/857417/': jsonRoute(job) });

    expect(hasControl(res.out)).toBe(false);
    expect(JSON.parse(res.out).title).toBe(evil);
  });

  test('an error message removes them', async () => {
    const res = await run(['jobs', 'get', '857417'], { 'GET /api/jobs/857417/': { status: 500, body: 'x' } });
    expect(res.code).toBe(1);
    const evilRes = await cli(['jobs', 'get', 'bad\u001b[2Jid'], { store: tempStore() });

    expect(evilRes.code).toBe(1);
    expect(hasControl(evilRes.err.trimEnd())).toBe(false);
    expect(evilRes.err).toContain('bad[2Jid');
  });
});
