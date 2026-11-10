import { describe, expect, test } from 'vitest';
import {
  buildJobsQuery,
  htmlToText,
  mapJobDetail,
  parseApplicantStats,
  parseCompany,
  parseJobsPage,
  parseSimilarJobs,
  type ApiJob,
} from '../../src/parsers/jobs.ts';
import { fixture } from '../helpers.ts';

const json = (name: string) => JSON.parse(fixture(name));

describe('buildJobsQuery', () => {
  test('joins the values of a multifilter with commas into one parameter', () => {
    expect(buildJobsQuery({ category: ['python', 'golang'], experience: [2, 3] })).toBe('category=python%2Cgolang&experience=2%2C3');
  });

  test('sends full_text as "on" only when it is true', () => {
    expect(buildJobsQuery({ query: 'django', full_text: true })).toBe('query=django&full_text=on');
    expect(buildJobsQuery({ query: 'django', full_text: false })).toBe('query=django');
  });

  test('leaves out empty values', () => {
    expect(buildJobsQuery({ category: [], query: '', domain: undefined, salary: 2500, company_name: 'sigma software' })).toBe(
      'salary=2500&company_name=sigma+software',
    );
  });

  test('returns an empty string when no filter is set', () => {
    expect(buildJobsQuery({})).toBe('');
  });
});

describe('htmlToText', () => {
  test('keeps paragraph breaks, line breaks and list items', () => {
    expect(htmlToText('<p>A&nbsp;b</p><p>&nbsp;</p><p><strong>B:</strong></p><ul><li>x</li><li>y</li></ul><p>C<br>D</p>')).toBe(
      'A b\n\nB:\n\n- x\n- y\n\nC\nD',
    );
  });

  test('keeps the list marker on the line of the item text in indented HTML', () => {
    expect(htmlToText('<ul>\n  <li>\n    <p>Question</p>\n    <div>Answer</div>\n  </li>\n</ul>')).toBe('- Question\n\nAnswer');
  });

  test('keeps the line breaks of plain text', () => {
    expect(htmlToText('First line.\r\n\r\nSecond line.')).toBe('First line.\n\nSecond line.');
  });
});

describe('parseJobsPage', () => {
  const page = parseJobsPage(json('api_jobs_python.json'));

  test('reads the count, the offset and the next page flag', () => {
    expect(page).toMatchObject({ count: 361, offset: 0, hasNextPage: true });
    expect(page.jobs.map(j => j.id)).toEqual(['845296', '856266', '857458', '857443', '849519', '855283', '855073', '857417', '857415', '857408']);
  });

  test('maps the fields of a job', () => {
    const job = page.jobs[0]!;
    expect(job).toMatchObject({
      id: '845296',
      url: 'https://djinni.co/jobs/845296-forward-ai-deployment-engineer-fde/',
      title: 'Forward AI Deployment Engineer (FDE)',
      company: 'Sigma Software',
      category: 'ML / AI',
      location: null,
      workFormat: 'Full Remote',
      experienceYears: 7,
      english: 'B2 – Вище середнього',
      domain: 'other',
      published: '2026-11-10T14:48:15.123570',
      salary: null,
      salaryGroup: 4,
      views: 131,
      applications: 21,
      isPartTime: true,
      isFavorite: false,
      hasSeen: false,
      hasApplied: false,
      canApply: false,
      canApplyReason: 'requirements_mismatch',
      requiresCoverLetter: false,
    });
  });

  test('shortens the description to plain text', () => {
    const description = page.jobs[0]!.description;
    expect(description.startsWith('Are you energized by walking into a client’s operation')).toBe(true);
    expect(description).not.toContain('<p>');
    expect(description).not.toContain('&nbsp;');
    expect(description.length).toBeLessThanOrEqual(301);
    expect(description.endsWith('…')).toBe(true);
  });

  test('reads the public salary range and ignores a zero range', () => {
    const favorites = parseJobsPage(json('api_jobs_favorites.json'));
    expect(favorites).toMatchObject({ count: 15, offset: 0, hasNextPage: true });
    expect(favorites.jobs.find(j => j.id === '853180')?.salary).toEqual({ min: 3000, max: 3500 });
    expect(favorites.jobs.find(j => j.id === '856271')?.salary).toBeNull();
  });

  test('reports no next page on the last page', () => {
    const data = json('api_jobs_favorites.json');
    const last = parseJobsPage({ ...data, offset: 10, results: data.results.slice(0, 5) });
    expect(last).toMatchObject({ count: 15, offset: 10, hasNextPage: false });
  });
});

