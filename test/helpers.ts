import * as cheerio from 'cheerio';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer as createMcpServer, type ServerDeps } from '../src/server.ts';
import { Store } from '../src/store.ts';

export const fixture = (name: string): string => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

// "at" is the time when the server got the full request. "respondedAt" is the time when it sent the response.
export type Recorded = { method: string; url: string; headers: IncomingMessage['headers']; body: string; at: number; respondedAt?: number };
// "delayMs" makes the server wait before it sends the response. "closeConnection" closes the connection with no response.
export type StaticRoute = string | { status?: number; headers?: Record<string, string | string[]>; body?: string; delayMs?: number; closeConnection?: boolean };
// A function route makes the response from the request, for example to check the form fields or the cookies.
export type Route = StaticRoute | ((req: Recorded) => StaticRoute);
export type FakeDjinni = { url: string; requests: Recorded[]; routes: Map<string, Route>; close: () => Promise<void> };

// A local HTTP server that answers like djinni.co. A route key is "METHOD /path?query".
// A route without a query also matches requests with any query.
export async function startFakeDjinni(routes: Record<string, Route> = {}): Promise<FakeDjinni> {
  const map = new Map(Object.entries(routes));
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.setEncoding('latin1');
    req.on('data', c => (body += c));
    req.on('end', () => {
      const record: Recorded = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body, at: Date.now() };
      requests.push(record);
      const url = req.url ?? '/';
      const route = map.get(`${req.method} ${url}`) ?? map.get(`${req.method} ${url.split('?')[0]}`);
      if (route === undefined) {
        res.writeHead(404);
        res.end('no route');
        return;
      }
      const made = typeof route === 'function' ? route(record) : route;
      const r = typeof made === 'string' ? { body: made } : made;
      if (r.closeConnection) {
        req.socket.destroy();
        return;
      }
      setTimeout(() => {
        record.respondedAt = Date.now();
        res.writeHead(r.status ?? 200, { 'content-type': 'text/html; charset=utf-8', ...(r.headers ?? {}) });
        res.end(r.body ?? '');
      }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    routes: map,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

// The inbox page with only the given threads, as the unread bucket shows them.
export function inboxWith(ids: string[]): string {
  const $ = cheerio.load(fixture('my_inbox.html'));
  $('.js-thread-item-wrapper').each((_, el) => {
    const id = $(el).find('.js-proposal').attr('data-id') ?? '';
    if (!ids.includes(id)) $(el).remove();
  });
  return $.html();
}

// A page of the hidden jobs (/my/dashboard/hidden/). djinni links each job as on the job list: /jobs/<id>-<slug>/.
// "pages" gives the page numbers of the pagination links.
export function hiddenJobsPage(ids: string[], pages: number[] = []): string {
  const jobs = ids.map(id => `<div class="job-item"><a href="/jobs/${id}-security-engineer-devsecops/">Security Engineer</a></div>`).join('');
  const links = pages.map(p => `<li class="page-item"><a class="page-link" href="?page=${p}">${p}</a></li>`).join('');
  return `<html><body>${jobs}<ul class="pagination">${links}</ul></body></html>`;
}

const jsonBody = (body: string) => ({ headers: { 'content-type': 'application/json' }, body });

// The pages of all doctor steps.
export const doctorRoutes = (): Record<string, Route> => ({
  'GET /my/profile/': fixture('my_profile.html'),
  'GET /api/jobs/?category=python': jsonBody(fixture('api_jobs_python.json')),
  'GET /api/jobs/845296/': jsonBody(fixture('api_job_detail.json')),
  'GET /developers/?keywords=python': fixture('developers_list.html'),
  'GET /my/account/': fixture('my_account.html'),
  'GET /my/resume/': fixture('my_resume.html'),
  'GET /my/subscriptions/': fixture('my_subscriptions.html'),
  'GET /my/inbox/': fixture('my_inbox.html'),
});

export const tempStore = (): Store => new Store(mkdtempSync(join(tmpdir(), 'djinni-mcp-')));

export const loggedInStore = (): Store => {
  const store = tempStore();
  store.saveSession({
    cookies: [
      { name: 'sessionid', value: 'SESS', domain: '.djinni.co', path: '/' },
      { name: 'csrftoken', value: 'CSRF', domain: 'djinni.co', path: '/' },
    ],
  });
  return store;
};

// Connects an MCP client to the server through an in-memory transport.
export async function connect(deps: ServerDeps): Promise<Client> {
  const server = createMcpServer(deps);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

export type ToolText = { text: string; isError: boolean };

export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolText> {
  const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
  return { text: res.content.map(c => c.text ?? '').join('\n'), isError: res.isError === true };
}

export async function callToolJson<T = any>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await callTool(client, name, args);
  if (res.isError) throw new Error(`Tool ${name} returned an error: ${res.text}`);
  return JSON.parse(res.text) as T;
}
