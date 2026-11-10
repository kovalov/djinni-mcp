import { afterEach, describe, expect, test } from 'vitest';
import { Ctx } from '../../src/context.ts';
import { getInboxThread, listInbox, markThreadUnread } from '../../src/core/inbox.ts';
import { NotLoggedInError } from '../../src/http.ts';
import { fixture, inboxWith, loggedInStore, startFakeDjinni, tempStore, type FakeDjinni, type Route } from '../helpers.ts';

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

const THREAD = '27257974';
const UNREAD = 'GET /my/inbox/?bucket=unread';

async function setup(routes: Record<string, Route> = {}) {
  djinni = await startFakeDjinni({
    'GET /my/profile/': fixture('my_profile.html'),
    'GET /my/inbox/': fixture('my_inbox.html'),
    [UNREAD]: inboxWith([]),
    [`GET /my/inbox/${THREAD}/`]: fixture('my_inbox_thread.html'),
    'POST /htmx/mark_unread/': '',
    ...routes,
  });
  return new Ctx({ store: loggedInStore(), baseUrl: djinni.url, minIntervalMs: 0 });
}

const posts = () => djinni.requests.filter(r => r.method === 'POST');
const gets = () => djinni.requests.filter(r => r.method === 'GET').map(r => r.url);

describe('listInbox', () => {
  test('reads each thread of the inbox page', async () => {
    const ctx = await setup();

    const inbox = await listInbox(ctx);

    expect(inbox.threads).toHaveLength(10);
    expect(inbox.threads[0]).toEqual({
      id: THREAD,
      url: `https://djinni.co/my/inbox/${THREAD}/`,
      label: 'TEXT_15 · TEXT_17',
      jobTitle: 'TEXT_18',
      preview: 'TEXT_26',
      date: 'TEXT_24 TEXT_25',
      unread: false,
    });
    expect(inbox.threads[1]).toMatchObject({ id: '27268862', label: 'TEXT_33 · TEXT_35', jobTitle: 'TEXT_36 · TEXT_38', preview: 'TEXT_46' });
    expect(inbox.threads.map(t => t.id)).toContain('25070689');
  });

  test('marks the threads of the unread bucket with one extra request for the default bucket', async () => {
    const ctx = await setup({ [UNREAD]: inboxWith(['27268862']) });

    const inbox = await listInbox(ctx);

    expect(inbox.threads.filter(t => t.unread).map(t => t.id)).toEqual(['27268862']);
    expect(gets()).toEqual(['/my/inbox/', '/my/inbox/?bucket=unread']);
  });

  test('sends the bucket and the search query and no extra request for the unread bucket', async () => {
    const ctx = await setup({ 'GET /my/inbox/?bucket=unread&q=python+dev': inboxWith(['27268862']) });

    const inbox = await listInbox(ctx, { bucket: 'unread', query: 'python dev' });

    expect(inbox.threads.map(t => [t.id, t.unread])).toEqual([['27268862', true]]);
    expect(gets()).toEqual(['/my/inbox/?bucket=unread&q=python+dev']);
  });

  test('sends no extra request for the archive bucket and gives unread null', async () => {
    const ctx = await setup();

    const inbox = await listInbox(ctx, { bucket: 'archive' });

    expect(gets()).toEqual(['/my/inbox/?bucket=archive']);
    expect(inbox.threads[0]!.unread).toBeNull();
  });

  test('checks the unread bucket also for a search in the default bucket', async () => {
    const ctx = await setup({ [UNREAD]: inboxWith([THREAD]) });

    const inbox = await listInbox(ctx, { query: 'go' });

    expect(gets()).toEqual(['/my/inbox/?q=go', '/my/inbox/?bucket=unread']);
    expect(inbox.threads[0]).toMatchObject({ id: THREAD, unread: true });
  });

  test('rejects an unknown bucket before a request', async () => {
    const ctx = await setup();

    await expect(listInbox(ctx, { bucket: 'spam' as never })).rejects.toThrow('"spam" is not an inbox bucket. Use unread, apply or archive.');
    expect(djinni.requests).toEqual([]);
  });

  test('throws NotLoggedInError without a saved session', async () => {
    djinni = await startFakeDjinni();
    const ctx = new Ctx({ store: tempStore(), baseUrl: djinni.url, minIntervalMs: 0 });

    await expect(listInbox(ctx)).rejects.toBeInstanceOf(NotLoggedInError);
    expect(djinni.requests).toEqual([]);
  });
});

