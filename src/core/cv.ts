import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as cheerio from 'cheerio';
import type { Ctx } from '../context.ts';
import { NotLoggedInError, type FormField, type PostResult } from '../http.ts';
import { ACCOUNT_FORM, parseProfileCvs, parseResumePage, type ProfileCv, type UploadedCv } from '../parsers/cv.ts';
import { serializeForm } from '../parsers/form.ts';
import { createDraft, deleteDraft, getDraft } from './drafts.ts';
import { markdownToPdf } from './cv-pdf.ts';
import { BIN } from '../bin.ts';

const ACCOUNT_PATH = '/my/account/';
const RESUME_PATH = '/my/resume/';
const DRAFT_KIND = 'cv_upload';
const CSRF_FIELD = 'csrfmiddlewaretoken';
// The account page says that the profile can hold up to 5 CV files.
export const CV_PROFILE_LIMIT = 5;
// The upload field says "до 10MB" and has maxlength="10000000". The stricter value is the limit.
export const CV_MAX_BYTES = 10_000_000;
// A guard against a page loop: 50 pages are 500 CV files.
const MAX_RESUME_PAGES = 50;
const MAX_MESSAGE = 300;

export type CvList = { profileCvs: ProfileCv[]; allCvs: UploadedCv[]; profileLimit: number };
export type RenderResult = { file: string; pages: number; size: number };
export type CvDraftResult = { draftId: string; expiresAt: string; file: string; name: string; size: number; pages?: number };
// The new CV file comes from the profile list when the profile shows it, else from the list of all CV files.
// "status" is null when djinni sent no HTTP answer to the upload POST.
export type CvSubmitResult = { ok: true; cv: ProfileCv | UploadedCv } | { ok: false; status: number | null; message: string };
export type ImportResult = { file: string; size: number };

type Fields = [string, string][];
// "form" is the account form when the draft was made, without the CSRF token.
// "cvFolderOnly" is true for a draft from an MCP tool. Then the file must stay in the CV folder.
type CvDraftPayload = { file: string; name: string; sha256: string; size: number; form: Fields; cvFolderOnly?: boolean };
type CvDraftPreview = { file: string; name: string; size: number; pages?: number };

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

async function loadAccountPage(ctx: Ctx): Promise<cheerio.CheerioAPI> {
  const $ = cheerio.load(await ctx.client().get(ACCOUNT_PATH));
  if ($(ACCOUNT_FORM).filter('form').length === 0) throw new Error(`djinni sent no account form on ${ACCOUNT_PATH}.`);
  return $;
}

const accountForm = ($: cheerio.CheerioAPI): Fields => serializeForm($, ACCOUNT_FORM).filter(([name]) => name !== CSRF_FIELD) as Fields;

// Returns the CV files in the profile and all uploaded CV files, from all pages of /my/resume/.
export async function listMyCvs(ctx: Ctx): Promise<CvList> {
  const profileCvs = parseProfileCvs(await loadAccountPage(ctx));
  return { profileCvs, allCvs: await listUploadedCvs(ctx), profileLimit: CV_PROFILE_LIMIT };
}

async function listUploadedCvs(ctx: Ctx): Promise<UploadedCv[]> {
  const allCvs: UploadedCv[] = [];
  let path = RESUME_PATH;
  for (let i = 0; i < MAX_RESUME_PAGES; i++) {
    const page = parseResumePage(await ctx.client().get(path));
    allCvs.push(...page.cvs);
    if (page.nextPage === null) break;
    path = `${RESUME_PATH}?page=${page.nextPage}`;
  }
  return allCvs;
}

function checkSize(file: string, size: number): void {
  if (size > CV_MAX_BYTES) throw new Error(`The file ${file} has ${size} bytes. djinni accepts at most ${CV_MAX_BYTES} bytes (10 MB).`);
}

// ---- The CV folder of the data folder ----

// Makes the CV folder when it does not exist. A CV holds personal data, so only the owner can open the folder.
// Returns the real path of the folder, with all symlinks resolved.
export function cvFolder(ctx: Ctx): string {
  const dir = ctx.store.path('cv');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return realpathSync(dir);
}

// True when the path is in the folder. A name that only starts with ".." (for example "..cv.pdf") is in the folder.
const isInside = (folder: string, path: string) => {
  const rel = relative(folder, path);
  return rel !== '' && !isAbsolute(rel) && !rel.split(sep).includes('..');
};

