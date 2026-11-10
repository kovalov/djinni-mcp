import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { Ctx } from '../../src/context.ts';
import { createDraft, getDraft, listDrafts } from '../../src/core/drafts.ts';
import { fixture, loggedInStore, startFakeDjinni, tempStore, type FakeDjinni, type Route } from '../helpers.ts';
import { cli, fakeIo } from './helpers.ts';

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

const PROFILE = fixture('my_profile.html');
const now = () => new Date('2026-11-10T12:00:00.000Z');
const LOCATION_INPUT = 'name="location" id="location" autocomplete="off" data-provide="" maxlength="255" class="form-control js-update-avg-salary" value=""';
const withLocation = (city: string) => PROFILE.replace(LOCATION_INPUT, LOCATION_INPUT.replace('value=""', `value="${city}"`));

async function setup(routes: Record<string, Route> = {}, store = loggedInStore()) {
  djinni = await startFakeDjinni({ 'GET /my/profile/': PROFILE, ...routes });
  return { store, baseUrl: djinni.url, minIntervalMs: 0, now };
}

// A fake djinni that shows the new city after the POST.
async function setupSubmit(city = 'Lviv') {
  const deps = await setup();
  djinni.routes.set('POST /my/profile/', () => {
    djinni.routes.set('GET /my/profile/', withLocation(city));
    return { status: 302, headers: { location: '/my/profile/' } };
  });
  return deps;
}

const posts = () => djinni.requests.filter(r => r.method === 'POST');

describe('djinni profile show', () => {
  test('prints the profile as text', async () => {
    const res = await cli(['profile', 'show'], await setup());

    expect(res.code).toBe(0);
    const lines = res.out.split('\n');
    expect(lines[0]).toBe('REDACTED_position');
    expect(lines).toContain('Category: Data Science → ML / AI (ML AI)');
    expect(lines).toContain('Salary: 3500');
    expect(lines).toContain('Hourly rate: (empty)');
    expect(lines).toContain('Experience: 5 років (10)');
    expect(lines).toContain('Languages: eng B2, ukr native');
    expect(lines).toContain('Work formats: remote');
    expect(lines).toContain('Defender: no');
    expect(lines).toContain('Work experience:');
    expect(lines).toContain('REDACTED_moreinfo');
    expect(res.out).toMatch(/^Skills: CRM, Zapier, /m);
  });

  test('--json prints the profile with the options', async () => {
    const res = await cli(['profile', 'show', '--json'], await setup());

    const profile = JSON.parse(res.out);
    expect(profile).toMatchObject({ position: 'REDACTED_position', formats: ['remote'] });
    expect(profile.options.formats).toHaveLength(3);
  });

  test('removes the control characters from the text', async () => {
    const res = await cli(['profile', 'show'], await setup({ 'GET /my/profile/': PROFILE.replace('REDACTED_moreinfo', 'Bad\u001b[31m text') }));

    expect(res.out).toContain('Bad[31m text');
    expect(res.out).not.toContain('\u001b');
  });
});

