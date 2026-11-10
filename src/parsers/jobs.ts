import * as cheerio from 'cheerio';
import { DJINNI_URL } from '../http.ts';
import { cleanText } from './me.ts';

// The filters of GET /api/jobs/. An array value is a multifilter.
export type JobFilters = {
  category?: string[];
  experience?: number[];
  location?: string[];
  language?: string[];
  salary?: number;
  editorial?: string;
  company_name?: string;
  query?: string;
  full_text?: boolean;
  domain?: string;
  offset?: number;
};

// The job object of the djinni JSON API. Only the keys that this module reads are listed.
export type ApiJob = {
  id: number;
  title: string;
  slug: string;
  company_name: string;
  long_description: string;
  category: { id: string; name: string } | null;
  location: string | null;
  work_format: string | null;
  experience: number | null;
  english: { id: string; name: string } | null;
  domain: string | null;
  published: string | null;
  recruiter: {
    id: number;
    name: string;
    position: string;
    public_url: string;
    employer_website: string;
    employer_about: string;
  } | null;
  dou_link: string;
  is_favorite: boolean;
  has_seen: boolean;
  has_applied: boolean;
  messagethread_url: string;
  views_count: number;
  applications_count: number;
  public_salary_min: number | null;
  public_salary_max: number | null;
  salary_group: number | null;
  can_apply: boolean;
  can_apply_reason: string;
  is_parttime: boolean;
  has_test: boolean;
  requires_cover_letter: boolean;
  is_ukraine_only: boolean;
  skills_experience: { name: string; experience_years: number | null }[];
  extra_keywords: string[];
  languages: { name: string; level: string }[];
};

export type ApiJobsPage = { count: number; offset: number; results: ApiJob[] };

export type JobSummary = {
  id: string;
  url: string;
  title: string;
  company: string;
  category: string | null;
  location: string | null;
  workFormat: string | null;
  experienceYears: number | null;
  english: string | null;
  domain: string | null;
  published: string | null;
  // The public salary range in USD. Null when the company hides the salary.
  salary: { min: number | null; max: number | null } | null;
  // The relative salary level of the job from 1 to 4. Djinni gives it also when the salary is hidden.
  salaryGroup: number | null;
  views: number;
  applications: number;
  isPartTime: boolean;
  isFavorite: boolean;
  hasSeen: boolean;
  hasApplied: boolean;
  canApply: boolean;
  canApplyReason: string | null;
  requiresCoverLetter: boolean;
  // The first part of the description as plain text.
  description: string;
};

export type JobsPage = { count: number; offset: number; hasNextPage: boolean; jobs: JobSummary[] };

// The description field holds the full description text.
export type JobDetail = JobSummary & {
  skills: { name: string; years: number | null }[];
  keywords: string[];
  languages: { language: string; level: string }[];
  aboutCompany: string | null;
  companyWebsite: string | null;
  douLink: string | null;
  recruiter: { id: string; name: string; position: string | null; url: string | null } | null;
  messageThreadUrl: string | null;
  hasTest: boolean;
  isUkraineOnly: boolean;
};

// Builds the query string for GET /api/jobs/. A multifilter becomes one comma-separated value.
export function buildJobsQuery(filters: JobFilters): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(filters) as [string, unknown][]) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) params.append(name, value.join(','));
    } else {
      params.append(name, value === true ? 'on' : String(value));
    }
  }
  return params.toString();
}

