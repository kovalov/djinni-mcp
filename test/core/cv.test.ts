import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { afterEach, describe, expect, test } from 'vitest';
import { Ctx } from '../../src/context.ts';
import { getDraft, listDrafts } from '../../src/core/drafts.ts';
import { listMyCvs, prepareCvUpload, renderCvPdf, submitCvUpload } from '../../src/core/cv.ts';
import { fixture, loggedInStore, startFakeDjinni, type FakeDjinni, type Recorded, type Route } from '../helpers.ts';
import { readPdf } from '../pdf.ts';

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

const ACCOUNT = fixture('my_account_raw.html');
const RESUME = fixture('my_resume_raw.html');
// The CV list as one page, without a link to a next page.
const RESUME_ONE = RESUME.replace(/href="\?page=2"/g, '');
const now = () => new Date('2026-11-10T12:00:00.000Z');

async function setup(routes: Record<string, Route> = {}, store = loggedInStore()) {
  djinni = await startFakeDjinni({ 'GET /my/account/': ACCOUNT, ...routes });
  return new Ctx({ store, baseUrl: djinni.url, minIntervalMs: 0, now });
}

// The account page with one profile CV card for each ID.
function accountWithCvs(ids: string[], html = ACCOUNT): string {
  const $ = cheerio.load(html);
  const card = $('#uploaded_cv_2705342');
  const cardHtml = $.html(card);
  card.replaceWith(ids.map(id => cardHtml.replaceAll('2705342', id)).join(''));
  return $.html();
}

// A small PDF file with bytes that are not valid UTF-8, to check that the upload sends the exact bytes.
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from([0x00, 0xe2, 0xff, 0x80, 0x0d, 0x0a]), Buffer.from('\n%%EOF\n')]);

function tempFile(name: string, data: Buffer | string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'djinni-cv-')), name);
  writeFileSync(file, data);
  return file;
}

type Part = { name: string; filename?: string; type?: string; data: Buffer };

// Splits a recorded multipart body into its parts. The fake server records the body as latin1.
function multipart(req: Recorded): Part[] {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/.exec(String(req.headers['content-type']));
  if (!m) throw new Error(`The request is not multipart: ${req.headers['content-type']}`);
  const boundary = m[1] ?? m[2]!;
  return req.body
    .split(`--${boundary}`)
    .slice(1, -1)
    .map(chunk => {
      const raw = chunk.replace(/^\r\n/, '').replace(/\r\n$/, '');
      const split = raw.indexOf('\r\n\r\n');
      const head = raw.slice(0, split);
      return {
        name: /name="([^"]*)"/.exec(head)![1]!,
        filename: /filename="([^"]*)"/.exec(head)?.[1],
        type: /content-type:\s*(\S+)/i.exec(head)?.[1],
        data: Buffer.from(raw.slice(split + 4), 'latin1'),
      };
    });
}

const posts = () => djinni.requests.filter(r => r.method === 'POST');

describe('listMyCvs', () => {
  test('returns the profile CV files, all uploaded CV files of all pages and the profile limit', async () => {
    // The last page: other CV IDs and no link to a next page.
    const last = cheerio.load(RESUME);
    last('.pagination.justify-content-end').empty();
    const page2Html = last.html().replace(/(cv_file_row_|cv_rename_)(\d+)/g, (_, prefix: string, id: string) => `${prefix}9${id}`);
    const ctx = await setup({ 'GET /my/resume/': RESUME, 'GET /my/resume/?page=2': page2Html });

    const result = await listMyCvs(ctx);

    expect(result.profileLimit).toBe(5);
    expect(result.profileCvs).toEqual([{ id: '2705342', name: 'TEXT_1', isDefault: false, uploaded: 'TEXT_2' }]);
    expect(result.allCvs).toHaveLength(20);
    expect(result.allCvs[0]).toEqual({ id: '2766722', name: 'TEXT_5', uploaded: 'TEXT_6', sharedLinks: 1 });
    expect(result.allCvs[10]!.id).toBe('92766722');
    expect(djinni.requests.map(r => r.url)).toEqual(['/my/account/', '/my/resume/', '/my/resume/?page=2']);
  });

  test('stops after 50 pages of the CV list', async () => {
    const ctx = await setup({
      'GET /my/resume/': req => {
        const page = Number(/page=(\d+)/.exec(req.url)?.[1] ?? '1');
        return `<ul class="pagination justify-content-end"><li><a href="?page=${page + 1}">next</a></li></ul>`;
      },
    });

    await listMyCvs(ctx);

    expect(djinni.requests.filter(r => r.url.startsWith('/my/resume/'))).toHaveLength(50);
  });

  test('fails when the account page has no account form', async () => {
    const ctx = await setup({ 'GET /my/account/': '<html><body>Login</body></html>' });

    await expect(listMyCvs(ctx)).rejects.toThrow('djinni sent no account form on /my/account/.');
  });
});

