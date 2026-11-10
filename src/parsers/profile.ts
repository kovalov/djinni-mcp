import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import { serializeForm } from './form.ts';
import { cleanText } from './me.ts';

// The candidate profile is one HTML form on /my/profile/. A POST of this form replaces the whole profile.
export const PROFILE_FORM = '#js-profile-form';

export type Option = { value: string; label: string };
export type SkillRow = { skill: string; years: number | null };
export type LanguageRow = { code: string; level: string };
export type DomainRow = { domain: string; years: number | null };
export type CertificationRow = { name: string; provider: string };

export type MyProfile = {
  position: string;
  category: Option | null;
  salaryMin: number | null;
  salaryHour: number | null;
  // NET or GROSS. Djinni shows this field only for a country other than Ukraine, so it is null when the page has no such field.
  salaryType: string | null;
  // The value of an option in options.experienceYears.
  experienceYears: string | null;
  workExperience: string;
  achievements: string;
  expectations: string;
  skills: SkillRow[];
  languages: LanguageRow[];
  domains: DomainRow[];
  certifications: CertificationRow[];
  country: string | null;
  location: string;
  formats: string[];
  employment: string[];
  domainZones: string[];
  uninterestedCompanyTypes: string[];
  communicationLanguages: string[];
  preferredCommunication: string | null;
  isDefender: boolean;
  hasMobilizationDeferment: boolean;
};

export type ProfileOptions = {
  category: Option[];
  experienceYears: Option[];
  skillYears: Option[];
  languageCodes: Option[];
  languageLevels: Option[];
  country: Option[];
  formats: Option[];
  employment: Option[];
  domainZones: Option[];
  uninterestedCompanyTypes: Option[];
  communicationLanguages: Option[];
  preferredCommunication: Option[];
  salaryType: Option[];
};

export type ProfilePage = MyProfile & { options: ProfileOptions };

// The form field names of each profile key.
export const TEXT_FIELDS = { position: 'position', location: 'location' } as const;
export const TEXTAREA_FIELDS = { workExperience: 'moreinfo', achievements: 'highlights', expectations: 'looking_for' } as const;
export const NUMBER_FIELDS = { salaryMin: 'salary_min', salaryHour: 'salary_hour' } as const;
export const SELECT_FIELDS = { experienceYears: 'experience_years', country: 'country_code', preferredCommunication: 'preferred_comm' } as const;
export const CHECKBOX_FIELDS = { isDefender: 'is_defender', hasMobilizationDeferment: 'has_mobilization_deferment' } as const;
export const GROUP_FIELDS = {
  formats: 'format_options',
  employment: 'employment_options',
  domainZones: 'domain_zones',
  uninterestedCompanyTypes: 'uninterested_company_types',
  communicationLanguages: 'lang_communicate',
} as const;
// The category select is "primary_keyword_cache" on the page. The category widget also keeps the value in a hidden field.
export const CATEGORY_SELECTS = ['primary_keyword', 'primary_keyword_cache'] as const;
export const CATEGORY_HIDDEN = '_tms_primary_keyword';
// The salary type radios have these IDs. Their name comes from the page.
export const SALARY_TYPE_IDS = ['salary_type_net', 'salary_type_gross'] as const;

// A row group is a list of entries with numbered field names, for example skills_experience[0][skill].
// The first column is the main column. A row with an empty main column is an empty row.
// A "years" column holds a number of years.
// For an empty list of domains or certifications, the page has one empty row ("emptyRow"). For skills and languages, it has no row.
export const ROW_FIELDS = {
  skills: { prefix: 'skills_experience', columns: { skill: 'skill', years: 'experience_years' }, emptyRow: false },
  languages: { prefix: 'language_knowledge', columns: { code: 'code', level: 'level' }, emptyRow: false },
  domains: { prefix: 'domain_experience', columns: { domain: 'domain', years: 'experience_years' }, emptyRow: true },
  certifications: { prefix: 'certifications', columns: { name: 'name', provider: 'provider' }, emptyRow: true },
} as const;
export type RowKey = keyof typeof ROW_FIELDS;

