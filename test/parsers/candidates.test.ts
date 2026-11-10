import * as cheerio from 'cheerio';
import { describe, expect, test } from 'vitest';
import { parseCandidate, parseCandidateList, parseSimilarCandidates, similarCandidatesPath } from '../../src/parsers/candidates.ts';
import { fixture } from '../helpers.ts';

const list = () => parseCandidateList(fixture('developers_list.html'));
const profile = () => fixture('candidate_profile.html');

describe('parseCandidateList', () => {
  test('reads the 10 cards of the page in order', () => {
    expect(list().candidates.map(c => c.hash)).toEqual([
      'a49535fea6',
      'af8f7852dc',
      '379bb1acdc',
      '26fdc6fcdd',
      '48dd314f3e',
      '10f888e6bf',
      'ce67826455',
      '8f38bc8e5b',
      'c712f7ed75',
      '8c202ce482',
    ]);
  });

  test('reads the fields of a card', () => {
    const first = list().candidates[0]!;

    expect(first).toEqual({
      hash: 'a49535fea6',
      url: 'https://djinni.co/q/a49535fea6/',
      title: 'C++ Engineer',
      salary: '$3500',
      salaryType: 'NET',
      category: 'CPP',
      experience: 'Більше 10 років досвіду',
      english: 'B2 – Вище середнього',
      location: 'Україна, Житомир',
      format: 'Офіс або віддалено',
      published: 'сьогодні',
      summary:
        'Windows development, backend mostly, from web crawlers to code injection, hooks and some drivers.\n\n' +
        "Last position - team lead at Audials AG responsible for development and deployment of major product's components.",
      skills: [
        { skill: 'Python', years: null },
        { skill: 'Gitlab CI/CD', years: '5р' },
        { skill: 'Jira & Confluence', years: '5р' },
        { skill: 'C/C++', years: '10+р' },
        { skill: 'Git', years: null },
        { skill: 'STL', years: null },
        { skill: 'Multithreading', years: null },
        { skill: 'Boost', years: null },
        { skill: 'REST API', years: null },
        { skill: 'Visual Studio', years: null },
        { skill: 'OOP', years: null },
        { skill: 'SQL початковий рівень', years: null },
        { skill: 'Алгоритми та структури даних', years: null },
        { skill: 'Windows API', years: '10+р' },
      ],
    });
  });

  test('keeps only the first text of the card as the summary', () => {
    const third = list().candidates[2]!;

    expect(third.summary).toBe(
      'Senior Data Engineer with 4+ years architecting lakehouse and real-time data platforms across fintech and telecom, ' +
        'specializing in CDC-based streaming ingestion, medallion data modeling, and dbt-driven data quality and governance frameworks.',
    );
    expect(third).toMatchObject({ category: 'Data Engineer', experience: '4.5 роки досвіду', english: 'C2 – Вільний', location: 'Ефіопія' });
  });

  test('reads short experience and the other salaries', () => {
    const { candidates } = list();

    expect(candidates[4]).toMatchObject({ title: 'Security Analyst (Pentest / SOC)', salary: '$800', experience: '6 місяців', format: 'Офіс або віддалено' });
    expect(candidates.map(c => c.salary)).toEqual(['$3500', '$2500', '$3500', '$2500', '$800', '$2000', '$3500', '$900', '$6500', '$1200']);
  });

  test('reads the page number and the next page flag', () => {
    expect(list()).toMatchObject({ page: 1, hasNextPage: true });
  });

  test('gives the count text but no total when the page shows only a rounded count', () => {
    const page = list();

    expect(page.totalText).toBe('1k+');
    expect(page).not.toHaveProperty('total');
  });

  test('gives the total when the page shows an exact count', () => {
    const html = fixture('developers_list.html').replace('<span id="all_candidates_total" class="nav-dj-tabs__count">1k+</span>', '<span id="all_candidates_total" class="nav-dj-tabs__count">347</span>');

    expect(parseCandidateList(html)).toMatchObject({ total: 347, totalText: '347' });
  });

  test('gives no next page on the last page', () => {
    const $ = cheerio.load(fixture('developers_list.html'));
    $('.pagination li.page-item').last().addClass('disabled').find('a').attr('href', '#');
    $('.pagination li.page-item.active span').text('101');

    expect(parseCandidateList($.html())).toMatchObject({ page: 101, hasNextPage: false });
  });

  test('returns an empty page for a page without cards', () => {
    expect(parseCandidateList('<html><body><h1>Кандидати</h1></body></html>')).toEqual({ candidates: [], page: 1, hasNextPage: false });
  });
});

