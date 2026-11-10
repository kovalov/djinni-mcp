import * as cheerio from 'cheerio';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { Ctx } from '../../src/context.ts';
import { getDraft, listDrafts } from '../../src/core/drafts.ts';
import { getMyProfile, prepareProfileUpdate, submitProfileUpdate } from '../../src/core/profile.ts';
import { serializeForm } from '../../src/parsers/form.ts';
import { NotLoggedInError } from '../../src/http.ts';
import { fixture, loggedInStore, startFakeDjinni, tempStore, type FakeDjinni, type Route } from '../helpers.ts';

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

// The page as the HTTP client gets it from djinni, and the page after its JavaScript ran in a browser.
const FIXTURES = ['my_profile_raw.html', 'my_profile.html'];
let PROFILE = '';

const now = () => new Date('2026-11-10T12:00:00.000Z');

async function setup(routes: Record<string, Route> = {}, store = loggedInStore()) {
  djinni = await startFakeDjinni({ 'GET /my/profile/': PROFILE, ...routes });
  return new Ctx({ store, baseUrl: djinni.url, minIntervalMs: 0, now });
}

// Changes the profile page with cheerio, for example to make the page after a successful POST.
export function editProfile(html: string, edit: ($: cheerio.CheerioAPI) => void): string {
  const $ = cheerio.load(html);
  edit($);
  return $.html();
}

