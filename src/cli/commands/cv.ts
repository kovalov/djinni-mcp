import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getCvUploadDraft, importCv, listMyCvs, prepareCvUpload, renderCvPdf, submitCvUpload } from '../../core/cv.ts';
import { print, terminalText, type Command } from '../command.ts';
import { cvDraftText, cvFileText, cvImportText, cvListText, cvRenderText, cvSubmitText } from '../format.ts';
import { BIN } from '../../bin.ts';

const SESSION = 'This needs a djinni session.';
const YES = ['y', 'yes'];

function readMarkdown(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read the Markdown file ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export const cvCommands: Command[] = [
  {
    name: 'cv list',
    summary: `Print the CV files in your djinni profile and all CV files that you uploaded. ${SESSION}`,
    async run(_values, _args, env) {
      const list = await listMyCvs(env.ctx);
      print(env, list, () => cvListText(list));
    },
  },
  {
    name: 'cv render',
    args: ['<file.md>'],
    summary:
      'Render a CV from a Markdown file to a PDF file. This command sends nothing to djinni. ' +
      'The Markdown can have headings, paragraphs, bullet lists, numbered lists, bold text, italic text and links.',
    flags: [
      { name: 'out', type: 'string', value: 'file.pdf', description: 'Write the PDF to this file. The default is a new file in the cv folder of the data folder.' },
      { name: 'force', type: 'boolean', description: 'Overwrite the --out file when it exists.' },
    ],
    async run(values, [file], env) {
      const out = values.out as string | undefined;
      const force = values.force === true;
      if (out !== undefined && !force && existsSync(resolve(out))) throw new Error(`The file ${resolve(out)} already exists. Use --force to overwrite it.`);
      const result = await renderCvPdf(env.ctx, { markdown: readMarkdown(file!), outFile: out, overwrite: force });
      print(env, result, () => cvRenderText(result));
    },
  },
  {
    name: 'cv import',
    args: ['<file.pdf>'],
    summary:
      'Copy a PDF file into the cv folder of the data folder. The MCP tools read only CV files in this folder. ' +
      'The copy keeps the base name with the extension .pdf, and gets a number when the folder has a file with that name.',
    async run(_values, [file], env) {
      const result = importCv(env.ctx, file!);
      print(env, result, () => cvImportText(result));
    },
  },
  {
    name: 'cv prepare',
    args: ['<file.pdf>'],
    summary:
      'Make a draft of a CV upload to your djinni profile. This command changes nothing on djinni. ' +
      `The file must be a PDF file of at most 10 MB. Upload the draft with "${BIN} cv submit". ${SESSION}`,
    flags: [{ name: 'name', type: 'string', value: 'name', description: 'The file name that recruiters see on djinni. The default is the name of the file.' }],
    async run(values, [file], env) {
      const draft = await prepareCvUpload(env.ctx, { file: file!, name: values.name as string | undefined });
      print(env, draft, () => cvDraftText(draft));
    },
  },
  {
    name: 'cv submit',
    args: ['<draft-id>'],
    summary:
      'Upload the PDF file of a CV draft to your djinni profile. The command prints the draft and asks for your approval. ' +
      `Then it reads the profile again and prints the new CV file. ${SESSION}`,
    flags: [{ name: 'yes', type: 'boolean', description: 'Upload the file without a question.' }],
    async run(values, [id], env) {
      if (values.yes !== true) {
        const preview = terminalText(cvFileText(getCvUploadDraft(env.ctx, id!)));
        if (env.json) env.io.stderr(preview);
        else env.io.stdout(`${preview}\n`);
        const answer = await env.io.prompt('Upload this CV to djinni? [y/N] ');
        if (!YES.includes(answer.trim().toLowerCase())) {
          env.io.stderr('Canceled. Nothing was sent to djinni.\n');
          return 1;
        }
      }
      const result = await submitCvUpload(env.ctx, id!);
      print(env, result, () => cvSubmitText(result, id!));
      return result.ok ? 0 : 1;
    },
  },
];
