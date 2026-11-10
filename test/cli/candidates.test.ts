import { afterEach, describe, expect, test } from 'vitest';
import { Ctx } from '../../src/context.ts';
import { getCandidate } from '../../src/core/candidates.ts';
import { parseCandidateList } from '../../src/parsers/candidates.ts';
import { fixture, loggedInStore, startFakeDjinni, tempStore, type FakeDjinni, type Route } from '../helpers.ts';
import { cli } from './helpers.ts';

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

async function run(argv: string[], routes: Record<string, Route>, store = loggedInStore()) {
  djinni = await startFakeDjinni({ 'GET /my/profile/': fixture('my_profile.html'), ...routes });
  return cli(argv, { store, baseUrl: djinni.url, minIntervalMs: 0 });
}

const dataRequests = () => djinni.requests.filter(r => r.url !== '/my/profile/');
const list = { 'GET /developers/': fixture('developers_list.html') };
const profile = { 'GET /q/a49535fea6/': fixture('candidate_profile.html') };

describe('djinni candidates search', () => {
  test('prints one line per candidate with the hash, title, salary, experience and URL', async () => {
    const res = await run(['candidates', 'search', '--keywords', 'python'], list);

    expect(res.code).toBe(0);
    const lines = res.out.trimEnd().split('\n');
    expect(lines[0]).toBe('Page 1. The search has 1k+ candidates.');
    expect(lines[1]).toBe('a49535fea6  C++ Engineer | $3500 NET | Більше 10 років досвіду | https://djinni.co/q/a49535fea6/');
    expect(lines[5]).toBe('48dd314f3e  Security Analyst (Pentest / SOC) | $800 NET | 6 місяців | https://djinni.co/q/48dd314f3e/');
    expect(lines).toHaveLength(12);
    expect(lines[11]).toBe('More candidates: add --page 2.');
  });

  test('sends every filter flag to djinni', async () => {
    const res = await run(
      [
        'candidates', 'search',
        '--keywords', 'python django', '--keywords-options', 'skills_only',
        '--title', 'Python,Golang', '--region', 'UKR', '--location', 'lviv',
        '--knows-ukrainian', 'false', '--exp-from', '2.5', '--exp-to', '5', '--salary-min', '1500', '--salary-max', '3000',
        '--english-level', 'upper', '--language', 'deu', '--language-level', 'B2', '--employment', 'fulltime', '--format', 'remote',
        '--domain', 'fintech,saas', '--domain-exclude', 'gambling', '--certifications', '76', '--sortby', 'salary_max', '--page', '3',
      ],
      list,
    );

    expect(res.code).toBe(0);
    expect(dataRequests().map(r => r.url)).toEqual([
      '/developers/?keywords=python+django&keywords_options=skills_only&title=Python%2CGolang&region=UKR&location=lviv' +
        '&knows_ukrainian=False&exp_from=2.5&exp_to=5&salary_min=1500&salary_max=3000&english_level=upper&language=deu&language_level=B2' +
        '&employment=fulltime&format=remote&domain=fintech&domain=saas&domain_exclude=gambling&certifications=76&sortby=salary_max&page=3',
    ]);
  });

  test('--json prints the core result', async () => {
    const res = await run(['candidates', 'search', '--json'], list);

    expect(JSON.parse(res.out)).toEqual(parseCandidateList(fixture('developers_list.html')));
  });

  test.each([[['--english-level', 'B2']], [['--page', '0']], [['--exp-from', '1.3']], [['--domain', 'banking']]])(
    '%j exits with 2 and sends no request',
    async flags => {
      const res = await run(['candidates', 'search', ...flags], list);

      expect(res.code).toBe(2);
      expect(res.err).toContain('candidate filter');
      expect(djinni.requests).toHaveLength(0);
    },
  );

  test('needs a session', async () => {
    const res = await run(['candidates', 'search'], list, tempStore());

    expect(res.code).toBe(1);
    expect(res.err).toBe('No djinni session. Run in a separate terminal window: npx djinni-mcp login\n');
    expect(djinni.requests).toHaveLength(0);
  });
});

