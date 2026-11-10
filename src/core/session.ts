import * as cheerio from 'cheerio';
import type { Ctx } from '../context.ts';
import { NotLoggedInError, type DjinniClient } from '../http.ts';
import { cleanText, parseWhoami, type Whoami } from '../parsers/me.ts';

const LOGIN_PATH = '/login?lang=uk';
const PROFILE_PATH = '/my/profile/';

// Returns the identity of the logged-in candidate. Throws NotLoggedInError if no valid session is saved.
export async function whoami(ctx: Ctx) {
  return { loggedIn: true as const, ...(await ctx.me()) };
}

// Logs in with the djinni login form and saves the new session.
// The password goes only into the POST body. It is never in an error message, a log line or a saved file.
export async function loginWithPassword(ctx: Ctx, email: string, password: string) {
  const client = ctx.newClient([]);
  // The login page sets the CSRF token and an anonymous session.
  // A redirect to another login page is not a session error here. The profile check decides.
  await client.get(LOGIN_PATH).catch(ignoreNotLoggedIn);
  let page = '';
  try {
    page = (await client.postForm(LOGIN_PATH, [['email', email], ['password', password]])).body;
  } catch (e) {
    // Djinni can send a failed login back to the login page.
    if (!(e instanceof NotLoggedInError)) throw e;
  }
  // The shape of the login response is not known. Only the profile page proves the login.
  const me = await profileOf(client);
  if (!me) {
    const detail = loginPageError(page, password);
    throw new Error(`djinni did not accept the login.${detail ? ` djinni says: ${detail}` : ''}`);
  }
  ctx.saveLogin({ cookies: client.getCookies() });
  return { loggedIn: true as const, ...me };
}

// Makes a session from the value of the sessionid cookie of a browser and saves it.
export async function loginWithCookie(ctx: Ctx, sessionid: string) {
  const value = sessionid.trim();
  if (!value) throw new Error('The sessionid value is empty. Copy the value of the sessionid cookie of djinni.co from your browser.');
  const client = ctx.newClient([{ name: 'sessionid', value, domain: '.djinni.co', path: '/' }]);
  if (!client.cookie('csrftoken')) {
    // A form POST needs the CSRF token. The login page sets it.
    await client.get(LOGIN_PATH).catch(ignoreNotLoggedIn);
  }
  const me = await profileOf(client);
  if (!me) throw new Error('djinni did not accept the sessionid cookie. Copy the value again after you log in to djinni.co in your browser.');
  ctx.saveLogin({ cookies: client.getCookies() });
  return { loggedIn: true as const, ...me };
}

// Opens a browser for a manual login, saves the session and returns the candidate.
export async function loginWithBrowser(ctx: Ctx) {
  await ctx.login();
  return whoami(ctx);
}

const ignoreNotLoggedIn = (e: unknown) => {
  if (!(e instanceof NotLoggedInError)) throw e;
};

// Returns the candidate of the client session, or null when djinni does not accept the session.
async function profileOf(client: DjinniClient): Promise<Whoami | null> {
  try {
    return parseWhoami(await client.get(PROFILE_PATH));
  } catch (e) {
    if (e instanceof NotLoggedInError) return null;
    throw e;
  }
}

// Returns the error text of a login page, without the password. The toast templates of the page are not errors.
function loginPageError(html: string, password: string): string {
  if (!html) return '';
  const $ = cheerio.load(html);
  const texts = $('.invalid-feedback, .alert')
    .not('.alert-success')
    .filter((_, el) => $(el).closest('.toast').length === 0)
    .toArray()
    .map(el => cleanText($(el).text()))
    .filter(Boolean);
  return redact([...new Set(texts)].join(' '), password);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Replaces the password in a page text. The page text is cleaned, so the cleaned password is replaced too. Case does not matter.
function redact(text: string, password: string): string {
  const forms = [...new Set([password, cleanText(password)])].filter(Boolean).sort((a, b) => b.length - a.length);
  if (forms.length === 0) return text;
  return text.replace(new RegExp(forms.map(escapeRegExp).join('|'), 'gi'), '***');
}
