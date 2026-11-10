import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Cookie } from './session.ts';
import { BIN } from './bin.ts';

export const DJINNI_URL = 'https://djinni.co';
const COOKIE_DOMAIN = 'djinni.co';
const MAX_REDIRECTS = 5;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

// The same login hint for the MCP server and the CLI.
// The npm package "djinni" belongs to another maintainer, so the hint names the bin of this package that runs.
// A "!" command in Claude Code can have no interactive stdin, so the hint asks for a separate terminal window.
export const LOGIN_HINT = `Run in a separate terminal window: ${BIN} login`;

export class NotLoggedInError extends Error {
  constructor() {
    super(`The djinni session is not valid. ${LOGIN_HINT}.`);
    this.name = 'NotLoggedInError';
  }
}

// An HTTP error status (400 or more) for a GET request. "status" lets the caller handle a known status.
export class HttpError extends Error {
  constructor(
    readonly status: number,
    method: string,
    path: string,
  ) {
    super(`djinni returned HTTP ${status} for ${method} ${path}`);
    this.name = 'HttpError';
  }
}

export type FilePart = { filename: string; type: string; data: Buffer };
export type FormField = [name: string, value: string | FilePart];
export type PostResult = { status: number; location: string | null; body: string };
// The full answer of one request. The client reads the body before the timeout ends.
type Answer = { status: number; headers: Headers; body: string };

// A request without a full answer in this time fails. A hung request must not stop the requests after it in the limiter.
export const GET_TIMEOUT_MS = 30_000;
// The time for a request that changes data, for example a POST with a file.
export const SEND_TIMEOUT_MS = 60_000;

// A lock file older than this is stale: its process stopped before it removed the lock.
const LIMIT_LOCK_STALE_MS = 30_000;
const LIMIT_LOCK_RETRY_MS = 10;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// The time of the last request of all processes that use the same data folder.
// The file is read and updated under an exclusive lock file, so that two processes never send at the same time.
class SharedLastRequest {
  private readonly file: string;
  private readonly lock: string;

  constructor(private readonly dir: string) {
    this.file = join(dir, 'last-request');
    this.lock = join(dir, 'last-request.lock');
  }

  // Takes the lock, runs the function with the time of the last request and saves the time that the function returns.
  async update(fn: (last: number) => Promise<number>): Promise<void> {
    await this.take();
    try {
      writeFileSync(this.file, String(await fn(this.read())), { mode: 0o600 });
    } finally {
      rmSync(this.lock, { force: true });
    }
  }

  private read(): number {
    try {
      const n = Number(readFileSync(this.file, 'utf8'));
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }

  private async take(): Promise<void> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (;;) {
      try {
        closeSync(openSync(this.lock, 'wx', 0o600));
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      if (this.isStale()) rmSync(this.lock, { force: true });
      else await sleep(LIMIT_LOCK_RETRY_MS);
    }
  }

  private isStale(): boolean {
    try {
      return Date.now() - statSync(this.lock).mtimeMs > LIMIT_LOCK_STALE_MS;
    } catch {
      // The lock file was removed after the failed open. The next try takes it.
      return false;
    }
  }
}

// Sends one request at a time, in order, with a minimum time between two requests.
// Clients that share one limiter share this rule. It keeps the load low for the djinni anti-bot.
// With "sharedDir", all limiters of all processes that use this folder keep the minimum interval together.
export class RateLimiter {
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  private readonly shared: SharedLastRequest | null;

  constructor(
    readonly minIntervalMs = 1500,
    sharedDir?: string,
  ) {
    this.shared = sharedDir && minIntervalMs > 0 ? new SharedLastRequest(sharedDir) : null;
  }

