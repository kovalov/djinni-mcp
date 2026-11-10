import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DJINNI_URL } from '../http.ts';
import { htmlToText, textOrNull } from './jobs.ts';
import { cleanText } from './me.ts';

// The candidate profiles on djinni are anonymous. The parsers return only the public hash of a profile, never the internal candidate ID.
// The parsers also drop the profile facts that have no field, because they can hold the military status of the candidate.

export type CandidateSkill = { skill: string; years: string | null };

export type CandidateSummary = {
  hash: string;
  url: string;
  title: string;
  // The salary text, for example "$3500". Null when the card shows no salary.
  salary: string | null;
  // The salary type badge, for example "NET".
  salaryType: string | null;
  // The category ID of the candidate, for example "CPP". It is a value of the title filter of search_candidates.
  category: string | null;
  experience: string | null;
  english: string | null;
  location: string | null;
  format: string | null;
  // The published date text, for example "сьогодні".
  published: string | null;
  // The first text of the card as plain text.
  summary: string;
  // The skills of the card. The years text is set when the card shows it, for example "5р".
  skills: CandidateSkill[];
};

export type CandidateList = { candidates: CandidateSummary[]; page: number; hasNextPage: boolean; total?: number; totalText?: string };

// The profile has the full texts, so it has no short summary text.
export type CandidateDetail = Omit<CandidateSummary, 'summary'> & {
  employment: string[];
  languages: { language: string; level: string }[];
  domains: { domain: string; years: string | null }[];
  certifications: string[];
  workExperience: string | null;
  achievements: string | null;
  jobExpectations: string | null;
  communicationLanguage: string | null;
  // The sections of the profile that have no field, as plain text by heading.
  otherSections: Record<string, string>;
};

const HASH_IN_PATH = /\/q\/([0-9a-f]+)\//;

export const candidateUrl = (hash: string) => `${DJINNI_URL}/q/${hash}/`;

// The source line breaks of the profile HTML are not line breaks on the page. Only the tags make line breaks.
const sectionText = (html: string | null) => htmlToText((html ?? '').replace(/\s+/g, ' '));

// Returns the name of the Bootstrap icon of an element, for example "geo-alt".
const iconOf = (el: cheerio.Cheerio<AnyNode>) => el.find('use').first().attr('href')?.split('#')[1] ?? '';

// Returns the text of an element without the elements of the selector.
const textWithout = (el: cheerio.Cheerio<AnyNode>, selector: string) => {
  const copy = el.clone();
  copy.find(selector).remove();
  return cleanText(copy.text());
};

const withoutPrefix = (text: string | null, prefix: string) => (text?.startsWith(prefix) ? text.slice(prefix.length).trim() : text);

function salaryOf(el: cheerio.Cheerio<AnyNode>) {
  return { salary: textOrNull(textWithout(el, '.salary-type-badge')), salaryType: textOrNull(el.find('.salary-type-badge').first().text()) };
}

// Returns the text of each span with an icon, by the icon name. The first span of an icon wins.
function factsOf($: cheerio.CheerioAPI, card: cheerio.Cheerio<AnyNode>): Record<string, string> {
  const facts: Record<string, string> = {};
  card.find('span').each((_, el) => {
    const span = $(el);
    if (span.children('svg').length === 0) return;
    const icon = iconOf(span);
    if (icon && !(icon in facts)) facts[icon] = cleanText(span.text());
  });
  return facts;
}

function parseCard($: cheerio.CheerioAPI, card: cheerio.Cheerio<AnyNode>): CandidateSummary | null {
  const link = card.find('a.profile[href^="/q/"]').first();
  const hash = HASH_IN_PATH.exec(link.attr('href') ?? '')?.[1];
  if (!hash) return null;
  const facts = factsOf($, card);
  const skills = card
    .find('span.d-inline-block.rounded')
    .toArray()
    .map(el => ({ skill: textWithout($(el), 'span'), years: textOrNull($(el).find('span.text-muted').text()) }))
    .filter(s => s.skill);
  return {
    hash,
    url: candidateUrl(hash),
    title: cleanText(link.text()),
    ...salaryOf(card.find('header .text-success').first()),
    category: facts['code-square'] ?? null,
    experience: facts['lightning-charge'] ?? null,
    english: facts['translate'] ?? null,
    location: facts['geo-alt'] ?? null,
    format: facts['laptop'] ?? null,
    published: withoutPrefix(facts['clock'] ?? null, 'Опубліковано'),
    summary: sectionText(card.find('.text-card > div:not(.mt-4)').first().html()),
    skills,
  };
}

