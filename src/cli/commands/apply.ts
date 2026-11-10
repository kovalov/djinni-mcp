import { readFileSync } from 'node:fs';
import { checkApplicationResend, getApplicationDraft, listApplications, prepareApplication, submitApplication } from '../../core/apply.ts';
import { print, terminalText, UsageError, type Command } from '../command.ts';
import { applicationDraftText, applicationPreviewText, applicationsText, applicationSubmitText } from '../format.ts';
import { BIN } from '../../bin.ts';

const SESSION = 'This needs a djinni session.';
const YES = ['y', 'yes'];

function readMessage(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read the message file ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function salaryFlag(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isInteger(n) || n <= 0) throw new UsageError('--salary must be a positive whole number.');
  return n;
}

export const applyCommands: Command[] = [
  {
    name: 'apply prepare',
    args: ['<job>'],
    summary:
      'Make a draft of a job application and print it. This command sends nothing to the employer. ' +
      `Send the draft with "${BIN} apply submit". The job is a job ID like 857417, or a djinni job URL. ${SESSION}`,
    flags: [
      { name: 'message-file', type: 'string', value: 'file', description: 'Read the cover letter from this text file.' },
      { name: 'cv', type: 'string', value: 'id', description: 'The ID of a CV file in your profile. The default is the CV file that the apply form selects.' },
      { name: 'salary', type: 'string', value: 'usd', description: 'The salary in USD for this job. The default is the salary of your profile.' },
    ],
    async run(values, [job], env) {
      const file = values['message-file'] as string | undefined;
      if (file === undefined) throw new UsageError(`"${BIN} apply prepare" needs --message-file.`);
      const salary = salaryFlag(values.salary as string | undefined);
      const draft = await prepareApplication(env.ctx, { job: job!, message: readMessage(file), cvId: values.cv as string | undefined, salary });
      print(env, draft, () => applicationDraftText(draft));
    },
  },
  {
    name: 'apply submit',
    args: ['<draft-id>'],
    summary:
      'Send an application draft to the employer. The command prints the draft and asks for your approval. ' +
      `An application cannot be taken back. ${SESSION}`,
    flags: [
      { name: 'yes', type: 'boolean', description: 'Send the application without a question.' },
      {
        name: 'resend',
        type: 'boolean',
        description: 'Send a draft again that was sent before with an unclear result. The command checks the job on djinni first and always asks.',
      },
    ],
    async run(values, [id], env) {
      const resend = values.resend === true;
      if (resend && values.yes === true) throw new UsageError('--resend does not work with --yes. The command always asks before it sends an application again.');
      // An agent can pipe "y" into the question. Only a person in a terminal can approve a resend.
      if (resend && !env.io.isInteractive) {
        throw new Error('--resend works only in an interactive terminal. Only a person can approve a resend: run the command in a terminal window, not through a pipe or an agent.');
      }
      // A resend checks djinni first, so the user sees no question for a job that djinni shows as applied.
      const draft = resend ? await checkApplicationResend(env.ctx, id!) : getApplicationDraft(env.ctx, id!);
      if (values.yes !== true) {
        const preview = terminalText(applicationPreviewText(draft.preview));
        if (env.json) env.io.stderr(preview);
        else env.io.stdout(`${preview}\n`);
        const question = resend ? 'The application may be sent already. Send it again? [y/N] ' : 'Send this application to the employer? [y/N] ';
        const answer = await env.io.prompt(question);
        if (!YES.includes(answer.trim().toLowerCase())) {
          env.io.stderr('Canceled. Nothing was sent to the employer.\n');
          return 1;
        }
      }
      const result = await submitApplication(env.ctx, id!, { resend });
      print(env, result, () => applicationSubmitText(result, id!));
      return result.ok ? 0 : 1;
    },
  },
  {
    name: 'applications',
    summary: 'Print the applications that djinni-mcp sent, from the log on this computer. The log does not have the applications from the djinni site.',
    async run(_values, _args, env) {
      const list = listApplications(env.ctx);
      print(env, list, () => applicationsText(list));
    },
  },
];
