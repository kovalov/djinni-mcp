import { loginWithBrowser, loginWithCookie, loginWithPassword, whoami } from '../../core/session.ts';
import { DJINNI_URL } from '../../http.ts';
import type { Whoami } from '../../parsers/me.ts';
import { print, UsageError, type CliEnv, type Command, type Values } from '../command.ts';

const loggedIn = (me: Whoami) => `Logged in as ${me.headline} (candidate ${me.candidateId}). The session is saved on this computer.\n`;

// The password and the cookie value come only from the hidden prompt. They are never printed.
async function login(values: Values, env: CliEnv) {
  const { ctx, io } = env;
  if (values.cookie && values.browser) throw new UsageError('Use --cookie or --browser, not both.');
  if (values.email !== undefined && (values.cookie || values.browser)) throw new UsageError('--email is only for the password login.');
  if (values.browser) return loginWithBrowser(ctx);
  if (values.cookie) {
    const sessionid = await io.promptHidden('djinni sessionid cookie: ');
    return loginWithCookie(ctx, sessionid);
  }
  const email = (typeof values.email === 'string' ? values.email : await io.prompt('djinni email: ')).trim();
  if (!email) throw new Error('The email is empty.');
  const password = await io.promptHidden('djinni password: ');
  if (!password) throw new Error('The password is empty.');
  return loginWithPassword(ctx, email, password);
}

export const sessionCommands: Command[] = [
  {
    name: 'login',
    summary:
      'Log in to djinni and save the session on this computer. By default, the command asks for the email and the password. ' +
      'The password input is hidden.',
    flags: [
      { name: 'email', type: 'string', value: 'email', description: 'The djinni email. Without this flag, the command asks for it.' },
      { name: 'cookie', type: 'boolean', description: 'Log in with the value of the sessionid cookie of djinni.co from your browser.' },
      { name: 'browser', type: 'boolean', description: 'Log in in a browser window. This needs Playwright, an optional dependency that npm installs by default. The password login and --cookie need no browser.' },
    ],
    async run(values, _args, env) {
      const me = await login(values, env);
      print(env, me, () => loggedIn(me));
    },
  },
  {
    name: 'whoami',
    summary: 'Show the logged-in candidate.',
    async run(_values, _args, env) {
      const me = await whoami(env.ctx);
      const profile = me.publicProfilePath ? `Public profile: ${DJINNI_URL}${me.publicProfilePath}\n` : '';
      print(env, me, () => `${me.headline} (candidate ${me.candidateId})\n${profile}`);
    },
  },
];