const isPdfName = (path: string) => extname(path).toLowerCase() === '.pdf';

// Checks an output path from an MCP tool. The path is relative to the CV folder, or absolute.
// It must name a new .pdf file in the CV folder. Symlinks of the folder path are resolved before the check.
export function cvOutputPath(ctx: Ctx, path: string): string {
  const folder = cvFolder(ctx);
  const refused = new Error(`out_file must name a PDF file in the CV folder ${ctx.store.path('cv')}. Give only a new file name, for example cv-company.pdf.`);
  const target = resolve(ctx.store.path('cv'), path);
  if (!isPdfName(target)) throw refused;
  let parent: string;
  try {
    parent = realpathSync(dirname(target));
  } catch {
    throw refused;
  }
  const real = resolve(parent, basename(target));
  if (!isInside(folder, real)) throw refused;
  // The path as the store names the folder, for example without the /private prefix of macOS.
  return join(ctx.store.path('cv'), relative(folder, real));
}

// Checks an input path from an MCP tool. The path is relative to the CV folder, or absolute.
// It must resolve, with all symlinks, to a .pdf file in the CV folder. Returns the real path.
export function cvInputPath(ctx: Ctx, path: string): string {
  const folder = cvFolder(ctx);
  const target = resolve(ctx.store.path('cv'), path);
  const refused = new Error(
    `The file ${target} is not in the CV folder. The MCP tools read only PDF files in the CV folder ${ctx.store.path('cv')}. ` +
      `Ask the user to run: ${BIN} cv import <path>`,
  );
  if (!existsSync(target)) {
    if (isInside(ctx.store.path('cv'), target) && isPdfName(target)) throw new Error(`The file ${target} does not exist.`);
    throw refused;
  }
  const real = realpathSync(target);
  if (!isInside(folder, real) || !isPdfName(real)) throw refused;
  return real;
}

const isExists = (e: unknown) => (e as NodeJS.ErrnoException).code === 'EEXIST';

// Writes a new file with mode 0600. Never overwrites a file: on a name clash, it adds -2, -3 and so on to the name.
function writeNewFile(file: string, write: (path: string) => void): string {
  const ext = extname(file);
  const stem = file.slice(0, file.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const path = n === 1 ? file : `${stem}-${n}${ext}`;
    try {
      write(path);
      return path;
    } catch (e) {
      if (!isExists(e)) throw e;
    }
  }
  throw new Error(`The folder ${dirname(file)} has too many files with the name ${basename(file)}.`);
}

// The file name for the default output: the words of the first heading, or "cv".
function slugOf(markdown: string): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(markdown)?.[1] ?? '';
  const words = heading.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.join('-').slice(0, 60).replace(/-+$/, '') || 'cv';
}

const timestamp = (date: Date) => date.toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');

// Renders Markdown to a PDF file with pdfkit. Sends no request to djinni.
// A CV holds personal data, so the file gets mode 0600. The function overwrites an existing outFile only with "overwrite".
// Without outFile, it writes a new file in the CV folder and never overwrites a file.
export async function renderCvPdf(ctx: Ctx, opts: { markdown: string; outFile?: string; overwrite?: boolean }): Promise<RenderResult> {
  const { data, pages } = await markdownToPdf(opts.markdown);
  const writePdf = (path: string, flag: string) => {
    writeFileSync(path, data, { mode: 0o600, flag });
    chmodSync(path, 0o600);
  };
  if (!opts.outFile) {
    const file = join(cvFolderPath(ctx), `${timestamp(ctx.now())}-${slugOf(opts.markdown)}.pdf`);
    checkSize(file, data.length);
    return { file: writeNewFile(file, path => writePdf(path, 'wx')), pages, size: data.length };
  }
  const file = resolve(opts.outFile);
  checkSize(file, data.length);
  mkdirSync(dirname(file), { recursive: true });
  try {
    writePdf(file, opts.overwrite ? 'w' : 'wx');
  } catch (e) {
    if (isExists(e)) throw new Error(`The file ${file} already exists.`);
    throw e;
  }
  return { file, pages, size: data.length };
}

