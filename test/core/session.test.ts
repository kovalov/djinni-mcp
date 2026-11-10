import { afterEach, describe, expect, test } from 'vitest';
import { Ctx } from '../../src/context.ts';
import { whoami } from '../../src/core/session.ts';
import { NotLoggedInError } from '../../src/http.ts';
import { Store } from '../../src/store.ts';
import { fixture, loggedInStore, startFakeDjinni, tempStore, type FakeDjinni } from '../helpers.ts';

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

describe('whoami', () => {
  test('returns the identity of the logged-in candidate', async () => {
    djinni = await startFakeDjinni({ 'GET /my/profile/': fixture('my_profile.html') });
    const ctx = new Ctx({ store: loggedInStore(), baseUrl: djinni.url, minIntervalMs: 0 });

    expect(await whoami(ctx)).toMatchObject({ loggedIn: true, candidateId: '100001', publicProfilePath: '/q/0000000000/' });
  });

  test('throws NotLoggedInError and sends no request when no session is saved', async () => {
    djinni = await startFakeDjinni();
    const ctx = new Ctx({ store: tempStore(), baseUrl: djinni.url, minIntervalMs: 0 });

    const err = await whoami(ctx).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotLoggedInError);
    expect((err as Error).message).toContain('Run in a separate terminal window: npx djinni-mcp login');
    expect(djinni.requests).toHaveLength(0);
  });

  test.each([['/login?next=/my/profile/'], ['/continue/']])(
    'throws NotLoggedInError when the session expired and djinni redirects to %s',
    async location => {
      djinni = await startFakeDjinni({ 'GET /my/profile/': { status: 302, headers: { location } } });
      const ctx = new Ctx({ store: loggedInStore(), baseUrl: djinni.url, minIntervalMs: 0 });

      await expect(whoami(ctx)).rejects.toBeInstanceOf(NotLoggedInError);
    },
  );

  test('throws NotLoggedInError when the profile page has no candidate ID', async () => {
    djinni = await startFakeDjinni({ 'GET /my/profile/': '<html><body><h1>Login</h1></body></html>' });
    const ctx = new Ctx({ store: loggedInStore(), baseUrl: djinni.url, minIntervalMs: 0 });

    await expect(whoami(ctx)).rejects.toBeInstanceOf(NotLoggedInError);
  });
});

describe('session check in Ctx', () => {
  test('checks the new session again after a login', async () => {
    djinni = await startFakeDjinni({ 'GET /my/profile/': { status: 302, headers: { location: '/continue/' } } });
    const store = loggedInStore();
    const login = async () => ({ cookies: [{ name: 'sessionid', value: 'NEW', domain: '.djinni.co', path: '/' }] });
    const ctx = new Ctx({ store, baseUrl: djinni.url, minIntervalMs: 0, login });

    await expect(whoami(ctx)).rejects.toBeInstanceOf(NotLoggedInError);
    djinni.routes.set('GET /my/profile/', fixture('my_profile.html'));
    await ctx.login();
    const me = await whoami(ctx);

    expect(me.candidateId).toBe('100001');
    expect(djinni.requests.map(r => r.headers.cookie)).toEqual(['sessionid=SESS; csrftoken=CSRF', 'sessionid=NEW']);
  });

  test('reuses the session check of an earlier operation', async () => {
    djinni = await startFakeDjinni({ 'GET /my/profile/': fixture('my_profile.html') });
    const ctx = new Ctx({ store: loggedInStore(), baseUrl: djinni.url, minIntervalMs: 0 });

    await whoami(ctx);
    await whoami(ctx);

    expect(djinni.requests).toHaveLength(1);
  });
});

