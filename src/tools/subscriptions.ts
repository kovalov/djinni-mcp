import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import {
  getSubscriptionOptions,
  listSubscriptions,
  prepareCompanySubscription,
  prepareSubscription,
  submitCompanySubscription,
  submitSubscription,
} from '../core/subscriptions.ts';
import { json, safely } from './result.ts';

const value = (field: string) => z.string().optional().describe(`One value of the ${field} field of get_subscription_options.`);
const values = (field: string) => z.array(z.string()).optional().describe(`The values of the ${field} field of get_subscription_options.`);

const prepare = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const submit = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const confirm = z.literal(true).describe('Set to true only after the user approved this exact draft in the chat.');

export function registerSubscriptionTools(server: McpServer, ctx: Ctx) {
  server.registerTool(
    'get_subscription_options',
    {
      title: 'Read the subscription options',
      description:
        'Return the allowed values for each field of a new djinni job subscription. Use these values in prepare_subscription. ' +
        'This tool needs a djinni session.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safely(async () => json(await getSubscriptionOptions(ctx))),
  );

  server.registerTool(
    'prepare_subscription',
    {
      title: 'Prepare a job subscription',
      description:
        'Make a draft of a new djinni job subscription. This tool changes nothing on djinni. ' +
        'After the submit, djinni sends the new jobs of the subscription to the user by email or Telegram. ' +
        'A field that you do not set matches all jobs. Show the draft to the user and ask for an explicit approval.',
      inputSchema: {
        name: z.string().describe('A short name for the subscription.'),
        category: value('category'),
        salary: value('salary'),
        exp_years: value('expYears'),
        format: values('format'),
        employment: values('employment'),
        english_level: value('englishLevel'),
        location: values('location'),
        domain: values('domain'),
        keywords: z.string().optional().describe('The keywords. For example: (senior|middle) rust -blockchain'),
        can_apply_only: z.boolean().optional().describe('Set to true to get only the jobs that the user can apply to.'),
      },
      annotations: prepare,
    },
    safely(async ({ exp_years, english_level, can_apply_only, ...rest }) =>
      json(await prepareSubscription(ctx, { ...rest, expYears: exp_years, englishLevel: english_level, canApplyOnly: can_apply_only })),
    ),
  );

  server.registerTool(
    'submit_subscription',
    {
      title: 'Submit a job subscription',
      description:
        'Create an approved job subscription on djinni. Call this tool only after the user approved this exact draft in the chat. Set confirm to true only then. ' +
        'Return the HTTP status and a short text from the djinni answer. ' +
        'If the result is ok false, check the subscriptions on https://djinni.co/my/subscriptions/ before any retry.',
      inputSchema: { draft_id: z.string().describe('The draft ID from prepare_subscription.'), confirm },
      annotations: submit,
    },
    safely(async ({ draft_id }) => json(await submitSubscription(ctx, draft_id))),
  );

  server.registerTool(
    'prepare_company_subscription',
    {
      title: 'Prepare a company subscription',
      description:
        'Make a draft of a subscription to the new jobs of the company of a djinni job. This tool changes nothing on djinni. ' +
        'The tool refuses when the job page does not show the subscribe button of the company, for example after a subscription. ' +
        'Show the company to the user and ask for an explicit approval.',
      inputSchema: { job: z.string().describe('A job ID like 857417, or a djinni job URL or path.') },
      annotations: prepare,
    },
    safely(async ({ job }) => json(await prepareCompanySubscription(ctx, { job }))),
  );

  server.registerTool(
    'submit_company_subscription',
    {
      title: 'Submit a company subscription',
      description:
        'Subscribe the user to the new jobs of the company of an approved draft. ' +
        'Call this tool only after the user approved this exact draft in the chat. Set confirm to true only then. ' +
        'Return the HTTP status and a short text from the djinni answer.',
      inputSchema: { draft_id: z.string().describe('The draft ID from prepare_company_subscription.'), confirm },
      annotations: submit,
    },
    safely(async ({ draft_id }) => json(await submitCompanySubscription(ctx, draft_id))),
  );

  server.registerTool(
    'list_subscriptions',
    {
      title: 'List the job subscriptions',
      description:
        'Read the djinni job subscriptions of the user. This tool cannot read the list format yet, so the list is always empty. ' +
        'The note field tells what the page shows. The user can manage the subscriptions on https://djinni.co/my/subscriptions/.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safely(async () => json(await listSubscriptions(ctx))),
  );
}
