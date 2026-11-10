import { afterEach, describe, expect, test } from 'vitest';
import { callTool, callToolJson, connect, fixture, inboxWith, loggedInStore, startFakeDjinni, type FakeDjinni, type Route } from '../helpers.ts';

// The MCP contract of the inbox tools. The behavior of the operations is in test/core/inbox.test.ts.

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

const THREAD = '27257974';
const UNREAD = 'GET /my/inbox/?bucket=unread';

async function setup(routes: Record<string, Route> = {}) {
  djinni = await startFakeDjinni({
    'GET /my/inbox/': fixture('my_inbox.html'),
    [UNREAD]: inboxWith([THREAD]),
    [`GET /my/inbox/${THREAD}/`]: fixture('my_inbox_thread.html'),
    'POST /htmx/mark_unread/': '',
    ...routes,
  });
  return connect({ store: loggedInStore(), baseUrl: djinni.url, minIntervalMs: 0 });
}

const posts = () => djinni.requests.filter(r => r.method === 'POST');
const toolOf = async (client: Awaited<ReturnType<typeof setup>>, name: string) => (await client.listTools()).tools.find(t => t.name === name)!;

describe('list_inbox', () => {
  test('is a read-only tool', async () => {
    const client = await setup();

    expect((await toolOf(client, 'list_inbox')).annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });

  test('returns the threads with the unread flags', async () => {
    const client = await setup();

    const inbox = await callToolJson(client, 'list_inbox');

    expect(inbox.threads).toHaveLength(10);
    expect(inbox.threads[0]).toMatchObject({ id: THREAD, unread: true });
    expect(inbox.threads[1]).toMatchObject({ id: '27268862', unread: false });
  });

  test('sends the bucket and the query', async () => {
    const client = await setup({ 'GET /my/inbox/?bucket=archive&q=rust': inboxWith(['27268862']) });

    const inbox = await callToolJson(client, 'list_inbox', { bucket: 'archive', query: 'rust' });

    expect(inbox.threads.map((t: { id: string }) => t.id)).toEqual(['27268862']);
  });

  test('rejects an unknown bucket', async () => {
    const client = await setup();

    const res = await callTool(client, 'list_inbox', { bucket: 'spam' });

    expect(res.isError).toBe(true);
    expect(djinni.requests).toEqual([]);
  });
});

describe('get_inbox_thread', () => {
  test('tells the agent that djinni marks a conversation as read', async () => {
    const client = await setup();

    const tool = await toolOf(client, 'get_inbox_thread');

    expect(tool.description).toContain(
      'Read one conversation with an employer. Djinni marks a conversation as read when it is opened. ' +
        'By default this tool marks an unread conversation as unread again after it reads it.',
    );
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
  });

  test('marks an unread conversation as unread again by default', async () => {
    const client = await setup();

    const thread = await callToolJson(client, 'get_inbox_thread', { thread_id: THREAD });

    expect(thread).toMatchObject({ threadId: THREAD, wasUnread: true, restoredUnread: true });
    expect(thread.messages).toHaveLength(5);
    expect(posts()).toHaveLength(1);
  });

  test('sends no POST with keep_unread false', async () => {
    const client = await setup();

    const thread = await callToolJson(client, 'get_inbox_thread', { thread_id: THREAD, keep_unread: false });

    expect(thread.restoredUnread).toBe(false);
    expect(posts()).toEqual([]);
  });

  test('rejects a thread ID that is not digits', async () => {
    const client = await setup();

    const res = await callTool(client, 'get_inbox_thread', { thread_id: '../../my/profile' });

    expect(res.isError).toBe(true);
    expect(djinni.requests).toEqual([]);
  });
});

describe('mark_thread_unread', () => {
  test('sends one POST with the thread ID', async () => {
    const client = await setup();

    const result = await callToolJson(client, 'mark_thread_unread', { thread_id: THREAD });

    expect(result).toEqual({ threadId: THREAD, ok: true, status: 200 });
    expect(new URLSearchParams(posts()[0]!.body).get('mt_id')).toBe(THREAD);
    expect((await toolOf(client, 'mark_thread_unread')).annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
  });
});