describe('djinni candidates get', () => {
  test('prints the head, the facts, the skills and the work experience', async () => {
    const res = await run(['candidates', 'get', 'https://djinni.co/q/a49535fea6/'], profile);

    expect(res.code).toBe(0);
    const lines = res.out.split('\n');
    expect(lines[0]).toBe('C++ Engineer');
    expect(lines[1]).toBe('a49535fea6 | $3500 / місяць NET | https://djinni.co/q/a49535fea6/');
    expect(res.out).toContain('Category: CPP\n');
    expect(res.out).toContain('Experience: Більше 10 років досвіду\n');
    expect(res.out).toContain('Employment: Повний день, Part-time\n');
    expect(res.out).toContain('Work format: Віддалена робота, Гібрид (офіс + віддалено)\n');
    expect(res.out).toContain('Skills: Gitlab CI/CD (5 років), Jira & Confluence (5 років), C/C++ (більше 10 років), Windows API (більше 10 років), Git, STL,');
    expect(res.out).toContain('Languages: Англійська (B2 – Вище середнього), Українська (Носій мови)\n');
    expect(res.out).toContain('Work experience:\nWindows development, backend mostly');
    expect(res.out).not.toMatch(/мобіліз|відстроч/i);
  });

  test('prints all sections of a full profile', async () => {
    const res = await run(['candidates', 'get', '379bb1acdc'], { 'GET /q/379bb1acdc/': fixture('candidate_profile_full.html') });

    expect(res.code).toBe(0);
    expect(res.out).toContain('Domains: Fintech (1 рік), Telecom / Communications (2.5 роки), Advertising / Marketing (2 роки)\n');
    expect(res.out).toContain('Certifications: Machine Learning and Web3 Engineering\n');
    expect(res.out).toContain('Communication language: English\n');
    expect(res.out).toContain('\nAchievements:\n• Lakehouse Architecture & Latency Cut (Fintech):\n');
    expect(res.out).toContain('\nJob expectations:\n• Role: Senior Data Engineer');
  });

  test('--json prints the core result', async () => {
    const res = await run(['candidates', 'get', 'a49535fea6', '--json'], profile);
    const ctx = new Ctx({ store: loggedInStore(), baseUrl: djinni.url, minIntervalMs: 0 });

    expect(JSON.parse(res.out)).toEqual(await getCandidate(ctx, 'a49535fea6'));
  });

  test('a value without a hash exits with 1 and sends no request', async () => {
    const res = await run(['candidates', 'get', 'python'], profile);

    expect(res.code).toBe(1);
    expect(res.err).toContain('has no djinni candidate hash');
    expect(djinni.requests).toHaveLength(0);
  });
});

describe('djinni candidates similar', () => {
  test('prints one line per similar candidate', async () => {
    const res = await run(['candidates', 'similar', 'a49535fea6'], { ...profile, 'GET /similar-candidates/q/952948/': fixture('candidate_similar.html') });

    expect(res.code).toBe(0);
    const lines = res.out.trimEnd().split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('b68a88b49c  Senior Enterprise Data Architect/ Data engineer/ DBA | $4500 | Більше 10 років досвіду | https://djinni.co/q/b68a88b49c/');
    expect(lines[4]).toBe('019734d3e3  Senior Data Engineer | $4000 | 8 років досвіду | https://djinni.co/q/019734d3e3/');
  });

  test('tells when djinni shows no similar candidates', async () => {
    const res = await run(['candidates', 'similar', 'a49535fea6'], { ...profile, 'GET /similar-candidates/q/952948/': '<div></div>' });

    expect(res.out).toBe('djinni shows no similar candidates.\n');
  });
});

describe('terminal control characters in candidate text', () => {
  const hasControl = (text: string) => /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text);

  test('the human output removes them', async () => {
    const html = fixture('developers_list.html').replace('C++ Engineer', 'C++\u001b[2J Engineer\u009b31m');

    const res = await run(['candidates', 'search'], { 'GET /developers/': html });

    expect(hasControl(res.out)).toBe(false);
    expect(res.out).toContain('a49535fea6  C++[2J Engineer31m | ');
  });

  test('the profile text removes them and keeps the line breaks', async () => {
    const html = fixture('candidate_profile.html').replace('hooks and some drivers.<br>', 'hooks and some drivers.\u001b]0;x\u0007<br>');

    const res = await run(['candidates', 'get', 'a49535fea6'], { 'GET /q/a49535fea6/': html });

    expect(hasControl(res.out)).toBe(false);
    expect(res.out).toContain('hooks and some drivers.]0;x\nLast position');
  });
});
