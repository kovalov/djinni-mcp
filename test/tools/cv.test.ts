import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { Ctx } from '../../src/context.ts';
import { importCv, prepareCvUpload } from '../../src/core/cv.ts';
import { getDraft } from '../../src/core/drafts.ts';
import type { Store } from '../../src/store.ts';
import { cli } from '../cli/helpers.ts';
import { callTool, callToolJson, connect, fixture, loggedInStore, startFakeDjinni, type FakeDjinni, type Route } from '../helpers.ts';

// The MCP contract of the CV tools: names, annotations, descriptions, input validation and output shape.
// The behavior of the operations is in test/core/cv.test.ts.

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

const ACCOUNT = fixture('my_account_raw.html');
const now = () => new Date('2026-11-10T12:00:00.000Z');
const TRUE_FACTS =
  "Adapt the CV only by reordering and rewording true facts from the user's profile and CV. " +
  'Never add experience, skills or results that the user does not have. Djinni blocks accounts for false CV data.';
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');

let store: Store;

async function setup(routes: Record<string, Route> = {}) {
  store = loggedInStore();
  djinni = await startFakeDjinni({
    'GET /my/account/': ACCOUNT,
    'GET /my/resume/': fixture('my_resume_raw.html').replace(/href="\?page=2"/g, ''),
    'POST /my/account/': { status: 302, headers: { location: '/my/account/' } },
    ...routes,
  });
  return connect({ store, baseUrl: djinni.url, minIntervalMs: 0, now });
}

// The CV folder of the data folder. The MCP tools read and write only files in this folder.
const cvDir = () => {
  mkdirSync(store.path('cv'), { recursive: true });
  return store.path('cv');
};

// A PDF file in the CV folder, or in another folder.
const pdfFile = (dir = cvDir(), name = 'CV_Test_User.pdf') => {
  const file = join(dir, name);
  writeFileSync(file, PDF);
  return file;
};
const outsideDir = () => mkdtempSync(join(tmpdir(), 'djinni-outside-'));

const posts = () => djinni.requests.filter(r => r.method === 'POST');

describe('CV tool list', () => {
  test('registers list_my_cvs as a read-only tool', async () => {
    const client = await setup();
    const { tools } = await client.listTools();

    expect(tools.find(t => t.name === 'list_my_cvs')!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });

  test('registers render_cv_pdf as a local tool with the rule about true facts', async () => {
    const client = await setup();
    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'render_cv_pdf')!;

    expect(tool.description).toContain(TRUE_FACTS);
    expect(tool.description).toContain('This tool sends nothing to djinni.');
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(tool.inputSchema.required).toEqual(['markdown']);
  });

  test('registers prepare_cv_upload as a tool that changes nothing on djinni, with the rule about true facts', async () => {
    const client = await setup();
    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'prepare_cv_upload')!;

    expect(tool.description).toContain(TRUE_FACTS);
    expect(tool.description).toContain('This tool changes nothing on djinni.');
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    expect(tool.inputSchema.required).toEqual(['file']);
  });

  test('registers submit_cv_upload as a destructive tool that needs confirm', async () => {
    const client = await setup();
    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'submit_cv_upload')!;

    expect(tool.description).toContain('Call this tool only after the user approved this exact file in the chat.');
    expect(tool.description).toContain('If the result is ok false, call list_my_cvs before any retry. djinni may have the file already.');
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    expect(tool.inputSchema.required).toEqual(['draft_id', 'confirm']);
  });

  test('the CV tool descriptions have no semicolons', async () => {
    const client = await setup();
    const { tools } = await client.listTools();

    for (const name of ['list_my_cvs', 'render_cv_pdf', 'prepare_cv_upload', 'submit_cv_upload']) {
      expect(tools.find(t => t.name === name)!.description).not.toContain(';');
    }
  });
});

describe('list_my_cvs', () => {
  test('returns the profile CV files, all CV files and the limit as JSON', async () => {
    const client = await setup();

    const result = await callToolJson(client, 'list_my_cvs');

    expect(result.profileLimit).toBe(5);
    expect(result.profileCvs).toEqual([{ id: '2705342', name: 'TEXT_1', isDefault: false, uploaded: 'TEXT_2' }]);
    expect(result.allCvs).toHaveLength(10);
  });
});