describe('getInboxThread', () => {
  test('reads the messages in order with the side, the date and the paragraphs', async () => {
    const ctx = await setup();

    const thread = await getInboxThread(ctx, THREAD);

    expect(thread.threadId).toBe(THREAD);
    expect(thread.url).toBe(`https://djinni.co/my/inbox/${THREAD}/`);
    expect(thread.messages.map(m => [m.id, m.side])).toEqual([
      ['71360017', 'candidate'],
      ['71360018', 'recruiter'],
      ['71360147', 'recruiter'],
      ['71360412', 'candidate'],
      ['71451653', 'recruiter'],
    ]);
    expect(thread.messages[0]).toMatchObject({ author: 'TEXT_50', date: 'TEXT_51 TEXT_52' });
    expect(thread.messages[0]!.text).toBe(
      'TEXT_53\n\nTEXT_54\n\nTEXT_55\n\nTEXT_56\n\nTEXT_57\n\nTEXT_58\n\nTEXT_59 TEXT_60\n\n- TEXT_61\n\nTEXT_62\n\n- TEXT_63\n\nTEXT_64',
    );
    expect(thread.messages[1]).toEqual({ id: '71360018', side: 'recruiter', author: 'TEXT_65', date: 'TEXT_66 TEXT_67', text: 'TEXT_68' });
    expect(thread.messages[3]!.text).toBe('TEXT_77\nTEXT_78');
    expect(thread.messages[4]!.text).toBe('TEXT_83\n\nTEXT_84\nTEXT_85');
  });

  test('sends no mark_unread POST for a thread that was read', async () => {
    const ctx = await setup();

    const thread = await getInboxThread(ctx, THREAD);

    expect(thread).toMatchObject({ wasUnread: false, restoredUnread: false });
    expect(posts()).toEqual([]);
    expect(gets()).toEqual(['/my/inbox/?bucket=unread', `/my/inbox/${THREAD}/`]);
  });

  test('marks an unread thread as unread again after the read with one POST', async () => {
    const ctx = await setup({ [UNREAD]: inboxWith([THREAD]) });

    const thread = await getInboxThread(ctx, THREAD, { keepUnread: true });

    expect(thread).toMatchObject({ wasUnread: true, restoredUnread: true });
    expect(posts()).toHaveLength(1);
    const post = posts()[0]!;
    expect(post.url).toBe('/htmx/mark_unread/');
    expect(post.headers['hx-request']).toBe('true');
    expect(new URLSearchParams(post.body).get('mt_id')).toBe(THREAD);
    const order = djinni.requests.map(r => `${r.method} ${r.url}`);
    expect(order.indexOf('POST /htmx/mark_unread/')).toBeGreaterThan(order.indexOf(`GET /my/inbox/${THREAD}/`));
  });

  test('keeps an unread thread unread by default', async () => {
    const ctx = await setup({ [UNREAD]: inboxWith([THREAD]) });

    const thread = await getInboxThread(ctx, THREAD);

    expect(thread.restoredUnread).toBe(true);
    expect(posts()).toHaveLength(1);
  });

  test('sends no POST with keepUnread false', async () => {
    const ctx = await setup({ [UNREAD]: inboxWith([THREAD]) });

    const thread = await getInboxThread(ctx, THREAD, { keepUnread: false });

    expect(thread).toMatchObject({ wasUnread: true, restoredUnread: false });
    expect(posts()).toEqual([]);
  });

  test('returns the messages with a warning when djinni rejects the mark_unread POST', async () => {
    const ctx = await setup({ [UNREAD]: inboxWith([THREAD]), 'POST /htmx/mark_unread/': { status: 500, body: 'error' } });

    const thread = await getInboxThread(ctx, THREAD);

    expect(thread.messages).toHaveLength(5);
    expect(thread.restoredUnread).toBe(false);
    expect(thread.warning).toBe('djinni marked the conversation as read, and the request to mark it as unread again failed: HTTP 500.');
  });

  test('returns the messages with a login warning when the session expires before the mark_unread POST', async () => {
    const ctx = await setup({ [UNREAD]: inboxWith([THREAD]), 'POST /htmx/mark_unread/': { status: 302, headers: { location: '/login' } } });

    const thread = await getInboxThread(ctx, THREAD);

    expect(thread.messages).toHaveLength(5);
    expect(thread.restoredUnread).toBe(false);
    expect(thread.warning).toBe(
      'djinni marked the conversation as read, and the conversation stays read: the djinni session is not valid. Run in a separate terminal window: npx djinni-mcp login.',
    );
  });

  test.each([['../profile'], ['123/'], ['12a'], ['']])('rejects the thread ID %j before a request', async id => {
    const ctx = await setup();

    await expect(getInboxThread(ctx, id)).rejects.toThrow(`"${id}" is not a djinni thread ID. A thread ID has only digits.`);
    expect(djinni.requests).toEqual([]);
  });
});

