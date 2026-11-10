import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import type { Ctx } from '../context.ts';
import { DJINNI_URL, NotLoggedInError, type PostResult } from '../http.ts';
import { serializeForm, setTreeSelection, TREE_WIDGET } from '../parsers/form.ts';
import type { ApiJob } from '../parsers/jobs.ts';
import { createDraft, deleteDraft, getDraft } from './drafts.ts';
import { jobId, jobPath } from './jobs.ts';

// The HTMX fragment with the form for a new job subscription, as the "create a subscription" link of the dashboard loads it.
const FORM_PATH = '/ajax/jobs_subs/form_modal?referral=my_subs&redirect=1';
const FORM = '#subscription-form-create';
const SUBSCRIPTIONS_PATH = '/my/subscriptions/';
const SUBSCRIPTIONS_URL = DJINNI_URL + SUBSCRIPTIONS_PATH;
// The text of /my/subscriptions/ for an account without subscriptions.
const NO_SUBSCRIPTIONS = 'У вас поки що немає підписок';
const DRAFT_KIND = 'subscription';
const COMPANY_DRAFT_KIND = 'company_subscription';
const CSRF_FIELD = 'csrfmiddlewaretoken';
const MAX_MESSAGE = 300;
const RETRY_WARNING = `djinni may have created the subscription. The draft is deleted. Check ${SUBSCRIPTIONS_URL} before you make a new draft.`;
const LIST_NOTE = `The list format of this page is not verified yet. The user can manage the subscriptions on ${SUBSCRIPTIONS_URL}.`;

export type Option = { value: string; label: string };
export type SubscriptionOptions = {
  name: { maxLength: number };
  keywords: { maxLength: number; example: string | null };
  category: Option[];
  salary: Option[];
  expYears: Option[];
  format: Option[];
  employment: Option[];
  englishLevel: Option[];
  location: Option[];
  domain: Option[];
};
// The fields of a new subscription. The values come from getSubscriptionOptions. A field that is not given stays empty ("not important").
export type SubscriptionFields = {
  name: string;
  category?: string;
  salary?: string;
  expYears?: string;
  format?: string[];
  employment?: string[];
  englishLevel?: string;
  location?: string[];
  domain?: string[];
  keywords?: string;
  canApplyOnly?: boolean;
};
// The preview has the labels of the given fields.
export type SubscriptionPreview = Record<string, string | string[] | boolean>;
export type SubscriptionDraftResult = { draftId: string; expiresAt: string; preview: SubscriptionPreview };
export type CompanySubscriptionPreview = { jobId: string; title: string; company: string };
export type CompanySubscriptionDraftResult = { draftId: string; expiresAt: string; preview: CompanySubscriptionPreview };
// "ok" is true when djinni answered without an HTTP error. "status" is null when djinni sent no HTTP answer.
export type SubscriptionSubmitResult = { ok: boolean; status: number | null; message: string };

type Fields = [string, string][];
type SubscriptionPayload = { path: string; fields: Fields };
type CompanyPayload = { jobId: string; path: string };

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

// The select fields and the checkbox groups of the form, by the key of SubscriptionFields.
const SELECTS = { salary: 'salary', expYears: 'exp_years', englishLevel: 'english_level' } as const;
const CHECKBOXES = { format: 'format', employment: 'employment' } as const;
const TREES = { category: 'primary_keyword', location: 'location', domain: 'domain' } as const;

async function loadForm(ctx: Ctx): Promise<cheerio.CheerioAPI> {
  await ctx.me();
  const $ = cheerio.load(await ctx.client().get(FORM_PATH, { hx: true }));
  if ($(FORM).filter('form').length === 0) throw new Error(`djinni sent no subscription form on ${FORM_PATH}.`);
  return $;
}

const form = ($: cheerio.CheerioAPI) => $(FORM).filter('form').first();

const selectOptions = ($: cheerio.CheerioAPI, name: string): Option[] =>
  form($)
    .find(`select[name="${name}"] option`)
    .toArray()
    .map(o => ({ value: $(o).attr('value') ?? '', label: collapse($(o).text()) }))
    .filter(o => o.value !== '');