// The font embedding and the pdf.js text extraction are slow on a machine under load.
describe('renderCvPdf', { timeout: 30_000 }, () => {
  const MARKDOWN = [
    '# Іван Тестовий',
    '',
    'Менеджер з продажу. **Жирний текст** і *курсив*, [GitHub](https://github.com/example).',
    '',
    '## Досвід',
    '',
    '### Компанія Альфа',
    '',
    '- Перший пункт',
    '- Другий пункт з **жирним**',
    '',
    '1. Крок один',
    '2. Крок два',
  ].join('\n');

  test('writes a PDF file to the cv folder of the data folder and returns its path, page count and size', async () => {
    const store = loggedInStore();
    const ctx = await setup({}, store);

    const result = await renderCvPdf(ctx, { markdown: MARKDOWN });

    expect(result.file).toBe(store.path('cv', '20261110-120000-іван-тестовий.pdf'));
    expect(readFileSync(result.file).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(result.pages).toBe(1);
    expect(result.size).toBe(statSync(result.file).size);
    expect(djinni.requests).toEqual([]);
  });

  test('puts the Cyrillic text of the headings, paragraphs and lists in the PDF', async () => {
    const ctx = await setup();

    const result = await renderCvPdf(ctx, { markdown: MARKDOWN });
    const [page] = await readPdf(readFileSync(result.file));
    const text = page!.text.replace(/\s+/g, ' ');

    for (const part of ['Іван Тестовий', 'Менеджер з продажу.', 'Жирний текст', 'курсив', 'GitHub', 'Досвід', 'Компанія Альфа', 'Перший пункт', 'Другий пункт з', 'жирним', 'Крок один', 'Крок два']) {
      expect(text).toContain(part);
    }
    expect(text).toMatch(/•\s*Перший пункт/);
    expect(text).toMatch(/1\.\s*Крок один/);
    expect(text).toMatch(/2\.\s*Крок два/);
  });

  test('embeds the bold and italic fonts and makes a link for a Markdown link', async () => {
    const ctx = await setup();

    const result = await renderCvPdf(ctx, { markdown: MARKDOWN });
    const pdf = readFileSync(result.file).toString('latin1');
    const [page] = await readPdf(readFileSync(result.file));

    expect(pdf).toMatch(/DejaVuSans-Bold\b/);
    expect(pdf).toMatch(/DejaVuSans-Oblique\b/);
    expect(page!.links).toEqual(['https://github.com/example']);
  });

  test('makes the default file readable only by the owner, because a CV holds personal data', async () => {
    const store = loggedInStore();
    const ctx = await setup({}, store);

    const result = await renderCvPdf(ctx, { markdown: MARKDOWN });

    expect(statSync(result.file).mode & 0o777).toBe(0o600);
    expect(statSync(store.path('cv')).mode & 0o777).toBe(0o700);
  });

  test('writes the file to outFile when it is given', async () => {
    const ctx = await setup();
    const out = join(mkdtempSync(join(tmpdir(), 'djinni-cv-')), 'my-cv.pdf');

    const result = await renderCvPdf(ctx, { markdown: MARKDOWN, outFile: out });

    expect(result.file).toBe(out);
    expect(existsSync(out)).toBe(true);
  });

  test('adds pages for a long CV', async () => {
    const ctx = await setup();
    const long = Array.from({ length: 120 }, (_, i) => `Абзац ${i} з текстом про досвід роботи.`).join('\n\n');

    const result = await renderCvPdf(ctx, { markdown: long });

    expect(result.pages).toBeGreaterThan(1);
    expect(await readPdf(readFileSync(result.file))).toHaveLength(result.pages);
  });

  test('keeps the marker of a list item on the page of the item text', async () => {
    const ctx = await setup();
    const items = Array.from({ length: 80 }, (_, i) => `- Пункт ${i}`).join('\n');

    const result = await renderCvPdf(ctx, { markdown: `# Тест\n\n${items}` });
    const pages = await readPdf(readFileSync(result.file));

    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.text.match(/•/g)?.length).toBe(page.text.match(/Пункт \d+/g)?.length);
  });

  test('gives a new file name to a second render with the same heading in the same second', async () => {
    const store = loggedInStore();
    const ctx = await setup({}, store);

    const first = await renderCvPdf(ctx, { markdown: '# Тест\n\nПерший.' });
    const second = await renderCvPdf(ctx, { markdown: '# Тест\n\nДругий.' });

    expect(first.file).toBe(store.path('cv', '20261110-120000-тест.pdf'));
    expect(second.file).toBe(store.path('cv', '20261110-120000-тест-2.pdf'));
    expect((await readPdf(readFileSync(first.file)))[0]!.text).toContain('Перший.');
    expect((await readPdf(readFileSync(second.file)))[0]!.text).toContain('Другий.');
  });

  test('refuses to overwrite an existing outFile and keeps its content', async () => {
    const ctx = await setup();
    const out = tempFile('cv.pdf', 'old');

    await expect(renderCvPdf(ctx, { markdown: '# Тест', outFile: out })).rejects.toThrow(`The file ${out} already exists.`);
    expect(readFileSync(out, 'utf8')).toBe('old');
  });

  test('overwrites an existing outFile with overwrite true and writes it with mode 0600', async () => {
    const ctx = await setup();
    const out = tempFile('cv.pdf', 'old');

    await renderCvPdf(ctx, { markdown: '# Тест', outFile: out, overwrite: true });

    expect(readFileSync(out).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  test.each([
    ['table', '| a | b |\n|---|---|\n| 1 | 2 |'],
    ['html', '<div>Block HTML</div>'],
    ['html', 'Text with <b>inline HTML</b>.'],
  ])('refuses Markdown with a %s token and writes no file', async (type, markdown) => {
    const store = loggedInStore();
    const ctx = await setup({}, store);

    await expect(renderCvPdf(ctx, { markdown: `# Тест\n\n${markdown}` })).rejects.toThrow(
      `The Markdown has a token of the type "${type}". The CV renderer does not support this type.`,
    );
    expect(existsSync(store.path('cv')) ? readdirSync(store.path('cv')) : []).toEqual([]);
  });

  test.each([['javascript:alert(1)'], ['file:///etc/passwd'], ['data:text/html,x']])('renders a link to %s as plain text without a link', async href => {
    const ctx = await setup();

    const result = await renderCvPdf(ctx, { markdown: `Text [Bad link](${href}) and [Mail](mailto:a@example.com) and [Web](http://example.com).` });
    const [page] = await readPdf(readFileSync(result.file));

    const pdf = readFileSync(result.file).toString('latin1');

    expect(page!.text).toContain('Bad link');
    // pdf.js hides unsafe link targets, so the check reads the link annotations of the raw PDF.
    expect(pdf.match(/\/Subtype \/Link/g)).toHaveLength(2);
    expect(pdf).not.toContain(href.slice(0, href.indexOf(':') + 1));
    expect(page!.links).toEqual(['mailto:a@example.com', 'http://example.com/']);
  });

  test('uses "cv" as the file name when the CV has no heading', async () => {
    const store = loggedInStore();
    const ctx = await setup({}, store);

    const result = await renderCvPdf(ctx, { markdown: 'Only a paragraph.' });

    expect(result.file).toBe(store.path('cv', '20261110-120000-cv.pdf'));
  });

  test('fails for Markdown without text', async () => {
    const ctx = await setup();

    await expect(renderCvPdf(ctx, { markdown: '  \n\n ' })).rejects.toThrow('The Markdown has no text.');
  });
});

describe('prepareCvUpload', () => {
  test('saves a cv_upload draft with the file path, its SHA-256, the size and the account form', async () => {
    const file = tempFile('CV_Test_User.pdf', PDF);
    const ctx = await setup();

    const result = await prepareCvUpload(ctx, { file });

    expect(result).toEqual({ draftId: expect.stringMatching(/^[0-9a-f]{8}$/), expiresAt: '2026-11-11T12:00:00.000Z', file, name: 'CV_Test_User.pdf', size: PDF.length });
    const draft = getDraft<Record<string, unknown>>(ctx, result.draftId, 'cv_upload');
    expect(draft.payload).toEqual({
      file,
      name: 'CV_Test_User.pdf',
      sha256: createHash('sha256').update(PDF).digest('hex'),
      size: PDF.length,
      form: [
        ['name', 'REDACTED_name'],
        ['email', 'REDACTED_email'],
        ['phone', ''],
        ['telegram', 'REDACTED_telegram'],
        ['whatsapp', ''],
        ['github', ''],
        ['portfolio', ''],
        ['linkedin', ''],
      ],
    });
    expect(djinni.requests.map(r => `${r.method} ${r.url}`)).toEqual(['GET /my/account/']);
  });

  test('returns the page count of the PDF when the file shows it', async () => {
    const pdf = await renderCvPdf(await setup(), { markdown: '# Тест\n\nТекст.' });
    await djinni.close();
    const ctx = await setup();

    const result = await prepareCvUpload(ctx, { file: pdf.file });

    expect(result.pages).toBe(1);
  });

  test('uses the given name as the file name on djinni and adds ".pdf" when it is missing', async () => {
    const file = tempFile('20261110-cv.pdf', PDF);
    const ctx = await setup();

    expect((await prepareCvUpload(ctx, { file, name: 'CV_Test_User' })).name).toBe('CV_Test_User.pdf');
    expect((await prepareCvUpload(ctx, { file, name: 'CV Test.PDF' })).name).toBe('CV Test.PDF');
  });

  test('refuses a name with a folder', async () => {
    const ctx = await setup();

    await expect(prepareCvUpload(ctx, { file: tempFile('cv.pdf', PDF), name: '../cv.pdf' })).rejects.toThrow('The name "../cv.pdf" must be a file name without a folder.');
  });

  test('refuses a file that does not exist', async () => {
    const ctx = await setup();

    await expect(prepareCvUpload(ctx, { file: '/no/such/cv.pdf' })).rejects.toThrow('The file /no/such/cv.pdf does not exist.');
    expect(djinni.requests).toEqual([]);
  });

  test('refuses a file that is not a PDF', async () => {
    const ctx = await setup();
    const file = tempFile('cv.pdf', 'Hello');

    await expect(prepareCvUpload(ctx, { file })).rejects.toThrow(`The file ${file} is not a PDF file. djinni accepts only PDF files.`);
    expect(djinni.requests).toEqual([]);
  });

  test('refuses a file bigger than 10 MB (10,000,000 bytes)', async () => {
    const ctx = await setup();
    const file = tempFile('cv.pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(10_000_000 - 8)]));

    await expect(prepareCvUpload(ctx, { file })).rejects.toThrow(`The file ${file} has 10000001 bytes. djinni accepts at most 10000000 bytes (10 MB).`);
    expect(djinni.requests).toEqual([]);
  });

  test('refuses the upload when the profile already holds 5 CV files and lists them', async () => {
    const ctx = await setup({ 'GET /my/account/': accountWithCvs(['1', '2', '3', '4', '5']) });

    const error = (await prepareCvUpload(ctx, { file: tempFile('cv.pdf', PDF) }).catch((e: unknown) => e)) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('The profile already holds 5 CV files. djinni accepts at most 5.');
    expect(error.message).toContain('Ask the user which CV file to delete first.');
    for (const id of ['1', '2', '3', '4', '5']) expect(error.message).toContain(`- ${id}: TEXT_1 (uploaded: TEXT_2)`);
    expect(posts()).toEqual([]);
    expect(listDrafts(ctx)).toEqual([]);
  });
});

describe('submitCvUpload', () => {
  const NEW_ACCOUNT = accountWithCvs(['2705342', '2800001']);

  // The account page before the POST, and the page with the new CV after the POST.
  const accountRoute = (after = NEW_ACCOUNT): Route => () => (posts().length > 0 ? after : ACCOUNT);

  async function prepared(routes: Record<string, Route> = {}) {
    const file = tempFile('CV_Test_User.pdf', PDF);
    const ctx = await setup({
      'GET /my/account/': accountRoute(),
      'GET /my/resume/': RESUME_ONE,
      'POST /my/account/': { status: 302, headers: { location: '/my/account/' } },
      ...routes,
    });
    const { draftId } = await prepareCvUpload(ctx, { file });
    return { ctx, file, draftId };
  }

  test('posts every account field and the cv_file part with the PDF bytes as multipart', async () => {
    const { ctx, draftId } = await prepared();

    await submitCvUpload(ctx, draftId);

    const [post] = posts();
    expect(post!.url).toBe('/my/account/');
    expect(String(post!.headers['content-type'])).toMatch(/^multipart\/form-data; boundary=/);
    const parts = multipart(post!);
    const text = (p: Part) => p.data.toString('utf8');
    expect(parts.filter(p => p.filename === undefined).map(p => [p.name, text(p)])).toEqual([
      ['name', 'REDACTED_name'],
      ['email', 'REDACTED_email'],
      ['phone', ''],
      ['telegram', 'REDACTED_telegram'],
      ['whatsapp', ''],
      ['github', ''],
      ['portfolio', ''],
      ['linkedin', ''],
      ['save_changes', 'Зберегти зміни'],
      ['csrfmiddlewaretoken', 'CSRF'],
    ]);
    const file = parts.find(p => p.name === 'cv_file')!;
    expect(file).toMatchObject({ filename: 'CV_Test_User.pdf', type: 'application/pdf' });
    expect(file.data.equals(PDF)).toBe(true);
  });

  test('returns the new CV file from the diff of the profile CV lists and deletes the draft', async () => {
    const { ctx, draftId } = await prepared();

    const result = await submitCvUpload(ctx, draftId);

    expect(result).toEqual({ ok: true, cv: { id: '2800001', name: 'TEXT_1', isDefault: false, uploaded: 'TEXT_2' } });
    expect(listDrafts(ctx)).toEqual([]);
  });

  test('finds the new CV file in the full CV list when the profile list does not show it', async () => {
    const row = '<div id="cv_file_row_2900001"><div id="cv_rename_2900001"><a>CV_Test_User.pdf</a></div></div>';
    const after = RESUME_ONE.replace('<div id="candidate_cv_files_list">', `<div id="candidate_cv_files_list">${row}`);
    const { ctx, draftId } = await prepared({ 'GET /my/account/': ACCOUNT, 'GET /my/resume/': () => (posts().length > 0 ? after : RESUME_ONE) });

    const result = await submitCvUpload(ctx, draftId);

    expect(result).toEqual({ ok: true, cv: { id: '2900001', name: 'CV_Test_User.pdf', uploaded: null, sharedLinks: 0 } });
    expect(djinni.requests.map(r => `${r.method} ${r.url}`).slice(-3)).toEqual(['POST /my/account/', 'GET /my/account/', 'GET /my/resume/']);
  });

  test('returns ok false and keeps the draft when a request after the POST fails', async () => {
    const { ctx, draftId } = await prepared({ 'GET /my/resume/': () => (posts().length > 0 ? { status: 500, body: 'error' } : RESUME_ONE) });

    const result = await submitCvUpload(ctx, draftId);

    expect(result).toEqual({
      ok: false,
      status: 302,
      message:
        'The upload request finished, but the check of the CV list failed: djinni returned HTTP 500 for GET /my/resume/. ' +
        'The file may be uploaded already. Call list_my_cvs before any retry.',
    });
    expect(listDrafts(ctx).map(d => d.id)).toEqual([draftId]);
  });

  test('returns ok false and keeps the draft when the connection closes during the upload POST', async () => {
    const { ctx, draftId } = await prepared({ 'POST /my/account/': { closeConnection: true } });

    const result = await submitCvUpload(ctx, draftId);

    expect(result).toMatchObject({ ok: false, status: null });
    expect(result.ok === false && result.message).toMatch(
      /^The upload request failed: .+\. djinni may have got the request\. The file may be uploaded already\. Call list_my_cvs before any retry\.$/,
    );
    expect(posts()).toHaveLength(1);
    expect(listDrafts(ctx).map(d => d.id)).toEqual([draftId]);
  });

  test('returns ok false with the status and a short text when no new CV appears, and keeps the draft', async () => {
    const page = ACCOUNT.replace('<div class="form-text">TEXT_11</div>', '<div class="form-text">TEXT_11</div><div class="invalid-feedback d-block">Файл занадто великий.</div>');
    const { ctx, draftId } = await prepared({ 'GET /my/account/': ACCOUNT, 'POST /my/account/': { status: 200, body: page } });

    const result = await submitCvUpload(ctx, draftId);

    expect(result).toEqual({ ok: false, status: 200, message: 'Файл занадто великий.' });
    expect(listDrafts(ctx).map(d => d.id)).toEqual([draftId]);
  });

  test('refuses a file that changed after the draft and sends no POST', async () => {
    const { ctx, file, draftId } = await prepared();
    writeFileSync(file, Buffer.concat([PDF, Buffer.from('x')]));

    await expect(submitCvUpload(ctx, draftId)).rejects.toThrow(`The file ${file} changed after the draft. Make a new draft.`);
    expect(posts()).toEqual([]);
  });

  test('checks the size of the file before it reads the file', async () => {
    const { ctx, file, draftId } = await prepared();
    writeFileSync(file, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(10_000_000 - 8)]));

    await expect(submitCvUpload(ctx, draftId)).rejects.toThrow(`The file ${file} has 10000001 bytes. djinni accepts at most 10000000 bytes (10 MB).`);
    expect(posts()).toEqual([]);
  });

  test('refuses the draft when the account fields changed and sends no POST', async () => {
    const { ctx, draftId } = await prepared();
    djinni.routes.set('GET /my/account/', ACCOUNT.replace('value="REDACTED_telegram"', 'value="@other"'));

    await expect(submitCvUpload(ctx, draftId)).rejects.toThrow('The account contacts on djinni changed after this draft. Make a new draft.');
    expect(posts()).toEqual([]);
  });

  test('refuses the upload when the profile holds 5 CV files at submit time', async () => {
    const { ctx, draftId } = await prepared();
    djinni.routes.set('GET /my/account/', accountWithCvs(['1', '2', '3', '4', '5']));

    await expect(submitCvUpload(ctx, draftId)).rejects.toThrow('The profile already holds 5 CV files.');
    expect(posts()).toEqual([]);
  });

  test('refuses a draft of another kind', async () => {
    const { ctx } = await prepared();
    const { createDraft } = await import('../../src/core/drafts.ts');
    const other = createDraft(ctx, 'profile', {}, {});

    await expect(submitCvUpload(ctx, other.id)).rejects.toThrow('is a profile draft, not a cv_upload draft');
  });
});
