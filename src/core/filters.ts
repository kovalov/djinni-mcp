import type { JobFilters } from '../parsers/jobs.ts';

export type { JobFilters } from '../parsers/jobs.ts';

// The allowed values of the filters of GET /api/jobs/. The MCP input schema and the CLI use these constants.
export const EXPERIENCE_VALUES = [0, 1, 2, 3, 5] as const;
export const SALARY_VALUES = [1500, 2500, 3500, 4500, 5500] as const;
export const LANGUAGE_VALUES = ['no_eng', 'has_eng', 'pre', 'intermediate', 'upper', 'fluent'] as const;
export const EDITORIAL_VALUES = ['nonhr', 'product', 'intl', 'relocate', 'hired', 'not-agency', 'is_parttime', 'has_public_salary'] as const;

const ANY_OF = 'The filter matches any of the values.';
const allowed = (values: readonly (string | number)[]) => `Allowed values: ${values.join(', ')}.`;

export const FILTER_DESCRIPTIONS = {
  category: `Job category IDs, for example python, javascript, golang, ml_ai. ${ANY_OF}`,
  experience: `Years of experience that the job asks for. ${allowed(EXPERIENCE_VALUES)} ${ANY_OF}`,
  location: `City IDs, for example kyiv, lviv, kharkiv. ${ANY_OF}`,
  language: `English levels. ${allowed(LANGUAGE_VALUES)} ${ANY_OF}`,
  salary: `The minimum monthly salary in USD. ${allowed(SALARY_VALUES)}`,
  editorial: `One special filter. ${allowed(EDITORIAL_VALUES)} For example, product shows only product companies.`,
  company_name: 'The company name, for example sigma software.',
  query: 'The words to search for.',
  full_text: 'Set to true to search for the words in the full job description.',
  domain: 'The business domain, for example fintech, gamedev, miltech, edutech.',
  offset: 'The number of jobs to skip. Use 10 to read the second page, 20 to read the third page.',
} as const satisfies Record<keyof JobFilters, string>;

const FIELDS = Object.keys(FILTER_DESCRIPTIONS) as (keyof JobFilters)[];

type FilterKind = 'job' | 'candidate';

const bad = (kind: FilterKind, field: string, value: unknown, rule: string) =>
  new Error(`The ${kind} filter "${field}" does not accept the value ${JSON.stringify(value)}. ${rule}`);

// The value checks of one filter kind. The error message names the kind, for example "The job filter".
function checks(kind: FilterKind) {
  // Returns the items of a list filter. A text item can hold more than one value, separated by commas.
  function items(field: string, value: unknown): (string | number)[] {
    const list: unknown[] = Array.isArray(value) ? value : [value];
    return list.flatMap((item): (string | number)[] => {
      if (typeof item === 'number') return [item];
      if (typeof item !== 'string') throw bad(kind, field, item, 'Use text.');
      return item
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    });
  }

  function oneOf<T extends string | number>(field: string, value: unknown, values: readonly T[]): T {
    if (typeof value === 'string' || typeof value === 'number') {
      const match = values.find(v => String(v) === String(value).trim());
      if (match !== undefined) return match;
    }
    throw bad(kind, field, value, allowed(values));
  }

  function single(field: string, value: unknown): unknown {
    const list = items(field, value);
    if (list.length !== 1) throw bad(kind, field, value, 'Use one value.');
    return list[0];
  }

  function text(field: string, value: unknown): string {
    if (typeof value !== 'string') throw bad(kind, field, value, 'Use text.');
    return value;
  }

  const textList = (field: string, value: unknown) => items(field, value).map(v => text(field, v));

  function flag(field: string, value: unknown): boolean {
    const result = typeof value === 'string' ? BOOLEAN_TEXT[value.trim().toLowerCase()] : value;
    if (typeof result !== 'boolean') throw bad(kind, field, value, 'Use true or false.');
    return result;
  }

  // Returns a number from a number or a text. A text must match the pattern. "rule" tells the allowed numbers.
  function number(field: string, value: unknown, pattern: RegExp, ok: (n: number) => boolean, rule: string): number {
    const n = typeof value === 'string' && pattern.test(value.trim()) ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n) || !ok(n)) throw bad(kind, field, value, rule);
    return n;
  }

  // Returns a whole number, min or more. A text must have only digits.
  const wholeNumber = (field: string, value: unknown, min: number) =>
    number(field, value, /^\d+$/, n => Number.isInteger(n) && n >= min, `Use a whole number, ${min} or more.`);

  // Returns a number with one optional decimal part, for example 2.5.
  const decimal = (field: string, value: unknown, ok: (n: number) => boolean, rule: string) => number(field, value, /^\d+(\.\d+)?$/, ok, rule);

  return { items, oneOf, single, text, textList, flag, wholeNumber, decimal };
}

const BOOLEAN_TEXT: Record<string, boolean> = { true: true, false: false, '1': true, '0': false };