describe('parseCandidate', () => {
  test('reads the head, the salary and the facts of the profile', () => {
    const detail = parseCandidate(profile());

    expect(detail).toMatchObject({
      hash: 'a49535fea6',
      url: 'https://djinni.co/q/a49535fea6/',
      title: 'C++ Engineer',
      salary: '$3500 / місяць',
      salaryType: 'NET',
      category: 'CPP',
      location: 'Україна, Житомир',
      experience: 'Більше 10 років досвіду',
      english: 'B2 – Вище середнього',
      employment: ['Повний день', 'Part-time'],
      format: 'Віддалена робота, Гібрид (офіс + віддалено)',
      published: '10 листопада 2026',
    });
  });

  test('reads the skills with years and the skills without years', () => {
    expect(parseCandidate(profile()).skills).toEqual([
      { skill: 'Gitlab CI/CD', years: '5 років' },
      { skill: 'Jira & Confluence', years: '5 років' },
      { skill: 'C/C++', years: 'більше 10 років' },
      { skill: 'Windows API', years: 'більше 10 років' },
      { skill: 'Git', years: null },
      { skill: 'STL', years: null },
      { skill: 'Multithreading', years: null },
      { skill: 'Python', years: null },
      { skill: 'Boost', years: null },
      { skill: 'REST API', years: null },
      { skill: 'Visual Studio', years: null },
      { skill: 'OOP', years: null },
      { skill: 'SQL початковий рівень', years: null },
      { skill: 'Алгоритми та структури даних', years: null },
    ]);
  });

  test('reads the languages with levels', () => {
    expect(parseCandidate(profile()).languages).toEqual([
      { language: 'Англійська', level: 'B2 – Вище середнього' },
      { language: 'Українська', level: 'Носій мови' },
    ]);
  });

  test('reads the work experience as plain text with the line break', () => {
    expect(parseCandidate(profile()).workExperience).toBe(
      'Windows development, backend mostly, from web crawlers to code injection, hooks and some drivers.\n' +
        "Last position - team lead at Audials AG responsible for development and deployment of major product's components.",
    );
  });

  test('gives empty values for the sections that the profile does not have', () => {
    expect(parseCandidate(profile())).toMatchObject({
      domains: [],
      certifications: [],
      achievements: null,
      jobExpectations: null,
      communicationLanguage: null,
      otherSections: {},
    });
  });

  test('gives no military status text', () => {
    const detail = parseCandidate(profile());

    expect(fixture('candidate_profile.html')).toContain('Має відстрочку від мобілізації');
    expect(JSON.stringify(detail)).not.toMatch(/мобіліз|відстроч/i);
    expect(detail).not.toHaveProperty('extra');
  });

  test('gives no internal candidate ID', () => {
    expect(JSON.stringify(parseCandidate(profile()))).not.toContain('952948');
  });

  test('reads an unknown section into otherSections by its heading', () => {
    const extra = '<section id="chapter-x" class="mb-5" data-chapter="Інше"><h2 class="fs-3 mb-3">Інше</h2><p>Some<br>\ntext</p></section>';
    const html = profile().replace('<section id="chapter-experience"', `${extra}<section id="chapter-experience"`);

    expect(parseCandidate(html).otherSections).toEqual({ Інше: 'Some\ntext' });
  });
});

