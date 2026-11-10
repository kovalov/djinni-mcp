import { BIN } from '../../bin.ts';
import { getDraft } from '../../core/drafts.ts';
import {
  getCompanySubscriptionDraft,
  getSubscriptionDraft,
  getSubscriptionOptions,
  listSubscriptions,
  prepareCompanySubscription,
  prepareSubscription,
  submitCompanySubscription,
  submitSubscription,
  type SubscriptionFields,
} from '../../core/subscriptions.ts';
import { print, terminalText, UsageError, type Command, type Flag, type Values } from '../command.ts';
import {
  companySubscriptionDraftText,
  companySubscriptionPreviewText,
  subscriptionDraftText,
  subscriptionOptionsText,
  subscriptionPreviewText,
  subscriptionSubmitText,
} from '../format.ts';

const SESSION = 'This needs a djinni session.';
const YES = ['y', 'yes'];
const OPTIONS = `Run "${BIN} subs options" for the allowed values.`;
const LIST = 'Repeat the flag or separate the values with commas.';

const one = (name: string, description: string): Flag => ({ name, type: 'string', value: 'value', description: `${description} ${OPTIONS}` });
const many = (name: string, description: string): Flag => ({ name, type: 'string', multiple: true, value: 'values', description: `${description} ${LIST}` });

const items = (values: string[] | undefined) => values?.flatMap(v => v.split(',')).map(s => s.trim()).filter(s => s !== '');

function fieldsFromFlags(values: Values): SubscriptionFields {
  const name = values.name as string | undefined;
  if (name === undefined) throw new UsageError(`"${BIN} subs prepare" needs --name.`);
  const fields: SubscriptionFields = { name };
  const set = <K extends keyof SubscriptionFields>(key: K, value: SubscriptionFields[K] | undefined) => {
    if (value !== undefined) fields[key] = value;
  };
  set('category', values.category as string | undefined);
  set('salary', values.salary as string | undefined);
  set('expYears', values['exp-years'] as string | undefined);
  set('format', items(values.format as string[] | undefined));
  set('employment', items(values.employment as string[] | undefined));
  set('englishLevel', values.english as string | undefined);
  set('location', items(values.location as string[] | undefined));
  set('domain', items(values.domain as string[] | undefined));
  set('keywords', values.keywords as string | undefined);
  if (values['can-apply-only'] === true) fields.canApplyOnly = true;
  return fields;
}

export const subsCommands: Command[] = [
  {
    name: 'subs options',
    summary: `Print the allowed values for each field of a new djinni job subscription. ${SESSION}`,
    async run(_values, _args, env) {
      const options = await getSubscriptionOptions(env.ctx);
      print(env, options, () => subscriptionOptionsText(options));
    },
  },
  {
    name: 'subs prepare',
    summary:
      'Make a draft of a new djinni job subscription. This command changes nothing on djinni. ' +
      'djinni sends the new jobs of a subscription by email or Telegram. A field that you do not set matches all jobs. ' +
      `Create the subscription with "${BIN} subs submit". ${SESSION}`,
    flags: [
      { name: 'name', type: 'string', value: 'name', description: 'A short name for the subscription.' },
      one('category', 'The job category.'),
      one('salary', 'The minimum salary.'),
      one('exp-years', 'The years of experience.'),
      many('format', 'The work formats.'),
      many('employment', 'The employment types.'),
      one('english', 'The English level.'),
      many('location', 'The countries.'),
      many('domain', 'The domains.'),
      { name: 'keywords', type: 'string', value: 'words', description: 'The keywords, for example "(senior|middle) rust -blockchain".' },
      { name: 'can-apply-only', type: 'boolean', description: 'Get only the jobs that you can apply to.' },
    ],
    async run(values, _args, env) {
      const draft = await prepareSubscription(env.ctx, fieldsFromFlags(values));
      print(env, draft, () => subscriptionDraftText(draft));
    },
  },
  {
    name: 'subs prepare-company',
    args: ['<job>'],
    summary:
      'Make a draft of a subscription to the new jobs of the company of a job. This command changes nothing on djinni. ' +
      `The job is a job ID like 857417, or a djinni job URL. ${SESSION}`,
    async run(_values, [job], env) {
      const draft = await prepareCompanySubscription(env.ctx, { job: job! });
      print(env, draft, () => companySubscriptionDraftText(draft));
    },
  },
  {
    name: 'subs submit',
    args: ['<draft-id>'],
    summary: `Create the subscription of a draft from "subs prepare" or "subs prepare-company" on djinni. The command prints the draft and asks for your approval. ${SESSION}`,
    flags: [{ name: 'yes', type: 'boolean', description: 'Create the subscription without a question.' }],
    async run(values, [id], env) {
      const company = getDraft(env.ctx, id!).kind === 'company_subscription';
      const preview = company ? companySubscriptionPreviewText(getCompanySubscriptionDraft(env.ctx, id!)) : subscriptionPreviewText(getSubscriptionDraft(env.ctx, id!).preview);
      if (values.yes !== true) {
        const text = terminalText(preview);
        if (env.json) env.io.stderr(text);
        else env.io.stdout(`${text}\n`);
        const answer = await env.io.prompt('Create this subscription on djinni? [y/N] ');
        if (!YES.includes(answer.trim().toLowerCase())) {
          env.io.stderr('Canceled. Nothing was sent to djinni.\n');
          return 1;
        }
      }
      const result = company ? await submitCompanySubscription(env.ctx, id!) : await submitSubscription(env.ctx, id!);
      print(env, result, () => subscriptionSubmitText(result));
      return result.ok ? 0 : 1;
    },
  },
  {
    name: 'subs list',
    summary: `Print your djinni job subscriptions. The list format is not verified yet. ${SESSION}`,
    async run(_values, _args, env) {
      const list = await listSubscriptions(env.ctx);
      print(env, list, () => `${list.note}\n`);
    },
  },
];
