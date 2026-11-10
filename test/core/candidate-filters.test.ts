import { describe, expect, test } from 'vitest';
import {
  CANDIDATE_DOMAIN_VALUES,
  CANDIDATE_FILTER_DESCRIPTIONS,
  CANDIDATE_LOCATION_VALUES,
  EMPLOYMENT_VALUES,
  ENGLISH_LEVEL_VALUES,
  FORMAT_VALUES,
  KEYWORDS_OPTIONS_VALUES,
  LANGUAGE_LEVEL_VALUES,
  SORTBY_VALUES,
  parseCandidateFilters,
} from '../../src/core/filters.ts';

// The allowed values come from the search form on test/fixtures/developers_list.html.
describe('candidate filter values', () => {
  test('holds the allowed values of the djinni search form', () => {
    expect(KEYWORDS_OPTIONS_VALUES).toEqual(['full_text', 'skills_only', 'skip_skills']);
    expect(ENGLISH_LEVEL_VALUES).toEqual(['no_english', 'basic', 'pre', 'intermediate', 'upper', 'fluent', 'proficient', 'native']);
    expect(LANGUAGE_LEVEL_VALUES).toEqual(['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'native']);
    expect(EMPLOYMENT_VALUES).toEqual(['fulltime', 'parttime', 'freelance']);
    expect(FORMAT_VALUES).toEqual(['remote', 'office', 'hybrid']);
    expect(SORTBY_VALUES).toEqual(['date', 'active', 'experience', 'salary_max', 'salary_min']);
    expect(CANDIDATE_LOCATION_VALUES).toHaveLength(22);
    expect(CANDIDATE_LOCATION_VALUES.slice(0, 3)).toEqual(['kyiv', 'vinnytsia', 'dnipro']);
    expect(CANDIDATE_DOMAIN_VALUES).toHaveLength(31);
    expect(CANDIDATE_DOMAIN_VALUES).toContain('fintech');
    expect(CANDIDATE_DOMAIN_VALUES).toContain('sports_fitness');
  });

  test('names the allowed values in the field descriptions', () => {
    const d = CANDIDATE_FILTER_DESCRIPTIONS;
    expect(d.english_level).toContain('Allowed values: no_english, basic, pre, intermediate, upper, fluent, proficient, native.');
    expect(d.keywords_options).toContain('Allowed values: full_text, skills_only, skip_skills.');
    expect(d.sortby).toContain('Allowed values: date, active, experience, salary_max, salary_min.');
    expect(d.location).toContain('kyiv, vinnytsia, dnipro');
    expect(d.domain).toContain('fintech');
    expect(d.page).toContain('1');
  });
});

describe('parseCandidateFilters', () => {
  test('converts text values from a command line to typed filters', () => {
    const filters = parseCandidateFilters({
      keywords: 'python django',
      keywords_options: 'skills_only',
      title: 'Python,Golang',
      region: 'UKR',
      location: 'lviv',
      knows_ukrainian: 'false',
      exp_from: '2.5',
      exp_to: '5',
      salary_min: '1500',
      salary_max: '3000',
      english_level: 'upper',
      language: 'deu',
      language_level: 'B2',
      employment: 'fulltime',
      format: 'remote',
      domain: 'fintech,saas',
      domain_exclude: ['gambling'],
      certifications: '76',
      sortby: 'salary_max',
      page: '3',
    });

    expect(filters).toEqual({
      keywords: 'python django',
      keywords_options: 'skills_only',
      title: ['Python', 'Golang'],
      region: 'UKR',
      location: 'lviv',
      knows_ukrainian: false,
      exp_from: 2.5,
      exp_to: 5,
      salary_min: 1500,
      salary_max: 3000,
      english_level: 'upper',
      language: 'deu',
      language_level: 'B2',
      employment: 'fulltime',
      format: 'remote',
      domain: ['fintech', 'saas'],
      domain_exclude: ['gambling'],
      certifications: ['76'],
      sortby: 'salary_max',
      page: 3,
    });
  });

  test('accepts typed values and leaves out fields without a value', () => {
    expect(parseCandidateFilters({ knows_ukrainian: true, exp_from: 0, salary_min: 0, page: 1, keywords: undefined, title: null })).toEqual({
      knows_ukrainian: true,
      exp_from: 0,
      salary_min: 0,
      page: 1,
    });
  });

  test.each([
    ['english_level', 'B2', 'Allowed values: no_english, basic, pre, intermediate, upper, fluent, proficient, native.'],
    ['keywords_options', 'all', 'Allowed values: full_text, skills_only, skip_skills.'],
    ['location', 'warsaw', 'Allowed values: kyiv, vinnytsia'],
    ['domain', 'banking', 'Allowed values: adult, advertising'],
    ['domain_exclude', 'banking', 'Allowed values: adult, advertising'],
    ['language_level', 'b2', 'Allowed values: A1, A2, B1, B2, C1, C2, native.'],
    ['employment', 'contract', 'Allowed values: fulltime, parttime, freelance.'],
    ['format', 'any', 'Allowed values: remote, office, hybrid.'],
    ['sortby', 'name', 'Allowed values: date, active, experience, salary_max, salary_min.'],
  ])('rejects a bad %s value and names the allowed values', (field, value, allowed) => {
    expect(() => parseCandidateFilters({ [field]: value })).toThrow(`candidate filter "${field}"`);
    expect(() => parseCandidateFilters({ [field]: value })).toThrow(allowed);
  });

  test.each([
    ['exp_from', '11'],
    ['exp_from', '1.3'],
    ['exp_from', '-1'],
    ['exp_to', '12'],
    ['exp_to', 'five'],
    ['salary_min', '-100'],
    ['salary_max', '1.5'],
    ['page', '0'],
    ['page', '2.5'],
    ['page', '1.0'],
    ['salary_min', '1500.0'],
    ['salary_max', '1e3'],
  ])('rejects the number %s=%s', (field, value) => {
    expect(() => parseCandidateFilters({ [field]: value })).toThrow(`candidate filter "${field}"`);
  });

  test('accepts the largest experience values of the form and half years', () => {
    expect(parseCandidateFilters({ exp_from: '10', exp_to: '11' })).toEqual({ exp_from: 10, exp_to: 11 });
    expect(parseCandidateFilters({ exp_from: '0.5', exp_to: '2.0' })).toEqual({ exp_from: 0.5, exp_to: 2 });
  });

  test('rejects more than one value for a filter that takes one value', () => {
    expect(() => parseCandidateFilters({ location: 'kyiv,lviv' })).toThrow('candidate filter "location"');
    expect(() => parseCandidateFilters({ region: 'UKR,POL' })).toThrow('candidate filter "region"');
    expect(() => parseCandidateFilters({ region: ['UKR', 'POL'] })).toThrow('candidate filter "region"');
    expect(() => parseCandidateFilters({ english_level: ['upper', 'fluent'] })).toThrow('candidate filter "english_level"');
  });

  test('rejects a knows_ukrainian value that is not true or false', () => {
    expect(() => parseCandidateFilters({ knows_ukrainian: 'yes' })).toThrow('candidate filter "knows_ukrainian"');
  });

  test('rejects an unknown filter and names the known filters', () => {
    expect(() => parseCandidateFilters({ category: 'python' })).toThrow('"category" is not a candidate filter');
    expect(() => parseCandidateFilters({ category: 'python' })).toThrow('keywords, keywords_options, title');
  });
});