describe('render_cv_pdf', { timeout: 30_000 }, () => {
  const MD = '# Тест\n\nТекст.';

  test('writes the PDF to out_file in the CV folder with mode 0600 and returns the path, the page count and the size', async () => {
    const client = await setup();
    const out = join(cvDir(), 'my-cv.pdf');

    const result = await callToolJson(client, 'render_cv_pdf', { markdown: MD, out_file: 'my-cv.pdf' });

    expect(result).toEqual({ file: out, pages: 1, size: expect.any(Number) });
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(djinni.requests).toEqual([]);
  });

  test('accepts an absolute out_file in the CV folder', async () => {
    const client = await setup();
    const out = join(cvDir(), 'abs.pdf');

    expect((await callToolJson(client, 'render_cv_pdf', { markdown: MD, out_file: out })).file).toBe(out);
  });

  test.each([
    ['an absolute path outside the CV folder', () => join(outsideDir(), 'cv.pdf')],
    ['a ../ path', () => '../cv.pdf'],
    ['a path through a symlink in the CV folder that points outside', () => {
      symlinkSync(outsideDir(), join(cvDir(), 'link'));
      return 'link/cv.pdf';
    }],
  ])('refuses %s and writes no file', async (_, makePath) => {
    const client = await setup();
    const out = makePath();

    const res = await callTool(client, 'render_cv_pdf', { markdown: MD, out_file: out });

    expect(res.isError).toBe(true);
    expect(res.text).toContain(`out_file must name a PDF file in the CV folder ${cvDir()}.`);
    expect(existsSync(isAbsolute(out) ? out : join(cvDir(), out))).toBe(false);
    expect(existsSync(store.path('cv.pdf'))).toBe(false);
  });

  test('accepts an out_file with the upper case extension .PDF and a name that starts with ".."', async () => {
    const client = await setup();

    expect((await callToolJson(client, 'render_cv_pdf', { markdown: MD, out_file: 'CV.PDF' })).file).toBe(join(cvDir(), 'CV.PDF'));
    expect((await callToolJson(client, 'render_cv_pdf', { markdown: MD, out_file: '..cv.pdf' })).file).toBe(join(cvDir(), '..cv.pdf'));
  });

  test('refuses an out_file without the .pdf extension', async () => {
    const client = await setup();

    const res = await callTool(client, 'render_cv_pdf', { markdown: MD, out_file: 'cv.txt' });

    expect(res.isError).toBe(true);
    expect(existsSync(join(cvDir(), 'cv.txt'))).toBe(false);
  });

  test('refuses an out_file that exists and keeps its content', async () => {
    const client = await setup();
    writeFileSync(join(cvDir(), 'old.pdf'), 'old');

    const res = await callTool(client, 'render_cv_pdf', { markdown: MD, out_file: 'old.pdf' });

    expect(res.isError).toBe(true);
    expect(res.text).toContain('already exists');
    expect(readFileSync(join(cvDir(), 'old.pdf'), 'utf8')).toBe('old');
  });
});

describe('prepare_cv_upload', () => {
  test('returns the draft and sends no POST', async () => {
    const client = await setup();
    const file = pdfFile();

    const result = await callToolJson(client, 'prepare_cv_upload', { file, name: 'CV_Test' });

    expect(result).toEqual({ draftId: expect.any(String), expiresAt: '2026-11-11T12:00:00.000Z', file: realpathSync(file), name: 'CV_Test.pdf', size: PDF.length });
    expect(posts()).toEqual([]);
  });

  test('accepts a file name relative to the CV folder', async () => {
    const client = await setup();
    const file = pdfFile();

    expect((await callToolJson(client, 'prepare_cv_upload', { file: 'CV_Test_User.pdf' })).file).toBe(realpathSync(file));
  });

  test('accepts a file with the upper case extension .PDF and a name that starts with ".."', async () => {
    const client = await setup();
    pdfFile(cvDir(), 'Resume.PDF');
    pdfFile(cvDir(), '..cv.pdf');

    expect((await callToolJson(client, 'prepare_cv_upload', { file: 'Resume.PDF' })).name).toBe('Resume.PDF');
    expect((await callToolJson(client, 'prepare_cv_upload', { file: '..cv.pdf' })).name).toBe('..cv.pdf');
  });

  test.each([['Resume.PDF', 'Resume.pdf'], ['resume', 'resume.pdf'], ['cv.docx', 'cv.pdf']])(
    'accepts the copy of %s that "cv import" makes',
    async (name, copyName) => {
      const client = await setup();
      const imported = importCv(new Ctx({ store, now }), pdfFile(outsideDir(), name));

      expect(imported.file).toBe(join(cvDir(), copyName));
      expect((await callToolJson(client, 'prepare_cv_upload', { file: imported.file })).name).toBe(copyName);
    },
  );

  test('saves the real path of the file in the draft', async () => {
    const client = await setup();
    const real = pdfFile();
    symlinkSync(real, join(cvDir(), 'link.pdf'));

    const { draftId } = await callToolJson(client, 'prepare_cv_upload', { file: 'link.pdf' });

    expect(getDraft<{ file: string }>(new Ctx({ store, now }), draftId).payload.file).toBe(realpathSync(real));
  });

  test('returns a tool error for a file in the CV folder that does not exist', async () => {
    const client = await setup();

    const res = await callTool(client, 'prepare_cv_upload', { file: 'none.pdf' });

    expect(res).toEqual({ isError: true, text: `The file ${join(cvDir(), 'none.pdf')} does not exist.` });
  });

  test.each([
    ['a file outside the CV folder', () => pdfFile(outsideDir())],
    ['a ../ path', () => {
      pdfFile(store.dir, 'up.pdf');
      return '../up.pdf';
    }],
    ['a symlink in the CV folder that points to a file outside', () => {
      symlinkSync(pdfFile(outsideDir()), join(cvDir(), 'link.pdf'));
      return 'link.pdf';
    }],
    ['a file without the .pdf extension', () => pdfFile(cvDir(), 'cv.txt')],
  ])('refuses %s and tells the agent to ask for "cv import"', async (_, makePath) => {
    const client = await setup();
    const file = makePath();

    const res = await callTool(client, 'prepare_cv_upload', { file });

    expect(res.isError).toBe(true);
    expect(res.text).toContain(`The MCP tools read only PDF files in the CV folder ${cvDir()}.`);
    expect(res.text).toContain('Ask the user to run: npx djinni-mcp cv import <path>');
    expect(djinni.requests).toEqual([]);
  });
});

