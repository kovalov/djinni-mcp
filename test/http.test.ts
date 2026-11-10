import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { DjinniClient, GET_TIMEOUT_MS, NotLoggedInError, SEND_TIMEOUT_MS } from '../src/http.ts';
import { startFakeDjinni } from './helpers.ts';
import type { Cookie } from '../src/session.ts';

type Seen = { method: string; url: string; headers: IncomingMessage['headers']; body: string };

let server: Server;
let baseUrl: string;
let seen: Seen[];
let handler: (req: IncomingMessage, body: string) => { status?: number; headers?: Record<string, string | string[]>; body?: string };

beforeEach(async () => {
  seen = [];
  handler = () => ({ body: '<html>ok</html>' });
  server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const r = handler(req, body);
      res.writeHead(r.status ?? 200, { 'content-type': 'text/html', ...(r.headers ?? {}) });
      res.end(r.body ?? '');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => new Promise<void>(resolve => server.close(() => resolve())));

// A second local server on another origin. It records each request that it receives.
const startServer = async () => {
  const seen: string[] = [];
  const s = createServer((req, res) => {
    seen.push(req.url ?? '');
    res.end('other');
  });
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise<void>(resolve => s.close(() => resolve())) };
};

const cookies = (): Cookie[] => [
  { name: 'sessionid', value: 'SESS', domain: '.djinni.co', path: '/' },
  { name: 'csrftoken', value: 'CSRF', domain: 'djinni.co', path: '/' },
  { name: 'other', value: 'X', domain: '.example.com', path: '/' },
];

const client = (opts: Partial<ConstructorParameters<typeof DjinniClient>[0]> = {}) =>
  new DjinniClient({ baseUrl, cookies: cookies(), minIntervalMs: 0, ...opts });