// Checks raw filter values, for example from command line flags, and returns the typed job filters.
// Throws an error that names the bad field and the allowed values.
// Set allowOffset to false for the filters of a watch. A watch always reads from the newest job.
export function parseJobFilters(raw: Record<string, unknown>, opts: { allowOffset?: boolean } = {}): JobFilters {
  const { items, oneOf, single, text, textList, flag, wholeNumber } = checks('job');
  const filters: JobFilters = {};
  for (const [field, value] of Object.entries(raw)) {
    if (!FIELDS.includes(field as keyof JobFilters)) {
      throw new Error(`"${field}" is not a job filter. Allowed filters: ${FIELDS.join(', ')}.`);
    }
    if (value === undefined || value === null) continue;
    if (field === 'offset' && opts.allowOffset === false) {
      throw new Error(`"offset" is not a watch filter. Allowed filters: ${FIELDS.filter(f => f !== 'offset').join(', ')}.`);
    }
    switch (field as keyof JobFilters) {
      case 'category':
      case 'location': {
        const list = textList(field, value);
        if (list.length) filters[field as 'category' | 'location'] = list;
        break;
      }
      case 'experience': {
        const list = items(field, value).map(v => oneOf(field, v, EXPERIENCE_VALUES));
        if (list.length) filters.experience = list;
        break;
      }
      case 'language': {
        const list = items(field, value).map(v => oneOf(field, v, LANGUAGE_VALUES));
        if (list.length) filters.language = list;
        break;
      }
      case 'salary':
        filters.salary = oneOf(field, single(field, value), SALARY_VALUES);
        break;
      case 'editorial':
        filters.editorial = oneOf(field, single(field, value), EDITORIAL_VALUES);
        break;
      case 'company_name':
      case 'query':
      case 'domain':
        filters[field as 'company_name' | 'query' | 'domain'] = text(field, value);
        break;
      case 'full_text':
        filters.full_text = flag(field, value);
        break;
      case 'offset':
        filters.offset = wholeNumber(field, value, 0);
        break;
    }
  }
  return filters;
}

// The allowed values of the filters of GET /developers/. They come from the search form on that page.
export const KEYWORDS_OPTIONS_VALUES = ['full_text', 'skills_only', 'skip_skills'] as const;
export const ENGLISH_LEVEL_VALUES = ['no_english', 'basic', 'pre', 'intermediate', 'upper', 'fluent', 'proficient', 'native'] as const;
export const LANGUAGE_LEVEL_VALUES = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'native'] as const;
export const EMPLOYMENT_VALUES = ['fulltime', 'parttime', 'freelance'] as const;
export const FORMAT_VALUES = ['remote', 'office', 'hybrid'] as const;
export const SORTBY_VALUES = ['date', 'active', 'experience', 'salary_max', 'salary_min'] as const;
export const CANDIDATE_LOCATION_VALUES = [
  'kyiv', 'vinnytsia', 'dnipro', 'ivano-frankivsk', 'zhytomyr', 'zaporizhzhia', 'lviv', 'mykolaiv', 'odesa', 'kropyvnytskyi', 'lutsk',
  'poltava', 'rivne', 'sumy', 'ternopil', 'kherson', 'kharkiv', 'khmelnytskyi', 'cherkasy', 'chernihiv', 'chernivtsi', 'uzhhorod',
] as const;
export const CANDIDATE_DOMAIN_VALUES = [
  'adult', 'advertising', 'agriculture', 'automotive', 'crypto', 'dating', 'miltech', 'ecommerce', 'edutech', 'energy', 'entertainment',
  'fintech', 'gambling', 'gamedev', 'govtech', 'hardware', 'healthcare', 'hrtech', 'legaltech', 'logistics', 'ml', 'manufacturing', 'media',
  'mobile', 'other', 'proptech', 'saas', 'security', 'sports_fitness', 'telecom', 'travel',
] as const;

// The filters of GET /developers/. An array value can hold more than one value.
export type CandidateFilters = {
  keywords?: string;
  keywords_options?: (typeof KEYWORDS_OPTIONS_VALUES)[number];
  title?: string[];
  region?: string;
  location?: (typeof CANDIDATE_LOCATION_VALUES)[number];
  knows_ukrainian?: boolean;
  exp_from?: number;
  exp_to?: number;
  salary_min?: number;
  salary_max?: number;
  english_level?: (typeof ENGLISH_LEVEL_VALUES)[number];
  language?: string;
  language_level?: (typeof LANGUAGE_LEVEL_VALUES)[number];
  employment?: (typeof EMPLOYMENT_VALUES)[number];
  format?: (typeof FORMAT_VALUES)[number];
  domain?: (typeof CANDIDATE_DOMAIN_VALUES)[number][];
  domain_exclude?: (typeof CANDIDATE_DOMAIN_VALUES)[number][];
  certifications?: string[];
  sortby?: (typeof SORTBY_VALUES)[number];
  page?: number;
};

const EXPERIENCE_STEP = 'Use a number in steps of 0.5';

