import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { Ctx } from '../../src/context.ts';
import { createDraft, getDraft, listDrafts } from '../../src/core/drafts.ts';
import { fixture, loggedInStore, startFakeDjinni, tempStore, type FakeDjinni, type Route } from '../helpers.ts';
import { cli, fakeIo } from './helpers.ts';

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

const ACCOUNT = fixture('my_account_raw.html');
const RESUME = fixture('my_resume_raw.html').replace(/href="\?page=2"/g, '');
const NEW_CARD = '<div id="uploaded_cv_2800001"><div id="cv_rename_2800001"><a>CV_Test_User.pdf</a></div></div>';
const NEW_ACCOUNT = ACCOUNT.replace('<div id="uploaded_cv_list">', `<div id="uploaded_cv_list">${NEW_CARD}`);
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');
const now = () => new Date('2026-11-10T12:00:00.000Z');

async function setup(routes: Record<string, Route> = {}, store = loggedInStore()) {
  djinni = await startFakeDjinni({ 'GET /my/account/': ACCOUNT, 'GET /my/resume/': RESUME, ...routes });
  return { store, baseUrl: djinni.url, minIntervalMs: 0, now };
}

// A fake djinni that shows the new CV file after the POST.
async function setupSubmit(after = NEW_ACCOUNT) {
  const deps = await setup();
  djinni.routes.set('POST /my/account/', () => {
    djinni.routes.set('GET /my/account/', after);
    return { status: 302, headers: { location: '/my/account/' } };
  });
  return deps;
}

const posts = () => djinni.requests.filter(r => r.method === 'POST');

function pdfIn(deps: { store: { dir: string } }, name = 'CV_Test_User.pdf'): string {
  const file = join(deps.store.dir, name);
  writeFileSync(file, PDF);
  return file;
}

