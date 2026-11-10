import { getInboxThread, listInbox, markThreadUnread, type InboxBucket } from '../../core/inbox.ts';
import { print, type Command } from '../command.ts';
import { inboxText, inboxThreadText, markUnreadText } from '../format.ts';
import { BIN } from '../../bin.ts';

const SESSION = 'This needs a djinni session.';

// "inbox read" and "inbox unread" come before "inbox", so that the CLI finds the two-word commands first.
export const inboxCommands: Command[] = [
  {
    name: 'inbox read',
    args: ['<thread-id>'],
    summary:
      'Print the messages of one conversation. djinni marks a conversation as read when it is opened. ' +
      `By default, the command marks an unread conversation as unread again after it reads it. ${SESSION}`,
    flags: [{ name: 'mark-read', type: 'boolean', description: 'Let the conversation stay read.' }],
    async run(values, [id], env) {
      const thread = await getInboxThread(env.ctx, id!, { keepUnread: values['mark-read'] !== true });
      print(env, thread, () => inboxThreadText(thread), thread.warning);
    },
  },
  {
    name: 'inbox unread',
    args: ['<thread-id>'],
    summary: `Mark one conversation as unread. ${SESSION}`,
    async run(_values, [id], env) {
      const result = await markThreadUnread(env.ctx, id!);
      print(env, result, () => markUnreadText(result));
      return result.ok ? 0 : 1;
    },
  },
  {
    name: 'inbox',
    summary: `Print the conversations with employers in your djinni inbox. This command opens no conversation. Read a conversation with "${BIN} inbox read <thread-id>". ${SESSION}`,
    flags: [
      { name: 'bucket', type: 'string', value: 'unread|apply|archive', description: 'The inbox bucket. Without it, the command reads the main inbox.' },
      { name: 'query', type: 'string', value: 'text', description: 'A search text for the conversations.' },
    ],
    async run(values, _args, env) {
      const inbox = await listInbox(env.ctx, { bucket: values.bucket as InboxBucket | undefined, query: values.query as string | undefined });
      print(env, inbox, () => inboxText(inbox), inbox.warning);
    },
  },
];