// Converts an HTML fragment to plain text. Paragraphs are separated by an empty line. List items start with "- ".
export function htmlToText(html: string): string {
  const $ = cheerio.load(`<div id="html-to-text">${html}</div>`);
  const root = $('#html-to-text');
  root.find('script, style').remove();
  root.find('br').replaceWith('\n');
  root.find('li').each((_, el) => {
    // The whitespace before the first child of an indented item must not move the item text to the next line.
    while (el.firstChild?.type === 'text' && el.firstChild.data.trim() === '') $(el.firstChild).remove();
    $(el).prepend('- ').append('\n');
  });
  root.find('p, div, ul, ol, h1, h2, h3, h4, h5, h6, blockquote').each((_, el) => {
    $(el).append('\n\n');
  });
  return root
    .text()
    .replace(/ /g, ' ')
    .split('\n')
    .map(line => line.replace(/[ \t\r]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const SHORT_DESCRIPTION_LENGTH = 300;

const shorten = (text: string) => {
  const t = cleanText(text);
  return t.length > SHORT_DESCRIPTION_LENGTH ? t.slice(0, SHORT_DESCRIPTION_LENGTH).trimEnd() + '…' : t;
};

// Returns the text without extra whitespace, or null for an empty text.
export const textOrNull = (s: string | null | undefined) => {
  const t = cleanText(s ?? '');
  return t ? t : null;
};

const absolute = (path: string | null | undefined) => (path ? new URL(path, DJINNI_URL).toString() : null);

export const jobPageUrl = (slug: string) => `${DJINNI_URL}/jobs/${slug}/`;

function mapSummary(job: ApiJob, description: string): JobSummary {
  const hasSalary = !!job.public_salary_min || !!job.public_salary_max;
  return {
    id: String(job.id),
    url: jobPageUrl(job.slug),
    title: cleanText(job.title),
    company: job.company_name,
    category: job.category?.name ?? null,
    location: textOrNull(job.location),
    workFormat: textOrNull(job.work_format),
    experienceYears: job.experience ?? null,
    english: job.english?.name ?? null,
    domain: textOrNull(job.domain),
    published: job.published ?? null,
    salary: hasSalary ? { min: job.public_salary_min || null, max: job.public_salary_max || null } : null,
    salaryGroup: job.salary_group ?? null,
    views: job.views_count,
    applications: job.applications_count,
    isPartTime: job.is_parttime,
    isFavorite: job.is_favorite,
    hasSeen: job.has_seen,
    hasApplied: job.has_applied,
    canApply: job.can_apply,
    canApplyReason: textOrNull(job.can_apply_reason),
    requiresCoverLetter: job.requires_cover_letter,
    description,
  };
}

export const mapJobSummary = (job: ApiJob): JobSummary => mapSummary(job, shorten(htmlToText(job.long_description ?? '')));

// Maps a page of GET /api/jobs/ or GET /api/jobs/favorites/.
export function parseJobsPage(data: ApiJobsPage): JobsPage {
  const jobs = data.results.map(mapJobSummary);
  return { count: data.count, offset: data.offset, hasNextPage: data.offset + data.results.length < data.count, jobs };
}

// Maps the job of GET /api/jobs/<id>/.
export function mapJobDetail(job: ApiJob): JobDetail {
  const recruiter = job.recruiter;
  return {
    ...mapSummary(job, htmlToText(job.long_description ?? '')),
    skills: (job.skills_experience ?? []).map(s => ({ name: s.name, years: s.experience_years ?? null })),
    keywords: job.extra_keywords ?? [],
    languages: (job.languages ?? []).map(l => ({ language: l.name, level: l.level })),
    aboutCompany: recruiter?.employer_about ? htmlToText(recruiter.employer_about) : null,
    companyWebsite: textOrNull(recruiter?.employer_website),
    douLink: textOrNull(job.dou_link),
    recruiter: recruiter
      ? { id: String(recruiter.id), name: recruiter.name, position: textOrNull(recruiter.position), url: absolute(recruiter.public_url) }
      : null,
    messageThreadUrl: absolute(textOrNull(job.messagethread_url)),
    hasTest: job.has_test,
    isUkraineOnly: job.is_ukraine_only,
  };
}

export type StatsBucket = { label: string; count: number; percent: number; you: boolean };
export type StatsDistribution = { key: string; title: string; buckets: StatsBucket[] };
export type ApplicantStats = { topSkills: string[]; distributions: StatsDistribution[] };

// Reads the applicant statistics fragment of GET /api/jobs/<id>/?apply_stats.
export function parseApplicantStats(html: string): ApplicantStats {
  const $ = cheerio.load(html);
  const topSkills = $('.badge')
    .toArray()
    .map(el => cleanText($(el).text()))
    .filter(Boolean);
  const distributions: StatsDistribution[] = [];
  $('script').each((_, el) => {
    const code = $(el).text();
    const chart = /chartId\s*=\s*"apply-stats-([\w-]+)"/.exec(code);
    const data = /allData\s*=\s*(\[.*?\]);/s.exec(code);
    if (!chart || !data) return;
    const key = chart[1]!;
    const rows = JSON.parse(data[1]!) as { label: string; count: number; percent: number; is_candidate: boolean }[];
    distributions.push({
      key,
      title: cleanText($(`#apply-stats-${key}`).parent().siblings('.fw-medium').first().text()),
      buckets: rows.map(r => ({ label: r.label, count: r.count, percent: r.percent, you: r.is_candidate })),
    });
  });
  return { topSkills, distributions };
}

export type HiddenJobsPage = { ids: string[]; nextPage: number | null };

// Reads one page of the hidden jobs list on /my/dashboard/hidden/. The page links each job as /jobs/<id>-<slug>/.
// "nextPage" is the lowest page number in the pagination links that is more than the current page.
export function parseHiddenJobsPage(html: string, page: number): HiddenJobsPage {
  const $ = cheerio.load(html);
  const ids = new Set<string>();
  $('a[href]').each((_, el) => {
    const m = /^(?:https:\/\/djinni\.co)?\/jobs\/(\d+)-[^/?#]+\/?(?:[?#].*)?$/.exec($(el).attr('href') ?? '');
    if (m) ids.add(m[1]!);
  });
  const pages = $('.pagination a[href]')
    .toArray()
    .map(el => Number(/[?&]page=(\d+)/.exec($(el).attr('href') ?? '')?.[1]))
    .filter(n => Number.isInteger(n) && n > page);
  return { ids: [...ids], nextPage: pages.length ? Math.min(...pages) : null };
}

export type SimilarJob = {
  id: string;
  url: string;
  title: string;
  company: string;
  // The relative salary level from "$" to "$$$$".
  salaryLevel: string | null;
  description: string;
  published: string | null;
};

// Reads the similar jobs fragment of GET /jobs/<id>/similar-jobs/.
export function parseSimilarJobs(html: string): SimilarJob[] {
  const $ = cheerio.load(html);
  const jobs: SimilarJob[] = [];
  $('a.similar-card').each((_, el) => {
    const card = $(el);
    const m = /\/jobs\/((\d+)-[^/?#]*)/.exec(card.attr('href') ?? '');
    if (!m) return;
    const level = cleanText(card.find('header span.text-body-tertiary').first().text());
    jobs.push({
      id: m[2]!,
      url: jobPageUrl(m[1]!),
      title: cleanText(card.find('.job-item__position').first().text()),
      company: cleanText(card.find('header span.small').first().text()),
      salaryLevel: /^\$+$/.test(level) ? level : null,
      description: cleanText(card.find('[id^="job-description-"]').text()),
      published: textOrNull(card.find('span.small.font-weight-600').not('.similar-card__btn').first().text()),
    });
  });
  return jobs;
}

export type CompanyPage = {
  name: string;
  description: string | null;
  // The labeled facts of the company, for example "Розмір".
  facts: Record<string, string>;
  links: { label: string; url: string }[];
};

// Reads the company description from the company page at /jobs/company-<slug>/.
export function parseCompany(html: string): CompanyPage {
  const $ = cheerio.load(html);
  const about = $('#about_company');
  const facts: Record<string, string> = {};
  const links: { label: string; url: string }[] = [];
  about.find('.company-profile-label').each((_, el) => {
    const label = cleanText($(el).text());
    const box = $(el).parent();
    const link = box.find('a[href^="http"]').first();
    if (link.length) {
      links.push({ label, url: link.attr('href')! });
      return;
    }
    const chips = box.find('.company-chip').toArray().map(c => cleanText($(c).text()));
    const value = chips.length ? chips.join(', ') : cleanText(box.find('.company-profile-value').first().text());
    if (label && value) facts[label] = value;
  });
  return {
    name: cleanText($('h1').first().text()),
    description: htmlToText(about.find('.ck-editor-text').first().html() ?? '') || null,
    facts,
    links,
  };
}