describe('DjinniClient.get', () => {
  test('sends only djinni cookies and a browser user agent', async () => {
    const html = await client().get('/jobs/');

    expect(html).toBe('<html>ok</html>');
    expect(seen[0]!.headers.cookie).toBe('sessionid=SESS; csrftoken=CSRF');
    expect(seen[0]!.headers['user-agent']).toMatch(/Mozilla\/5\.0/);
  });

  test('adds the HX-Request header for HTMX fragments', async () => {
    await client().get('/ajax/cv_input/', { hx: true });

    expect(seen[0]!.headers['hx-request']).toBe('true');
  });

  test('throws NotLoggedInError when djinni redirects to the login page', async () => {
    handler = () => ({ status: 302, headers: { location: '/login?next=/my/profile/' } });

    await expect(client().get('/my/profile/')).rejects.toBeInstanceOf(NotLoggedInError);
  });

  test.each([['/continue/'], ['/continue/?next=/my/profile/']])(
    'throws NotLoggedInError when djinni redirects to %s',
    async location => {
      handler = () => ({ status: 302, headers: { location } });

      await expect(client().get('/my/profile/')).rejects.toBeInstanceOf(NotLoggedInError);
    },
  );

  test('throws NotLoggedInError for a redirect to /continue/ as an absolute URL on the same origin', async () => {
    handler = () => ({ status: 302, headers: { location: `${baseUrl}/continue/` } });

    await expect(client().get('/my/profile/')).rejects.toBeInstanceOf(NotLoggedInError);
    expect(seen).toHaveLength(1);
  });

  test('detects a login redirect on Node versions without URL.parse', async () => {
    // Node 22.0 has no URL.parse. package.json allows Node 22.0.
    const parse = Object.getOwnPropertyDescriptor(URL, 'parse')!;
    Reflect.deleteProperty(URL, 'parse');
    try {
      handler = () => ({ status: 302, headers: { location: '/continue/' } });

      await expect(client().get('/my/profile/')).rejects.toBeInstanceOf(NotLoggedInError);
      await expect(client().postForm('/my/profile/', [['a', 'b']])).rejects.toBeInstanceOf(NotLoggedInError);
    } finally {
      Object.defineProperty(URL, 'parse', parse);
    }
  });

  test('does not throw for a Location header that is not a valid URL', async () => {
    handler = () => ({ status: 200, headers: { location: 'http://[bad' }, body: 'page' });

    expect(await client().get('/jobs/')).toBe('page');
  });

  test('follows a redirect to a path that only starts with the word continue', async () => {
    handler = req => (req.url === '/old/' ? { status: 302, headers: { location: '/continued/' } } : { body: 'continued page' });

    expect(await client().get('/old/')).toBe('continued page');
  });

  test('follows a redirect that does not go to the login page', async () => {
    handler = req => (req.url === '/old/' ? { status: 301, headers: { location: '/new/' } } : { body: 'new page' });

    expect(await client().get('/old/')).toBe('new page');
  });

  test('follows a redirect to an absolute URL on the same origin', async () => {
    handler = req => (req.url === '/old/' ? { status: 302, headers: { location: `${baseUrl}/new/` } } : { body: 'new page' });

    expect(await client().get('/old/')).toBe('new page');
    expect(seen[1]!.headers.cookie).toBe('sessionid=SESS; csrftoken=CSRF');
  });

  test('throws NotLoggedInError for a login redirect to an absolute URL on the same origin', async () => {
    handler = () => ({ status: 302, headers: { location: `${baseUrl}/login?next=/my/` } });

    await expect(client().get('/my/')).rejects.toBeInstanceOf(NotLoggedInError);
  });

  test('throws on a redirect to another origin and sends no request there', async () => {
    const other = await startServer();
    try {
      handler = () => ({ status: 302, headers: { location: `${other.url}/steal/` } });

      await expect(client().get('/jobs/')).rejects.toThrow(other.url);
      expect(other.seen).toEqual([]);
    } finally {
      await other.close();
    }
  });

  test('throws after more than 5 redirects in one call', async () => {
    handler = req => {
      const n = Number(req.url?.match(/^\/r(\d+)/)?.[1] ?? 0);
      return { status: 302, headers: { location: `/r${n + 1}` } };
    };

    await expect(client().get('/r0')).rejects.toThrow(/redirects/);
    expect(seen.length).toBe(6);
  });

  test('follows a chain of 5 redirects', async () => {
    handler = req => {
      const n = Number(req.url?.match(/^\/r(\d+)/)?.[1] ?? 0);
      return n < 5 ? { status: 302, headers: { location: `/r${n + 1}` } } : { body: 'end' };
    };

    expect(await client().get('/r0')).toBe('end');
  });

  test('never sends a request to a URL on another origin', async () => {
    const other = await startServer();
    try {
      await expect(client().get(`${other.url}/x/`)).rejects.toThrow(other.url);
      await expect(client().postForm(`${other.url}/x/`, [['a', 'b']])).rejects.toThrow(other.url);
      expect(other.seen).toEqual([]);
    } finally {
      await other.close();
    }
  });

  test('throws an error that names the status and the path on HTTP 4xx and 5xx', async () => {
    handler = () => ({ status: 404, body: 'not found' });

    await expect(client().get('/jobs/1-x/')).rejects.toThrow('HTTP 404 for GET /jobs/1-x/');
  });

  test('stores cookies that the server sets', async () => {
    handler = () => ({ headers: { 'set-cookie': ['csrftoken=NEW; Path=/; Secure', 'messages=m1; Path=/'] }, body: 'x' });
    const c = client();

    await c.get('/jobs/');
    await c.get('/jobs/');

    expect(seen[1]!.headers.cookie).toBe('sessionid=SESS; csrftoken=NEW; messages=m1');
  });

  test('waits at least minIntervalMs between two requests', async () => {
    const c = client({ minIntervalMs: 150 });

    const start = Date.now();
    await c.get('/a');
    await c.get('/b');

    expect(Date.now() - start).toBeGreaterThanOrEqual(150);
  });
});