describe('parseCandidate on a profile with all sections', () => {
  const full = () => parseCandidate(fixture('candidate_profile_full.html'));

  test('reads the head and the facts', () => {
    expect(full()).toMatchObject({
      hash: '379bb1acdc',
      url: 'https://djinni.co/q/379bb1acdc/',
      title: 'Data Engineer',
      salary: '$3500 / місяць',
      salaryType: 'NET',
      category: 'Data Engineer',
      location: 'Ефіопія, Addis Ababa',
      experience: '4.5 роки досвіду',
      english: 'C2 – Вільний',
      employment: ['Повний день', 'Part-time · $20 за годину', 'Фріланс (разові проекти) · $20 за годину'],
      format: 'Віддалена робота',
      published: '10 листопада 2026',
      otherSections: {},
    });
  });

  test('reads the skills with years, the folded skills and the skills without years', () => {
    const skills = full().skills;

    expect(skills).toHaveLength(21);
    expect(skills.slice(0, 2)).toEqual([
      { skill: 'Python', years: '5 років' },
      { skill: 'SQL початковий рівень', years: '5 років' },
    ]);
    expect(skills[10]).toEqual({ skill: 'Power BI', years: '1 рік' });
    expect(skills.slice(13)).toEqual([
      { skill: 'Google BigQuery', years: '2 роки' },
      { skill: 'Snowflake', years: null },
      { skill: 'Salesforce', years: null },
      { skill: 'Azure', years: null },
      { skill: 'Big Data', years: null },
      { skill: 'ETL', years: null },
      { skill: 'Jira & Confluence', years: null },
      { skill: 'Git', years: null },
    ]);
  });

  test('reads the domains with years', () => {
    expect(full().domains).toEqual([
      { domain: 'Fintech', years: '1 рік' },
      { domain: 'Telecom / Communications', years: '2.5 роки' },
      { domain: 'Advertising / Marketing', years: '2 роки' },
    ]);
  });

  test('reads the languages and the certifications', () => {
    const detail = full();

    expect(detail.languages).toEqual([
      { language: 'Англійська', level: 'C2 – Вільний' },
      { language: 'Амхарська', level: 'Носій мови' },
    ]);
    expect(detail.certifications).toEqual(['Machine Learning and Web3 Engineering']);
  });

  test('reads the work experience, the achievements and the job expectations as plain text', () => {
    const detail = full();

    expect(detail.workExperience).toBe(
      'Senior Data Engineer with 4+ years architecting lakehouse and real-time data platforms across fintech and telecom, ' +
        'specializing in CDC-based streaming ingestion, medallion data modeling, and dbt-driven data quality and governance frameworks.',
    );
    expect(detail.achievements!.startsWith('• Lakehouse Architecture & Latency Cut (Fintech):\nArchitected the migration of a multi-bank data ecosystem')).toBe(true);
    expect(detail.achievements).toContain('first audit-grade data governance standard.\n\n• Real-Time CDC Streaming (Fintech):\nReplaced legacy');
    expect(detail.achievements!.split('\n\n')).toHaveLength(6);
    expect(detail.achievements!.endsWith('lifting downstream reporting accuracy from 40% to 97%.')).toBe(true);
    expect(detail.jobExpectations).toBe(
      [
        '• Role: Senior Data Engineer / Data Platform Engineer / Analytics Engineer',
        '• Work Format: Fully remote (Contract / B2B or Full-Time)',
        '• Team & Culture: Engineering-led teams with high ownership, clear communication, modern engineering standards (CI/CD, code review, automated testing), and an appreciation for data correctness.',
        '• Preferred Tech Ecosystem: Modern Data Stack (Iceberg, Trino, dbt, Spark, Airflow/Dagster), cloud data warehouses (Snowflake, BigQuery, Redshift, ClickHouse), and event-driven/CDC architectures (Kafka, Debezium, streaming ingestion).',
        '• Domain Interests: Fintech, Cloud & SaaS Intelligence, High-throughput Analytics, Big Data, and AI/ML-enabling data platforms.',
      ].join('\n'),
    );
  });

  test('reads the communication language', () => {
    expect(full().communicationLanguage).toBe('English');
  });

  test('gives no internal candidate ID', () => {
    const json = JSON.stringify(full());

    expect(json).not.toContain('675131');
    expect(json).not.toContain('100001');
  });
});

describe('similarCandidatesPath', () => {
  test('reads the path of the similar candidates fragment from the profile page', () => {
    expect(similarCandidatesPath(profile())).toBe('/similar-candidates/q/952948/');
  });

  test.each([['<div></div>'], ['<div hx-get="/similar-candidates/q/../../my/profile/"></div>'], ['<div hx-get="/similar-candidates/q/952948/?x=1"></div>']])(
    'returns null for %j',
    html => {
      expect(similarCandidatesPath(html)).toBeNull();
    },
  );
});

describe('parseSimilarCandidates', () => {
  const similar = () => parseSimilarCandidates(fixture('candidate_similar.html'));

  test('reads the 5 cards of the fragment and strips the query from the links', () => {
    expect(similar().map(c => [c.hash, c.url])).toEqual([
      ['b68a88b49c', 'https://djinni.co/q/b68a88b49c/'],
      ['486bd02f61', 'https://djinni.co/q/486bd02f61/'],
      ['4a70043a44', 'https://djinni.co/q/4a70043a44/'],
      ['c32aeedec2', 'https://djinni.co/q/c32aeedec2/'],
      ['019734d3e3', 'https://djinni.co/q/019734d3e3/'],
    ]);
  });

  test('reads the fields of a card', () => {
    expect(similar()[0]).toEqual({
      hash: 'b68a88b49c',
      url: 'https://djinni.co/q/b68a88b49c/',
      title: 'Senior Enterprise Data Architect/ Data engineer/ DBA',
      salary: '$4500',
      salaryType: null,
      category: 'Data Engineer',
      experience: 'Більше 10 років досвіду',
      english: 'C2 – Вільний',
      location: 'Туреччина',
      format: null,
      published: null,
      summary:
        'Enterprise Data Architect with over 18 years of progressive experience in database administration, high-availability infrastructure design, and multi-cloud...',
      skills: [],
    });
  });

  test('reads the salary, the location and the experience of each card', () => {
    expect(similar().map(c => [c.salary, c.location, c.experience])).toEqual([
      ['$4500', 'Туреччина', 'Більше 10 років досвіду'],
      ['$3500', 'Ефіопія', '6 років досвіду'],
      ['$2500', 'Узбекистан', '4 роки досвіду'],
      ['$4000', 'Кенія', '6 років досвіду'],
      ['$4000', 'Узбекистан', '8 років досвіду'],
    ]);
  });

  test('returns no candidates for a page without cards', () => {
    expect(parseSimilarCandidates('<div></div>')).toEqual([]);
  });
});