describe('submit_cv_upload', () => {
  test('refuses a CLI draft of a file outside the CV folder and sends no POST, but the CLI can submit the draft', async () => {
    const client = await setup();
    const deps = { store, baseUrl: djinni.url, minIntervalMs: 0, now };
    const { draftId } = await prepareCvUpload(new Ctx(deps), { file: pdfFile(outsideDir()) });

    const res = await callTool(client, 'submit_cv_upload', { draft_id: draftId, confirm: true });

    expect(res.isError).toBe(true);
    expect(res.text).toContain('The MCP tools upload only files in the CV folder.');
    expect(res.text).toContain(`Ask the user to submit this draft in a terminal: npx djinni-mcp cv submit ${draftId}`);
    expect(posts()).toEqual([]);

    const run = await cli(['cv', 'submit', draftId, '--yes'], deps);

    expect(run.err).toBe('');
    expect(posts()).toHaveLength(1);
  });

  test('refuses confirm false and sends no POST', async () => {
    const client = await setup();
    const { draftId } = await callToolJson(client, 'prepare_cv_upload', { file: pdfFile() });

    const res = await callTool(client, 'submit_cv_upload', { draft_id: draftId, confirm: false });

    expect(res.isError).toBe(true);
    expect(posts()).toEqual([]);
  });

  test('refuses to upload a draft file that the user changed to a symlink to a file outside the CV folder', async () => {
    const client = await setup();
    const file = pdfFile();
    const { draftId } = await callToolJson(client, 'prepare_cv_upload', { file });
    rmSync(file);
    symlinkSync(pdfFile(outsideDir()), file);

    const res = await callTool(client, 'submit_cv_upload', { draft_id: draftId, confirm: true });

    expect(res.isError).toBe(true);
    expect(res.text).toContain('is not in the CV folder');
    expect(posts()).toEqual([]);
  });

  test('uploads the file with confirm true and returns the new CV file', async () => {
    const client = await setup();
    const { draftId } = await callToolJson(client, 'prepare_cv_upload', { file: pdfFile() });
    djinni.routes.set('POST /my/account/', () => {
      djinni.routes.set('GET /my/account/', ACCOUNT.replace('<div id="uploaded_cv_list">', '<div id="uploaded_cv_list"><div id="uploaded_cv_2800001"><div id="cv_rename_2800001"><a>CV_Test_User.pdf</a></div></div>'));
      return { status: 302, headers: { location: '/my/account/' } };
    });

    const result = await callToolJson(client, 'submit_cv_upload', { draft_id: draftId, confirm: true });

    expect(result).toEqual({ ok: true, cv: { id: '2800001', name: 'CV_Test_User.pdf', isDefault: true, uploaded: null } });
    expect(posts()).toHaveLength(1);
  });
});
