import { isDeepStrictEqual } from 'node:util';
import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import {
  CATEGORY_HIDDEN,
  categorySelectName,
  CHECKBOX_FIELDS,
  GROUP_FIELDS,
  NUMBER_FIELDS,
  parseProfilePage,
  PROFILE_FORM,
  profileFields,
  ROW_FIELDS,
  salaryTypeName,
  SELECT_FIELDS,
  TEXT_FIELDS,
  TEXTAREA_FIELDS,
  type MyProfile,
  type Option,
  type ProfileOptions,
  type ProfilePage,
  type RowKey,
} from '../parsers/profile.ts';
import { setTreeSelection, TREE_WIDGET } from '../parsers/form.ts';
import { createDraft, deleteDraft, getDraft } from './drafts.ts';

const PROFILE_PATH = '/my/profile/';
const DRAFT_KIND = 'profile';
const CSRF_FIELD = 'csrfmiddlewaretoken';

const years = z.number().nullable().optional().describe('The years of experience. Use a value from options.skillYears, or null.');

// The keys and the value types of a profile change. The keys are the keys of the structured profile.
// A list value replaces the full list.
export const PROFILE_CHANGES_SHAPE = {
  position: z.string().optional().describe('The job title of the profile.'),
  category: z.string().optional().describe('The value of a category from options.category.'),
  salaryMin: z.number().nullable().optional().describe('The minimum monthly salary in USD.'),
  salaryHour: z.number().nullable().optional().describe('The minimum hourly rate in USD, or null for no rate.'),
  salaryType: z.string().optional().describe('NET or GROSS, from options.salaryType. djinni shows it only when the country is not Ukraine.'),
  experienceYears: z.string().optional().describe('The value of an option from options.experienceYears.'),
  workExperience: z.string().optional().describe('The work experience text.'),
  achievements: z.string().optional().describe('The achievements text.'),
  expectations: z.string().optional().describe('The job expectations text.'),
  skills: z
    .array(z.strictObject({ skill: z.string(), years }))
    .optional()
    .describe('The full list of skills.'),
  languages: z
    .array(z.strictObject({ code: z.string(), level: z.string() }))
    .optional()
    .describe('The full list of languages. Use a code from options.languageCodes and a level from options.languageLevels.'),
  domains: z
    .array(z.strictObject({ domain: z.string(), years }))
    .optional()
    .describe('The full list of domains with experience.'),
  certifications: z
    .array(z.strictObject({ name: z.string(), provider: z.string().optional() }))
    .optional()
    .describe('The full list of certifications.'),
  country: z.string().optional().describe('The country code from options.country.'),
  location: z.string().optional().describe('The city.'),
  formats: z.array(z.string()).optional().describe('The work formats from options.formats.'),
  employment: z.array(z.string()).optional().describe('The employment types from options.employment.'),
  domainZones: z.array(z.string()).optional().describe('The domains that the user does not want, from options.domainZones.'),
  uninterestedCompanyTypes: z.array(z.string()).optional().describe('The company types that the user does not want, from options.uninterestedCompanyTypes.'),
  communicationLanguages: z.array(z.string()).optional().describe('The languages for communication, from options.communicationLanguages.'),
  preferredCommunication: z.string().optional().describe('The preferred contact channel from options.preferredCommunication.'),
  isDefender: z.boolean().optional().describe('True when the user is a combatant of the Defense Forces of Ukraine.'),
  hasMobilizationDeferment: z.boolean().optional().describe('True when the user has a deferment from mobilization.'),
};
export const PROFILE_CHANGES = z.strictObject(PROFILE_CHANGES_SHAPE);
export type ProfileChanges = z.infer<typeof PROFILE_CHANGES>;
type ChangeKey = keyof ProfileChanges;

export type DiffLine = { field: string; old: string; new: string };
export type Mismatch = { field: string; expected: string; actual: string };
export type ProfileDraftResult = { draftId: string; expiresAt: string; diff: DiffLine[] };
export type ProfileSubmitResult = { ok: boolean; changed: string[]; mismatches: Mismatch[] };

type Fields = [string, string][];
// "base" is the form when the draft was made, without the CSRF token. "fields" is the form to post.
// "expected" has the new value of each changed key, in the form of the structured profile.
type ProfileDraftPayload = { base: Fields; fields: Fields; expected: Partial<Record<ChangeKey, unknown>> };
type ProfileDraftPreview = { diff: DiffLine[] };