describe('mapJobDetail', () => {
  const job = mapJobDetail(json('api_job_detail.json'));

  test('maps the summary fields of the job', () => {
    expect(job).toMatchObject({
      id: '857417',
      url: 'https://djinni.co/jobs/857417-software-engineer-c-python/',
      title: 'Software Engineer (C++, Python)',
      company: 'Stellar Jet',
      location: 'Kyiv',
      workFormat: 'Office Work',
      experienceYears: 3,
      english: 'No English',
      domain: 'miltech',
      views: 63,
      applications: 5,
      hasSeen: true,
    });
  });

  test('keeps the paragraph breaks and the list items of the full description', () => {
    expect(job.description.startsWith('Шукаємо розробника для створення та вдосконалення алгоритмів')).toBe(true);
    expect(job.description).toContain(
      "Основні обов'язки:\n\n- Розробка та оптимізація алгоритмів планування маршрутів.\n- Реалізація алгоритмів пошуку шляху",
    );
    expect(job.description.endsWith('зробіть свій внесок у розвиток технологій.')).toBe(true);
  });

  test('maps the skills, the keywords and the languages', () => {
    expect(job.skills).toEqual([
      { name: 'Python', years: null },
      { name: 'C/C++', years: null },
      { name: 'PyTorch', years: null },
      { name: 'Tensorflow', years: null },
      { name: 'GIS', years: null },
    ]);
    expect(job.keywords).toEqual(['Python', 'C/C++', 'PyTorch', 'Tensorflow', 'GIS']);
    expect(job.languages).toEqual([]);
    const sigma = mapJobDetail(json('api_jobs_python.json').results[0] as ApiJob);
    expect(sigma.skills[0]).toEqual({ name: 'Python', years: 7 });
    const razom = mapJobDetail(json('api_jobs_python.json').results[1] as ApiJob);
    expect(razom.languages).toEqual([{ language: 'Ukrainian', level: 'Native' }]);
  });

  test('maps the company text, the company links and the recruiter', () => {
    expect(job.aboutCompany?.startsWith('Stellar Jet — це R&D бюро, що розробляє критично важливі технології')).toBe(true);
    expect(job.aboutCompany).toContain('продовжуємо активну роботу над перспективними розробками.\n\nМи співпрацюємо');
    expect(job).toMatchObject({
      companyWebsite: 'https://www.linkedin.com/company/stellar-jet/?viewAsMember=true',
      douLink: 'https://jobs.dou.ua/companies/stellar-jet/',
      recruiter: {
        id: '206387',
        name: 'Recruiter 206387',
        position: 'Technical Recruiter',
        url: 'https://djinni.co/r/206387-technical-recruiter-at-stellar-jet/',
      },
      hasTest: false,
      isUkraineOnly: false,
    });
  });
});

describe('parseApplicantStats', () => {
  const stats = parseApplicantStats(fixture('job_apply_stats.html'));

  test('reads the top skills of the applicants', () => {
    expect(stats.topSkills).toEqual([
      'OOP',
      'Docker',
      'Git',
      'MySQL',
      'REST API',
      'JavaScript',
      'SQL початковий рівень',
      'Python',
      'Claude Code',
      'PostgreSQL',
      'Redis',
      'Codex',
    ]);
  });

  test('reads every distribution with the bucket of the user', () => {
    expect(stats.distributions).toEqual([
      {
        key: 'experience',
        title: 'Досвід',
        buckets: [
          { label: '< 1 року', count: 0, percent: 0, you: false },
          { label: '1-2 роки', count: 0, percent: 0, you: false },
          { label: '2-3 роки', count: 1, percent: 50, you: false },
          { label: '3-5 років', count: 1, percent: 50, you: false },
          { label: '5-10 років', count: 2, percent: 100, you: true },
          { label: '10+ років', count: 1, percent: 50, you: false },
        ],
      },
      {
        key: 'english',
        title: 'Англійська',
        buckets: [
          { label: 'B2', count: 3, percent: 100, you: true },
          { label: 'C2', count: 2, percent: 67, you: false },
        ],
      },
    ]);
  });

  test('returns empty lists for a fragment without data', () => {
    expect(parseApplicantStats('<h3>Огляд кандидатів</h3>')).toEqual({ topSkills: [], distributions: [] });
  });
});

describe('parseSimilarJobs', () => {
  const jobs = parseSimilarJobs(fixture('job_similar.html'));

  test('reads every card of the fragment', () => {
    expect(jobs.map(j => j.id)).toEqual(['855655', '855113', '853441', '856453', '851764']);
  });

  test('reads the fields of a card', () => {
    expect(jobs[0]).toMatchObject({
      id: '855655',
      url: 'https://djinni.co/jobs/855655-middle-python-developer-in-test-qa-server-aut/',
      title: 'Middle Python Developer in test (QA Server Automation)',
      company: 'Ajax Systems',
      salaryLevel: '$$',
      published: '28 жовтня',
    });
    expect(jobs[0]!.description.startsWith('Ajax Systems — міжнародна технологічна компанія')).toBe(true);
    expect(jobs[2]?.company).toBe('EVERSTAR | Робота в MilTech');
  });
});

describe('parseCompany', () => {
  const company = parseCompany(fixture('company.html'));

  test('reads the name, the description and the facts', () => {
    expect(company.name).toBe('Stellar Jet');
    expect(company.description?.startsWith('Stellar Jet — це R&D бюро, що розробляє критично важливі технології')).toBe(true);
    expect(company.facts).toEqual({
      'Тип компанії': 'Продуктова компанія',
      Розмір: '1000+ співробітників',
      Країни: 'Україна',
      Домени: 'DefTech',
    });
  });

  test('reads the links of the company', () => {
    expect(company.links).toEqual([{ label: 'Веб-сайт', url: 'https://www.linkedin.com/company/stellar-jet/?viewAsMember=true' }]);
  });
});