// The CV folder path as the store gives it. cvFolder() makes the folder.
const cvFolderPath = (ctx: Ctx) => {
  cvFolder(ctx);
  return ctx.store.path('cv');
};

// Copies a PDF file into the CV folder, so that the MCP tools can read it.
// The copy keeps the base name of the file with the extension ".pdf", for example "Resume.PDF" becomes "Resume.pdf".
export function importCv(ctx: Ctx, file: string): ImportResult {
  const source = resolve(file);
  const data = readPdfFile(source);
  const base = basename(source);
  const stem = extname(base) ? base.slice(0, -extname(base).length) : base;
  const target = join(cvFolderPath(ctx), `${stem}.pdf`);
  const copy = writeNewFile(target, path => {
    writeFileSync(path, data, { mode: 0o600, flag: 'wx' });
    chmodSync(path, 0o600);
  });
  return { file: copy, size: data.length };
}

// Reads a CV file and checks that it is a PDF file of at most 10 MB.
function readPdfFile(file: string): Buffer {
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`The file ${file} does not exist.`);
  checkSize(file, statSync(file).size);
  const data = readFileSync(file);
  if (data.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error(`The file ${file} is not a PDF file. djinni accepts only PDF files.`);
  return data;
}

// Counts the page objects of a PDF. Returns undefined when the PDF keeps its objects in compressed streams.
function pageCount(data: Buffer): number | undefined {
  const count = data.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
  return count > 0 ? count : undefined;
}

function uploadName(file: string, name: string | undefined): string {
  if (name === undefined) return basename(file);
  const trimmed = name.trim();
  if (trimmed === '' || /[/\\]/.test(trimmed)) throw new Error(`The name "${name}" must be a file name without a folder.`);
  return /\.pdf$/i.test(trimmed) ? trimmed : `${trimmed}.pdf`;
}

function checkProfileLimit(cvs: ProfileCv[]): void {
  if (cvs.length < CV_PROFILE_LIMIT) return;
  const lines = cvs.map(cv => `- ${cv.id}: ${cv.name}${cv.uploaded ? ` (uploaded: ${cv.uploaded})` : ''}`);
  throw new Error(
    [
      `The profile already holds ${cvs.length} CV files. djinni accepts at most ${CV_PROFILE_LIMIT}.`,
      'The CV files in the profile:',
      ...lines,
      'Ask the user which CV file to delete first. Then the user deletes it on djinni, and you make a new draft.',
    ].join('\n'),
  );
}

// Makes a draft of a CV upload. Sends no change to djinni.
// With "cvFolderOnly", the file must be a .pdf file in the CV folder, and the draft keeps its real path.
export async function prepareCvUpload(ctx: Ctx, opts: { file: string; name?: string; cvFolderOnly?: boolean }): Promise<CvDraftResult> {
  const file = opts.cvFolderOnly ? cvInputPath(ctx, opts.file) : resolve(opts.file);
  const name = uploadName(file, opts.name);
  const data = readPdfFile(file);
  const $ = await loadAccountPage(ctx);
  checkProfileLimit(parseProfileCvs($));
  const pages = pageCount(data);
  const preview: CvDraftPreview = { file, name, size: data.length, ...(pages ? { pages } : {}) };
  const draft = createDraft<CvDraftPayload, CvDraftPreview>(
    ctx,
    DRAFT_KIND,
    { file, name, sha256: sha256(data), size: data.length, form: accountForm($), ...(opts.cvFolderOnly ? { cvFolderOnly: true } : {}) },
    preview,
  );
  return { draftId: draft.id, expiresAt: draft.expiresAt, ...preview };
}

// Returns a saved CV upload draft. Sends no request.
export function getCvUploadDraft(ctx: Ctx, draftId: string): CvDraftResult {
  const draft = getDraft<CvDraftPayload, CvDraftPreview>(ctx, draftId, DRAFT_KIND);
  return { draftId: draft.id, expiresAt: draft.expiresAt, ...draft.preview };
}

// A short text from the response page: the first error message in the account form, else the page title, else the start of the text.
// The page always has toast templates with a default text, so the search stays in the form.
function responseMessage(body: string): string {
  const $ = cheerio.load(body);
  const error = $(ACCOUNT_FORM)
    .find('.invalid-feedback, .errorlist, .alert')
    .toArray()
    .map(el => collapse($(el).text()))
    .find(t => t !== '');
  const text = error ?? (collapse($('title').text()) || collapse($('body').text()));
  return text.slice(0, MAX_MESSAGE);
}