// Reads the /my/profile/ page with the session client. Throws NotLoggedInError if no valid session is saved.
async function loadProfilePage(ctx: Ctx): Promise<cheerio.CheerioAPI> {
  await ctx.me();
  const $ = cheerio.load(await ctx.client().get(PROFILE_PATH));
  if ($(PROFILE_FORM).filter('form').length === 0) throw new Error(`djinni sent no profile form on ${PROFILE_PATH}.`);
  return $;
}

export async function getMyProfile(ctx: Ctx): Promise<ProfilePage> {
  return parseProfilePage(await loadProfilePage(ctx));
}

// ---- Validation and the new values ----

// The shape has the keys in the order of the structured profile.
const KEY_ORDER = Object.keys(PROFILE_CHANGES_SHAPE) as ChangeKey[];

const OPTION_KEYS: Partial<Record<ChangeKey, keyof ProfileOptions>> = {
  category: 'category',
  experienceYears: 'experienceYears',
  country: 'country',
  preferredCommunication: 'preferredCommunication',
  salaryType: 'salaryType',
  formats: 'formats',
  employment: 'employment',
  domainZones: 'domainZones',
  uninterestedCompanyTypes: 'uninterestedCompanyTypes',
  communicationLanguages: 'communicationLanguages',
};
// The short lists of allowed values go into the error message. A longer list stays in the profile options.
const MAX_LISTED_VALUES = 12;

function checkOption(value: string, allowed: Option[], label: string, optionsKey: keyof ProfileOptions): void {
  if (allowed.some(o => o.value === value)) return;
  const list = allowed.length > 0 && allowed.length <= MAX_LISTED_VALUES ? `: ${allowed.map(o => o.value).join(', ')}` : '';
  throw new Error(`"${value}" is not an allowed value for ${label}. Use a value from options.${optionsKey} of the profile${list}.`);
}

const checkYears = (value: number | null | undefined, options: ProfileOptions, label: string): number | null => {
  if (value === null || value === undefined) return null;
  if (!options.skillYears.some(o => Number(o.value) === value)) checkOption(String(value), options.skillYears, label, 'skillYears');
  return value;
};

function checkUnique(values: string[], key: string): void {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) throw new Error(`${key} has the value "${v}" more than one time.`);
    seen.add(v);
  }
}

const notEmpty = (value: string, label: string) => {
  const v = value.trim();
  if (!v) throw new Error(`${label} must not be empty.`);
  return v;
};

// The form control of a field name, for the limits of the form (required, maxlength, min, max, step).
const control = ($: cheerio.CheerioAPI, name: string) =>
  $(PROFILE_FORM)
    .find('input, textarea, select')
    .filter((_, el) => el.attribs['name'] === name)
    .first();

function checkText($: cheerio.CheerioAPI, key: string, name: string, value: string, multiline: boolean): string {
  const el = control($, name);
  if (!multiline && /[\r\n]/.test(value)) throw new Error(`${key} must be one line.`);
  if (el.attr('required') !== undefined && value.trim() === '') throw new Error(`${key} must not be empty.`);
  const max = Number(el.attr('maxlength'));
  if (Number.isFinite(max) && max > 0 && value.length > max) throw new Error(`${key} has ${value.length} characters. The form allows at most ${max}.`);
  return value;
}

function checkNumber($: cheerio.CheerioAPI, key: string, name: string, value: number | null): number | null {
  const el = control($, name);
  if (value === null) {
    if (el.attr('required') !== undefined) throw new Error(`${key} must not be empty.`);
    return null;
  }
  const attr = (a: string) => (el.attr(a) === undefined || el.attr(a) === '' ? null : Number(el.attr(a)));
  const min = attr('min');
  const max = attr('max');
  const step = attr('step');
  const steps = step ? (value - (min ?? 0)) / step : 0;
  const valid =
    Number.isFinite(value) && (min === null || value >= min) && (max === null || value <= max) && Math.abs(steps - Math.round(steps)) < 1e-9;
  if (!valid) {
    const limits = [min !== null && `min ${min}`, max !== null && `max ${max}`, step && `step ${step}`].filter(Boolean).join(', ');
    throw new Error(`The value ${value} is not valid for ${key}. The form allows ${limits}.`);
  }
  return value;
}

type Rows = {
  skills: { skill: string; years: number | null }[];
  languages: { code: string; level: string }[];
  domains: { domain: string; years: number | null }[];
  certifications: { name: string; provider: string }[];
};

// djinni renders one row for each skill, and the page with the most skills that we saw has 12 rows (0 to 11).
// So the limit is the larger of 12 and the row count of the page.
const MIN_SKILL_LIMIT = 12;
type RowLimits = { skills: number };