function parseCards($: cheerio.CheerioAPI, selector: string): CandidateSummary[] {
  const seen = new Set<string>();
  const result: CandidateSummary[] = [];
  $(selector).each((_, el) => {
    const card = parseCard($, $(el));
    if (!card || seen.has(card.hash)) return;
    seen.add(card.hash);
    result.push(card);
  });
  return result;
}

// Reads a page of the candidate search at GET /developers/.
export function parseCandidateList(html: string): CandidateList {
  const $ = cheerio.load(html);
  const page = Number(cleanText($('.pagination .page-item.active').first().text())) || 1;
  const next = $('.pagination li.page-item')
    .not('.disabled')
    .filter((_, el) => iconOf($(el)) === 'chevron-right' && /[?&]page=\d+/.test($(el).find('a').attr('href') ?? ''));
  const result: CandidateList = { candidates: parseCards($, '.candidate-search-card'), page, hasNextPage: next.length > 0 };
  const count = cleanText($('.nav-dj-tabs .nav-link.active .nav-dj-tabs__count').first().text());
  if (count) {
    if (/^\d[\d ]*$/.test(count)) result.total = Number(count.replace(/ /g, ''));
    result.totalText = count;
  }
  return result;
}

// Reads the similar candidates fragment of GET /similar-candidates/q/<id>/.
// Each card is a link like /q/<hash>/?ref=similar_candidates. The hash and the URL have no query.
export function parseSimilarCandidates(html: string): CandidateSummary[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const result: CandidateSummary[] = [];
  $('a.similar-card[href^="/q/"]').each((_, el) => {
    const card = $(el);
    const hash = HASH_IN_PATH.exec(card.attr('href') ?? '')?.[1];
    if (!hash || seen.has(hash)) return;
    seen.add(hash);
    const facts = factsOf($, card);
    result.push({
      hash,
      url: candidateUrl(hash),
      title: cleanText(card.find('.similar-card__title').first().text()),
      salary: textOrNull(card.find('strong.text-success').first().text()),
      salaryType: null,
      category: facts['code-square'] ?? null,
      experience: facts['lightning-charge'] ?? null,
      english: facts['translate'] ?? null,
      location: facts['geo-alt'] ?? null,
      format: facts['laptop'] ?? null,
      published: null,
      summary: sectionText(card.find('.similar-card__description').first().html()),
      skills: [],
    });
  });
  return result;
}

// Returns the path of the similar candidates fragment from a profile page, for example "/similar-candidates/q/952948/".
// The path holds the internal candidate ID. Use it only for the request.
export function similarCandidatesPath(html: string): string | null {
  const path = cheerio.load(html)('[hx-get^="/similar-candidates/q/"]').first().attr('hx-get') ?? '';
  return /^\/similar-candidates\/q\/\d+\/$/.test(path) ? path : null;
}

type Row = { name: string; value: string | null };

// Returns the rows of a section: the name and value lines, then the items of a comma-separated list.
function rowsOf($: cheerio.CheerioAPI, body: cheerio.Cheerio<AnyNode>): Row[] {
  const lines = body
    .find('.detail-rows__line')
    .toArray()
    .map(el => ({ name: cleanText($(el).find('.detail-rows__name').text()), value: textOrNull($(el).find('.detail-rows__value').text()) }));
  // The comma-separated list is the text that stays without the rows, the fold link ("+ ще 4") and the scripts.
  const rest = textWithout(body, '.detail-rows, a, script')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(name => ({ name, value: null }));
  return [...lines, ...rest].filter(r => r.name);
}

type SectionKey = 'skills' | 'languages' | 'workExperience' | 'achievements' | 'jobExpectations' | 'domains' | 'certifications' | 'communicationLanguage';