describe('DjinniClient.getJson', () => {
  test('parses the body as JSON', async () => {
    handler = () => ({ headers: { 'content-type': 'application/json' }, body: '{"count":2,"results":[]}' });

    expect(await client().getJson<{ count: number }>('/api/jobs/')).toEqual({ count: 2, results: [] });
  });

  test('sends the HX-Request header when hx is set', async () => {
    handler = () => ({ body: '[]' });

    await client().getJson('/api/jobs/', { hx: true });

    expect(seen[0]!.headers['hx-request']).toBe('true');
  });

  test('throws an error that names the path when djinni returns an HTML page', async () => {
    handler = () => ({ body: '<!DOCTYPE html><html><body>Maintenance</body></html>' });

    const err = await client()
      .getJson('/api/jobs/?category=python')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('/api/jobs/?category=python');
    expect((err as Error).message).toContain('djinni returned no JSON');
    expect(err).not.toBeInstanceOf(SyntaxError);
  });
});

describe('DjinniClient.postForm', () => {
  test('throws NotLoggedInError when djinni redirects the form to /continue/', async () => {
    handler = () => ({ status: 302, headers: { location: '/continue/' } });

    await expect(client().postForm('/my/profile/', [['position', 'X']])).rejects.toBeInstanceOf(NotLoggedInError);
  });

  test('sends an urlencoded form with the CSRF token from the cookie', async () => {
    await client().postForm('/my/profile/', [
      ['position', 'Data Engineer'],
      ['format_options', 'remote'],
      ['format_options', 'office'],
    ]);

    const req = seen[0]!;
    expect(req.method).toBe('POST');
    expect(req.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(req.headers['x-csrftoken']).toBe('CSRF');
    expect(req.headers.referer).toBe(`${baseUrl}/my/profile/`);
    expect(new URLSearchParams(req.body).getAll('format_options')).toEqual(['remote', 'office']);
    expect(new URLSearchParams(req.body).get('csrfmiddlewaretoken')).toBe('CSRF');
  });

  test('sends multipart data when a field holds a file', async () => {
    await client().postForm('/my/account/', [
      ['name', 'Test'],
      ['cv_file', { filename: 'cv.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4') }],
    ]);

    const req = seen[0]!;
    expect(req.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(req.body).toContain('filename="cv.pdf"');
    expect(req.body).toContain('%PDF-1.4');
    expect(req.body).toContain('name="csrfmiddlewaretoken"');
  });

  test('sends multipart data without a file when the caller asks for it', async () => {
    await client().postForm('/jobs/1-x/', [['message', 'Привіт'], ['job_apply', '']], { multipart: true });

    const req = seen[0]!;
    expect(req.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const form = await new Response(req.body, { headers: { 'content-type': req.headers['content-type']! } }).formData();
    expect([...form.entries()]).toEqual([
      ['message', 'Привіт'],
      ['job_apply', ''],
      ['csrfmiddlewaretoken', 'CSRF'],
    ]);
  });

  test('returns the status, the final location and the body', async () => {
    handler = () => ({ status: 302, headers: { location: '/my/profile/?saved=1' } });

    const res = await client().postForm('/my/profile/', [['position', 'X']]);

    expect(res).toEqual({ status: 302, location: '/my/profile/?saved=1', body: '' });
  });
});

describe('DjinniClient.postJson', () => {
  test('sends a JSON body with the CSRF header, the Referer and the Origin', async () => {
    handler = () => ({ status: 201, headers: { 'content-type': 'application/json' }, body: '{"id":1}' });

    const res = await client().postJson('/api/jobs/favorites/', { job_id: 123, referral: 'detail' });

    const req = seen[0]!;
    expect(req.method).toBe('POST');
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers['x-csrftoken']).toBe('CSRF');
    expect(req.headers.referer).toBe(`${baseUrl}/api/jobs/favorites/`);
    expect(req.headers.origin).toBe(baseUrl);
    expect(req.headers.cookie).toBe('sessionid=SESS; csrftoken=CSRF');
    expect(JSON.parse(req.body)).toEqual({ job_id: 123, referral: 'detail' });
    expect(res).toEqual({ status: 201, location: null, body: '{"id":1}' });
  });

  test('throws NotLoggedInError when djinni redirects the request to the login page', async () => {
    handler = () => ({ status: 302, headers: { location: '/login?next=/api/jobs/favorites/' } });

    await expect(client().postJson('/api/jobs/favorites/', {})).rejects.toBeInstanceOf(NotLoggedInError);
  });

  test('refuses a path on another origin', async () => {
    const other = await startServer();
    try {
      await expect(client().postJson(`${other.url}/x/`, {})).rejects.toThrow(other.url);
      expect(other.seen).toEqual([]);
    } finally {
      await other.close();
    }
  });
});

describe('DjinniClient.delete', () => {
  test('sends DELETE with the CSRF header and the Referer and returns the status', async () => {
    handler = () => ({ status: 204 });

    const res = await client().delete('/api/jobs/favorites/123/');

    const req = seen[0]!;
    expect(req.method).toBe('DELETE');
    expect(req.url).toBe('/api/jobs/favorites/123/');
    expect(req.headers['x-csrftoken']).toBe('CSRF');
    expect(req.headers.referer).toBe(`${baseUrl}/api/jobs/favorites/123/`);
    expect(req.headers.origin).toBe(baseUrl);
    expect(res).toEqual({ status: 204, location: null, body: '' });
  });

  test('throws NotLoggedInError when djinni redirects the request to /continue/', async () => {
    handler = () => ({ status: 302, headers: { location: '/continue/' } });

    await expect(client().delete('/api/jobs/blocked/1/')).rejects.toBeInstanceOf(NotLoggedInError);
  });
});

describe('DjinniClient request timeout', () => {
  test('uses 30 s for a GET and 60 s for a request that changes data', () => {
    expect(GET_TIMEOUT_MS).toBe(30_000);
    expect(SEND_TIMEOUT_MS).toBe(60_000);
  });

  test('a GET without an answer fails after the GET timeout', async () => {
    const fake = await startFakeDjinni({ 'GET /slow/': { body: 'late', delayMs: 1000 } });
    try {
      const c = new DjinniClient({ baseUrl: fake.url, cookies: cookies(), minIntervalMs: 0, timeouts: { getMs: 50 } });

      await expect(c.get('/slow/')).rejects.toThrow('djinni did not answer GET /slow/ in 0.05 s.');
    } finally {
      await fake.close();
    }
  });

  test('a POST without an answer fails after the POST timeout, and the next request is sent', async () => {
    const fake = await startFakeDjinni({ 'POST /slow/': { body: 'late', delayMs: 1000 }, 'GET /next/': 'next' });
    try {
      const c = new DjinniClient({ baseUrl: fake.url, cookies: cookies(), minIntervalMs: 0, timeouts: { sendMs: 50 } });

      await expect(c.postForm('/slow/', [['a', 'b']])).rejects.toThrow('djinni did not answer POST /slow/ in 0.05 s.');
      expect(await c.get('/next/')).toBe('next');
    } finally {
      await fake.close();
    }
  });

  test('a body that stops in the middle also fails after the timeout', async () => {
    const slow = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('part');
    });
    await new Promise<void>(resolve => slow.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
    try {
      const c = new DjinniClient({ baseUrl: url, cookies: cookies(), minIntervalMs: 0, timeouts: { getMs: 100 } });

      await expect(c.get('/part/')).rejects.toThrow('djinni did not answer GET /part/ in 0.1 s.');
    } finally {
      slow.closeAllConnections();
      await new Promise<void>(resolve => slow.close(() => resolve()));
    }
  });
});