const ROW_NAME = /^(\w+)\[(\d+)\]\[(\w+)\]$/;
const fromCrlf = (s: string) => s.replace(/\r\n?/g, '\n');
const numberOrNull = (s: string | undefined) => (s === undefined || s.trim() === '' || !Number.isFinite(Number(s)) ? null : Number(s));

const optionsOf = ($: cheerio.CheerioAPI, select: cheerio.Cheerio<Element>, keepEmpty = false): Option[] =>
  select
    .first()
    .find('option')
    .toArray()
    .map(o => ({ value: o.attribs['value'] ?? cleanText($(o).text()), label: cleanText($(o).text()) }))
    .filter(o => keepEmpty || o.value !== '');

// The options of a group of checkboxes or radios. The label is the text of the label element for the input.
const choicesOf = (form: cheerio.Cheerio<Element>, labels: Map<string, string>, type: string, name: string): Option[] =>
  form
    .find(`input[type="${type}"]`)
    .toArray()
    .filter(el => el.attribs['name'] === name)
    .map(el => ({ value: el.attribs['value'] ?? 'on', label: labels.get(el.attribs['id'] ?? '') ?? '' }));

// Returns the text of each label element of the form by the ID in its "for" attribute.
function labelsOf($: cheerio.CheerioAPI, form: cheerio.Cheerio<Element>): Map<string, string> {
  const labels = new Map<string, string>();
  form.find('label[for]').each((_, el) => {
    const id = el.attribs['for']!;
    if (!labels.has(id)) labels.set(id, cleanText($(el).text()));
  });
  return labels;
}

const byName = (form: cheerio.Cheerio<Element>, tag: string, name: string) => form.find(tag).filter((_, el) => el.attribs['name'] === name);

// Returns the name of the salary type radios, or null when the page has no salary type field.
export function salaryTypeName($: cheerio.CheerioAPI): string | null {
  const form = $(PROFILE_FORM);
  for (const id of SALARY_TYPE_IDS) {
    const name = form.find(`#${id}`).attr('name');
    if (name) return name;
  }
  return null;
}

// Returns the name of the category select on the page.
export function categorySelectName($: cheerio.CheerioAPI): string | null {
  const form = $(PROFILE_FORM);
  return CATEGORY_SELECTS.find(name => byName(form, 'select', name).length > 0) ?? null;
}

// Reads the rows of a row group from the form fields, in the order of the row numbers. Empty rows are left out.
export function readRows(fields: [string, string][], prefix: string): Record<string, string>[] {
  const rows = new Map<string, Record<string, string>>();
  for (const [name, value] of fields) {
    const m = ROW_NAME.exec(name);
    if (!m || m[1] !== prefix) continue;
    const row = rows.get(m[2]!) ?? {};
    row[m[3]!] = value;
    rows.set(m[2]!, row);
  }
  return [...rows.values()];
}

export function parseProfileOptions($: cheerio.CheerioAPI): ProfileOptions {
  const form = $(PROFILE_FORM);
  const category = categorySelectName($);
  const salaryType = salaryTypeName($);
  const labels = labelsOf($, form);
  const rowSelect = (prefix: string, column: string) =>
    form.find('select').filter((_, el) => {
      const m = ROW_NAME.exec(el.attribs['name'] ?? '');
      return !!m && m[1] === prefix && m[3] === column;
    });
  return {
    category: category ? optionsOf($, byName(form, 'select', category)) : [],
    experienceYears: optionsOf($, byName(form, 'select', SELECT_FIELDS.experienceYears)),
    skillYears: optionsOf($, form.find('select.js-skills-chips-years')),
    languageCodes: optionsOf($, rowSelect(ROW_FIELDS.languages.prefix, ROW_FIELDS.languages.columns.code)),
    languageLevels: optionsOf($, rowSelect(ROW_FIELDS.languages.prefix, ROW_FIELDS.languages.columns.level)),
    country: optionsOf($, byName(form, 'select', SELECT_FIELDS.country)),
    formats: choicesOf(form, labels, 'checkbox', GROUP_FIELDS.formats),
    employment: choicesOf(form, labels, 'checkbox', GROUP_FIELDS.employment),
    domainZones: choicesOf(form, labels, 'checkbox', GROUP_FIELDS.domainZones),
    uninterestedCompanyTypes: choicesOf(form, labels, 'checkbox', GROUP_FIELDS.uninterestedCompanyTypes),
    communicationLanguages: choicesOf(form, labels, 'checkbox', GROUP_FIELDS.communicationLanguages),
    // The empty option means "not important", so it is an allowed value.
    preferredCommunication: optionsOf($, byName(form, 'select', SELECT_FIELDS.preferredCommunication), true),
    salaryType: salaryType ? choicesOf(form, labels, 'radio', salaryType) : [],
  };
}