const checkboxOptions = ($: cheerio.CheerioAPI, name: string): Option[] =>
  form($)
    .find(`input[type="checkbox"][name="${name}"]`)
    .toArray()
    .map(el => {
      const id = $(el).attr('id');
      const label = id ? collapse($(`label[for="${id}"]`).first().text()) : '';
      return { value: $(el).attr('value') ?? 'on', label };
    });

type TreeItem = { key?: unknown; label?: unknown; children?: unknown };

const treeWidget = ($: cheerio.CheerioAPI, name: string): Element | undefined =>
  form($).find(TREE_WIDGET).filter(`[data-name="${name}"]`).get(0);

// All keys of a tree widget with their labels, with the children of each item. A key that repeats counts once.
function treeOptions($: cheerio.CheerioAPI, name: string): Option[] {
  const widget = treeWidget($, name);
  if (!widget) return [];
  let data: { groups?: { items?: TreeItem[] }[] };
  try {
    data = JSON.parse($(widget).children('script.tms-data').first().text() || '{}');
  } catch {
    return [];
  }
  const options = new Map<string, string>();
  const walk = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const item of items as TreeItem[]) {
      if (typeof item.key === 'string' && !options.has(item.key)) options.set(item.key, collapse(String(item.label ?? item.key)));
      walk(item.children);
    }
  };
  for (const group of data.groups ?? []) walk(group.items);
  return [...options].map(([value, label]) => ({ value, label }));
}

const maxLength = ($: cheerio.CheerioAPI, name: string, fallback: number) => Number(form($).find(`input[name="${name}"]`).attr('maxlength') ?? fallback) || fallback;

function readOptions($: cheerio.CheerioAPI): SubscriptionOptions {
  const example = collapse(form($).find('input[name="keywords"]').parent().find('.form-text').first().text()).replace(/^Наприклад:\s*/, '');
  return {
    name: { maxLength: maxLength($, 'name', 40) },
    keywords: { maxLength: maxLength($, 'keywords', 250), example: example || null },
    category: treeOptions($, TREES.category),
    salary: selectOptions($, SELECTS.salary),
    expYears: selectOptions($, SELECTS.expYears),
    format: checkboxOptions($, CHECKBOXES.format),
    employment: checkboxOptions($, CHECKBOXES.employment),
    englishLevel: selectOptions($, SELECTS.englishLevel),
    location: treeOptions($, TREES.location),
    domain: treeOptions($, TREES.domain),
  };
}

// Returns the allowed values of each field of a new job subscription.
export async function getSubscriptionOptions(ctx: Ctx): Promise<SubscriptionOptions> {
  return readOptions(await loadForm(ctx));
}

// Returns the label of each value. Throws for a value that the form does not allow.
function labels(key: string, values: string[], options: Option[]): string[] {
  return values.map(value => {
    const option = options.find(o => o.value === value);
    if (!option) throw new Error(`${key} "${value}" is not an allowed value. Allowed values: ${options.map(o => o.value).join(', ')}.`);
    return option.label;
  });
}