// An unread bucket page with a next-page link, as the paginated lists of djinni show it.
const withNextPage = (html: string, next: number) =>
  html.replace('</body>', `<ul class="pagination"><li class="page-item"><a class="page-link" href="?bucket=unread&amp;page=${next}">${next}</a></li></ul></body>`);

describe('the unread bucket with more pages', () => {
  test('follows the next page before it decides that a thread is read', async () => {
    const ctx = await setup({
      [UNREAD]: withNextPage(inboxWith(['27268862']), 2),
      'GET /my/inbox/?bucket=unread&page=2': inboxWith([THREAD]),
    });

    const thread = await getInboxThread(ctx, THREAD);

    expect(thread).toMatchObject({ wasUnread: true, restoredUnread: true });
    expect(gets()).toEqual(['/my/inbox/?bucket=unread', '/my/inbox/?bucket=unread&page=2', `/my/inbox/${THREAD}/`]);
  });

  test('marks the threads of all unread pages in the inbox list', async () => {
    const ctx = await setup({
      [UNREAD]: withNextPage(inboxWith(['27268862']), 2),
      'GET /my/inbox/?bucket=unread&page=2': inboxWith([THREAD]),
    });

    const inbox = await listInbox(ctx);

    expect(inbox.threads.filter(t => t.unread).map(t => t.id)).toEqual([THREAD, '27268862']);
  });

  test('reads at most 10 pages', async () => {
    const endless: Route = req => {
      const page = Number(new URL(req.url, 'http://x').searchParams.get('page') ?? '1');
      return withNextPage(inboxWith([]), page + 1);
    };
    const ctx = await setup({ [UNREAD]: endless, 'GET /my/inbox/': endless });

    await getInboxThread(ctx, THREAD);

    expect(gets().filter(u => u.startsWith('/my/inbox/?bucket=unread'))).toHaveLength(10);
  });

  const endless: Route = req => {
    const page = Number(new URL(req.url, 'http://x').searchParams.get('page') ?? '1');
    return withNextPage(inboxWith([]), page + 1);
  };

  test('warns in the inbox list when the page limit stops the read of the unread bucket', async () => {
    const ctx = await setup({ [UNREAD]: endless, 'GET /my/inbox/': endless });

    const inbox = await listInbox(ctx);

    expect(inbox.warning).toBe(
      'The unread bucket has more than 10 pages, and the tool read only the first 10 pages. Some unread conversations can show as read.',
    );
  });

  test('warns in the thread when the page limit stops the read and the thread is not on the pages that were read', async () => {
    const ctx = await setup({ [UNREAD]: endless, 'GET /my/inbox/': endless });

    const thread = await getInboxThread(ctx, THREAD);

    expect(thread.warning).toBe(
      'The unread bucket has more than 10 pages, and the tool read only the first 10 pages. ' +
        'The conversation may have been unread before the read. Then djinni marked it as read, and the tool did not mark it as unread again.',
    );
  });

  test('gives no page limit warning when all unread pages were read', async () => {
    const ctx = await setup({ [UNREAD]: withNextPage(inboxWith(['27268862']), 2), 'GET /my/inbox/?bucket=unread&page=2': inboxWith([]) });

    expect((await listInbox(ctx)).warning).toBeUndefined();
    expect((await getInboxThread(ctx, THREAD)).warning).toBeUndefined();
  });
});

describe('markThreadUnread', () => {
  test('sends one HTMX POST with the thread ID', async () => {
    const ctx = await setup();

    const result = await markThreadUnread(ctx, THREAD);

    expect(result).toEqual({ threadId: THREAD, ok: true, status: 200 });
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.headers['hx-request']).toBe('true');
    expect(new URLSearchParams(posts()[0]!.body).get('mt_id')).toBe(THREAD);
  });

  test('returns ok false for an HTTP error', async () => {
    const ctx = await setup({ 'POST /htmx/mark_unread/': { status: 403, body: 'no' } });

    expect(await markThreadUnread(ctx, THREAD)).toEqual({ threadId: THREAD, ok: false, status: 403 });
  });

  test('rejects a thread ID with other characters before a request', async () => {
    const ctx = await setup();

    await expect(markThreadUnread(ctx, '1 2')).rejects.toThrow('"1 2" is not a djinni thread ID.');
    expect(djinni.requests).toEqual([]);
  });
});