// Reads the structured profile from the fields that a browser submits for the profile form.
export function profileFromFields($: cheerio.CheerioAPI, fields: [string, string][], options: ProfileOptions): MyProfile {
  const first = (name: string) => fields.find(([n]) => n === name)?.[1];
  const all = (name: string) => fields.filter(([n]) => n === name).map(([, v]) => v);
  const category = categorySelectName($);
  const categoryValue = (category && first(category)) || first(CATEGORY_HIDDEN) || '';
  const salaryType = salaryTypeName($);
  const rows = (key: RowKey) => readRows(fields, ROW_FIELDS[key].prefix);
  const skill = ROW_FIELDS.skills.columns;
  const language = ROW_FIELDS.languages.columns;
  const domain = ROW_FIELDS.domains.columns;
  const certification = ROW_FIELDS.certifications.columns;
  return {
    position: first(TEXT_FIELDS.position) ?? '',
    category: categoryValue ? { value: categoryValue, label: options.category.find(o => o.value === categoryValue)?.label ?? categoryValue } : null,
    salaryMin: numberOrNull(first(NUMBER_FIELDS.salaryMin)),
    salaryHour: numberOrNull(first(NUMBER_FIELDS.salaryHour)),
    salaryType: salaryType ? (first(salaryType) ?? null) : null,
    experienceYears: first(SELECT_FIELDS.experienceYears) || null,
    workExperience: fromCrlf(first(TEXTAREA_FIELDS.workExperience) ?? ''),
    achievements: fromCrlf(first(TEXTAREA_FIELDS.achievements) ?? ''),
    expectations: fromCrlf(first(TEXTAREA_FIELDS.expectations) ?? ''),
    skills: rows('skills')
      .filter(r => r[skill.skill])
      .map(r => ({ skill: r[skill.skill]!, years: numberOrNull(r[skill.years]) })),
    languages: rows('languages')
      .filter(r => r[language.code])
      .map(r => ({ code: r[language.code]!, level: r[language.level] ?? '' })),
    domains: rows('domains')
      .filter(r => r[domain.domain])
      .map(r => ({ domain: r[domain.domain]!, years: numberOrNull(r[domain.years]) })),
    certifications: rows('certifications')
      .filter(r => r[certification.name])
      .map(r => ({ name: r[certification.name]!, provider: r[certification.provider] ?? '' })),
    country: first(SELECT_FIELDS.country) || null,
    location: first(TEXT_FIELDS.location) ?? '',
    formats: all(GROUP_FIELDS.formats),
    employment: all(GROUP_FIELDS.employment),
    domainZones: all(GROUP_FIELDS.domainZones),
    uninterestedCompanyTypes: all(GROUP_FIELDS.uninterestedCompanyTypes),
    communicationLanguages: all(GROUP_FIELDS.communicationLanguages),
    preferredCommunication: first(SELECT_FIELDS.preferredCommunication) ?? null,
    isDefender: first(CHECKBOX_FIELDS.isDefender) !== undefined,
    hasMobilizationDeferment: first(CHECKBOX_FIELDS.hasMobilizationDeferment) !== undefined,
  };
}

// Returns the string fields of the profile form, as a browser submits them.
export const profileFields = ($: cheerio.CheerioAPI): [string, string][] =>
  serializeForm($, PROFILE_FORM).filter((f): f is [string, string] => typeof f[1] === 'string');

// Reads the profile and the allowed values from the loaded /my/profile/ page. The page must have the profile form.
export function parseProfilePage($: cheerio.CheerioAPI): ProfilePage {
  const options = parseProfileOptions($);
  return { ...profileFromFields($, profileFields($), options), options };
}
