import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { loadPlaywright, loginWithBrowser } from '../src/login.ts';
import { startFakeDjinni, type FakeDjinni } from './helpers.ts';

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

test('returns the cookies after the user reaches a logged-in page', async () => {
  djinni = await startFakeDjinni({
    // An anonymous visitor also gets a sessionid, so the cookie alone does not prove a login.
    'GET /login': {
      headers: { 'set-cookie': 'sessionid=ANON; Path=/' },
      body: '<html><body>login form<script>setTimeout(() => { document.cookie = "sessionid=USER; path=/"; location.href = "/my/inbox/"; }, 300)</script></body></html>',
    },
    'GET /my/inbox/': '<html><body><div data-candidate-id="100001"></div></body></html>',
  });

  const state = await loginWithBrowser({ baseUrl: djinni.url, headless: true, timeoutMs: 15_000 });

  expect(state.cookies.find(c => c.name === 'sessionid')?.value).toBe('USER');
}, 30_000);

test('fails with a clear message when the user does not log in before the timeout', async () => {
  djinni = await startFakeDjinni({ 'GET /login': '<html><body>login form</body></html>' });

  await expect(loginWithBrowser({ baseUrl: djinni.url, headless: true, timeoutMs: 1_000 })).rejects.toThrow(/did not finish the login/);
}, 30_000);

test('loads Playwright only when the browser login runs', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'login.ts'), 'utf8');

  expect(source).not.toMatch(/^import (?!type ).*from 'playwright'/m);
});

test.each([
  ['the module error code', Object.assign(new Error("Cannot find package 'playwright' imported from /x/login.js"), { code: 'ERR_MODULE_NOT_FOUND' })],
  ['the message of a missing package', new Error("Cannot find package 'playwright'")],
  ['the message of a missing module', new Error("Cannot find module 'playwright'")],
])('tells the user how to install Playwright or which other login to use for %s', async (_name, error) => {
  const err = (await loadPlaywright(() => Promise.reject(error)).catch((e: unknown) => e)) as Error;

  expect(err.message).toContain('Playwright is an optional dependency of djinni-mcp. npm installs it by default.');
  expect(err.message).not.toMatch(/npm (i|install) -g/);
  expect(err.message).toContain('npx djinni-mcp login --cookie');
  expect(err.message).toMatch(/password/);
});

test('rethrows an error that is not a missing Playwright', async () => {
  const broken = new Error('Playwright failed to read its config');

  await expect(loadPlaywright(() => Promise.reject(broken))).rejects.toBe(broken);
});

test('rethrows a missing module error of another package', async () => {
  const other = Object.assign(new Error("Cannot find package 'playwright-core'"), { code: 'ERR_MODULE_NOT_FOUND' });

  await expect(loadPlaywright(() => Promise.reject(other))).rejects.toBe(other);
});