describe('djinni profile prepare', () => {
  test('makes a draft from --set values and prints the diff and the next command', async () => {
    const deps = await setup();

    const res = await cli(
      ['profile', 'prepare', '--set', 'formats=remote,office', '--set', 'location=Lviv', '--set', 'skills=CRM:2,TypeScript', '--set', 'salaryHour=25', '--set', 'isDefender=false'],
      deps,
    );

    expect(res.code).toBe(0);
    const [draft] = listDrafts(new Ctx(deps));
    expect(res.out).toBe(
      [
        'salaryHour:',
        '  - (empty)',
        '  + 25',
        'skills:',
        '  - CRM, Zapier, Lead generation and sales qualification, Automation, Marketing Automation, Data analysis, Управління відділами продажу, n8n, Штучний інтелект (AI), Автоматизація бізнес-процесів, Автоматизація продажів, CRM Automation',
        '  + CRM (2 years), TypeScript',
        'location:',
        '  - (empty)',
        '  + Lviv',
        'formats:',
        '  - remote',
        '  + remote, office',
        '',
        `Draft ${draft!.id} expires at 2026-11-11T12:00:00.000Z. Nothing was sent to djinni.`,
        `Send it with: npx djinni-mcp profile submit ${draft!.id}`,
        '',
      ].join('\n'),
    );
    expect(posts()).toEqual([]);
  });

  test('indents the next lines of a multiline value', async () => {
    const res = await cli(['profile', 'prepare', '--set', 'workExperience=Line 1\nLine 2'], await setup());

    expect(res.out).toMatch(/^workExperience:\n {2}- REDACTED_moreinfo\n {2}\+ Line 1\n {4}Line 2\n/);
  });

  test('reads the changes from --file, and --set overrides the file', async () => {
    const deps = await setup();
    const file = join(deps.store.dir, 'changes.json');
    writeFileSync(file, JSON.stringify({ location: 'Kyiv', languages: [{ code: 'eng', level: 'C1' }], domainZones: ['gambling'] }));

    const res = await cli(['profile', 'prepare', '--file', file, '--set', 'location=Odesa', '--json'], deps);

    expect(res.code).toBe(0);
    expect(JSON.parse(res.out).diff).toEqual([
      { field: 'languages', old: 'eng B2, ukr native', new: 'eng C1' },
      { field: 'location', old: '(empty)', new: 'Odesa' },
      { field: 'domainZones', old: '(none)', new: 'gambling' },
    ]);
  });

  test('reads the rows of --set languages, domains and certifications', async () => {
    const res = await cli(
      ['profile', 'prepare', '--set', 'languages=eng:C1,ukr:native', '--set', 'domains=fintech:1.5', '--set', 'certifications=AWS SAA:Amazon,Scrum', '--set', 'employment=', '--json'],
      await setup(),
    );

    expect(JSON.parse(res.out).diff).toEqual([
      { field: 'languages', old: 'eng B2, ukr native', new: 'eng C1, ukr native' },
      { field: 'domains', old: '(none)', new: 'fintech (1.5 years)' },
      { field: 'certifications', old: '(none)', new: 'AWS SAA (Amazon), Scrum' },
      { field: 'employment', old: 'parttime', new: '(none)' },
    ]);
  });

  test.each([
    [['--set', 'nickname=x'], 'Unknown profile key "nickname".'],
    [['--set', 'location'], '--set needs the form <key>=<value>, not "location".'],
    [['--set', 'salaryMin=abc'], 'salaryMin needs a number, not "abc".'],
    [['--set', 'isDefender=maybe'], 'isDefender needs true or false, not "maybe".'],
    [['--set', 'languages=eng'], 'languages needs items like eng:B2, not "eng".'],
    [[], '"npx djinni-mcp profile prepare" needs --set or --file.'],
  ])('exits with 2 for the bad command line %j', async (flags, message) => {
    const res = await cli(['profile', 'prepare', ...flags], await setup());

    expect(res.code).toBe(2);
    expect(res.err).toContain(message);
    expect(djinni.requests).toEqual([]);
  });

  test('exits with 1 for a value that the profile does not allow', async () => {
    const res = await cli(['profile', 'prepare', '--set', 'formats=moon'], await setup());

    expect(res.code).toBe(1);
    expect(res.err).toContain('"moon" is not an allowed value for formats.');
  });

  test('exits with 1 for a changes file that is not a JSON object', async () => {
    const deps = await setup();
    const file = join(deps.store.dir, 'changes.json');
    writeFileSync(file, '[1]');

    const res = await cli(['profile', 'prepare', '--file', file], deps);

    expect(res.code).toBe(1);
    expect(res.err).toContain(`The file ${file} has no JSON object with profile changes.`);
  });
});

