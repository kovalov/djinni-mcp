import { afterEach, describe, expect, test } from 'vitest';
import { parseWhoami } from '../../src/parsers/me.ts';
import { callTool, callToolJson, connect, fixture, loggedInStore, startFakeDjinni, tempStore, type FakeDjinni } from '../helpers.ts';

// The MCP contract of the session tools. The behavior of whoami is in test/core/session.test.ts.

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

describe('djinni_whoami', () => {
  test('returns the identity of the logged-in candidate', async () => {
    djinni = await startFakeDjinni({ 'GET /my/profile/': fixture('my_profile.html') });
    const client = await connect({ store: loggedInStore(), baseUrl: djinni.url, minIntervalMs: 0 });

    const me = await callToolJson(client, 'djinni_whoami');

    expect(me).toMatchObject({ loggedIn: true, candidateId: '100001', publicProfilePath: '/q/0000000000/' });
  });

  test('tells the agent to run djinni login when no session is saved', async () => {
    djinni = await startFakeDjinni();
    const client = await connect({ store: tempStore(), baseUrl: djinni.url, minIntervalMs: 0 });

    const res = await callTool(client, 'djinni_whoami');

    expect(res.isError).toBe(true);
    expect(res.text).toContain('Run in a separate terminal window: npx djinni-mcp login');
    expect(djinni.requests).toHaveLength(0);
  });

  test.each([['/login?next=/my/profile/'], ['/continue/']])(
    'tells the agent to run djinni login when djinni redirects the profile page to %s',
    async location => {
      djinni = await startFakeDjinni({ 'GET /my/profile/': { status: 302, headers: { location } } });
      const client = await connect({ store: loggedInStore(), baseUrl: djinni.url, minIntervalMs: 0 });

      const res = await callTool(client, 'djinni_whoami');

      expect(res.isError).toBe(true);
      expect(res.text).toContain('Run in a separate terminal window: npx djinni-mcp login');
    },
  );
});

const TERMINAL_TEXT =
  'Ask the user to run this command in a separate terminal window: npx djinni-mcp login. ' +
  'The command asks for the djinni email and password. The password does not go through the agent. After the login, call djinni_whoami.';

describe('djinni_login', () => {
  test('never names the bin of another npm package or the Claude Code "!" form', async () => {
    const client = await connect({ store: tempStore() });

    const { tools } = await client.listTools();
    const login = tools.find(t => t.name === 'djinni_login')!;

    expect(login.description).toContain('This method sends no login request. If a session is saved, it checks the session once.');
    expect(JSON.stringify(login)).not.toMatch(/npx djinni(?!-mcp)|! npx/);
  });

  test.each([[{}], [{ method: 'terminal' }]])('with %j tells the agent to ask the user for the terminal login and sends no request', async args => {
    djinni = await startFakeDjinni();
    const client = await connect({ store: tempStore(), baseUrl: djinni.url, minIntervalMs: 0 });

    const res = await callTool(client, 'djinni_login', args);

    expect(res).toEqual({ text: TERMINAL_TEXT, isError: false });
    expect(djinni.requests).toHaveLength(0);
  });

  test('adds a line about the saved session when the saved session is valid', async () => {
    djinni = await startFakeDjinni({ 'GET /my/profile/': fixture('my_profile.html') });
    const client = await connect({ store: loggedInStore(), baseUrl: djinni.url, minIntervalMs: 0 });
    const headline = parseWhoami(fixture('my_profile.html'))!.headline;

    const res = await callTool(client, 'djinni_login');

    expect(res.isError).toBe(false);
    expect(res.text).toBe(
      `${TERMINAL_TEXT}\nA saved session exists for ${headline}. A new login is necessary only if a tool says that the session is not valid.`,
    );
    expect(djinni.requests.map(r => r.url)).toEqual(['/my/profile/']);
  });

  test('gives only the terminal text when the saved session is not valid', async () => {
    djinni = await startFakeDjinni({ 'GET /my/profile/': { status: 302, headers: { location: '/continue/' } } });
    const client = await connect({ store: loggedInStore(), baseUrl: djinni.url, minIntervalMs: 0 });

    const res = await callTool(client, 'djinni_login');

    expect(res).toEqual({ text: TERMINAL_TEXT, isError: false });
  });

  test('with the browser method saves the session that the browser flow returns', async () => {
    djinni = await startFakeDjinni({ 'GET /my/profile/': fixture('my_profile.html') });
    const store = tempStore();
    const login = async () => ({ cookies: [{ name: 'sessionid', value: 'NEW', domain: '.djinni.co', path: '/' }] });
    const client = await connect({ store, baseUrl: djinni.url, minIntervalMs: 0, login });

    const res = await callToolJson(client, 'djinni_login', { method: 'browser' });

    expect(store.loadSession()?.cookies[0]?.value).toBe('NEW');
    expect(res).toMatchObject({ loggedIn: true, candidateId: '100001' });
    expect(djinni.requests[0]?.headers.cookie).toBe('sessionid=NEW');
  });

  test('rejects an unknown method', async () => {
    djinni = await startFakeDjinni();
    const client = await connect({ store: tempStore(), baseUrl: djinni.url, minIntervalMs: 0 });

    const res = await callTool(client, 'djinni_login', { method: 'password' });

    expect(res.isError).toBe(true);
    expect(djinni.requests).toHaveLength(0);
  });
});