// The section IDs of test/fixtures/candidate_profile_full.html.
const SECTION_IDS: Record<string, SectionKey> = {
  'chapter-skills': 'skills',
  'chapter-domain': 'domains',
  'chapter-languages': 'languages',
  'chapter-certifications': 'certifications',
  'chapter-experience': 'workExperience',
  'chapter-highlights': 'achievements',
  'chapter-looking-for': 'jobExpectations',
  'chapter-preferred-language': 'communicationLanguage',
};

// A section with an unknown ID is found by its heading in the djinni UI in Ukrainian.
const SECTION_HEADINGS: [RegExp, SectionKey][] = [
  [/^Досвід навичок/i, 'skills'],
  [/^Володіння мовами/i, 'languages'],
  [/^Досвід роботи/i, 'workExperience'],
  [/^Досягнення/i, 'achievements'],
  [/^Очікування/i, 'jobExpectations'],
  [/домен/i, 'domains'],
  [/сертифікац/i, 'certifications'],
  [/спілкуван/i, 'communicationLanguage'],
];

// Reads a candidate profile at GET /q/<hash>/.
export function parseCandidate(html: string): CandidateDetail {
  const $ = cheerio.load(html);
  const hash = HASH_IN_PATH.exec($('link[rel="canonical"]').attr('href') ?? '')?.[1] ?? '';
  const titleLink = $('.breadcrumb a[href*="title="]').last().attr('href');
  const aside = $('aside').first();

  const detail: CandidateDetail = {
    hash,
    url: candidateUrl(hash),
    title: textWithout($('h1').first(), 'span'),
    ...salaryOf(aside.find('.card-header h3').first()),
    category: titleLink ? new URL(titleLink, DJINNI_URL).searchParams.get('title') : null,
    experience: null,
    english: null,
    location: null,
    format: null,
    published: null,
    skills: [],
    employment: [],
    languages: [],
    domains: [],
    certifications: [],
    workExperience: null,
    achievements: null,
    jobExpectations: null,
    communicationLanguage: null,
    otherSections: {},
  };

  const formats: string[] = [];
  aside.find('.card-body li').each((_, el) => {
    const li = $(el);
    const text = cleanText(li.text());
    switch (iconOf(li)) {
      case 'geo-alt':
        detail.location = text;
        break;
      case 'lightning-charge':
        detail.experience = text;
        break;
      case 'translate':
        detail.english = textOrNull(li.find('.text-nowrap').text()) ?? text;
        break;
      // The other languages are in the languages section.
      case 'chat-text':
        break;
      case 'check-circle':
        detail.employment.push(text);
        break;
      case 'laptop':
        formats.push(text);
        break;
      // A fact without a field can be the military status of the candidate. The parser drops it.
    }
  });
  detail.format = formats.length ? formats.join(', ') : null;
  aside.children('ul').each((_, el) => {
    $(el)
      .children('li')
      .each((_, li) => {
        if (iconOf($(li)) === 'clock') detail.published = withoutPrefix(textOrNull($(li).text()), 'Опубліковано');
      });
  });

  $('section[data-chapter]').each((_, el) => {
    const section = $(el);
    const heading = cleanText(section.find('h2').first().text()) || cleanText(section.attr('data-chapter') ?? '');
    const body = section.clone();
    body.find('h2').first().remove();
    const key = SECTION_IDS[section.attr('id') ?? ''] ?? SECTION_HEADINGS.find(([pattern]) => pattern.test(heading))?.[1];
    switch (key) {
      case 'skills':
        detail.skills = rowsOf($, body).map(r => ({ skill: r.name, years: r.value }));
        break;
      case 'languages':
        detail.languages = rowsOf($, body).map(r => ({ language: r.name, level: r.value ?? '' }));
        break;
      case 'domains':
        detail.domains = rowsOf($, body).map(r => ({ domain: r.name, years: r.value }));
        break;
      case 'certifications':
        detail.certifications = rowsOf($, body).map(r => r.name);
        break;
      case 'communicationLanguage':
        detail.communicationLanguage = textOrNull(body.text());
        break;
      case 'workExperience':
      case 'achievements':
      case 'jobExpectations':
        detail[key] = sectionText(body.html()) || null;
        break;
      default: {
        const text = sectionText(body.html());
        if (heading && text) detail.otherSections[heading] = text;
      }
    }
  });
  return detail;
}