const MAY_BE_UPLOADED = 'The file may be uploaded already. Call list_my_cvs before any retry.';

// The error text without the last period. A fetch error adds its cause, for example "fetch failed (other side closed)".
function errorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause instanceof Error ? ` (${e.cause.message})` : '';
  return `${e.message}${cause}`.replace(/\.$/, '');
}

// The fields that a browser sends when the user picks a file and clicks the save button of the account form.
function uploadFields($: cheerio.CheerioAPI, name: string, data: Buffer): FormField[] {
  const fields: FormField[] = serializeForm($, ACCOUNT_FORM);
  const submit = $(ACCOUNT_FORM).filter('form').first().find('input[type="submit"][name], button[type="submit"][name]').first();
  const file: FormField = ['cv_file', { filename: name, type: 'application/pdf', data }];
  const csrf = fields.findIndex(([n]) => n === CSRF_FIELD);
  const extra: FormField[] = [file, ...(submit.length ? [[submit.attr('name')!, submit.attr('value') ?? ''] as FormField] : [])];
  fields.splice(csrf < 0 ? fields.length : csrf, 0, ...extra);
  return fields;
}

// Uploads the CV file of an approved draft to djinni. Refuses the draft when the file or the account form changed after the draft.
// djinni gives no clear answer for the POST, so the diff of the full CV lists before and after the POST finds the new CV file.
// With "cvFolderOnly" (the MCP tools), the file of every draft must be in the CV folder.
export async function submitCvUpload(ctx: Ctx, draftId: string, opts: { cvFolderOnly?: boolean } = {}): Promise<CvSubmitResult> {
  const draft = getDraft<CvDraftPayload, CvDraftPreview>(ctx, draftId, DRAFT_KIND);
  const { file, name } = draft.payload;
  if (draft.payload.cvFolderOnly) cvInputPath(ctx, file);
  else if (opts.cvFolderOnly) {
    try {
      cvInputPath(ctx, file);
    } catch {
      throw new Error(
        `The file ${file} of the draft ${draftId} is not in the CV folder. The MCP tools upload only files in the CV folder. ` +
          `Ask the user to submit this draft in a terminal: ${BIN} cv submit ${draftId}`,
      );
    }
  }
  if (!existsSync(file)) throw new Error(`The file ${file} does not exist. Make a new draft.`);
  const size = statSync(file).size;
  checkSize(file, size);
  const changed = new Error(`The file ${file} changed after the draft. Make a new draft.`);
  if (size !== draft.payload.size) throw changed;
  const data = readFileSync(file);
  if (sha256(data) !== draft.payload.sha256) throw changed;
  const $ = await loadAccountPage(ctx);
  if (!isDeepStrictEqual(accountForm($), draft.payload.form)) {
    throw new Error('The account contacts on djinni changed after this draft. Make a new draft.');
  }
  const before = parseProfileCvs($);
  checkProfileLimit(before);
  const known = new Set([...before, ...(await listUploadedCvs(ctx))].map(cv => cv.id));
  let res: PostResult;
  try {
    res = await ctx.client().postForm(ACCOUNT_PATH, uploadFields($, name, data));
  } catch (e) {
    // A redirect to the login page is an answer: djinni did not take the file.
    if (e instanceof NotLoggedInError) throw e;
    return {
      ok: false,
      status: null,
      message: `The upload request failed: ${errorText(e)}. djinni may have got the request. ${MAY_BE_UPLOADED}`,
    };
  }
  // After the POST, djinni may have the file. An error of the check must not look like a failed upload, so the result is ok false.
  let after: CvList;
  try {
    after = await listMyCvs(ctx);
  } catch (e) {
    return {
      ok: false,
      status: res.status,
      message: `The upload request finished, but the check of the CV list failed: ${errorText(e)}. ${MAY_BE_UPLOADED}`,
    };
  }
  const cv = after.profileCvs.find(c => !known.has(c.id)) ?? after.allCvs.find(c => !known.has(c.id));
  if (!cv) return { ok: false, status: res.status, message: responseMessage(res.body) };
  deleteDraft(ctx, draftId);
  return { ok: true, cv };
}
