import type { Ctx } from '../context.ts';
import { LOGIN_HINT, NotLoggedInError } from '../http.ts';
import { hasInboxPage, parseInboxList, parseInboxThread, threadUrl, type InboxMessage, type InboxThreadSummary } from '../parsers/inbox.ts';

// The inbox operations only read, except markThreadUnread. They need a djinni session.
// djinni marks a thread as read when the thread page opens. getInboxThread can mark it as unread again.

export const INBOX_BUCKETS = ['unread', 'apply', 'archive'] as const;
export type InboxBucket = (typeof INBOX_BUCKETS)[number];

const INBOX_PATH = '/my/inbox/';
const MARK_UNREAD_PATH = '/htmx/mark_unread/';

// "warning" is set when the unread flags can be incomplete.
export type InboxList = { bucket: InboxBucket | null; query: string | null; threads: InboxThreadSummary[]; warning?: string };
// "wasUnread" is true when the thread was in the unread bucket before the read.
// "restoredUnread" is true when the thread was marked as unread again after the read.
export type InboxThread = {
  threadId: string;
  url: string;
  wasUnread: boolean;
  restoredUnread: boolean;
  messages: InboxMessage[];
  warning?: string;
};
export type MarkUnreadResult = { threadId: string; ok: boolean; status: number | null };

// A thread ID has only digits, so it cannot change the request path.
function threadId(input: string): string {
  if (!/^\d+$/.test(input)) throw new Error(`"${input}" is not a djinni thread ID. A thread ID has only digits.`);
  return input;
}

function checkBucket(bucket: string | undefined): InboxBucket | undefined {
  if (bucket === undefined || (INBOX_BUCKETS as readonly string[]).includes(bucket)) return bucket as InboxBucket | undefined;
  throw new Error(`"${bucket}" is not an inbox bucket. Use ${INBOX_BUCKETS.slice(0, -1).join(', ')} or ${INBOX_BUCKETS.at(-1)}.`);
}

function inboxPath(bucket?: InboxBucket, query?: string): string {
  const params = new URLSearchParams();
  if (bucket) params.set('bucket', bucket);
  if (query) params.set('q', query);
  const search = params.toString();
  return search ? `${INBOX_PATH}?${search}` : INBOX_PATH;
}

// The unread bucket can have more than one page. The pages after MAX_UNREAD_PAGES are not read.
const MAX_UNREAD_PAGES = 10;
const PAGE_LIMIT = `The unread bucket has more than ${MAX_UNREAD_PAGES} pages, and the tool read only the first ${MAX_UNREAD_PAGES} pages.`;

// Returns the IDs of the threads in the unread bucket, from all pages up to the page limit.
// "complete" is false when the page limit stopped the read before the last page.
async function unreadIds(ctx: Ctx): Promise<{ ids: Set<string>; complete: boolean }> {
  const ids = new Set<string>();
  let path = inboxPath('unread');
  for (let page = 1; page <= MAX_UNREAD_PAGES; page++) {
    const html = await ctx.client().get(path);
    for (const t of parseInboxList(html)) ids.add(t.id);
    if (!hasInboxPage(html, page + 1)) return { ids, complete: true };
    path = `${inboxPath('unread')}&page=${page + 1}`;
  }
  return { ids, complete: false };
}

// Reads the threads of an inbox bucket. Without a bucket, it reads the main bucket and then the unread bucket for the unread flags.
// In the apply and archive buckets, "unread" is null.
export async function listInbox(ctx: Ctx, opts: { bucket?: InboxBucket; query?: string } = {}): Promise<InboxList> {
  const bucket = checkBucket(opts.bucket);
  const query = opts.query?.trim() || undefined;
  const client = ctx.client();
  const threads = parseInboxList(await client.get(inboxPath(bucket, query)));
  if (bucket === 'unread') threads.forEach(t => (t.unread = true));
  const result: InboxList = { bucket: bucket ?? null, query: query ?? null, threads };
  if (bucket === undefined) {
    const unread = await unreadIds(ctx);
    threads.forEach(t => (t.unread = unread.ids.has(t.id)));
    if (!unread.complete) result.warning = `${PAGE_LIMIT} Some unread conversations can show as read.`;
  }
  return result;
}

// Sends the POST of the "mark as unread" action of the inbox page.
export async function markThreadUnread(ctx: Ctx, thread: string): Promise<MarkUnreadResult> {
  const id = threadId(thread);
  const res = await ctx.client().postForm(MARK_UNREAD_PATH, [['mt_id', id]], { hx: true });
  return { threadId: id, ok: res.status < 400, status: res.status };
}

function errorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause instanceof Error ? ` (${e.cause.message})` : '';
  return `${e.message}${cause}`.replace(/\.$/, '');
}

// Reads the messages of one thread. djinni marks the thread as read when the page opens.
// If the thread was unread and keepUnread is true, the thread is marked as unread again after the read.
export async function getInboxThread(ctx: Ctx, thread: string, opts: { keepUnread?: boolean } = {}): Promise<InboxThread> {
  const id = threadId(thread);
  const keepUnread = opts.keepUnread ?? true;
  const unread = await unreadIds(ctx);
  const wasUnread = unread.ids.has(id);
  const messages = parseInboxThread(await ctx.client().get(`${INBOX_PATH}${id}/`));
  const result: InboxThread = { threadId: id, url: threadUrl(id), wasUnread, restoredUnread: false, messages };
  if (!wasUnread && keepUnread && !unread.complete) {
    result.warning =
      `${PAGE_LIMIT} The conversation may have been unread before the read. ` +
      'Then djinni marked it as read, and the tool did not mark it as unread again.';
  }
  if (!wasUnread || !keepUnread) return result;
  const failed = 'djinni marked the conversation as read, and the request to mark it as unread again failed';
  try {
    const mark = await markThreadUnread(ctx, id);
    if (mark.ok) result.restoredUnread = true;
    else result.warning = `${failed}: HTTP ${mark.status}.`;
  } catch (e) {
    // The messages are read already. The user must log in again before the thread can be marked as unread.
    if (e instanceof NotLoggedInError) result.warning = `djinni marked the conversation as read, and the conversation stays read: the djinni session is not valid. ${LOGIN_HINT}.`;
    else result.warning = `${failed}: ${errorText(e)}.`;
  }
  return result;
}