function rowLimits($: cheerio.CheerioAPI): RowLimits {
  const rows = new Set(
    $(PROFILE_FORM)
      .find('input, select')
      .toArray()
      .map(el => new RegExp(`^${ROW_FIELDS.skills.prefix}\\[(\\d+)\\]`).exec(el.attribs['name'] ?? '')?.[1])
      .filter(i => i !== undefined),
  );
  return { skills: Math.max(MIN_SKILL_LIMIT, rows.size) };
}

// Checks each change against the form and its options. Returns the new value of each key, in the form of the structured profile.
// The category is its value, not the option with the label.
function newValues($: cheerio.CheerioAPI, changes: ProfileChanges, options: ProfileOptions): Partial<Record<ChangeKey, unknown>> {
  const out: Partial<Record<ChangeKey, unknown>> = {};
  for (const key of KEY_ORDER) {
    const value = changes[key];
    if (value === undefined) continue;
    const optionsKey = OPTION_KEYS[key];
    if (key === 'salaryType' && options.salaryType.length === 0) {
      throw new Error('The profile form has no salary type field. djinni shows it only when the country is not Ukraine. Change the country first, then make a new draft.');
    }
    if (key in TEXT_FIELDS) out[key] = checkText($, key, TEXT_FIELDS[key as keyof typeof TEXT_FIELDS], value as string, false);
    else if (key in TEXTAREA_FIELDS)
      out[key] = checkText($, key, TEXTAREA_FIELDS[key as keyof typeof TEXTAREA_FIELDS], (value as string).replace(/\r\n?/g, '\n'), true);
    else if (key in NUMBER_FIELDS) out[key] = checkNumber($, key, NUMBER_FIELDS[key as keyof typeof NUMBER_FIELDS], value as number | null);
    else if (key in CHECKBOX_FIELDS) out[key] = value;
    else if (key in GROUP_FIELDS) {
      const list = value as string[];
      for (const v of list) checkOption(v, options[optionsKey!], key, optionsKey!);
      // The browser sends the checked boxes in the order of the page.
      out[key] = options[optionsKey!].map(o => o.value).filter(v => list.includes(v));
    } else if (optionsKey) {
      checkOption(value as string, options[optionsKey], key, optionsKey);
      out[key] = value;
    } else out[key] = checkRows(key as RowKey, value as never, options, rowLimits($));
  }
  return out;
}

function checkRows(key: RowKey, value: Rows[RowKey], options: ProfileOptions, limits: RowLimits): Rows[RowKey] {
  if (key === 'skills') {
    if (value.length > limits.skills) throw new Error(`skills has ${value.length} items. The form allows at most ${limits.skills} skills.`);
    const rows = (value as ProfileChanges['skills'])!.map(r => ({ skill: notEmpty(r.skill, 'skills.skill'), years: checkYears(r.years, options, 'skills.years') }));
    checkUnique(rows.map(r => r.skill), key);
    return rows;
  }
  if (key === 'languages') {
    const rows = (value as Rows['languages']).map(r => {
      checkOption(r.code, options.languageCodes, 'languages.code', 'languageCodes');
      checkOption(r.level, options.languageLevels, 'languages.level', 'languageLevels');
      return { code: r.code, level: r.level };
    });
    checkUnique(rows.map(r => r.code), key);
    return rows;
  }
  if (key === 'domains') {
    const rows = (value as ProfileChanges['domains'])!.map(r => ({ domain: notEmpty(r.domain, 'domains.domain'), years: checkYears(r.years, options, 'domains.years') }));
    checkUnique(rows.map(r => r.domain), key);
    return rows;
  }
  const rows = (value as ProfileChanges['certifications'])!.map(r => ({ name: notEmpty(r.name, 'certifications.name'), provider: (r.provider ?? '').trim() }));
  checkUnique(rows.map(r => r.name), key);
  return rows;
}

// The value of a key in the current profile, in the same form as the new values.
const currentValue = (profile: MyProfile, key: ChangeKey): unknown => (key === 'category' ? (profile.category?.value ?? '') : profile[key]);

// The keys of the structured profile that a change can set, in the order of the profile.
export const PROFILE_KEYS: readonly ChangeKey[] = KEY_ORDER;
export type ProfileKey = ChangeKey;

// Returns the value of a profile key as plain text, in the same form as the diff.
export const profileFieldText = (page: ProfilePage, key: ChangeKey): string => valueText(key, currentValue(page, key), page.options);

// ---- Plain text of the values ----

const yearsText = (y: number | null) => (y === null ? '' : ` (${y} ${y === 1 ? 'year' : 'years'})`);
const listText = (items: string[]) => (items.length ? items.join(', ') : '(none)');

