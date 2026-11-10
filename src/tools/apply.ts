import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { listApplications, prepareApplication, submitApplication } from '../core/apply.ts';
import { json, safely } from './result.ts';

export function registerApplyTools(server: McpServer, ctx: Ctx) {
  server.registerTool(
    'prepare_application',
    {
      title: 'Prepare a job application',
      description:
        'Make a draft of a job application. This tool sends nothing. Show the full cover letter, the CV name and the salary to the user and ask for an explicit approval. ' +
        'Write the cover letter only from true facts about the user.',
      inputSchema: {
        job: z.string().describe('A job ID like 857417, or a djinni job URL or path.'),
        message: z.string().describe('The full cover letter. Some jobs require a cover letter.'),
        cv_id: z
          .string()
          .optional()
          .describe('The ID of a CV file in the profile, from list_my_cvs. The default is the CV file that the apply form of djinni selects.'),
        salary: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('The salary in USD that the user wants for this job. The default is the salary of the profile.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safely(async ({ job, message, cv_id, salary }) => json(await prepareApplication(ctx, { job, message, cvId: cv_id, salary }))),
  );

  server.registerTool(
    'submit_application',
    {
      title: 'Submit a job application',
      description:
        'Send an approved application to the employer. Call this tool only after the user approved this exact draft in the chat. An application cannot be taken back.',
      inputSchema: {
        draft_id: z.string().describe('The draft ID from prepare_application.'),
        confirm: z.literal(true).describe('Set to true only after the user approved this exact draft in the chat.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    safely(async ({ draft_id }) => json(await submitApplication(ctx, draft_id))),
  );

  server.registerTool(
    'list_applications',
    {
      title: 'List the sent applications',
      description:
        'Return the applications that djinni-mcp sent, from the log on this computer, newest first. ' +
        'The log does not have the applications that the user sent on the djinni site. ' +
        'Also return the number of applications today and the daily limit.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safely(async () => json(listApplications(ctx))),
  );
}