  schedule<T>(send: () => Promise<T>): Promise<T> {
    const wait = async (last: number) => {
      const ms = Math.max(last, this.lastRequestAt) + this.minIntervalMs - Date.now();
      if (ms > 0) await sleep(ms);
      this.lastRequestAt = Date.now();
      return this.lastRequestAt;
    };
    const run = async () => {
      if (this.shared) await this.shared.update(wait);
      else await wait(0);
      return send();
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

export type ClientOptions = {
  cookies: Cookie[];
  baseUrl?: string;
  // The minimum time between two requests. The client ignores it when a limiter is given.
  minIntervalMs?: number;
  // A limiter to share with other clients. Without it, the client makes its own limiter.
  limiter?: RateLimiter;
  // Called after the server changes a cookie, so that the caller can save the session.
  onCookiesChanged?: (cookies: Cookie[]) => void;
  // Called before the client throws NotLoggedInError.
  onNotLoggedIn?: () => void;
  // The request timeouts. The defaults are GET_TIMEOUT_MS and SEND_TIMEOUT_MS.
  timeouts?: { getMs?: number; sendMs?: number };
};

const isDjinniCookie = (c: Cookie) => c.domain.replace(/^\./, '').endsWith(COOKIE_DOMAIN);
// Djinni sends a user without a valid session to /login or to /continue/.
const LOGIN_PATH = /^\/(login|continue)(\/|$)/;

export class DjinniClient {
  readonly baseUrl: string;
  private readonly origin: string;
  private cookies: Cookie[];
  private readonly limiter: RateLimiter;
  private readonly onCookiesChanged?: (cookies: Cookie[]) => void;
  private readonly onNotLoggedIn?: () => void;
  private readonly timeouts: { getMs: number; sendMs: number };

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl ?? DJINNI_URL;
    this.origin = new URL(this.baseUrl).origin;
    this.cookies = opts.cookies.filter(isDjinniCookie);
    this.limiter = opts.limiter ?? new RateLimiter(opts.minIntervalMs);
    this.onCookiesChanged = opts.onCookiesChanged;
    this.onNotLoggedIn = opts.onNotLoggedIn;
    this.timeouts = { getMs: opts.timeouts?.getMs ?? GET_TIMEOUT_MS, sendMs: opts.timeouts?.sendMs ?? SEND_TIMEOUT_MS };
  }

  getCookies(): Cookie[] {
    return this.cookies.map(c => ({ ...c }));
  }

  cookie(name: string): string | undefined {
    return this.cookies.find(c => c.name === name)?.value;
  }

  async get(path: string, opts: { hx?: boolean } = {}): Promise<string> {
    let url = new URL(path, this.baseUrl);
    for (let redirects = 0; ; redirects++) {
      const res = await this.request(url.href, { method: 'GET', headers: opts.hx ? { 'HX-Request': 'true' } : {} });
      const location = res.headers.get('location');
      if (this.isLoginRedirect(location, url)) throw this.notLoggedIn();
      if (res.status >= 300 && res.status < 400 && location) {
        if (redirects >= MAX_REDIRECTS) throw new Error(`djinni sent more than ${MAX_REDIRECTS} redirects for GET ${path}`);
        const target = new URL(location, url);
        // The session cookies must stay on the djinni origin.
        if (target.origin !== this.origin) {
          throw new Error(`djinni redirected GET ${path} to another origin (${target.origin}). The client does not follow this redirect.`);
        }
        url = target;
        continue;
      }
      if (res.status >= 400) throw new HttpError(res.status, 'GET', path);
      return res.body;
    }
  }

  // Sends GET and parses the body as JSON.
  async getJson<T>(path: string, opts: { hx?: boolean } = {}): Promise<T> {
    const body = await this.get(path, opts);
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error(`djinni returned no JSON for GET ${path}.`);
    }
  }

  // The headers that djinni (Django) checks for a request that changes data: the CSRF token, the Referer and the Origin.
  private csrfHeaders(path: string): Record<string, string> {
    return { 'X-CSRFToken': this.cookie('csrftoken') ?? '', Referer: this.baseUrl + path, Origin: this.baseUrl };
  }

  // Sends a request that changes data and returns the status, the location and the body. A redirect to the login page throws NotLoggedInError.
  private async send(method: string, path: string, headers: Record<string, string>, body?: string | FormData): Promise<PostResult> {
    const res = await this.request(path, { method, headers: { ...this.csrfHeaders(path), ...headers }, body });
    const location = res.headers.get('location');
    if (this.isLoginRedirect(location, new URL(path, this.baseUrl))) throw this.notLoggedIn();
    return { status: res.status, location, body: res.body };
  }

  // Sends POST with a JSON body, as the djinni pages do for the JSON API.
  postJson(path: string, body: unknown): Promise<PostResult> {
    return this.send('POST', path, { 'Content-Type': 'application/json' }, JSON.stringify(body));
  }

  delete(path: string): Promise<PostResult> {
    return this.send('DELETE', path, {});
  }

  // Sends the form as urlencoded data, or as multipart data when a field holds a file or "multipart" is true.
  // Use "multipart" for a form with enctype="multipart/form-data", so that the request is the same as a browser request.
  async postForm(path: string, fields: FormField[], opts: { hx?: boolean; multipart?: boolean } = {}): Promise<PostResult> {
    const csrf = this.cookie('csrftoken') ?? '';
    const all: FormField[] = [...fields.filter(([n]) => n !== 'csrfmiddlewaretoken'), ['csrfmiddlewaretoken', csrf]];
    const multipart = opts.multipart === true || all.some(([, v]) => typeof v !== 'string');
    let body: string | FormData;
    const headers: Record<string, string> = {};
    if (opts.hx) headers['HX-Request'] = 'true';
    if (multipart) {
      const fd = new FormData();
      for (const [n, v] of all) {
        if (typeof v === 'string') fd.append(n, v);
        else fd.append(n, new Blob([new Uint8Array(v.data)], { type: v.type }), v.filename);
      }
      body = fd;
    } else {
      body = new URLSearchParams(all as [string, string][]).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    return this.send('POST', path, headers, body);
  }

  private notLoggedIn(): NotLoggedInError {
    this.onNotLoggedIn?.();
    return new NotLoggedInError();
  }

  private isLoginRedirect(location: string | null, from: URL): boolean {
    if (!location) return false;
    let target: URL;
    try {
      target = new URL(location, from);
    } catch {
      return false;
    }
    return target.origin === this.origin && LOGIN_PATH.test(target.pathname);
  }

  // Sends one request in the limiter and reads the full answer. The timeout starts when the limiter sends the request.
  private request(path: string, init: { method: string; headers: Record<string, string>; body?: string | FormData }): Promise<Answer> {
    const url = new URL(path, this.baseUrl);
    // Never send the session cookies to another origin.
    if (url.origin !== this.origin) {
      return Promise.reject(new Error(`The client sends requests only to ${this.origin}, not to ${url.origin}.`));
    }
    const timeoutMs = init.method === 'GET' ? this.timeouts.getMs : this.timeouts.sendMs;
    return this.limiter.schedule(async () => {
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        const res = await fetch(url, {
          method: init.method,
          body: init.body,
          redirect: 'manual',
          signal,
          headers: {
            'User-Agent': USER_AGENT,
            'Accept-Language': 'uk-UA,uk;q=0.9,en;q=0.8',
            Cookie: this.cookies.map(c => `${c.name}=${c.value}`).join('; '),
            ...init.headers,
          },
        });
        this.storeSetCookies(res.headers.getSetCookie());
        return { status: res.status, headers: res.headers, body: await res.text() };
      } catch (e) {
        if (signal.aborted) throw new Error(`djinni did not answer ${init.method} ${url.pathname}${url.search} in ${timeoutMs / 1000} s.`);
        throw e;
      }
    });
  }

  private storeSetCookies(lines: string[]) {
    if (lines.length === 0) return;
    for (const line of lines) {
      const [pair = '', ...attrs] = line.split(';').map(s => s.trim());
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const attr = (k: string) => attrs.find(a => a.toLowerCase().startsWith(k + '='))?.split('=')[1];
      const maxAge = attr('max-age');
      const existing = this.cookies.find(c => c.name === name);
      if (maxAge !== undefined && Number(maxAge) <= 0) {
        this.cookies = this.cookies.filter(c => c.name !== name);
        continue;
      }
      if (existing) existing.value = value;
      else this.cookies.push({ name, value, domain: attr('domain') ?? COOKIE_DOMAIN, path: attr('path') ?? '/' });
    }
    this.onCookiesChanged?.(this.getCookies());
  }
}