describe('djinni profile submit', () => {
  async function draftFor(deps: Awaited<ReturnType<typeof setup>>) {
    await cli(['profile', 'prepare', '--set', 'location=Lviv'], deps);
    return listDrafts(new Ctx(deps))[0]!.id;
  }

  test('prints the diff, asks for the approval and sends the draft on "y"', async () => {
    const deps = await setupSubmit();
    const id = await draftFor(deps);
    const io = fakeIo({ prompt: ['y'] });

    const res = await cli(['profile', 'submit', id], deps, io);

    expect(res.code).toBe(0);
    expect(io.questions).toEqual(['Send this change to djinni? [y/N] ']);
    expect(res.out).toBe('location:\n  - (empty)\n  + Lviv\n\ndjinni saved the changes: location.\n');
    expect(posts()).toHaveLength(1);
  });

  test.each([['yes'], [' YES '], ['Y']])('accepts the answer %j', async answer => {
    const deps = await setupSubmit();
    const id = await draftFor(deps);

    const res = await cli(['profile', 'submit', id], deps, fakeIo({ prompt: [answer] }));

    expect(res.code).toBe(0);
    expect(posts()).toHaveLength(1);
  });

  test.each([[''], ['n'], ['no'], ['yep']])('sends nothing for the answer %j', async answer => {
    const deps = await setupSubmit();
    const id = await draftFor(deps);

    const res = await cli(['profile', 'submit', id], deps, fakeIo({ prompt: [answer] }));

    expect(res.code).toBe(1);
    expect(res.err).toBe('Canceled. Nothing was sent to djinni.\n');
    expect(posts()).toEqual([]);
    expect(getDraft(new Ctx(deps), id).id).toBe(id);
  });

  test('--yes sends at once without a question', async () => {
    const deps = await setupSubmit();
    const id = await draftFor(deps);
    const io = fakeIo();

    const res = await cli(['profile', 'submit', id, '--yes', '--json'], deps, io);

    expect(res.code).toBe(0);
    expect(io.questions).toEqual([]);
    expect(JSON.parse(res.out)).toEqual({ ok: true, changed: ['location'], mismatches: [] });
  });

  test('--json without --yes prints the diff to stderr and only the result to stdout', async () => {
    const deps = await setupSubmit();
    const id = await draftFor(deps);

    const res = await cli(['profile', 'submit', id, '--json'], deps, fakeIo({ prompt: ['y'] }));

    expect(res.err).toContain('location:\n  - (empty)\n  + Lviv\n');
    expect(JSON.parse(res.out)).toMatchObject({ ok: true });
  });

  test('prints the mismatches and exits with 1', async () => {
    const deps = await setupSubmit('Kyiv');
    const id = await draftFor(deps);

    const res = await cli(['profile', 'submit', id, '--yes'], deps);

    expect(res.code).toBe(1);
    expect(res.out).toBe('djinni does not show these changes after the POST:\n  location: expected Lviv, got Kyiv\n');
  });

  test('exits with 1 for an unknown draft and asks nothing', async () => {
    const deps = await setup();
    const io = fakeIo({ prompt: ['y'] });

    const res = await cli(['profile', 'submit', 'abcd1234'], deps, io);

    expect(res.code).toBe(1);
    expect(res.err).toContain('The draft ID "abcd1234" is not known.');
    expect(io.questions).toEqual([]);
    expect(djinni.requests).toEqual([]);
  });
});

describe('djinni drafts', () => {
  test('list prints one line per draft with the changed fields', async () => {
    const store = tempStore();
    const ctx = new Ctx({ store, now });
    const draft = createDraft(ctx, 'profile', {}, { diff: [{ field: 'location', old: '', new: 'Lviv' }, { field: 'formats', old: '', new: '' }] });

    const res = await cli(['drafts', 'list'], { store, now });

    expect(res.out).toBe(`${draft.id}  profile | expires 2026-11-11T12:00:00.000Z | location, formats\n`);
  });

  test('list --json leaves out the payload', async () => {
    const store = tempStore();
    const ctx = new Ctx({ store, now });
    const draft = createDraft(ctx, 'profile', { secret: 1 }, { diff: [] });

    const res = await cli(['drafts', 'list', '--json'], { store, now });

    expect(JSON.parse(res.out)).toEqual([{ id: draft.id, kind: 'profile', createdAt: draft.createdAt, expiresAt: draft.expiresAt, preview: { diff: [] } }]);
  });

  test('list says that there are no drafts', async () => {
    const res = await cli(['drafts', 'list'], { store: tempStore(), now });

    expect(res.out).toBe('No drafts.\n');
  });

  test('rm deletes a draft', async () => {
    const store = tempStore();
    const ctx = new Ctx({ store, now });
    const draft = createDraft(ctx, 'profile', {}, {});

    const res = await cli(['drafts', 'rm', draft.id], { store, now });

    expect(res.code).toBe(0);
    expect(res.out).toBe(`Deleted the draft ${draft.id}.\n`);
    expect(listDrafts(ctx)).toEqual([]);
  });

  test('rm exits with 1 for an unknown ID', async () => {
    const res = await cli(['drafts', 'rm', 'abcd1234'], { store: tempStore(), now });

    expect(res.code).toBe(1);
    expect(res.err).toContain('The draft ID "abcd1234" is not known.');
  });
});
