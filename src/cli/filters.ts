import {
  CANDIDATE_FILTER_DESCRIPTIONS,
  FILTER_DESCRIPTIONS as d,
  parseCandidateFilters,
  parseJobFilters,
  type CandidateFilters,
  type JobFilters,
} from '../core/filters.ts';
import { UsageError, type Flag, type Values } from './command.ts';

const LIST = 'Repeat the flag or separate the values with commas.';
const list = (name: string, value: string, description: string): Flag => ({ name, type: 'string', multiple: true, value, description: `${description} ${LIST}` });
const text = (name: string, value: string, description: string): Flag => ({ name, type: 'string', value, description });

// The job filter flags of "jobs search" and "watch add".
export const FILTER_FLAGS: Flag[] = [
  list('category', 'ids', d.category),
  list('experience', 'n', d.experience),
  list('location', 'ids', d.location),
  list('language', 'levels', d.language),
  text('salary', 'n', d.salary),
  text('editorial', 'value', d.editorial),
  text('company', 'name', d.company_name),
  text('query', 'words', d.query),
  { name: 'full-text', type: 'boolean', description: 'Search for the words in the full job description.' },
  text('domain', 'id', d.domain),
];

export const OFFSET_FLAG: Flag = text('offset', 'n', d.offset);

// Checks the filter flags and returns the job filters. Throws UsageError for a bad value.
export function filtersFromFlags(values: Values, opts: { allowOffset?: boolean } = {}): JobFilters {
  const raw = {
    category: values.category,
    experience: values.experience,
    location: values.location,
    language: values.language,
    salary: values.salary,
    editorial: values.editorial,
    company_name: values.company,
    query: values.query,
    full_text: values['full-text'] === true ? true : undefined,
    domain: values.domain,
    offset: values.offset,
  };
  try {
    return parseJobFilters(raw, opts);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

const c = CANDIDATE_FILTER_DESCRIPTIONS;

// The candidate filter flags of "candidates search". A flag name is the filter name with "-" in place of "_".
export const CANDIDATE_FILTER_FLAGS: Flag[] = [
  text('keywords', 'words', c.keywords),
  text('keywords-options', 'value', c.keywords_options),
  list('title', 'ids', c.title),
  text('region', 'code', c.region),
  text('location', 'id', c.location),
  text('knows-ukrainian', 'bool', `${c.knows_ukrainian} Use true or false.`),
  text('exp-from', 'years', c.exp_from),
  text('exp-to', 'years', c.exp_to),
  text('salary-min', 'usd', c.salary_min),
  text('salary-max', 'usd', c.salary_max),
  text('english-level', 'level', c.english_level),
  text('language', 'code', c.language),
  text('language-level', 'level', c.language_level),
  text('employment', 'value', c.employment),
  text('format', 'value', c.format),
  list('domain', 'ids', c.domain),
  list('domain-exclude', 'ids', c.domain_exclude),
  list('certifications', 'ids', c.certifications),
  text('sortby', 'value', c.sortby),
  text('page', 'n', c.page),
];

// Checks the candidate filter flags and returns the candidate filters. Throws UsageError for a bad value.
export function candidateFiltersFromFlags(values: Values): CandidateFilters {
  const raw = Object.fromEntries(CANDIDATE_FILTER_FLAGS.map(f => [f.name.replace(/-/g, '_'), values[f.name]]));
  try {
    return parseCandidateFilters(raw);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}
