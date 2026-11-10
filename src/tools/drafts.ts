import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { deleteDraft, listDrafts } from '../core/drafts.ts';
import { json, safely } from './result.ts';

export function registerDraftTools(server: McpServer, ctx: Ctx) {
  server.registerTool(
    'list_drafts',
    {
      title: 'List the drafts',
      description:
        'List the drafts on this computer that did not expire, oldest first. Each draft has the ID, the kind, the dates and the preview. ' +
        'A draft expires 24 hours after it was made. This tool sends no request to djinni.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safely(async () => json(listDrafts(ctx).map(({ payload: _payload, ...draft }) => draft))),
  );

  server.registerTool(
    'delete_draft',
    {
      title: 'Delete a draft',
      description: 'Delete a draft from this computer. This tool changes nothing on djinni and sends no request to djinni.',
      inputSchema: { draft_id: z.string().describe('The draft ID from list_drafts or from a prepare_ tool.') },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    safely(async ({ draft_id }) => json(deleteDraft(ctx, draft_id))),
  );
}
