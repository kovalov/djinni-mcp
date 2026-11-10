import { afterEach, describe, expect, test } from 'vitest';
import { Ctx } from '../../src/context.ts';
import { loginWithBrowser, loginWithCookie, loginWithPassword, whoami } from '../../src/core/session.ts';
import { NotLoggedInError } from '../../src/http.ts';
import { fixture, loggedInStore, startFakeDjinni, tempStore, type FakeDjinni, type Recorded, type Route } from '../helpers.ts';

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

const EMAIL = 'user@example.com';
const PASSWORD = 's3cret-Pa55';
const LOGIN_ERROR = 'Невірний email або пароль';

const form = (req: Recorded) => new URLSearchParams(req.body);
const hasCookie = (req: Recorded, pair: string) => (req.headers.cookie ?? '').split('; ').includes(pair);

// The profile page answers only for the authenticated session. Djinni sends other visitors to the login page.
const profile: Route = req =>
  hasCookie(req, 'sessionid=AUTH') ? fixture('my_profile.html') : { status: 302, headers: { location: '/login?next=/my/profile/' } };

const loginPage: Route = {
  headers: { 'set-cookie': ['csrftoken=CSRF1; Path=/', 'sessionid=ANON; Path=/; HttpOnly'] },
  body: '<form method="post" id="signup"><input name="email"><input name="password"><input name="social_auth"></form>',
};

// The POST accepts only the right email, password, CSRF token and anonymous session.
const loginPost =
  (failure: Route = { body: `<form id="signup"><div class="invalid-feedback">${LOGIN_ERROR}</div></form>` }): Route =>
  req => {
    const f = form(req);
    const ok =
      f.get('email') === EMAIL &&
      f.get('password') === PASSWORD &&
      f.get('csrfmiddlewaretoken') === 'CSRF1' &&
      req.headers['x-csrftoken'] === 'CSRF1' &&
      hasCookie(req, 'sessionid=ANON');
    if (!ok) return typeof failure === 'function' ? failure(req) : failure;
    return {
      status: 302,
      headers: { location: '/my/', 'set-cookie': ['sessionid=AUTH; Path=/; HttpOnly', 'csrftoken=CSRF2; Path=/'] },
    };
  };

const passwordRoutes = (failure?: Route): Record<string, Route> => ({
  'GET /login?lang=uk': loginPage,
  'POST /login?lang=uk': loginPost(failure),
  'GET /my/profile/': profile,
});

const cookieValue = (ctx: Ctx, name: string) => ctx.store.loadSession()?.cookies.find(c => c.name === name)?.value;

