import type { Browser } from 'playwright';
import { DJINNI_URL } from './http.ts';
import type { StorageState } from './session.ts';
import { BIN } from './bin.ts';

export type LoginOptions = { baseUrl?: string; headless?: boolean; timeoutMs?: number };

type Playwright = typeof import('playwright');

// Playwright is an optional dependency. Only the browser login loads it.
export async function loadPlaywright(importer: () => Promise<Playwright> = () => import('playwright')): Promise<Playwright> {
  try {
    return await importer();
  } catch (e) {
    if (!isMissingPlaywright(e)) throw e;
    throw new Error(
      'The browser login needs Playwright, and Playwright is not installed. ' +
        'Playwright is an optional dependency of djinni-mcp. npm installs it by default. Install djinni-mcp again without --omit=optional. ' +
        `Or log in without a browser: ${BIN} login (with the email and password), or ${BIN} login --cookie.`,
    );
  }
}

// True only for the error of an import that cannot find the playwright package itself.
function isMissingPlaywright(e: unknown): boolean {
  const message = e instanceof Error ? e.message : '';
  if (!/Cannot find (package|module) 'playwright'/.test(message)) return false;
  const code = (e as { code?: unknown }).code;
  return code === undefined || code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}

// Starts the installed Google Chrome. If Chrome is not installed, starts the Playwright Chromium.
export async function launchBrowser(headless: boolean): Promise<Browser> {
  const { chromium } = await loadPlaywright();
  try {
    return await chromium.launch({ channel: 'chrome', headless });
  } catch {
    return chromium.launch({ headless });
  }
}

// Opens the djinni login page and waits until the user reaches a page of the candidate cabinet.
export async function loginWithBrowser(opts: LoginOptions = {}): Promise<StorageState> {
  const baseUrl = opts.baseUrl ?? DJINNI_URL;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const browser = await launchBrowser(opts.headless ?? false);
  try {
    const context = await browser.newContext({ locale: 'uk-UA' });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/login?lang=uk`);
    try {
      await page.waitForSelector('[data-candidate-id]', { timeout: timeoutMs, state: 'attached' });
    } catch {
      throw new Error(`The user did not finish the login in ${Math.round(timeoutMs / 1000)} seconds. Run the browser login again.`);
    }
    return (await context.storageState()) as StorageState;
  } finally {
    await browser.close();
  }
}
