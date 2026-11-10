import { afterEach, describe, expect, test } from 'vitest';
import { Ctx } from '../../src/context.ts';
import { getDraft, listDrafts } from '../../src/core/drafts.ts';
import {
  getSubscriptionOptions,
  listSubscriptions,
  prepareCompanySubscription,
  prepareSubscription,
  submitCompanySubscription,
  submitSubscription,
} from '../../src/core/subscriptions.ts';
import { NotLoggedInError } from '../../src/http.ts';
import type { Store } from '../../src/store.ts';
import { fixture, loggedInStore, startFakeDjinni, tempStore, type FakeDjinni, type Route } from '../helpers.ts';

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

const FORM_PATH = '/ajax/jobs_subs/form_modal';
const CREATE = 'POST /ajax/jobs_subs/create';
const COMPANY = 'POST /ajax/jobs_subs/company_subscribe/';
const JOB_PAGE = '/jobs/845744-link-builder/';
const jsonRoute = (body: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function setup(routes: Record<string, Route> = {}, store: Store = loggedInStore()) {
  djinni = await startFakeDjinni({
    'GET /my/profile/': fixture('my_profile.html'),
    [`GET ${FORM_PATH}`]: fixture('subscription_form.html'),
    'GET /api/jobs/845744/': jsonRoute(JSON.parse(fixture('api_job_apply.json'))),
    [`GET ${JOB_PAGE}`]: fixture('job_apply_raw.html'),
    'GET /my/subscriptions/': fixture('my_subscriptions.html'),
    ...routes,
  });
  return new Ctx({ store, baseUrl: djinni.url, minIntervalMs: 0, now: () => new Date('2026-11-10T12:00:00.000Z') });
}

const posts = () => djinni.requests.filter(r => r.method === 'POST');

describe('getSubscriptionOptions', () => {
  test('reads the allowed values of the subscription form', async () => {
    const ctx = await setup();

    const options = await getSubscriptionOptions(ctx);

    expect(djinni.requests.find(r => r.url.startsWith(FORM_PATH))!.headers['hx-request']).toBe('true');
    expect(options.name).toEqual({ maxLength: 40 });
    expect(options.keywords).toEqual({ maxLength: 250, example: '(senior|middle) rust -blockchain' });
    expect(options.salary[0]).toEqual({ value: '500', label: 'від $500' });
    expect(options.salary).toHaveLength(20);
    expect(options.expYears.map(o => o.value)).toEqual(['no_exp', '1y', '2y', '3y', '4y', '5y', '6y', '7y', '8y', '9y', '10y']);
    expect(options.englishLevel.map(o => o.value)).toEqual(['no_eng', 'basic', 'pre', 'intermediate', 'upper', 'fluent', 'proficient', 'native']);
    expect(options.format).toEqual([
      { value: 'office', label: 'Офіс' },
      { value: 'hybrid', label: 'Гібридний формат' },
      { value: 'remote', label: 'Віддалена робота' },
    ]);
    expect(options.employment).toEqual([
      { value: 'fulltime', label: 'Повний день' },
      { value: 'parttime', label: 'Part-time' },
    ]);
    expect(options.category).toContainEqual({ value: 'Python', label: 'Python' });
    expect(options.category).toContainEqual({ value: 'Angular', label: 'Angular' });
    expect(options.location).toContainEqual({ value: 'UKR', label: 'Україна' });
    expect(options.domain).toContainEqual({ value: 'fintech', label: 'Fintech' });
  });
});

describe('prepareSubscription', () => {
  test('makes a draft and sends nothing', async () => {
    const ctx = await setup();

    const draft = await prepareSubscription(ctx, { name: 'Python remote', category: 'Python', salary: '3000', format: ['remote'] });

    expect(draft.preview).toEqual({
      name: 'Python remote',
      category: 'Python',
      salary: 'від $3000',
      format: ['Віддалена робота'],
    });
    expect(draft.expiresAt).toBe('2026-11-11T12:00:00.000Z');
    expect(getDraft(ctx, draft.draftId, 'subscription').kind).toBe('subscription');
    expect(posts()).toEqual([]);
  });

  test('refuses a value that the form does not allow and names the allowed values', async () => {
    const ctx = await setup();

    await expect(prepareSubscription(ctx, { name: 'X', englishLevel: 'c1' })).rejects.toThrow(
      'englishLevel "c1" is not an allowed value. Allowed values: no_eng, basic, pre, intermediate, upper, fluent, proficient, native.',
    );
    expect(listDrafts(ctx)).toEqual([]);
  });

  test('refuses an empty name and a name longer than 40 characters', async () => {
    const ctx = await setup();

    await expect(prepareSubscription(ctx, { name: '  ' })).rejects.toThrow('The subscription name must have 1 to 40 characters.');
    await expect(prepareSubscription(ctx, { name: 'x'.repeat(41) })).rejects.toThrow('The subscription name must have 1 to 40 characters.');
  });

  test('throws NotLoggedInError when no session is saved', async () => {
    const ctx = await setup({}, tempStore());

    await expect(prepareSubscription(ctx, { name: 'X' })).rejects.toBeInstanceOf(NotLoggedInError);
  });

  test('reads the name limit from the maxlength of the form', async () => {
    const form = fixture('subscription_form.html').replace('name="name" maxlength="40"', 'name="name" maxlength="20"');
    const ctx = await setup({ [`GET ${FORM_PATH}`]: form });

    await expect(prepareSubscription(ctx, { name: '' })).rejects.toThrow('The subscription name must have 1 to 20 characters.');
    await expect(prepareSubscription(ctx, { name: 'x'.repeat(21) })).rejects.toThrow('The subscription name must have 1 to 20 characters.');
    await expect(prepareSubscription(ctx, { name: 'x'.repeat(20) })).resolves.toBeDefined();
  });
});

describe('submitSubscription', () => {
  test('posts the form fields to the create path of the form with the HX-Request header', async () => {
    const ctx = await setup({ [CREATE]: '<div class="alert alert-success">Підписку створено</div>' });
    const { draftId } = await prepareSubscription(ctx, {
      name: 'Python remote',
      category: 'Python',
      salary: '3000',
      expYears: '3y',
      format: ['remote', 'hybrid'],
      employment: ['fulltime'],
      englishLevel: 'upper',
      location: ['UKR', 'POL'],
      domain: ['fintech'],
      keywords: 'django -blockchain',
      canApplyOnly: true,
    });

    const result = await submitSubscription(ctx, draftId);

    expect(result).toEqual({ ok: true, status: 200, message: 'Підписку створено' });
    const [post] = posts();
    expect(post!.url).toBe('/ajax/jobs_subs/create?redirect=1');
    expect(post!.headers['hx-request']).toBe('true');
    expect([...new URLSearchParams(post!.body)]).toEqual([
      ['referral', 'my_subs'],
      ['name', 'Python remote'],
      ['primary_keyword', 'Python'],
      ['salary', '3000'],
      ['exp_years', '3y'],
      ['format', 'hybrid'],
      ['format', 'remote'],
      ['employment', 'fulltime'],
      ['english_level', 'upper'],
      ['location', 'UKR'],
      ['location', 'POL'],
      ['domain', 'fintech'],
      ['keywords', 'django -blockchain'],
      ['can_apply_only', '1'],
      ['csrfmiddlewaretoken', 'CSRF'],
    ]);
    expect(listDrafts(ctx)).toEqual([]);
  });

  test('returns ok false with the status and deletes the draft for an HTTP error', async () => {
    const ctx = await setup({ [CREATE]: { status: 400, body: '<form><div class="invalid-feedback">Назва вже існує</div></form>' } });
    const { draftId } = await prepareSubscription(ctx, { name: 'X' });

    expect(await submitSubscription(ctx, draftId)).toEqual({ ok: false, status: 400, message: 'Назва вже існує' });
    expect(listDrafts(ctx)).toEqual([]);
    await expect(submitSubscription(ctx, draftId)).rejects.toThrow(`The draft ID "${draftId}" is not known.`);
    expect(posts()).toHaveLength(1);
  });

  test('returns ok false with a retry warning when the POST gets no answer', async () => {
    const ctx = await setup({ [CREATE]: { closeConnection: true } });
    const { draftId } = await prepareSubscription(ctx, { name: 'X' });

    const result = await submitSubscription(ctx, draftId);

    expect(result).toMatchObject({ ok: false, status: null });
    expect((result as { message: string }).message).toMatch(
      /^The subscription request failed: .+\. djinni may have created the subscription\. The draft is deleted\. Check https:\/\/djinni\.co\/my\/subscriptions\/ before you make a new draft\.$/,
    );
    expect(listDrafts(ctx)).toEqual([]);
    await expect(submitSubscription(ctx, draftId)).rejects.toThrow(`The draft ID "${draftId}" is not known.`);
    expect(posts()).toHaveLength(1);
  });

  test('refuses a company subscription draft', async () => {
    const ctx = await setup();
    const { draftId } = await prepareCompanySubscription(ctx, { job: '845744' });

    await expect(submitSubscription(ctx, draftId)).rejects.toThrow('is a company_subscription draft, not a subscription draft');
    expect(posts()).toEqual([]);
  });
});

describe('company subscription', () => {
  test('prepareCompanySubscription makes a draft with the job and the company and sends nothing', async () => {
    const ctx = await setup();

    const draft = await prepareCompanySubscription(ctx, { job: 'https://djinni.co/jobs/845744-link-builder/' });

    expect(draft.preview).toEqual({ jobId: '845744', title: 'Link builder', company: 'Come Back Agency' });
    expect(posts()).toEqual([]);
  });

  test('prepareCompanySubscription reads the subscribe button on the job page', async () => {
    const ctx = await setup();

    await prepareCompanySubscription(ctx, { job: '845744' });

    expect(djinni.requests.map(r => r.url)).toContain(JOB_PAGE);
  });

  test('prepareCompanySubscription refuses when the company button does not say "Підписатись" and saves no draft', async () => {
    const ctx = await setup({ [`GET ${JOB_PAGE}`]: fixture('job_apply_raw.html').replace('Підписатись', 'Ви підписані') });

    await expect(prepareCompanySubscription(ctx, { job: '845744' })).rejects.toThrow(
      'The job page does not show the "Підписатись" button for the company Come Back Agency. The button says "Ви підписані". ' +
        'You may be subscribed to this company already. Check the job page https://djinni.co/jobs/845744-link-builder/.',
    );
    expect(listDrafts(ctx)).toEqual([]);
    expect(posts()).toEqual([]);
  });

  test('prepareCompanySubscription refuses when the job page has no company button', async () => {
    const page = fixture('job_apply_raw.html').replace(/<a href="\/ajax\/jobs_subs\/company_subscribe\/[^]*?<\/a>/, '');
    const ctx = await setup({ [`GET ${JOB_PAGE}`]: page });

    await expect(prepareCompanySubscription(ctx, { job: '845744' })).rejects.toThrow(
      'The job page does not show the "Підписатись" button for the company Come Back Agency. The page has no company subscription button.',
    );
    expect(listDrafts(ctx)).toEqual([]);
  });

  test('submitCompanySubscription posts to the company subscribe path with the job ID', async () => {
    const ctx = await setup({ [COMPANY]: '<a role="button">Ви підписані</a>' });
    const { draftId } = await prepareCompanySubscription(ctx, { job: '845744' });

    const result = await submitCompanySubscription(ctx, draftId);

    expect(result).toEqual({ ok: true, status: 200, message: 'Ви підписані' });
    const [post] = posts();
    expect(post!.url).toBe('/ajax/jobs_subs/company_subscribe/?job_id=845744');
    expect(post!.headers['hx-request']).toBe('true');
    expect(post!.headers['x-csrftoken']).toBe('CSRF');
    expect(listDrafts(ctx)).toEqual([]);
  });
});

describe('listSubscriptions', () => {
  test('returns an empty list and a note for the page without subscriptions', async () => {
    const ctx = await setup();

    expect(await listSubscriptions(ctx)).toEqual({
      subscriptions: [],
      note:
        'djinni shows no job subscriptions. The list format of this page is not verified yet. ' +
        'The user can manage the subscriptions on https://djinni.co/my/subscriptions/.',
    });
  });

  test('says that it cannot read the list when the page does not show the empty text', async () => {
    const ctx = await setup({ 'GET /my/subscriptions/': fixture('my_subscriptions.html').replace('У вас поки що немає підписок', 'Python remote') });

    expect((await listSubscriptions(ctx)).note).toBe(
      'The page may list job subscriptions, but this tool cannot read the list yet. The list format of this page is not verified yet. ' +
        'The user can manage the subscriptions on https://djinni.co/my/subscriptions/.',
    );
  });
});
