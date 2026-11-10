import { parseArgs } from 'node:util';
import type { Ctx } from '../context.ts';
import type { CliIo } from './io.ts';
import { BIN } from '../bin.ts';

// An error in the command line. The CLI exits with 2.
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export type Flag = {
  name: string;
  type: 'string' | 'boolean';
  // A flag that can repeat. Its value is a list.
  multiple?: boolean;
  // The name of the value in the help text, for example "ids".
  value?: string;
  short?: string;
  description: string;
};

export type Values = Record<string, string | boolean | string[] | undefined>;
export type CliEnv = { ctx: Ctx; io: CliIo; json: boolean };

export type Command = {
  // One or two words, for example "whoami" or "jobs search".
  name: string;
  // The positional arguments. "<job>" is necessary, "[<id>]" is optional.
  args?: string[];
  summary: string;
  flags?: Flag[];
  // Returns the exit code. No value means 0.
  run(values: Values, args: string[], env: CliEnv): Promise<number | void>;
};

export const GLOBAL_FLAGS: Flag[] = [
  { name: 'json', type: 'boolean', description: 'Print the result as JSON.' },
  { name: 'help', short: 'h', type: 'boolean', description: 'Print the usage.' },
];

const flagLabel = (f: Flag) => `${f.short ? `-${f.short}, ` : ''}--${f.name}${f.value ? ` <${f.value}>` : ''}`;

// Returns one line for each item, with the descriptions in one column.
export function table(rows: [string, string][]): string[] {
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  return rows.map(([label, text]) => `  ${label.padEnd(width)}${text}`);
}

export function commandUsage(cmd: Command): string {
  const args = cmd.args?.length ? ` ${cmd.args.join(' ')}` : '';
  const flags = [...(cmd.flags ?? []), ...GLOBAL_FLAGS];
  return [`Usage: ${BIN} ${cmd.name}${args} [flags]`, '', cmd.summary, '', 'Flags:', ...table(flags.map(f => [flagLabel(f), f.description])), ''].join('\n');
}

// Parses the flags and the arguments of a command. Throws UsageError for a bad command line.
export function parseCommand(cmd: Command, argv: string[]): { values: Values; args: string[] } {
  const options = Object.fromEntries(
    [...(cmd.flags ?? []), ...GLOBAL_FLAGS].map(f => [
      f.name,
      { type: f.type, ...(f.multiple ? { multiple: true } : {}), ...(f.short ? { short: f.short } : {}) },
    ]),
  );
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_')) throw new UsageError((e as Error).message);
    throw e;
  }
  const values = parsed.values as Values;
  const args = parsed.positionals;
  if (!values.help) {
    const all = cmd.args ?? [];
    const required = all.filter(a => a.startsWith('<'));
    if (args.length < required.length) throw new UsageError(`"${BIN} ${cmd.name}" needs ${required.slice(args.length).join(' ')}.`);
    if (args.length > all.length) throw new UsageError(`"${BIN} ${cmd.name}" got too many arguments: ${args.slice(all.length).join(' ')}.`);
  }
  return { values, args };
}

// Removes the C0 and C1 control characters, except tab and line feed, and the bidi control characters.
// Server text can hold terminal escape sequences, and a terminal must not get them.
// A bidi control (U+202A-202E, U+2066-2069, U+200E, U+200F) can show the text in a different order than its real order.
export const terminalText = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');

// JSON.stringify escapes the C0 control characters, but not DEL and the C1 control characters.
const terminalJson = (value: unknown) =>
  JSON.stringify(value, null, 2).replace(/[\u007f-\u009f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

// Prints the core result: JSON with --json, else the human text. The session warning goes to stderr.
export function print(env: CliEnv, value: unknown, text: () => string, warning?: string): void {
  if (env.json) {
    env.io.stdout(`${terminalJson(value)}\n`);
    return;
  }
  if (warning) env.io.stderr(terminalText(`Warning: ${warning}\n`));
  env.io.stdout(terminalText(text()));
}