describe('djinni cv list', () => {
  test('prints the CV files in the profile and all uploaded CV files', async () => {
    const res = await cli(['cv', 'list'], await setup());

    expect(res.code).toBe(0);
    const out = res.out.split('\n');
    expect(out.slice(0, 3)).toEqual(['CV files in the profile (1 of 5):', '  2705342  TEXT_1 | uploaded TEXT_2', '']);
    expect(out[3]).toBe('All uploaded CV files (10):');
    expect(out[4]).toBe('  2766722  TEXT_5 | uploaded TEXT_6 | 1 shared link');
  });

  test('marks the default CV file and prints the JSON with --json', async () => {
    const deps = await setup({ 'GET /my/account/': ACCOUNT.replace(/hx-post="\/ajax\/cv_set_default\/[^"]*"/, '') });

    expect((await cli(['cv', 'list'], deps)).out).toContain('  2705342  TEXT_1 | default | uploaded TEXT_2\n');
    const json = JSON.parse((await cli(['cv', 'list', '--json'], deps)).out);
    expect(json).toMatchObject({ profileLimit: 5, profileCvs: [{ id: '2705342', isDefault: true }] });
  });

  test('strips the control characters of the server text', async () => {
    const deps = await setup({ 'GET /my/account/': ACCOUNT.replace('>TEXT_1</a>', '>Bad\u001b[31m name</a>') });

    expect((await cli(['cv', 'list'], deps)).out).toContain('  2705342  Bad[31m name | uploaded TEXT_2\n');
  });
});

describe('djinni cv render', () => {
  test('renders the Markdown file to the --out file and prints the path', async () => {
    const deps = await setup();
    const md = join(deps.store.dir, 'cv.md');
    writeFileSync(md, '# Тест\n\nТекст.');
    const out = join(deps.store.dir, 'cv.pdf');

    const res = await cli(['cv', 'render', md, '--out', out], deps);

    expect(res.code).toBe(0);
    expect(res.out).toMatch(new RegExp(`^Wrote ${out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(1 page, \\d+\\.\\d KB\\)\\. Nothing was sent to djinni\\.\\n$`));
    expect(readFileSync(out).subarray(0, 5).toString()).toBe('%PDF-');
    expect(djinni.requests).toEqual([]);
  });

  test('writes the --out file with mode 0600', async () => {
    const deps = await setup();
    const md = join(deps.store.dir, 'cv.md');
    writeFileSync(md, '# Тест');
    const out = join(deps.store.dir, 'mode.pdf');

    await cli(['cv', 'render', md, '--out', out], deps);

    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  test('refuses to overwrite an existing --out file without --force', async () => {
    const deps = await setup();
    const md = join(deps.store.dir, 'cv.md');
    writeFileSync(md, '# Тест');
    const out = join(deps.store.dir, 'old.pdf');
    writeFileSync(out, 'old');

    const res = await cli(['cv', 'render', md, '--out', out], deps);

    expect(res.code).toBe(1);
    expect(res.err).toContain(`The file ${out} already exists. Use --force to overwrite it.`);
    expect(readFileSync(out, 'utf8')).toBe('old');
  });

  test('overwrites an existing --out file with --force', async () => {
    const deps = await setup();
    const md = join(deps.store.dir, 'cv.md');
    writeFileSync(md, '# Тест');
    const out = join(deps.store.dir, 'old.pdf');
    writeFileSync(out, 'old');

    const res = await cli(['cv', 'render', md, '--out', out, '--force'], deps);

    expect(res.code).toBe(0);
    expect(readFileSync(out).subarray(0, 5).toString()).toBe('%PDF-');
  });

  test('writes to the cv folder of the data folder without --out', async () => {
    const deps = await setup();
    const md = join(deps.store.dir, 'cv.md');
    writeFileSync(md, '# Test User\n\nText.');

    const res = await cli(['cv', 'render', md, '--json'], deps);

    expect(JSON.parse(res.out).file).toBe(deps.store.path('cv', '20261110-120000-test-user.pdf'));
    expect(existsSync(deps.store.path('cv', '20261110-120000-test-user.pdf'))).toBe(true);
  });

  test('exits with 1 for a Markdown file that does not exist', async () => {
    const res = await cli(['cv', 'render', '/no/such/cv.md'], await setup());

    expect(res.code).toBe(1);
    expect(res.err).toContain('Cannot read the Markdown file /no/such/cv.md');
  });
});

describe('djinni cv import', () => {
  test('copies the PDF file into the CV folder with mode 0600 and prints the new path', async () => {
    const deps = await setup();
    const file = pdfIn(deps);

    const res = await cli(['cv', 'import', file], deps);

    const copy = deps.store.path('cv', 'CV_Test_User.pdf');
    expect(res.code).toBe(0);
    expect(res.out).toBe(`Copied the file to ${copy}\n`);
    expect(readFileSync(copy).equals(PDF)).toBe(true);
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    expect(djinni.requests).toEqual([]);
  });

  test('adds a number to the name when the CV folder has a file with that name', async () => {
    const deps = await setup();
    const file = pdfIn(deps);
    await cli(['cv', 'import', file], deps);

    const res = await cli(['cv', 'import', file, '--json'], deps);

    expect(JSON.parse(res.out)).toEqual({ file: deps.store.path('cv', 'CV_Test_User-2.pdf'), size: PDF.length });
    expect(readFileSync(deps.store.path('cv', 'CV_Test_User.pdf')).equals(PDF)).toBe(true);
  });

  test('refuses a file that is not a PDF file', async () => {
    const deps = await setup();
    const file = join(deps.store.dir, 'cv.pdf');
    writeFileSync(file, 'Hello');

    const res = await cli(['cv', 'import', file], deps);

    expect(res.code).toBe(1);
    expect(res.err).toContain('is not a PDF file');
    expect(existsSync(deps.store.path('cv', 'cv.pdf'))).toBe(false);
  });

  test('refuses a file bigger than 10 MB', async () => {
    const deps = await setup();
    const file = join(deps.store.dir, 'big.pdf');
    writeFileSync(file, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(10_000_000 - 8)]));

    const res = await cli(['cv', 'import', file], deps);

    expect(res.code).toBe(1);
    expect(res.err).toContain('djinni accepts at most 10000000 bytes (10 MB).');
    expect(existsSync(deps.store.path('cv', 'big.pdf'))).toBe(false);
  });
});

describe('djinni cv prepare', () => {
  test('makes a draft and prints the file, the name, the size and the submit command', async () => {
    const deps = await setup();
    const file = pdfIn(deps);

    const res = await cli(['cv', 'prepare', file], deps);

    expect(res.code).toBe(0);
    const id = listDrafts(new Ctx(deps))[0]!.id;
    expect(res.out).toBe(
      [
        `File: ${file}`,
        'Name on djinni: CV_Test_User.pdf',
        `Size: ${PDF.length} bytes`,
        '',
        `Draft ${id} expires at 2026-11-11T12:00:00.000Z. Nothing was sent to djinni.`,
        `Upload it with: npx djinni-mcp cv submit ${id}`,
        '',
      ].join('\n'),
    );
    expect(posts()).toEqual([]);
  });

  test('takes the name on djinni from --name', async () => {
    const deps = await setup();

    const res = await cli(['cv', 'prepare', pdfIn(deps, '1.pdf'), '--name', 'CV_Test_User', '--json'], deps);

    expect(JSON.parse(res.out).name).toBe('CV_Test_User.pdf');
  });

  test('exits with 1 and lists the CV files when the profile is full', async () => {
    const card = ACCOUNT.slice(ACCOUNT.indexOf('<div id="uploaded_cv_2705342"'), ACCOUNT.indexOf('<a href="#" role="button" hx-get="/ajax/cv_input/'));
    const full = ACCOUNT.replace(card, ['1', '2', '3', '4', '5'].map(id => card.replaceAll('2705342', id)).join(''));
    const deps = await setup({ 'GET /my/account/': full });

    const res = await cli(['cv', 'prepare', pdfIn(deps)], deps);

    expect(res.code).toBe(1);
    expect(res.err).toContain('The profile already holds 5 CV files.');
    expect(res.err).toContain('Ask the user which CV file to delete first.');
  });
});

describe('djinni cv submit', () => {
  async function draftFor(deps: Awaited<ReturnType<typeof setup>>) {
    await cli(['cv', 'prepare', pdfIn(deps)], deps);
    return listDrafts(new Ctx(deps))[0]!.id;
  }

  test('prints the draft, asks for the approval and uploads the file on "y"', async () => {
    const deps = await setupSubmit();
    const id = await draftFor(deps);
    const io = fakeIo({ prompt: ['y'] });

    const res = await cli(['cv', 'submit', id], deps, io);

    expect(res.code).toBe(0);
    expect(io.questions).toEqual(['Upload this CV to djinni? [y/N] ']);
    expect(res.out).toBe(
      `File: ${join(deps.store.dir, 'CV_Test_User.pdf')}\nName on djinni: CV_Test_User.pdf\nSize: ${PDF.length} bytes\n\ndjinni shows the new CV file: 2800001  CV_Test_User.pdf\n`,
    );
    expect(posts()).toHaveLength(1);
  });

  test.each([[''], ['n'], ['no']])('sends nothing for the answer %j', async answer => {
    const deps = await setupSubmit();
    const id = await draftFor(deps);

    const res = await cli(['cv', 'submit', id], deps, fakeIo({ prompt: [answer] }));

    expect(res.code).toBe(1);
    expect(res.err).toBe('Canceled. Nothing was sent to djinni.\n');
    expect(posts()).toEqual([]);
    expect(getDraft(new Ctx(deps), id).id).toBe(id);
  });

  test('--yes uploads at once without a question', async () => {
    const deps = await setupSubmit();
    const id = await draftFor(deps);
    const io = fakeIo();

    const res = await cli(['cv', 'submit', id, '--yes', '--json'], deps, io);

    expect(res.code).toBe(0);
    expect(io.questions).toEqual([]);
    expect(JSON.parse(res.out)).toEqual({ ok: true, cv: { id: '2800001', name: 'CV_Test_User.pdf', isDefault: true, uploaded: null } });
  });

  test('--json without --yes prints the draft to stderr and only the result to stdout', async () => {
    const deps = await setupSubmit();
    const id = await draftFor(deps);

    const res = await cli(['cv', 'submit', id, '--json'], deps, fakeIo({ prompt: ['y'] }));

    expect(res.err).toContain('Name on djinni: CV_Test_User.pdf\n');
    expect(JSON.parse(res.out)).toMatchObject({ ok: true });
  });

  test('says "no HTTP answer" and exits with 1 when the connection closes during the upload', async () => {
    const deps = await setup();
    djinni.routes.set('POST /my/account/', { closeConnection: true });
    const id = await draftFor(deps);

    const res = await cli(['cv', 'submit', id, '--yes'], deps);

    expect(res.code).toBe(1);
    expect(res.out).toMatch(/^djinni shows no new CV file after the upload \(no HTTP answer\)\.\n/);
    expect(res.out).toContain('Call list_my_cvs before any retry.');
  });

  test('prints the status and the text of djinni and exits with 1 when no new CV file appears', async () => {
    const deps = await setupSubmit(ACCOUNT);
    const id = await draftFor(deps);

    const res = await cli(['cv', 'submit', id, '--yes'], deps);

    expect(res.code).toBe(1);
    expect(res.out).toMatch(/^djinni shows no new CV file after the upload \(HTTP 302\)\.\n/);
    expect(res.out).toContain(`The draft ${id} stays.`);
  });
});

describe('djinni drafts list', () => {
  test('shows the file name of a CV upload draft', async () => {
    const store = tempStore();
    const draft = createDraft(new Ctx({ store, now }), 'cv_upload', {}, { file: '/x/CV.pdf', name: 'CV.pdf', size: 10 });

    const res = await cli(['drafts', 'list'], { store, now });

    expect(res.out).toBe(`${draft.id}  cv_upload | expires 2026-11-11T12:00:00.000Z | CV.pdf\n`);
  });
});