describe('loginWithPassword', () => {
  test('logs in with the form and saves the djinni cookies of the new session', async () => {
    djinni = await startFakeDjinni(passwordRoutes());
    const ctx = new Ctx({ store: tempStore(), baseUrl: djinni.url, minIntervalMs: 0 });

    const me = await loginWithPassword(ctx, EMAIL, PASSWORD);

    expect(me).toMatchObject({ loggedIn: true, candidateId: '100001' });
    expect(djinni.requests.map(r => `${r.method} ${r.url}`)).toEqual(['GET /login?lang=uk', 'POST /login?lang=uk', 'GET /my/profile/']);
    expect(djinni.requests[0]?.headers.cookie ?? '').toBe('');
    expect(djinni.requests[1]?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(cookieValue(ctx, 'sessionid')).toBe('AUTH');
    expect(cookieValue(ctx, 'csrftoken')).toBe('CSRF2');
  });

  test('replaces an old session that is not valid, and the next operation uses the new session', async () => {
    djinni = await startFakeDjinni(passwordRoutes());
    const ctx = new Ctx({ store: loggedInStore(), baseUrl: djinni.url, minIntervalMs: 0 });
    await expect(whoami(ctx)).rejects.toBeInstanceOf(NotLoggedInError);

    await loginWithPassword(ctx, EMAIL, PASSWORD);
    const me = await whoami(ctx);

    expect(me.candidateId).toBe('100001');
    expect(hasCookie(djinni.requests.at(-1)!, 'sessionid=AUTH')).toBe(true);
  });

  test('throws with the error text of the login page when djinni does not accept the password, and saves nothing', async () => {
    djinni = await startFakeDjinni(passwordRoutes());
    const store = loggedInStore();
    const ctx = new Ctx({ store, baseUrl: djinni.url, minIntervalMs: 0 });

    const err = (await loginWithPassword(ctx, EMAIL, 'wrong-password').catch((e: unknown) => e)) as Error;

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('djinni did not accept the login');
    expect(err.message).toContain(LOGIN_ERROR);
    expect(err.message).not.toContain('wrong-password');
    expect(store.loadSession()?.cookies.find(c => c.name === 'sessionid')?.value).toBe('SESS');
  });

  test('never puts the password in the error message, also when the login page shows it', async () => {
    djinni = await startFakeDjinni(passwordRoutes(req => ({ body: `<div class="alert alert-danger">Bad login for ${form(req).get('password')}</div>` })));
    const store = tempStore();
    const ctx = new Ctx({ store, baseUrl: djinni.url, minIntervalMs: 0 });

    const err = (await loginWithPassword(ctx, EMAIL, 'wrong-password').catch((e: unknown) => e)) as Error;

    expect(err.message).toContain('djinni did not accept the login');
    expect(err.message).not.toContain('wrong-password');
    expect(store.loadSession()).toBeNull();
  });

  test.each([
    ['a  b\tc', (pw: string) => pw],
    ['Line1\nLine2', (pw: string) => pw],
    ['MiXed-Case-9', (pw: string) => pw.toUpperCase()],
  ])('redacts the password %j also after the page text is cleaned', async (password, echo) => {
    djinni = await startFakeDjinni(passwordRoutes(req => ({ body: `<div class="alert alert-danger">Bad login: ${echo(form(req).get('password')!)}</div>` })));
    const ctx = new Ctx({ store: tempStore(), baseUrl: djinni.url, minIntervalMs: 0 });

    const err = (await loginWithPassword(ctx, EMAIL, password).catch((e: unknown) => e)) as Error;

    expect(err.message).toContain('Bad login: ***');
    const clean = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    expect(clean(err.message)).not.toContain(clean(password));
  });

  test('says that djinni did not accept the login when the login page sends the user to another login page', async () => {
    djinni = await startFakeDjinni({ ...passwordRoutes(), 'GET /login?lang=uk': { status: 302, headers: { location: '/login/' } } });
    const ctx = new Ctx({ store: tempStore(), baseUrl: djinni.url, minIntervalMs: 0 });

    const err = (await loginWithPassword(ctx, EMAIL, PASSWORD).catch((e: unknown) => e)) as Error;

    expect(err).not.toBeInstanceOf(NotLoggedInError);
    expect(err.message).toContain('djinni did not accept the login');
  });

  test('ignores the hidden toast templates of the page', async () => {
    const toast = '<div class="toast"><div class="alert alert-danger">Щось пішло не так</div></div>';
    djinni = await startFakeDjinni(passwordRoutes({ body: toast }));
    const ctx = new Ctx({ store: tempStore(), baseUrl: djinni.url, minIntervalMs: 0 });

    const err = (await loginWithPassword(ctx, EMAIL, 'wrong-password').catch((e: unknown) => e)) as Error;

    expect(err.message).toContain('djinni did not accept the login');
    expect(err.message).not.toContain('Щось пішло не так');
  });

  test('says that djinni did not accept the login when the POST sends the user back to the login page', async () => {
    djinni = await startFakeDjinni(passwordRoutes({ status: 302, headers: { location: '/login?lang=uk' } }));
    const store = tempStore();
    const ctx = new Ctx({ store, baseUrl: djinni.url, minIntervalMs: 0 });

    const err = (await loginWithPassword(ctx, EMAIL, 'wrong-password').catch((e: unknown) => e)) as Error;

    expect(err).not.toBeInstanceOf(NotLoggedInError);
    expect(err.message).toContain('djinni did not accept the login');
    expect(store.loadSession()).toBeNull();
  });

  test('shares the rate limiter of the context with the other clients', async () => {
    djinni = await startFakeDjinni(passwordRoutes());
    const ctx = new Ctx({ store: loggedInStore(), baseUrl: djinni.url, minIntervalMs: 120 });
    await expect(whoami(ctx)).rejects.toBeInstanceOf(NotLoggedInError);

    await loginWithPassword(ctx, EMAIL, PASSWORD);

    const times = djinni.requests.map(r => r.at);
    expect(times).toHaveLength(4);
    // The server records the arrival time, so a gap can be shorter than 120 ms under load. A client with its own limiter gives a gap near 0.
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(60);
  });
});

describe('loginWithCookie', () => {
  const cookieRoutes = (): Record<string, Route> => ({
    'GET /login?lang=uk': { headers: { 'set-cookie': 'csrftoken=CSRF1; Path=/' }, body: 'login page' },
    'GET /my/profile/': profile,
  });

  test('makes a session from the sessionid value, gets a CSRF token and saves the session', async () => {
    djinni = await startFakeDjinni(cookieRoutes());
    const ctx = new Ctx({ store: tempStore(), baseUrl: djinni.url, minIntervalMs: 0 });

    const me = await loginWithCookie(ctx, ' AUTH ');

    expect(me).toMatchObject({ loggedIn: true, candidateId: '100001' });
    expect(djinni.requests.map(r => `${r.method} ${r.url}`)).toEqual(['GET /login?lang=uk', 'GET /my/profile/']);
    expect(djinni.requests[0]?.headers.cookie).toBe('sessionid=AUTH');
    expect(ctx.store.loadSession()?.cookies).toEqual([
      { name: 'sessionid', value: 'AUTH', domain: '.djinni.co', path: '/' },
      expect.objectContaining({ name: 'csrftoken', value: 'CSRF1' }),
    ]);
  });

  test('throws and saves nothing when djinni does not accept the sessionid value', async () => {
    djinni = await startFakeDjinni(cookieRoutes());
    const store = loggedInStore();
    const ctx = new Ctx({ store, baseUrl: djinni.url, minIntervalMs: 0 });

    const err = (await loginWithCookie(ctx, 'BAD-VALUE').catch((e: unknown) => e)) as Error;

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NotLoggedInError);
    expect(err.message).toContain('djinni did not accept the sessionid cookie');
    expect(err.message).not.toContain('BAD-VALUE');
    expect(store.loadSession()?.cookies.find(c => c.name === 'sessionid')?.value).toBe('SESS');
  });

  test('throws and sends no request for an empty value', async () => {
    djinni = await startFakeDjinni(cookieRoutes());
    const ctx = new Ctx({ store: tempStore(), baseUrl: djinni.url, minIntervalMs: 0 });

    await expect(loginWithCookie(ctx, '  ')).rejects.toThrow(/sessionid value is empty/);
    expect(djinni.requests).toHaveLength(0);
  });
});

describe('loginWithBrowser', () => {
  test('saves the session of the browser flow and returns the candidate', async () => {
    djinni = await startFakeDjinni({ 'GET /my/profile/': profile });
    const store = tempStore();
    const login = async () => ({ cookies: [{ name: 'sessionid', value: 'AUTH', domain: '.djinni.co', path: '/' }] });
    const ctx = new Ctx({ store, baseUrl: djinni.url, minIntervalMs: 0, login });

    const me = await loginWithBrowser(ctx);

    expect(me).toMatchObject({ loggedIn: true, candidateId: '100001' });
    expect(store.loadSession()?.cookies[0]?.value).toBe('AUTH');
  });
});
