import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { getInboxThread, INBOX_BUCKETS, listInbox, markThreadUnread } from '../core/inbox.ts';
import { json, safely } from './result.ts';

const threadId = z.string().describe('The thread ID from list_inbox, for example 27257974.');

export function registerInboxTools(server: McpServer, ctx: Ctx) {
  server.registerTool(
    'list_inbox',
    {
      title: 'List the inbox conversations',
      description:
        'Read the list of the conversations with employers in the djinni inbox. This tool does not open a conversation, so it changes nothing on djinni. ' +
        'Without a bucket, the tool reads the main inbox and sets unread to true or false. In the apply and archive buckets, unread is null. ' +
        'This tool needs a djinni session.',
      inputSchema: {
        bucket: z.enum(INBOX_BUCKETS).optional().describe('The inbox bucket. Without it, the tool reads the main inbox.'),
        query: z.string().optional().describe('A search text for the conversations.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safely(async ({ bucket, query }) => json(await listInbox(ctx, { bucket, query }))),
  );

  server.registerTool(
    'get_inbox_thread',
    {
      title: 'Read an inbox conversation',
      description:
        'Read one conversation with an employer. Djinni marks a conversation as read when it is opened. ' +
        'By default this tool marks an unread conversation as unread again after it reads it. ' +
        'The side of a message is candidate for a message of the user and recruiter for a message of the employer. ' +
        'This tool cannot send a reply. This tool needs a djinni session.',
      inputSchema: {
        thread_id: threadId,
        keep_unread: z
          .boolean()
          .optional()
          .describe('Set to false only when the user wants the conversation to stay read. The default is true.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safely(async ({ thread_id, keep_unread }) => json(await getInboxThread(ctx, thread_id, { keepUnread: keep_unread ?? true }))),
  );

  server.registerTool(
    'mark_thread_unread',
    {
      title: 'Mark a conversation as unread',
      description: 'Mark one conversation of the djinni inbox as unread. This tool needs a djinni session.',
      inputSchema: { thread_id: threadId },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safely(async ({ thread_id }) => json(await markThreadUnread(ctx, thread_id))),
  );
}