describe('session saved by another process', () => {
  const session = (value: string) => ({ cookies: [{ name: 'sessionid', value, domain: '.djinni.co', path: '/' }] });

  test('uses the new session that another process saved after a check that did not accept the old session', async () => {
    djinni = await startFakeDjinni({
      'GET /my/profile/': req => (req.headers.cookie === 'sessionid=NEW' ? fixture('my_profile.html') : { status: 302, headers: { location: '/continue/' } }),
    });
    const store = loggedInStore();
    const ctx = new Ctx({ store, baseUrl: djinni.url, minIntervalMs: 0 });

    await expect(whoami(ctx)).rejects.toBeInstanceOf(NotLoggedInError);
    new Store(store.dir).saveSession(session('NEW'));
    const me = await whoami(ctx);

    expect(me.candidateId).toBe('100001');
    expect(djinni.requests.map(r => r.headers.cookie)).toEqual(['sessionid=SESS; csrftoken=CSRF', 'sessionid=NEW']);
  });

  test('uses the new session that another process saved after the valid session expired', async () => {
    djinni = await startFakeDjinni({ 'GET /my/profile/': fixture('my_profile.html'), 'GET /my/applications/': { status: 302, headers: { location: '/continue/' } } });
    const store = loggedInStore();
    const ctx = new Ctx({ store, baseUrl: djinni.url, minIntervalMs: 0 });

    await whoami(ctx);
    await expect(ctx.client().get('/my/applications/')).rejects.toBeInstanceOf(NotLoggedInError);
    new Store(store.dir).saveSession(session('NEW'));
    const me = await whoami(ctx);

    expect(me.candidateId).toBe('100001');
    expect(djinni.requests.at(-1)?.headers.cookie).toBe('sessionid=NEW');
  });

  test('does not overwrite a new login when djinni deletes the old session cookie', async () => {
    const store = loggedInStore();
    djinni = await startFakeDjinni({
      'GET /my/profile/': () => {
        // Another process saves a new login while the request of the old client runs.
        new Store(store.dir).saveSession(session('NEW'));
        return { status: 302, headers: { location: '/continue/', 'set-cookie': 'sessionid=""; Max-Age=0; Path=/' } };
      },
    });
    const ctx = new Ctx({ store, baseUrl: djinni.url, minIntervalMs: 0 });

    await expect(whoami(ctx)).rejects.toBeInstanceOf(NotLoggedInError);

    expect(store.loadSession()).toEqual(session('NEW'));
  });

  test('does not overwrite a new login when djinni changes a cookie of the old session', async () => {
    const store = loggedInStore();
    djinni = await startFakeDjinni({
      'GET /my/profile/': () => {
        new Store(store.dir).saveSession(session('NEW'));
        return { headers: { 'set-cookie': 'csrftoken=CSRF2; Path=/' }, body: fixture('my_profile.html') };
      },
    });
    const ctx = new Ctx({ store, baseUrl: djinni.url, minIntervalMs: 0 });

    await whoami(ctx);

    expect(store.loadSession()).toEqual(session('NEW'));
  });

  test('never saves a session without the sessionid cookie that djinni deleted', async () => {
    const store = loggedInStore();
    djinni = await startFakeDjinni({
      'GET /my/profile/': { status: 302, headers: { location: '/continue/', 'set-cookie': 'sessionid=""; Max-Age=0; Path=/' } },
    });
    const ctx = new Ctx({ store, baseUrl: djinni.url, minIntervalMs: 0 });

    await expect(whoami(ctx)).rejects.toBeInstanceOf(NotLoggedInError);

    expect(store.loadSession()?.cookies.map(c => c.name)).toEqual(['sessionid', 'csrftoken']);
  });

  test('saves a cookie change of the current session', async () => {
    const store = loggedInStore();
    djinni = await startFakeDjinni({ 'GET /my/profile/': { headers: { 'set-cookie': 'csrftoken=CSRF2; Path=/' }, body: fixture('my_profile.html') } });
    const ctx = new Ctx({ store, baseUrl: djinni.url, minIntervalMs: 0 });

    await whoami(ctx);

    expect(store.loadSession()?.cookies.find(c => c.name === 'csrftoken')?.value).toBe('CSRF2');
  });
});