// Sets the given fields in the loaded form, as a user does in the browser. Returns the preview with the labels.
function fillForm($: cheerio.CheerioAPI, fields: SubscriptionFields): SubscriptionPreview {
  const options = readOptions($);
  const name = fields.name.trim();
  if (name.length === 0 || name.length > options.name.maxLength) {
    throw new Error(`The subscription name must have 1 to ${options.name.maxLength} characters.`);
  }
  const keywords = fields.keywords?.trim() ?? '';
  if (keywords.length > options.keywords.maxLength) throw new Error(`The keywords must have at most ${options.keywords.maxLength} characters.`);
  const preview: SubscriptionPreview = { name };
  form($).find('input[name="name"]').attr('value', name);
  for (const [key, field] of Object.entries(TREES) as [keyof typeof TREES, string][]) {
    const value = fields[key];
    if (value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    const named = labels(key, values, options[key]);
    setTreeSelection($, treeWidget($, field)!, values);
    preview[key] = Array.isArray(value) ? named : named[0]!;
  }
  for (const [key, field] of Object.entries(SELECTS) as [keyof typeof SELECTS, string][]) {
    const value = fields[key];
    if (value === undefined) continue;
    preview[key] = labels(key, [value], options[key])[0]!;
    const select = form($).find(`select[name="${field}"]`);
    select.find('option').removeAttr('selected');
    select.find('option').filter((_, o) => $(o).attr('value') === value).attr('selected', '');
  }
  for (const [key, field] of Object.entries(CHECKBOXES) as [keyof typeof CHECKBOXES, string][]) {
    const values = fields[key];
    if (values === undefined) continue;
    preview[key] = labels(key, values, options[key]);
    form($)
      .find(`input[type="checkbox"][name="${field}"]`)
      .each((_, el) => {
        if (values.includes($(el).attr('value') ?? 'on')) $(el).attr('checked', '');
        else $(el).removeAttr('checked');
      });
  }
  if (keywords) {
    form($).find('input[name="keywords"]').attr('value', keywords);
    preview.keywords = keywords;
  }
  if (fields.canApplyOnly !== undefined) {
    const box = form($).find('input[name="can_apply_only"]');
    if (fields.canApplyOnly) box.attr('checked', '');
    else box.removeAttr('checked');
    preview.canApplyOnly = fields.canApplyOnly;
  }
  return preview;
}

// The POST path of the form. It must be a djinni subscription path, so that a changed page cannot send the form elsewhere.
function createPath($: cheerio.CheerioAPI): string {
  const path = form($).attr('hx-post') ?? '';
  if (!/^\/ajax\/jobs_subs\/[A-Za-z0-9_/]+(\?[A-Za-z0-9_=&]*)?$/.test(path)) throw new Error(`The subscription form has an unexpected POST path "${path}".`);
  return path;
}

// Makes a draft of a new djinni job subscription. Sends nothing to djinni.
export async function prepareSubscription(ctx: Ctx, fields: SubscriptionFields): Promise<SubscriptionDraftResult> {
  const $ = await loadForm(ctx);
  const preview = fillForm($, fields);
  const payload: SubscriptionPayload = { path: createPath($), fields: serializeForm($, FORM).filter(([n]) => n !== CSRF_FIELD) as Fields };
  const draft = createDraft<SubscriptionPayload, SubscriptionPreview>(ctx, DRAFT_KIND, payload, preview);
  return { draftId: draft.id, expiresAt: draft.expiresAt, preview };
}

export function getSubscriptionDraft(ctx: Ctx, draftId: string): SubscriptionDraftResult {
  const draft = getDraft<SubscriptionPayload, SubscriptionPreview>(ctx, draftId, DRAFT_KIND);
  return { draftId: draft.id, expiresAt: draft.expiresAt, preview: draft.preview };
}

// A short text from the response fragment: the first error or alert, else the text of the fragment.
function responseMessage(body: string): string {
  const $ = cheerio.load(body);
  $('script, style').remove();
  const notice = $('.invalid-feedback, .errorlist, .alert')
    .toArray()
    .map(el => collapse($(el).text()))
    .find(t => t !== '');
  return (notice ?? collapse($('body').text())).slice(0, MAX_MESSAGE);
}

function errorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause instanceof Error ? ` (${e.cause.message})` : '';
  return `${e.message}${cause}`.replace(/\.$/, '');
}

// Sends an HTMX POST. Deletes the draft before the POST, so that a retry cannot create a second subscription without a new draft.
async function send(ctx: Ctx, draftId: string, path: string, fields: Fields): Promise<SubscriptionSubmitResult> {
  deleteDraft(ctx, draftId);
  let res: PostResult;
  try {
    res = await ctx.client().postForm(path, fields, { hx: true });
  } catch (e) {
    if (e instanceof NotLoggedInError) throw e;
    return { ok: false, status: null, message: `The subscription request failed: ${errorText(e)}. ${RETRY_WARNING}` };
  }
  return { ok: res.status < 400, status: res.status, message: responseMessage(res.body) };
}