describe.each(FIXTURES)('profile core on %s', name => {
  beforeAll(() => {
    PROFILE = fixture(name);
  });

  describe('getMyProfile', () => {
    test('returns the structured profile from the profile form', async () => {
      const ctx = await setup();

      const { options, ...profile } = await getMyProfile(ctx);

      expect(profile).toEqual({
        position: 'REDACTED_position',
        category: { value: 'ML AI', label: 'Data Science → ML / AI' },
        salaryMin: 3500,
        salaryHour: null,
        salaryType: null,
        experienceYears: '10',
        workExperience: 'REDACTED_moreinfo',
        achievements: 'REDACTED_highlights',
        expectations: 'REDACTED_looking_for',
        skills: [
          { skill: 'CRM', years: null },
          { skill: 'Zapier', years: null },
          { skill: 'Lead generation and sales qualification', years: null },
          { skill: 'Automation', years: null },
          { skill: 'Marketing Automation', years: null },
          { skill: 'Data analysis', years: null },
          { skill: 'Управління відділами продажу', years: null },
          { skill: 'n8n', years: null },
          { skill: 'Штучний інтелект (AI)', years: null },
          { skill: 'Автоматизація бізнес-процесів', years: null },
          { skill: 'Автоматизація продажів', years: null },
          { skill: 'CRM Automation', years: null },
        ],
        languages: [
          { code: 'eng', level: 'B2' },
          { code: 'ukr', level: 'native' },
        ],
        domains: [],
        certifications: [],
        country: 'UKR',
        location: '',
        formats: ['remote'],
        employment: ['parttime'],
        domainZones: [],
        uninterestedCompanyTypes: [],
        communicationLanguages: ['uk', 'en'],
        preferredCommunication: 'djinni',
        isDefender: false,
        hasMobilizationDeferment: false,
      });
    });

    test('returns the allowed values with labels for each select and checkbox group', async () => {
      const ctx = await setup();

      const { options } = await getMyProfile(ctx);

      expect(options.category).toHaveLength(157);
      expect(options.category[0]).toEqual({ value: 'JavaScript', label: 'JavaScript / Front-End' });
      expect(options.category).toContainEqual({ value: 'Angular', label: 'JavaScript / Front-End → Angular' });
      expect(options.experienceYears).toHaveLength(17);
      expect(options.experienceYears[0]).toEqual({ value: '0', label: 'Без досвіду' });
      expect(options.experienceYears).toContainEqual({ value: '10', label: '5 років' });
      expect(options.skillYears.map(o => o.value)).toEqual(['0.5', '1', '1.5', '2', '2.5', '3', '3.5', '4', '4.5', '5', '6', '7', '8', '9', '10', '11']);
      expect(options.skillYears[1]).toEqual({ value: '1', label: '1 рік' });
      expect(options.languageCodes).toHaveLength(114);
      expect(options.languageCodes).toContainEqual({ value: 'eng', label: 'Англійська' });
      expect(options.languageLevels.map(o => o.value)).toEqual(['none', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'native']);
      expect(options.country).toHaveLength(250);
      expect(options.country[0]).toEqual({ value: 'AUS', label: 'Австралія' });
      expect(options.formats).toEqual([
        { value: 'remote', label: 'Віддалена робота' },
        { value: 'office', label: expect.any(String) },
        { value: 'hybrid', label: expect.any(String) },
      ]);
      expect(options.employment.map(o => o.value)).toEqual(['fulltime', 'parttime', 'freelance']);
      expect(options.employment[1]).toEqual({ value: 'parttime', label: 'Part-time' });
      expect(options.domainZones).toHaveLength(30);
      expect(options.domainZones[0]).toEqual({ value: 'adult', label: 'Adult' });
      expect(options.uninterestedCompanyTypes.map(o => o.value)).toEqual(['agency', 'mixed', 'outsource', 'outstaff', 'product', 'startup', 'inhouse_it', 'government']);
      expect(options.uninterestedCompanyTypes[0]).toEqual({ value: 'agency', label: 'Агенція' });
      expect(options.communicationLanguages).toEqual([
        { value: 'uk', label: 'Українська' },
        { value: 'en', label: 'English' },
      ]);
      expect(options.preferredCommunication).toEqual([
        { value: '', label: '(не важливо)' },
        { value: 'djinni', label: 'Djinni' },
        { value: 'email', label: 'Email' },
        { value: 'phone', label: 'Phone' },
        { value: 'whatsapp', label: 'WhatsApp' },
        { value: 'telegram', label: 'Telegram' },
        { value: 'linkedin', label: 'LinkedIn' },
      ]);
      expect(options.salaryType).toEqual([]);
    });

    test('reads the salary type radio when the page has it', async () => {
      const html = editProfile(PROFILE, $ => {
        $('#salary_min').after(
          '<div id="salary_type_row"><input type="radio" name="salary_type" id="salary_type_net" value="NET"><label for="salary_type_net">Net</label>' +
            '<input type="radio" name="salary_type" id="salary_type_gross" value="GROSS" checked><label for="salary_type_gross">Gross</label></div>',
        );
      });
      const ctx = await setup({ 'GET /my/profile/': html });

      const profile = await getMyProfile(ctx);

      expect(profile.salaryType).toBe('GROSS');
      expect(profile.options.salaryType).toEqual([
        { value: 'NET', label: 'Net' },
        { value: 'GROSS', label: 'Gross' },
      ]);
    });

    test('reads the rows of the domains, the certifications and the skill years', async () => {
      const html = editProfile(PROFILE, $ => {
        $('input[name="skills_experience[0][experience_years]"]').attr('value', '2.5');
        $('input[name="domain_experience[0][domain]"]').attr('value', 'fintech');
        $('input[name="domain_experience[0][experience_years]"]').attr('value', '3');
        $('input[name="certifications[0][name]"]').attr('value', 'AWS SAA');
        $('input[name="certifications[0][provider]"]').attr('value', 'Amazon');
        $('#moreinfo').text('Line 1\r\nLine 2');
        $('#is_defender').attr('checked', '');
      });
      const ctx = await setup({ 'GET /my/profile/': html });

      const profile = await getMyProfile(ctx);

      expect(profile.skills[0]).toEqual({ skill: 'CRM', years: 2.5 });
      expect(profile.domains).toEqual([{ domain: 'fintech', years: 3 }]);
      expect(profile.certifications).toEqual([{ name: 'AWS SAA', provider: 'Amazon' }]);
      expect(profile.workExperience).toBe('Line 1\nLine 2');
      expect(profile.isDefender).toBe(true);
    });

    test('needs a valid session', async () => {
      const ctx = await setup({ 'GET /my/profile/': { status: 302, headers: { location: '/login' } } });

      await expect(getMyProfile(ctx)).rejects.toBeInstanceOf(NotLoggedInError);
    });

    test('needs a saved session and sends no request without it', async () => {
      const ctx = await setup({}, tempStore());

      await expect(getMyProfile(ctx)).rejects.toBeInstanceOf(NotLoggedInError);
      expect(djinni.requests).toEqual([]);
    });

    test('throws when the page has no profile form', async () => {
      const html = editProfile(PROFILE, $ => void $('#js-profile-form').remove());
      const ctx = await setup({ 'GET /my/profile/': html });

      await expect(getMyProfile(ctx)).rejects.toThrow('djinni sent no profile form on /my/profile/.');
    });
  });

  // The fields that a browser submits for the profile form of the fixture.
  const baseFields = () => serializeForm(PROFILE, '#js-profile-form') as [string, string][];
  // The entries of a form body in the order of the body.
  const bodyEntries = (body: string) => [...new URLSearchParams(body).entries()];
  const posts = () => djinni.requests.filter(r => r.method === 'POST');

  describe('prepareProfileUpdate', () => {
    test('saves a draft with the diff and sends nothing to djinni', async () => {
      const ctx = await setup();

      const result = await prepareProfileUpdate(ctx, {
        formats: ['hybrid', 'remote'],
        workExperience: 'New text\nline 2',
        skills: [{ skill: 'CRM', years: 2 }, { skill: 'TypeScript' }],
        experienceYears: '11',
        isDefender: false,
      });

      expect(result).toEqual({
        draftId: expect.stringMatching(/^[0-9a-f]{8}$/),
        expiresAt: '2026-11-11T12:00:00.000Z',
        diff: [
          { field: 'experienceYears', old: '5 років (10)', new: '6 років (11)' },
          { field: 'workExperience', old: 'REDACTED_moreinfo', new: 'New text\nline 2' },
          {
            field: 'skills',
            old: 'CRM, Zapier, Lead generation and sales qualification, Automation, Marketing Automation, Data analysis, Управління відділами продажу, n8n, Штучний інтелект (AI), Автоматизація бізнес-процесів, Автоматизація продажів, CRM Automation',
            new: 'CRM (2 years), TypeScript',
          },
          { field: 'formats', old: 'remote', new: 'remote, hybrid' },
        ],
      });
      expect(djinni.requests.every(r => r.method === 'GET')).toBe(true);
      const draft = getDraft(ctx, result.draftId, 'profile');
      expect(draft.preview).toEqual({ diff: result.diff });
    });

    test('shows the empty values, the lists and the flags in plain text', async () => {
      const ctx = await setup();

      const { diff } = await prepareProfileUpdate(ctx, {
        salaryHour: 25,
        location: 'Lviv',
        domainZones: ['gambling'],
        employment: [],
        languages: [{ code: 'eng', level: 'C1' }],
        certifications: [{ name: 'AWS SAA', provider: 'Amazon' }, { name: 'Scrum' }],
        domains: [{ domain: 'fintech', years: 1 }],
        hasMobilizationDeferment: true,
        preferredCommunication: '',
        category: 'Python',
      });

      expect(diff).toEqual([
        { field: 'category', old: 'Data Science → ML / AI (ML AI)', new: 'Python (Python)' },
        { field: 'salaryHour', old: '(empty)', new: '25' },
        { field: 'languages', old: 'eng B2, ukr native', new: 'eng C1' },
        { field: 'domains', old: '(none)', new: 'fintech (1 year)' },
        { field: 'certifications', old: '(none)', new: 'AWS SAA (Amazon), Scrum' },
        { field: 'location', old: '(empty)', new: 'Lviv' },
        { field: 'employment', old: 'parttime', new: '(none)' },
        { field: 'domainZones', old: '(none)', new: 'gambling' },
        { field: 'preferredCommunication', old: 'Djinni (djinni)', new: '(не важливо)' },
        { field: 'hasMobilizationDeferment', old: 'no', new: 'yes' },
      ]);
    });

    test('refuses changes that do not change the profile and saves no draft', async () => {
      const ctx = await setup();

      await expect(prepareProfileUpdate(ctx, { formats: ['remote'], salaryMin: 3500, category: 'ML AI' })).rejects.toThrow(
        'The changes do not change the profile. The profile already has these values.',
      );
      expect(listDrafts(ctx)).toEqual([]);
    });

    test('refuses an empty change set', async () => {
      const ctx = await setup();

      await expect(prepareProfileUpdate(ctx, {})).rejects.toThrow('The changes do not change the profile.');
    });

    test.each([
      [{ formats: ['moon'] }, '"moon" is not an allowed value for formats. Use a value from options.formats of the profile: remote, office, hybrid.'],
      [{ country: 'XXX' }, '"XXX" is not an allowed value for country. Use a value from options.country of the profile.'],
      [{ category: '' }, '"" is not an allowed value for category.'],
      [{ experienceYears: '99' }, '"99" is not an allowed value for experienceYears.'],
      [{ languages: [{ code: 'eng', level: 'Z9' }] }, '"Z9" is not an allowed value for languages.level.'],
      [{ languages: [{ code: 'zzz', level: 'B2' }] }, '"zzz" is not an allowed value for languages.code.'],
      [{ skills: [{ skill: 'CRM', years: 1.25 }] }, '"1.25" is not an allowed value for skills.years.'],
      [{ domains: [{ domain: 'fintech', years: 0.7 }] }, '"0.7" is not an allowed value for domains.years.'],
      [{ skills: [{ skill: 'CRM' }, { skill: 'CRM' }] }, 'skills has the value "CRM" more than one time.'],
      [{ skills: [{ skill: ' ' }] }, 'skills.skill must not be empty.'],
      [{ skills: Array.from({ length: 13 }, (_, i) => ({ skill: `Skill ${i}` })) }, 'skills has 13 items. The form allows at most 12 skills.'],
      [{ salaryMin: 3510 }, 'The value 3510 is not valid for salaryMin. The form allows min 100, step 50.'],
      [{ salaryMin: 50 }, 'The value 50 is not valid for salaryMin. The form allows min 100, step 50.'],
      [{ salaryHour: 601 }, 'The value 601 is not valid for salaryHour. The form allows min 1, max 600, step 1.'],
      [{ salaryMin: null }, 'salaryMin must not be empty.'],
      [{ position: '' }, 'position must not be empty.'],
      [{ position: 'A\nB' }, 'position must be one line.'],
      [{ workExperience: 'x'.repeat(2501) }, 'workExperience has 2501 characters. The form allows at most 2500.'],
      [{ salaryType: 'GROSS' }, 'The profile form has no salary type field. djinni shows it only when the country is not Ukraine.'],
    ])('refuses the change %j before any POST', async (changes, message) => {
      const ctx = await setup();

      await expect(prepareProfileUpdate(ctx, changes as never)).rejects.toThrow(message);
      expect(posts()).toEqual([]);
      expect(listDrafts(ctx)).toEqual([]);
    });

    test.each([
      [{ nickname: 'x' }, 'nickname'],
      [{ formats: 'remote' }, 'formats'],
      [{ isDefender: 'yes' }, 'isDefender'],
      [{ skills: [{ name: 'CRM' }] }, 'skills'],
    ])('refuses the change %j that does not match the change schema, before any request', async (changes, path) => {
      const ctx = await setup();

      await expect(prepareProfileUpdate(ctx, changes as never)).rejects.toThrow(`The changes are not valid: ${path}`);
      expect(djinni.requests).toEqual([]);
    });

    test('needs a valid session', async () => {
      const ctx = await setup({}, tempStore());

      await expect(prepareProfileUpdate(ctx, { location: 'Lviv' })).rejects.toBeInstanceOf(NotLoggedInError);
    });
  });

  // The profile page after djinni saved the changes of the main submit test.
  const savedPage = () =>
    editProfile(PROFILE, $ => {
      $('#format_hybrid').attr('checked', '');
      $('#moreinfo').text('New text\r\nline 2');
      $('input[name="skills_experience[0][experience_years]"]').attr('value', '2');
      $('input[name="skills_experience[1][skill]"]').attr('value', 'TypeScript');
      $('input[name^="skills_experience["]').each((_, el) => {
        if (!/^skills_experience\[[01]\]/.test(el.attribs['name']!)) $(el).remove();
      });
    });

  const CHANGES = { formats: ['remote', 'hybrid'], workExperience: 'New text\nline 2', skills: [{ skill: 'CRM', years: 2 }, { skill: 'TypeScript' }] };

  // A fake djinni whose profile page changes to "after" when it gets the POST.
  async function setupSubmit(after: string | null, routes: Record<string, Route> = {}) {
    let page = PROFILE;
    return setup({
      'GET /my/profile/': () => page,
      'POST /my/profile/': () => {
        if (after !== null) page = after;
        return { status: 302, headers: { location: '/my/profile/' } };
      },
      ...routes,
    });
  }

  describe('submitProfileUpdate', () => {
    test('posts every field of the form with the changes and confirms them with a new GET', async () => {
      const ctx = await setupSubmit(savedPage());
      const { draftId } = await prepareProfileUpdate(ctx, CHANGES);

      const result = await submitProfileUpdate(ctx, draftId);

      expect(result).toEqual({ ok: true, changed: ['workExperience', 'skills', 'formats'], mismatches: [] });
      const [post] = posts();
      expect(post!.url).toBe('/my/profile/');
      expect(post!.headers['content-type']).toBe('application/x-www-form-urlencoded');
      const base = baseFields();
      const firstSkill = base.findIndex(([n]) => n.startsWith('skills_experience['));
      const afterSkills = base.findLastIndex(([n]) => n.startsWith('skills_experience[')) + 1;
      const expected = [
        ...base.slice(0, firstSkill),
        ['skills_experience[0][skill]', 'CRM'],
        ['skills_experience[0][experience_years]', '2'],
        ['skills_experience[1][skill]', 'TypeScript'],
        ['skills_experience[1][experience_years]', ''],
        ...base.slice(afterSkills),
      ]
        .map(([n, v]) => [n, n === 'moreinfo' ? 'New text\r\nline 2' : n === 'csrfmiddlewaretoken' ? 'CSRF' : v])
        .flatMap(([n, v]) => (n === 'format_options' ? [[n, 'remote'], [n, 'hybrid']] : [[n, v]]));
      expect(bodyEntries(post!.body)).toEqual(expected);
      expect(() => getDraft(ctx, draftId)).toThrow('is not known');
    });

    test('keeps the empty row of a row group when the new list is empty', async () => {
      const html = editProfile(PROFILE, $ => {
        $('input[name="certifications[0][name]"]').attr('value', 'AWS SAA');
      });
      const ctx = await setup({ 'GET /my/profile/': html, 'POST /my/profile/': { status: 302, headers: { location: '/my/profile/' } } });
      const { draftId } = await prepareProfileUpdate(ctx, { certifications: [], skills: [] });

      await submitProfileUpdate(ctx, draftId);

      const entries = bodyEntries(posts()[0]!.body);
      expect(entries.filter(([n]) => n.startsWith('certifications['))).toEqual([
        ['certifications[0][name]', ''],
        ['certifications[0][provider]', ''],
      ]);
      expect(entries.filter(([n]) => n.startsWith('skills_experience['))).toEqual([]);
    });

    test('sets the category in the select and in the hidden field of the category widget', async () => {
      const ctx = await setupSubmit(null);
      const { draftId } = await prepareProfileUpdate(ctx, { category: 'Python' });

      await submitProfileUpdate(ctx, draftId);

      const entries = bodyEntries(posts()[0]!.body);
      expect(entries.filter(([n]) => n === 'primary_keyword_cache' || n === '_tms_primary_keyword')).toEqual([
        ['primary_keyword_cache', 'Python'],
        ['_tms_primary_keyword', 'Python'],
      ]);
    });

    test('sets the checked salary type radio', async () => {
      const html = editProfile(PROFILE, $ => {
        $('#salary_min').after(
          '<input type="radio" name="salary_type" id="salary_type_net" value="NET" checked><input type="radio" name="salary_type" id="salary_type_gross" value="GROSS">',
        );
      });
      const ctx = await setup({ 'GET /my/profile/': html, 'POST /my/profile/': { status: 302, headers: { location: '/my/profile/' } } });
      const { draftId } = await prepareProfileUpdate(ctx, { salaryType: 'GROSS' });

      await submitProfileUpdate(ctx, draftId);

      expect(bodyEntries(posts()[0]!.body).filter(([n]) => n === 'salary_type')).toEqual([['salary_type', 'GROSS']]);
    });

    test('confirms a category change with the new GET', async () => {
      const after = editProfile(PROFILE, $ => {
        $('select[name="primary_keyword_cache"] option').removeAttr('selected');
        $('select[name="primary_keyword_cache"] option[value="Python"]').attr('selected', '');
        $('input[name="_tms_primary_keyword"]').attr('value', 'Python');
        const script = $('#primary_keyword_tree script.tms-data');
        script.text(script.text().replace('"selected": ["ML AI"]', '"selected": ["Python"]'));
      });
      const ctx = await setupSubmit(after);
      const { draftId } = await prepareProfileUpdate(ctx, { category: 'Python' });

      expect(await submitProfileUpdate(ctx, draftId)).toEqual({ ok: true, changed: ['category'], mismatches: [] });
    });

    test('sets the selected option of the selects', async () => {
      const ctx = await setupSubmit(null);
      const { draftId } = await prepareProfileUpdate(ctx, { experienceYears: '11', country: 'POL', preferredCommunication: 'telegram' });

      await submitProfileUpdate(ctx, draftId);

      const entries = bodyEntries(posts()[0]!.body);
      const names = ['experience_years', 'country_code', 'preferred_comm'];
      expect(entries.filter(([n]) => names.includes(n))).toEqual([
        ['experience_years', '11'],
        ['country_code', 'POL'],
        ['preferred_comm', 'telegram'],
      ]);
      expect(entries.map(([n]) => n)).toEqual(baseFields().map(([n]) => n));
    });

    test('checks a single checkbox at its place in the form', async () => {
      const ctx = await setupSubmit(null);
      const { draftId } = await prepareProfileUpdate(ctx, { isDefender: true });

      await submitProfileUpdate(ctx, draftId);

      const names = bodyEntries(posts()[0]!.body).map(([n]) => n);
      expect(bodyEntries(posts()[0]!.body).filter(([n]) => n === 'is_defender')).toEqual([['is_defender', 'on']]);
      expect(names.indexOf('is_defender')).toBe(names.indexOf('highlights') + 1);
    });

    test('sends the value attribute of a checked checkbox', async () => {
      const html = editProfile(PROFILE, $ => void $('#has_mobilization_deferment').attr('value', '1'));
      const ctx = await setup({ 'GET /my/profile/': html, 'POST /my/profile/': { status: 302, headers: { location: '/my/profile/' } } });
      const { draftId } = await prepareProfileUpdate(ctx, { hasMobilizationDeferment: true });

      await submitProfileUpdate(ctx, draftId);

      expect(bodyEntries(posts()[0]!.body).filter(([n]) => n === 'has_mobilization_deferment')).toEqual([['has_mobilization_deferment', '1']]);
    });

    test('refuses a stale draft when the profile changed after the draft, and sends no POST', async () => {
      const ctx = await setupSubmit(null);
      const { draftId } = await prepareProfileUpdate(ctx, CHANGES);
      djinni.routes.set('GET /my/profile/', PROFILE.replace('value="REDACTED_position"', 'value="Other position"'));

      await expect(submitProfileUpdate(ctx, draftId)).rejects.toThrow(
        'The profile on djinni changed after this draft. Make a new draft from the current profile.',
      );
      expect(posts()).toEqual([]);
    });

    test('accepts a new CSRF token on the page, because djinni changes it on each page', async () => {
      const ctx = await setupSubmit(savedPage());
      const { draftId } = await prepareProfileUpdate(ctx, CHANGES);
      const page = PROFILE.replace('value="CSRF_TOKEN"', 'value="OTHER_TOKEN"');
      let posted = false;
      djinni.routes.set('GET /my/profile/', () => (posted ? savedPage() : page));
      djinni.routes.set('POST /my/profile/', () => ((posted = true), { status: 302, headers: { location: '/my/profile/' } }));

      const result = await submitProfileUpdate(ctx, draftId);

      expect(result.ok).toBe(true);
    });

    test('reports the fields that djinni does not show after the POST and keeps the draft', async () => {
      const ctx = await setupSubmit(PROFILE);
      const { draftId } = await prepareProfileUpdate(ctx, { formats: ['remote', 'hybrid'], location: 'Lviv' });
      djinni.routes.set('POST /my/profile/', () => {
        djinni.routes.set('GET /my/profile/', editProfile(PROFILE, $ => void $('#location').attr('value', 'Lviv')));
        return { status: 200, body: 'form with errors' };
      });

      const result = await submitProfileUpdate(ctx, draftId);

      expect(result).toEqual({
        ok: false,
        changed: ['location'],
        mismatches: [{ field: 'formats', expected: 'remote, hybrid', actual: 'remote' }],
      });
      expect(getDraft(ctx, draftId).id).toBe(draftId);
    });

    test('throws for an HTTP error of the POST', async () => {
      const ctx = await setupSubmit(null, { 'POST /my/profile/': { status: 500, body: 'error' } });
      const { draftId } = await prepareProfileUpdate(ctx, { location: 'Lviv' });

      await expect(submitProfileUpdate(ctx, draftId)).rejects.toThrow('djinni returned HTTP 500 for POST /my/profile/.');
    });

    test('refuses an unknown draft and a draft of another kind before any request', async () => {
      const ctx = await setupSubmit(null);

      await expect(submitProfileUpdate(ctx, 'abcd1234')).rejects.toThrow('The draft ID "abcd1234" is not known.');
      expect(djinni.requests).toEqual([]);
    });

    test('refuses an expired draft', async () => {
      let time = new Date('2026-11-10T12:00:00.000Z');
      djinni = await startFakeDjinni({ 'GET /my/profile/': PROFILE });
      const ctx = new Ctx({ store: loggedInStore(), baseUrl: djinni.url, minIntervalMs: 0, now: () => time });
      const { draftId } = await prepareProfileUpdate(ctx, { location: 'Lviv' });
      time = new Date('2026-11-11T12:00:00.001Z');

      await expect(submitProfileUpdate(ctx, draftId)).rejects.toThrow(`The draft "${draftId}" expired at 2026-11-11T12:00:00.000Z. Make a new draft.`);
      expect(posts()).toEqual([]);
    });
  });
});
