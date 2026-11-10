import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { getMyProfile, prepareProfileUpdate, PROFILE_CHANGES, submitProfileUpdate } from '../core/profile.ts';
import { json, safely } from './result.ts';

export function registerProfileTools(server: McpServer, ctx: Ctx) {
  server.registerTool(
    'get_my_profile',
    {
      title: 'Read my profile',
      description:
        'Read the djinni candidate profile of the user. Return the title, the category, the salary and the experience. ' +
        'Also return the texts, the skills, the languages, the domains and the certifications. ' +
        'Also return the location, the work formats and the communication settings. ' +
        'The options field has the allowed values with labels for each select and checkbox group. Use these values in prepare_profile_update. ' +
        'This tool needs a djinni session.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safely(async () => json(await getMyProfile(ctx))),
  );

  server.registerTool(
    'prepare_profile_update',
    {
      title: 'Prepare a profile change',
      description:
        'Make a draft of a profile change. This tool changes nothing on djinni. Show the full diff to the user and ask for an explicit approval. ' +
        'Never add facts that the user did not confirm. Djinni blocks accounts for false profile data.',
      inputSchema: {
        changes: PROFILE_CHANGES.describe(
          'The fields to change, with the keys of get_my_profile. Give only the fields that change. A list replaces the full list.',
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safely(async ({ changes }) => json(await prepareProfileUpdate(ctx, changes))),
  );

  server.registerTool(
    'submit_profile_update',
    {
      title: 'Submit a profile change',
      description:
        'Send an approved profile draft to djinni. Call this tool only after the user approved this exact draft in the chat. Set confirm to true only then.',
      inputSchema: {
        draft_id: z.string().describe('The draft ID from prepare_profile_update.'),
        confirm: z.literal(true).describe('Set to true only after the user approved this exact draft in the chat.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    safely(async ({ draft_id }) => json(await submitProfileUpdate(ctx, draft_id))),
  );
}
