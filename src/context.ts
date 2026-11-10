import { createHash } from 'node:crypto';
import { DjinniClient, LOGIN_HINT, NotLoggedInError, RateLimiter } from './http.ts';
import { parseWhoami, type Whoami } from './parsers/me.ts';
import type { Cookie, StorageState } from './session.ts';
import type { Store } from './store.ts';

export type ServerDeps = {
  store: Store;
  baseUrl?: string;
  minIntervalMs?: number;
  // Opens a browser for a manual login and returns the new session.
  login?: () => Promise<StorageState>;
  now?: () => Date;
};

// Djinni answers the public API also for a session that is not valid, but without the user fields.
export const INVALID_SESSION_WARNING = `The saved djinni session is not valid. The results do not show your applications and favorites. ${LOGIN_HINT}.`;

// A client for public data. The warning is set when the saved session is not valid.
export type ReadClient = { client: DjinniClient; warning?: string };

// A read of the hidden jobs list. "at" is the time of the result in milliseconds. "result" is set when the read ends.
// "read" never rejects: a failed read gives { failed: true }. "truncated" is true when the page limit stopped the read before the last page.
export type HiddenJobsResult = { ids: Set<string>; truncated: boolean } | { failed: true };
export type HiddenJobsRead = { at: number; result?: HiddenJobsResult; read: Promise<HiddenJobsResult> };

const SESSION_COOKIE = 'sessionid';
const sessionIdOf = (cookies: Cookie[]) => cookies.find(c => c.name === SESSION_COOKIE)?.value;

export class Ctx {
  private cached: DjinniClient | null = null;
  // The sessionid of the saved session that the kept client uses.
  private cachedSid: string | undefined;
  // The result of the session check: the candidate, or null for a session that is not valid.
  private checked: Promise<Whoami | null> | null = null;
  // The sessionid that the kept session check is for.
  private checkedSid: string | undefined;
  // True after the check accepted the session.
  private sessionValid = false;
  // The last read of the hidden jobs list (see hiddenJobs in core/jobs.ts). A new session drops it.
  hiddenJobs: HiddenJobsRead | null = null;
  // One limiter for all clients of this context: one request at a time, with the minimum interval between any two requests.
  // It shares the time of the last request with the other processes of the same data folder.
  private readonly limiter: RateLimiter;

  constructor(readonly deps: ServerDeps) {
    // The time of the last request is also in the data folder, so that parallel CLI processes keep the interval too.
    this.limiter = new RateLimiter(deps.minIntervalMs, deps.store.path('locks'));
  }

  get store(): Store {
    return this.deps.store;
  }

  now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // Reads the saved session again. Another process (for example "npx djinni-mcp login") can save a new session at any time.
  // When the sessionid changed, the kept client and the kept session check are for the old session, so they are dropped.
  private loadCurrentSession(): StorageState | null {
    const state = this.store.loadSession();
    const sid = state ? sessionIdOf(state.cookies) : undefined;
    if (this.cached && (!state || sid !== this.cachedSid)) this.cached = null;
    if (this.checked && (!state || sid !== this.checkedSid)) this.resetSessionCheck();
    return state;
  }

  // Returns a hash of the sessionid of the saved session, or undefined when no session is saved.
  // Data in the data folder that belongs to one session keeps this key, not the sessionid itself.
  sessionKey(): string | undefined {
    const sid = sessionIdOf(this.store.loadSession()?.cookies ?? []);
    return sid === undefined ? undefined : createHash('sha256').update(sid).digest('hex').slice(0, 32);
  }

  // Returns a client for the saved session. Throws NotLoggedInError if no session is saved.
  client(): DjinniClient {
    const state = this.loadCurrentSession();
    if (!state) throw new NotLoggedInError();
    if (this.cached) return this.cached;
    let sid = sessionIdOf(state.cookies);
    const client = new DjinniClient({
      cookies: state.cookies,
      baseUrl: this.deps.baseUrl,
      limiter: this.limiter,
      // Saves the changed cookies only while the saved session is still the session of this client (compare and set).
      // A new login of another process is never overwritten. When djinni deletes the sessionid, nothing is saved.
      onCookiesChanged: cookies => {
        const next = sessionIdOf(cookies);
        if (sid !== undefined && next === undefined) return;
        const current = this.store.loadSession();
        if (!current || sessionIdOf(current.cookies) !== sid) return;
        this.store.saveSession({ ...current, cookies });
        if (this.cached === client) this.cachedSid = next;
        if (this.checked && this.checkedSid === sid) this.checkedSid = next;
        sid = next;
      },
      // The session expired after the check. The next operation checks it again.
      onNotLoggedIn: () => {
        if (this.sessionValid) this.resetSessionCheck();
      },
    });
    this.cached = client;
    this.cachedSid = sid;
    return client;
  }

  // Returns a client that sends no session cookies. Use it for public pages.
  anonymousClient(): DjinniClient {
    return this.newClient([]);
  }

  // Returns a client with the given cookies that does not save them. The login flow uses it before it saves a session.
  newClient(cookies: Cookie[]): DjinniClient {
    return new DjinniClient({ cookies, baseUrl: this.deps.baseUrl, limiter: this.limiter });
  }

  // Checks the saved session with one GET /my/profile/.
  // Returns null when no session is saved or when djinni does not accept the session.
  // A failed request (for example HTTP 500) throws and is not cached.
  // The check is kept only for the sessionid that it was made for.
  session(): Promise<Whoami | null> {
    const state = this.loadCurrentSession();
    if (!state) return Promise.resolve(null);
    if (!this.checked) this.checkedSid = sessionIdOf(state.cookies);
    this.checked ??= this.client()
      .get('/my/profile/')
      .then(
        html => {
          const me = parseWhoami(html);
          this.sessionValid = !!me;
          return me;
        },
        e => {
          if (e instanceof NotLoggedInError) return null;
          throw e;
        },
      );
    const check = this.checked;
    check.catch(() => {
      if (this.checked === check) this.checked = null;
    });
    return check;
  }

  // Returns the logged-in candidate. Throws NotLoggedInError if no valid session is saved.
  async me(): Promise<Whoami> {
    const me = await this.session();
    if (!me) throw new NotLoggedInError();
    return me;
  }

  // Returns the session client when the saved session is valid, else the anonymous client.
  // The warning is set when a session is saved but djinni does not accept it.
  async readClient(): Promise<ReadClient> {
    if (!this.store.loadSession()) return { client: this.anonymousClient() };
    if (await this.session()) return { client: this.client() };
    return { client: this.anonymousClient(), warning: INVALID_SESSION_WARNING };
  }

  // Runs the browser login flow and saves the new session.
  async login(): Promise<void> {
    if (!this.deps.login) throw new Error('Login is not available in this environment.');
    this.saveLogin(await this.deps.login());
  }

  // Saves a new session. The next operation uses it and checks it again.
  saveLogin(state: StorageState): void {
    this.store.saveSession(state);
    this.cached = null;
    this.resetSessionCheck();
  }

  private resetSessionCheck(): void {
    this.checked = null;
    this.sessionValid = false;
    this.hiddenJobs = null;
  }
}
