import { afterEach, describe, expect, test } from 'vitest';
import { fixture, inboxWith, loggedInStore, startFakeDjinni, type FakeDjinni, type Route } from '../helpers.ts';
import { cli } from './helpers.ts';

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

const THREAD = '27257974';
const UNREAD = 'GET /my/inbox/?bucket=unread';

async function run(argv: string[], routes: Record<string, Route> = {}) {
  djinni = await startFakeDjinni({
    'GET /my/inbox/': fixture('my_inbox.html'),
    [UNREAD]: inboxWith([THREAD]),
    [`GET /my/inbox/${THREAD}/`]: fixture('my_inbox_thread.html'),
    'POST /htmx/mark_unread/': '',
    ...routes,
  });
  return cli(argv, { store: loggedInStore(), baseUrl: djinni.url, minIntervalMs: 0 });
}

const posts = () => djinni.requests.filter(r => r.method === 'POST');

describe('djinni inbox', () => {
  test('prints one entry for each conversation with the unread mark', async () => {
    const res = await run(['inbox']);

    expect(res.code).toBe(0);
    expect(res.out).toMatch(/^27257974  unread  TEXT_24 TEXT_25 \| TEXT_15 · TEXT_17 \| TEXT_18\n  TEXT_26\n27268862  TEXT_44 TEXT_45 \| TEXT_33 · TEXT_35 \| TEXT_36 · TEXT_38\n  TEXT_46\n/);
    expect(res.out).toMatch(/\nRead a conversation: npx djinni-mcp inbox read <thread-id>\n$/);
    expect(posts()).toEqual([]);
  });

  test('sends the bucket and the query flags', async () => {
    const res = await run(['inbox', '--bucket', 'apply', '--query', 'go'], { 'GET /my/inbox/?bucket=apply&q=go': inboxWith(['27268862']) });

    expect(res.code).toBe(0);
    expect(res.out).toMatch(/^27268862  TEXT_44/);
    expect(djinni.requests.map(r => r.url)).toEqual(['/my/inbox/?bucket=apply&q=go']);
  });

  test('prints the page limit warning to stderr', async () => {
    const endless: Route = req => {
      const page = Number(new URL(req.url, 'http://x').searchParams.get('page') ?? '1');
      return inboxWith([THREAD]).replace('</body>', `<ul class="pagination"><li><a class="page-link" href="?bucket=unread&amp;page=${page + 1}">${page + 1}</a></li></ul></body>`);
    };

    const res = await run(['inbox'], { [UNREAD]: endless, 'GET /my/inbox/': endless });

    expect(res.code).toBe(0);
    expect(res.err).toBe(
      'Warning: The unread bucket has more than 10 pages, and the tool read only the first 10 pages. Some unread conversations can show as read.\n',
    );
  });

  test('prints a short line for an empty bucket', async () => {
    const res = await run(['inbox', '--bucket', 'archive'], { 'GET /my/inbox/?bucket=archive': inboxWith([]) });

    expect(res.out).toBe('No conversations.\n');
  });

  test('exits with 1 for an unknown bucket', async () => {
    const res = await run(['inbox', '--bucket', 'spam']);

    expect(res.code).toBe(1);
    expect(res.err).toContain('"spam" is not an inbox bucket.');
  });

  test('prints JSON with --json', async () => {
    const res = await run(['inbox', '--json']);

    expect(JSON.parse(res.out).threads[0]).toMatchObject({ id: THREAD, unread: true });
  });

  test('removes the control characters from the human output', async () => {
    const html = fixture('my_inbox.html').replace('>TEXT_26<', '>TEXT\u001b[2J_26\u009b31m<');

    const res = await run(['inbox'], { 'GET /my/inbox/': html });

    expect(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(res.out)).toBe(false);
    expect(res.out).toContain('\n  TEXT[2J_2631m\n');
  });
});

describe('djinni inbox read', () => {
  test('prints the messages and marks an unread conversation as unread again', async () => {
    const res = await run(['inbox', 'read', THREAD]);

    expect(res.code).toBe(0);
    expect(res.out).toMatch(/^Conversation 27257974: https:\/\/djinni\.co\/my\/inbox\/27257974\/\n\nYou, TEXT_50, TEXT_51 TEXT_52:\nTEXT_53\n\nTEXT_54\n/);
    expect(res.out).toContain('\n\nEmployer, TEXT_65, TEXT_66 TEXT_67:\nTEXT_68\n\n');
    expect(res.out).toMatch(/\nThe conversation is marked as unread again\.\n$/);
    expect(posts()).toHaveLength(1);
  });

  test('sends no POST with --mark-read', async () => {
    const res = await run(['inbox', 'read', THREAD, '--mark-read']);

    expect(res.code).toBe(0);
    expect(res.out).toMatch(/\nThe conversation is now marked as read\.\n$/);
    expect(posts()).toEqual([]);
  });

  test('prints the warning to stderr when the mark_unread POST fails', async () => {
    const res = await run(['inbox', 'read', THREAD], { 'POST /htmx/mark_unread/': { status: 500, body: 'error' } });

    expect(res.code).toBe(0);
    expect(res.err).toBe('Warning: djinni marked the conversation as read, and the request to mark it as unread again failed: HTTP 500.\n');
  });

  test('exits with 2 without a thread ID', async () => {
    const res = await run(['inbox', 'read']);

    expect(res.code).toBe(2);
    expect(res.err).toContain('"npx djinni-mcp inbox read" needs <thread-id>.');
  });
});

describe('djinni inbox unread', () => {
  test('marks the conversation as unread', async () => {
    const res = await run(['inbox', 'unread', THREAD]);

    expect(res.code).toBe(0);
    expect(res.out).toBe('Conversation 27257974 is marked as unread.\n');
    expect(new URLSearchParams(posts()[0]!.body).get('mt_id')).toBe(THREAD);
  });

  test('exits with 1 when djinni rejects the request', async () => {
    const res = await run(['inbox', 'unread', THREAD], { 'POST /htmx/mark_unread/': { status: 403, body: 'no' } });

    expect(res.code).toBe(1);
    expect(res.out).toBe('djinni returned HTTP 403. The conversation may still be marked as read.\n');
  });
});
