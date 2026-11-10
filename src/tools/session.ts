import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { loginWithBrowser, whoami } from '../core/session.ts';
import { json, safely } from './result.ts';
import { BIN } from '../bin.ts';

const TERMINAL_LOGIN =
  `Ask the user to run this command in a separate terminal window: ${BIN} login. ` +
  'The command asks for the djinni email and password. The password does not go through the agent. After the login, call djinni_whoami.';

// The terminal method sends no login request. With a saved session, it checks only that session.
async function terminalLogin(ctx: Ctx): Promise<string> {
  const me = await ctx.session().catch(() => null);
  if (!me) return TERMINAL_LOGIN;
  return `${TERMINAL_LOGIN}\nA saved session exists for ${me.headline}. A new login is necessary only if a tool says that the session is not valid.`;
}

export function registerSessionTools(server: McpServer, ctx: Ctx) {
  server.registerTool(
    'djinni_login',
    {
      title: 'Log in to djinni',
      description:
        'Log in to djinni.co. The default method "terminal" returns the text to tell the user: ' +
        'the user runs the login command in a separate terminal window and types the password there, so the password does not go through the agent. ' +
        'This method sends no login request. If a session is saved, it checks the session once. ' +
        'The method "browser" opens a browser window with the djinni login page and needs Playwright. ' +
        'Use this tool when another tool says that the session is not valid.',
      inputSchema: {
        method: z
          .enum(['terminal', 'browser'])
          .optional()
          .describe('"terminal" (the default) or "browser". Use "browser" only when the user asks for a browser window.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    safely(async ({ method }) => {
      if (method === 'browser') return json(await loginWithBrowser(ctx));
      return { content: [{ type: 'text', text: await terminalLogin(ctx) }] };
    }),
  );

  server.registerTool(
    'djinni_whoami',
    {
      title: 'Show the logged-in candidate',
      description: 'Show the candidate ID, the profile headline and the public profile path of the logged-in djinni user.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safely(async () => json(await whoami(ctx))),
  );
}
