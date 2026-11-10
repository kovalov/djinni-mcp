import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { cvOutputPath, listMyCvs, prepareCvUpload, renderCvPdf, submitCvUpload } from '../core/cv.ts';
import { json, safely } from './result.ts';

const TRUE_FACTS =
  "Adapt the CV only by reordering and rewording true facts from the user's profile and CV. " +
  'Never add experience, skills or results that the user does not have. Djinni blocks accounts for false CV data.';

export function registerCvTools(server: McpServer, ctx: Ctx) {
  server.registerTool(
    'list_my_cvs',
    {
      title: 'List my CV files',
      description:
        'List the CV files of the user on djinni. The profileCvs field has the CV files in the profile. ' +
        'The allCvs field has all uploaded CV files. For each file, sharedLinks is the number of links that djinni sent to recruiters. ' +
        'The profile can hold at most profileLimit CV files. This tool needs a djinni session.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safely(async () => json(await listMyCvs(ctx))),
  );

  server.registerTool(
    'render_cv_pdf',
    {
      title: 'Render a CV to PDF',
      description:
        'Render a CV from Markdown to a new PDF file in the CV folder of the djinni-mcp data folder. This tool sends nothing to djinni. ' +
        'The tool never overwrites a file. ' +
        'The Markdown can have headings (#, ##, ###), paragraphs, bullet lists, numbered lists, bold text, italic text and links. ' +
        'Other Markdown, for example tables and HTML, gives an error. ' +
        `${TRUE_FACTS} ` +
        'Return the path of the file, the page count and the size in bytes.',
      inputSchema: {
        markdown: z.string().describe('The CV text in Markdown.'),
        out_file: z
          .string()
          .optional()
          .describe('The name of a new .pdf file in the CV folder, for example cv-company.pdf. The default is a new name from the time and the first heading.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    safely(async ({ markdown, out_file }) => json(await renderCvPdf(ctx, { markdown, outFile: out_file === undefined ? undefined : cvOutputPath(ctx, out_file) }))),
  );

  server.registerTool(
    'prepare_cv_upload',
    {
      title: 'Prepare a CV upload',
      description:
        'Make a draft of a CV upload to the djinni profile. This tool changes nothing on djinni. ' +
        'The file must be a PDF file of at most 10 MB. It must be in the CV folder of the djinni-mcp data folder, for example a file from render_cv_pdf. ' +
        'The profile can hold at most 5 CV files. ' +
        'Show the file name and the size to the user and ask for an explicit approval. ' +
        TRUE_FACTS,
      inputSchema: {
        file: z.string().describe('The path of the PDF file in the CV folder, or its name in that folder. For example, use the file from render_cv_pdf.'),
        name: z
          .string()
          .optional()
          .describe('The file name that recruiters see on djinni, for example CV_Name_Surname.pdf. The default is the name of the file.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safely(async ({ file, name }) => json(await prepareCvUpload(ctx, { file, name, cvFolderOnly: true }))),
  );

  server.registerTool(
    'submit_cv_upload',
    {
      title: 'Submit a CV upload',
      description:
        'Upload the PDF file of an approved draft to the djinni profile. ' +
        'Call this tool only after the user approved this exact file in the chat. Set confirm to true only then. ' +
        'Return the new CV file. If djinni shows no new CV file, return ok false with the HTTP status and a short text from the djinni page. ' +
        'If the result is ok false, call list_my_cvs before any retry. djinni may have the file already.',
      inputSchema: {
        draft_id: z.string().describe('The draft ID from prepare_cv_upload.'),
        confirm: z.literal(true).describe('Set to true only after the user approved this exact file in the chat.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    safely(async ({ draft_id }) => json(await submitCvUpload(ctx, draft_id, { cvFolderOnly: true }))),
  );
}