// Sends an approved subscription draft to djinni. djinni then sends the new jobs of the subscription by email or Telegram.
export async function submitSubscription(ctx: Ctx, draftId: string): Promise<SubscriptionSubmitResult> {
  const draft = getDraft<SubscriptionPayload, SubscriptionPreview>(ctx, draftId, DRAFT_KIND);
  await ctx.me();
  return send(ctx, draftId, draft.payload.path, draft.payload.fields);
}

// The text of the company button on a job page for a candidate without a subscription to the company.
const SUBSCRIBE_TEXT = 'Підписатись';

// Refuses when the job page does not show the subscribe button of the company, for example after a subscription.
// The fixtures have only the button without a subscription, so any other text or a missing button is refused.
async function checkCompanyButton(ctx: Ctx, path: string, company: string): Promise<void> {
  const $ = cheerio.load(await ctx.client().get(path));
  const button = $('[hx-post*="/ajax/jobs_subs/company"]').first();
  const text = collapse(button.text());
  if (button.length > 0 && text === SUBSCRIBE_TEXT) return;
  const head = `The job page does not show the "${SUBSCRIBE_TEXT}" button for the company ${company}.`;
  if (button.length === 0) throw new Error(`${head} The page has no company subscription button.`);
  throw new Error(`${head} The button says "${text}". You may be subscribed to this company already. Check the job page ${DJINNI_URL + path}.`);
}

// Makes a draft of a subscription to the new jobs of the company of a job. Sends nothing to djinni.
export async function prepareCompanySubscription(ctx: Ctx, opts: { job: string }): Promise<CompanySubscriptionDraftResult> {
  const id = jobId(opts.job);
  await ctx.me();
  const job = await ctx.client().getJson<ApiJob>(`/api/jobs/${id}/`);
  const preview: CompanySubscriptionPreview = { jobId: id, title: collapse(job.title), company: collapse(job.company_name) };
  await checkCompanyButton(ctx, jobPath(job, id), preview.company);
  const payload: CompanyPayload = { jobId: id, path: `/ajax/jobs_subs/company_subscribe/?job_id=${id}` };
  const draft = createDraft<CompanyPayload, CompanySubscriptionPreview>(ctx, COMPANY_DRAFT_KIND, payload, preview);
  return { draftId: draft.id, expiresAt: draft.expiresAt, preview };
}

export function getCompanySubscriptionDraft(ctx: Ctx, draftId: string): CompanySubscriptionDraftResult {
  const draft = getDraft<CompanyPayload, CompanySubscriptionPreview>(ctx, draftId, COMPANY_DRAFT_KIND);
  return { draftId: draft.id, expiresAt: draft.expiresAt, preview: draft.preview };
}

export async function submitCompanySubscription(ctx: Ctx, draftId: string): Promise<SubscriptionSubmitResult> {
  const draft = getDraft<CompanyPayload, CompanySubscriptionPreview>(ctx, draftId, COMPANY_DRAFT_KIND);
  await ctx.me();
  return send(ctx, draftId, draft.payload.path, []);
}

// The section of /my/subscriptions/ with the notification channel form and the job subscriptions.
// "empty" is true when the section shows the text for an account without subscriptions. Returns null when the page has no such section.
export function subscriptionsSection(html: string): { empty: boolean } | null {
  const $ = cheerio.load(html);
  const channel = $('main form').filter((_, f) => $(f).attr('id') === '#notifications-channel');
  if (channel.length === 0) return null;
  return { empty: collapse(channel.first().parent().text()).includes(NO_SUBSCRIPTIONS) };
}

// Reads /my/subscriptions/. The format of a list with subscriptions is not known yet, so the list is always empty.
export async function listSubscriptions(ctx: Ctx): Promise<{ subscriptions: never[]; note: string }> {
  const $ = cheerio.load(await ctx.client().get(SUBSCRIPTIONS_PATH));
  const empty = collapse($('main').text()).includes(NO_SUBSCRIPTIONS);
  const head = empty ? 'djinni shows no job subscriptions.' : 'The page may list job subscriptions, but this tool cannot read the list yet.';
  return { subscriptions: [], note: `${head} ${LIST_NOTE}` };
}