export const CANDIDATE_FILTER_DESCRIPTIONS = {
  keywords: 'The words to search for, for example python django.',
  keywords_options: `Where to search for the words. If you do not set it, djinni searches in the title and the skills. ${allowed(KEYWORDS_OPTIONS_VALUES)} full_text also searches in the work experience, the achievements and the job expectations.`,
  title: `Category IDs, for example Python, JavaScript, CPP, QA Automation. ${ANY_OF}`,
  region: 'One country code, for example UKR, POL, DEU, or eu for the EU countries.',
  location: `One city in Ukraine. ${allowed(CANDIDATE_LOCATION_VALUES)}`,
  knows_ukrainian: 'Set to true to find only candidates who know Ukrainian. Set to false to find only candidates who do not know Ukrainian.',
  exp_from: `The minimum years of experience. ${EXPERIENCE_STEP}, from 0 to 10.`,
  exp_to: `The maximum years of experience. ${EXPERIENCE_STEP}, from 0 to 11.`,
  salary_min: 'The minimum expected monthly salary in USD.',
  salary_max: 'The maximum expected monthly salary in USD.',
  english_level: `The English level. ${allowed(ENGLISH_LEVEL_VALUES)}`,
  language: 'One more language as a three-letter code, for example ukr, pol, deu.',
  language_level: `The level of the language in the language filter. ${allowed(LANGUAGE_LEVEL_VALUES)}`,
  employment: `The type of employment. ${allowed(EMPLOYMENT_VALUES)}`,
  format: `The work format. ${allowed(FORMAT_VALUES)}`,
  domain: `Business domains of the candidate experience. ${allowed(CANDIDATE_DOMAIN_VALUES)}`,
  domain_exclude: `Business domains to exclude. ${allowed(CANDIDATE_DOMAIN_VALUES)}`,
  certifications: 'Certification IDs from the djinni search form. Use any to find candidates with one or more certifications.',
  sortby: `The sort order. If you do not set it, djinni shows the newest profiles first. ${allowed(SORTBY_VALUES)}`,
  page: 'The page number, from 1. Each page has 10 candidates.',
} as const satisfies Record<keyof CandidateFilters, string>;

const CANDIDATE_FIELDS = Object.keys(CANDIDATE_FILTER_DESCRIPTIONS) as (keyof CandidateFilters)[];

const halfStep = (max: number) => (n: number) => n >= 0 && n <= max && Number.isInteger(n * 2);

// Checks raw filter values, for example from command line flags, and returns the typed candidate filters.
// Throws an error that names the bad field and the allowed values.
export function parseCandidateFilters(raw: Record<string, unknown>): CandidateFilters {
  const { items, oneOf, single, text, textList, flag, wholeNumber, decimal } = checks('candidate');
  const filters: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(raw)) {
    if (!CANDIDATE_FIELDS.includes(field as keyof CandidateFilters)) {
      throw new Error(`"${field}" is not a candidate filter. Allowed filters: ${CANDIDATE_FIELDS.join(', ')}.`);
    }
    if (value === undefined || value === null) continue;
    switch (field as keyof CandidateFilters) {
      case 'keywords':
        filters[field] = text(field, value);
        break;
      case 'region':
      case 'language':
        filters[field] = text(field, single(field, value));
        break;
      case 'title':
      case 'certifications': {
        const list = textList(field, value);
        if (list.length) filters[field] = list;
        break;
      }
      case 'domain':
      case 'domain_exclude': {
        const list = items(field, value).map(v => oneOf(field, v, CANDIDATE_DOMAIN_VALUES));
        if (list.length) filters[field] = list;
        break;
      }
      case 'keywords_options':
        filters[field] = oneOf(field, single(field, value), KEYWORDS_OPTIONS_VALUES);
        break;
      case 'location':
        filters[field] = oneOf(field, single(field, value), CANDIDATE_LOCATION_VALUES);
        break;
      case 'english_level':
        filters[field] = oneOf(field, single(field, value), ENGLISH_LEVEL_VALUES);
        break;
      case 'language_level':
        filters[field] = oneOf(field, single(field, value), LANGUAGE_LEVEL_VALUES);
        break;
      case 'employment':
        filters[field] = oneOf(field, single(field, value), EMPLOYMENT_VALUES);
        break;
      case 'format':
        filters[field] = oneOf(field, single(field, value), FORMAT_VALUES);
        break;
      case 'sortby':
        filters[field] = oneOf(field, single(field, value), SORTBY_VALUES);
        break;
      case 'knows_ukrainian':
        filters[field] = flag(field, value);
        break;
      case 'exp_from':
        filters[field] = decimal(field, value, halfStep(10), `${EXPERIENCE_STEP}, from 0 to 10.`);
        break;
      case 'exp_to':
        filters[field] = decimal(field, value, halfStep(11), `${EXPERIENCE_STEP}, from 0 to 11.`);
        break;
      case 'salary_min':
      case 'salary_max':
        filters[field] = wholeNumber(field, value, 0);
        break;
      case 'page':
        filters[field] = wholeNumber(field, value, 1);
        break;
    }
  }
  return filters as CandidateFilters;
}
