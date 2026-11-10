import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Ctx, type ServerDeps } from './context.ts';
import { registerPrompts } from './prompts.ts';
import { registerApplyTools } from './tools/apply.ts';
import { registerCandidateTools } from './tools/candidates.ts';
import { registerCvTools } from './tools/cv.ts';
import { registerDoctorTools } from './tools/doctor.ts';
import { registerDraftTools } from './tools/drafts.ts';
import { registerInboxTools } from './tools/inbox.ts';
import { registerJobTools } from './tools/jobs.ts';
import { registerProfileTools } from './tools/profile.ts';
import { registerSessionTools } from './tools/session.ts';
import { registerSubscriptionTools } from './tools/subscriptions.ts';

export type { ServerDeps } from './context.ts';

export const SERVER_INSTRUCTIONS =
  'This server works with the djinni.co account of a job seeker. ' +
  'Tools with the prefix "prepare_" make a draft and change nothing on djinni. ' +
  'Show the full draft to the user. Call the matching "submit_" tool only after the user gives an explicit approval in the chat. ' +
  'Never put false facts in a profile, a CV or a cover letter. Djinni blocks accounts for false profile data and for spam.';

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: 'djinni-mcp', version: '0.1.0' }, { instructions: SERVER_INSTRUCTIONS });
  const ctx = new Ctx(deps);
  registerSessionTools(server, ctx);
  registerJobTools(server, ctx);
  registerCandidateTools(server, ctx);
  registerProfileTools(server, ctx);
  registerCvTools(server, ctx);
  registerApplyTools(server, ctx);
  registerSubscriptionTools(server, ctx);
  registerInboxTools(server, ctx);
  registerDraftTools(server, ctx);
  registerDoctorTools(server, ctx);
  registerPrompts(server);
  return server;
}
