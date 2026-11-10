import { afterEach, describe, expect, test } from 'vitest';
import { parseWhoami } from '../../src/parsers/me.ts';
import { fixture, startFakeDjinni, tempStore, type FakeDjinni, type Recorded, type Route } from '../helpers.ts';
import { cli, fakeIo } from './helpers.ts';

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

const EMAIL = 'user@example.com';
const PASSWORD = 'hunter2-Secret';
const HEADLINE = parseWhoami(fixture('my_profile.html'))!.headline;

const hasCookie = (req: Recorded, pair: string) => (req.headers.cookie ?? '').split('; ').includes(pair);
const profile: Route = req => (hasCookie(req, 'sessionid=AUTH') ? fixture('my_profile.html') : { status: 302, headers: { location: '/login' } });

const routes = (): Record<string, Route> => ({
  // Like Django, the login page starts an anonymous session only for a visitor without a session.
  'GET /login?lang=uk': req => ({
    headers: { 'set-cookie': ['csrftoken=CSRF1; Path=/', ...(req.headers.cookie?.includes('sessionid=') ? [] : ['sessionid=ANON; Path=/'])] },
    body: 'login form',
  }),
  'POST /login?lang=uk': req => {
    const f = new URLSearchParams(req.body);
    if (f.get('email') !== EMAIL || f.get('password') !== PASSWORD) return { body: `<div class="alert alert-danger">Wrong login for ${f.get('password')}</div>` };
    return { status: 302, headers: { location: '/my/', 'set-cookie': 'sessionid=AUTH; Path=/' } };
  },
  'GET /my/profile/': profile,
});

const sessionid = (store: ReturnType<typeof tempStore>) => store.loadSession()?.cookies.find(c => c.name === 'sessionid')?.value;

describe('djinni login', () => {
  test('asks for the email and the hidden password, saves the session and prints the candidate', async () => {
    djinni = await startFakeDjinni(routes());
    const store = tempStore();
    const io = fakeIo({ prompt: [EMAIL], hidden: [PASSWORD] });

    const res = await cli(['login'], { store, baseUrl: djinni.url, minIntervalMs: 0 }, io);

    expect(res.code).toBe(0);
    expect(io.questions).toEqual(['djinni email: ', 'djinni password: ']);
    expect(res.out).toContain(`Logged in as ${HEADLINE}`);
    expect(sessionid(store)).toBe('AUTH');
    expect(res.out + res.err).not.toContain(PASSWORD);
  });

  test('takes the email from --email and asks only for the password', async () => {
    djinni = await startFakeDjinni(routes());
    const io = fakeIo({ hidden: [PASSWORD] });

    const res = await cli(['login', '--email', EMAIL], { store: tempStore(), baseUrl: djinni.url, minIntervalMs: 0 }, io);

    expect(res.code).toBe(0);
    expect(io.questions).toEqual(['djinni password: ']);
  });

  test('never prints the password when djinni does not accept the login', async () => {
    djinni = await startFakeDjinni(routes());
    const store = tempStore();
    const io = fakeIo({ prompt: [EMAIL], hidden: ['wrong-Pass-123'] });

    const res = await cli(['login'], { store, baseUrl: djinni.url, minIntervalMs: 0 }, io);

    expect(res.code).toBe(1);
    expect(res.err).toContain('djinni did not accept the login');
    expect(res.out + res.err).not.toContain('wrong-Pass-123');
    expect(store.loadSession()).toBeNull();
  });

  test('never answers with the no-session hint when djinni sends the login page to another login page', async () => {
    djinni = await startFakeDjinni({ ...routes(), 'GET /login?lang=uk': { status: 302, headers: { location: '/login/' } } });
    const io = fakeIo({ prompt: [EMAIL], hidden: [PASSWORD] });

    const res = await cli(['login'], { store: tempStore(), baseUrl: djinni.url, minIntervalMs: 0 }, io);

    // This fake POST does not check the CSRF token, so the login goes on and the profile check decides.
    expect(res.err).not.toContain('No djinni session');
    expect(res.code).toBe(0);
  });

  test('stops before a request when the password is empty', async () => {
    djinni = await startFakeDjinni(routes());
    const io = fakeIo({ prompt: [EMAIL], hidden: [''] });

    const res = await cli(['login'], { store: tempStore(), baseUrl: djinni.url, minIntervalMs: 0 }, io);

    expect(res.code).toBe(1);
    expect(res.err).toContain('The password is empty');
    expect(djinni.requests).toHaveLength(0);
  });

  test('--cookie asks for the hidden sessionid value and saves the session', async () => {
    djinni = await startFakeDjinni(routes());
    const store = tempStore();
    const io = fakeIo({ hidden: ['AUTH'] });

    const res = await cli(['login', '--cookie'], { store, baseUrl: djinni.url, minIntervalMs: 0 }, io);

    expect(res.code).toBe(0);
    expect(io.questions).toEqual(['djinni sessionid cookie: ']);
    expect(sessionid(store)).toBe('AUTH');
    expect(res.out).toContain(`Logged in as ${HEADLINE}`);
  });

  test('--browser runs the browser flow', async () => {
    djinni = await startFakeDjinni(routes());
    const store = tempStore();
    const login = async () => ({ cookies: [{ name: 'sessionid', value: 'AUTH', domain: '.djinni.co', path: '/' }] });

    const res = await cli(['login', '--browser', '--json'], { store, baseUrl: djinni.url, minIntervalMs: 0, login });

    expect(res.code).toBe(0);
    expect(JSON.parse(res.out)).toMatchObject({ loggedIn: true, candidateId: '100001' });
    expect(sessionid(store)).toBe('AUTH');
  });

  test.each([[['login', '--cookie', '--browser']], [['login', '--browser', '--email', EMAIL]], [['login', '--cookie', '--email', EMAIL]]])(
    '%j is a usage error',
    async argv => {
      const res = await cli(argv, { store: tempStore() });

      expect(res.code).toBe(2);
    },
  );
});

describe('djinni whoami', () => {
  test('prints the candidate', async () => {
    djinni = await startFakeDjinni({ 'GET /my/profile/': fixture('my_profile.html') });
    const store = tempStore();
    store.saveSession({ cookies: [{ name: 'sessionid', value: 'AUTH', domain: '.djinni.co', path: '/' }] });

    const res = await cli(['whoami'], { store, baseUrl: djinni.url, minIntervalMs: 0 });

    expect(res.code).toBe(0);
    expect(res.out).toBe(`${HEADLINE} (candidate 100001)\nPublic profile: https://djinni.co/q/0000000000/\n`);
  });
});