function valueText(key: ChangeKey, value: unknown, options: ProfileOptions): string {
  if (value === null || value === undefined || value === '') {
    if (key === 'preferredCommunication') return options.preferredCommunication.find(o => o.value === '')?.label ?? '(empty)';
    return '(empty)';
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  const optionsKey = OPTION_KEYS[key];
  if (key === 'skills') return listText((value as Rows['skills']).map(r => r.skill + yearsText(r.years)));
  if (key === 'domains') return listText((value as Rows['domains']).map(r => r.domain + yearsText(r.years)));
  if (key === 'languages') return listText((value as Rows['languages']).map(r => `${r.code} ${r.level}`));
  if (key === 'certifications') return listText((value as Rows['certifications']).map(r => (r.provider ? `${r.name} (${r.provider})` : r.name)));
  if (Array.isArray(value)) return listText(value as string[]);
  if (optionsKey && key !== 'salaryType') {
    const label = options[optionsKey].find(o => o.value === value)?.label;
    return label ? `${label} (${value})` : String(value);
  }
  return String(value);
}

// ---- Changes of the form ----

const nameIs = (name: string) => (_: number, el: Element) => el.attribs['name'] === name;

function setSelect(form: cheerio.Cheerio<Element>, name: string, value: string): void {
  const select = form.find('select').filter(nameIs(name));
  select.find('option').removeAttr('selected');
  select
    .find('option')
    .filter((_, o) => (o.attribs['value'] ?? '') === value)
    .first()
    .attr('selected', '');
}

function setChecked(form: cheerio.Cheerio<Element>, type: string, name: string, values: string[]): void {
  form
    .find(`input[type="${type}"]`)
    .filter(nameIs(name))
    .each((_, el) => {
      if (values.includes(el.attribs['value'] ?? 'on')) el.attribs['checked'] = '';
      else delete el.attribs['checked'];
    });
}

// Checks or unchecks a single checkbox. A checked box sends its own value attribute.
function setFlag(form: cheerio.Cheerio<Element>, name: string, checked: boolean): void {
  form
    .find('input[type="checkbox"]')
    .filter(nameIs(name))
    .each((_, el) => {
      if (checked) el.attribs['checked'] = '';
      else delete el.attribs['checked'];
    });
}

// Replaces all rows of a row group with hidden inputs at the place of the first old row.
// An empty list of a group with "emptyRow" gets one empty row, as the page has it.
function setRows($: cheerio.CheerioAPI, form: cheerio.Cheerio<Element>, key: RowKey, rows: Record<string, string | number | null>[]): void {
  const { prefix, columns, emptyRow } = ROW_FIELDS[key];
  const old = form.find('input, select, textarea').filter((_, el) => (el.attribs['name'] ?? '').startsWith(`${prefix}[`));
  const list = rows.length === 0 && emptyRow ? [Object.fromEntries(Object.keys(columns).map(k => [k, '']))] : rows;
  const inputs = list.flatMap((row, i) =>
    Object.entries(columns).map(([k, column]) => $('<input type="hidden">').attr('name', `${prefix}[${i}][${column}]`).attr('value', String(row[k] ?? ''))),
  );
  if (old.length === 0) form.append(inputs.map(i => i.get(0)!));
  else old.first().before(inputs.map(i => i.get(0)!));
  old.remove();
}

function applyChanges($: cheerio.CheerioAPI, values: Partial<Record<ChangeKey, unknown>>): void {
  const form = $(PROFILE_FORM).filter('form').first();
  const input = (name: string) => form.find('input').filter(nameIs(name));
  for (const [key, value] of Object.entries(values) as [ChangeKey, unknown][]) {
    if (key in TEXT_FIELDS) input(TEXT_FIELDS[key as keyof typeof TEXT_FIELDS]).attr('value', value as string);
    else if (key in TEXTAREA_FIELDS)
      form
        .find('textarea')
        .filter(nameIs(TEXTAREA_FIELDS[key as keyof typeof TEXTAREA_FIELDS]))
        .text(value as string);
    else if (key in NUMBER_FIELDS) input(NUMBER_FIELDS[key as keyof typeof NUMBER_FIELDS]).attr('value', value === null ? '' : String(value));
    else if (key in SELECT_FIELDS) setSelect(form, SELECT_FIELDS[key as keyof typeof SELECT_FIELDS], value as string);
    else if (key in CHECKBOX_FIELDS) setFlag(form, CHECKBOX_FIELDS[key as keyof typeof CHECKBOX_FIELDS], value as boolean);
    else if (key in GROUP_FIELDS) setChecked(form, 'checkbox', GROUP_FIELDS[key as keyof typeof GROUP_FIELDS], value as string[]);
    else if (key === 'category') {
      // The browser sends the category twice: from the select, and from the field of the category widget.
      // The raw page has only the widget. After JavaScript, the page also has the hidden input of the widget.
      setSelect(form, categorySelectName($)!, value as string);
      input(CATEGORY_HIDDEN).attr('value', value as string);
      form
        .find(TREE_WIDGET)
        .filter((_, el) => el.attribs['data-name'] === CATEGORY_HIDDEN)
        .each((_, el) => setTreeSelection($, el, [value as string]));
    } else if (key === 'salaryType') setChecked(form, 'radio', salaryTypeName($)!, [value as string]);
    else setRows($, form, key as RowKey, value as Record<string, string | number | null>[]);
  }
}

const withoutCsrf = (fields: Fields): Fields => fields.filter(([name]) => name !== CSRF_FIELD);

function parseChanges(changes: unknown): ProfileChanges {
  const parsed = PROFILE_CHANGES.safeParse(changes);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map(i => {
    const path = i.path.join('.');
    const keys = 'keys' in i && Array.isArray(i.keys) ? (i.keys as string[]).join(', ') : '';
    return [path, keys, i.message].filter(Boolean).join(': ');
  });
  throw new Error(`The changes are not valid: ${issues.join('. ')}.`);
}

// Makes a draft of a profile change. Sends no change to djinni.
export async function prepareProfileUpdate(ctx: Ctx, changes: ProfileChanges): Promise<ProfileDraftResult> {
  const checked = parseChanges(changes);
  const $ = await loadProfilePage(ctx);
  const page = parseProfilePage($);
  const values = newValues($, checked, page.options);
  const diff: DiffLine[] = [];
  const expected: Partial<Record<ChangeKey, unknown>> = {};
  for (const [key, value] of Object.entries(values) as [ChangeKey, unknown][]) {
    const old = currentValue(page, key);
    if (isDeepStrictEqual(old, value)) continue;
    expected[key] = value;
    diff.push({ field: key, old: valueText(key, old, page.options), new: valueText(key, value, page.options) });
  }
  if (diff.length === 0) throw new Error('The changes do not change the profile. The profile already has these values.');
  const base = withoutCsrf(profileFields($));
  applyChanges($, expected);
  const draft = createDraft<ProfileDraftPayload, ProfileDraftPreview>(ctx, DRAFT_KIND, { base, fields: withoutCsrf(profileFields($)), expected }, { diff });
  return { draftId: draft.id, expiresAt: draft.expiresAt, diff };
}

// Returns a saved profile draft with its diff. Sends no request.
export function getProfileDraft(ctx: Ctx, draftId: string): ProfileDraftResult {
  const draft = getDraft<ProfileDraftPayload, ProfileDraftPreview>(ctx, draftId, DRAFT_KIND);
  return { draftId: draft.id, expiresAt: draft.expiresAt, diff: draft.preview.diff };
}

// Sends an approved profile draft to djinni. Refuses the draft when the profile changed after the draft.
// djinni gives no clear answer for the POST, so a new GET of the profile decides which changes djinni saved.
export async function submitProfileUpdate(ctx: Ctx, draftId: string): Promise<ProfileSubmitResult> {
  const draft = getDraft<ProfileDraftPayload, ProfileDraftPreview>(ctx, draftId, DRAFT_KIND);
  const $ = await loadProfilePage(ctx);
  if (!isDeepStrictEqual(withoutCsrf(profileFields($)), draft.payload.base)) {
    throw new Error('The profile on djinni changed after this draft. Make a new draft from the current profile.');
  }
  const res = await ctx.client().postForm(PROFILE_PATH, draft.payload.fields);
  if (res.status >= 400) throw new Error(`djinni returned HTTP ${res.status} for POST ${PROFILE_PATH}.`);
  const after = parseProfilePage(await loadProfilePage(ctx));
  const changed: string[] = [];
  const mismatches: Mismatch[] = [];
  for (const [key, value] of Object.entries(draft.payload.expected) as [ChangeKey, unknown][]) {
    const actual = currentValue(after, key);
    if (isDeepStrictEqual(actual, value)) changed.push(key);
    else mismatches.push({ field: key, expected: valueText(key, value, after.options), actual: valueText(key, actual, after.options) });
  }
  const ok = mismatches.length === 0;
  if (ok) deleteDraft(ctx, draftId);
  return { ok, changed, mismatches };
}
