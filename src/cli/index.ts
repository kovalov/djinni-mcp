#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ctx, type ServerDeps } from '../context.ts';
import { LOGIN_HINT, NotLoggedInError } from '../http.ts';
import { loginWithBrowser } from '../login.ts';
import { Store } from '../store.ts';
import { commandUsage, GLOBAL_FLAGS, parseCommand, table, terminalText, UsageError, type Command } from './command.ts';
import { candidateCommands } from './commands/candidates.ts';
import { applyCommands } from './commands/apply.ts';
import { cvCommands } from './commands/cv.ts';
import { doctorCommands } from './commands/doctor.ts';
import { draftCommands } from './commands/drafts.ts';
import { inboxCommands } from './commands/inbox.ts';
import { jobCommands } from './commands/jobs.ts';
import { profileCommands } from './commands/profile.ts';
import { sessionCommands } from './commands/session.ts';
import { subsCommands } from './commands/subs.ts';
import { watchCommands } from './commands/watch.ts';
import { createTerminalIo, type CliIo } from './io.ts';
import { BIN } from '../bin.ts';

export type { CliIo } from './io.ts';

// Add a new command group here. A group is the first word of its commands, for example "jobs".
const COMMANDS: Command[] = [...sessionCommands, ...jobCommands, ...watchCommands, ...candidateCommands, ...profileCommands, ...cvCommands, ...applyCommands, ...subsCommands, ...inboxCommands, ...draftCommands, ...doctorCommands];

const NO_SESSION = `No djinni session. ${LOGIN_HINT}`;
const HELP = ['--help', '-h'];

function mainUsage(): string {
  return [
    `Usage: ${BIN} <command> [flags]`,
    '',
    'Work with the djinni.co account of a job seeker from the terminal.',
    '',
    'Commands:',
    ...table(COMMANDS.map(c => [c.name, c.summary.split('. ')[0]!.replace(/\.$/, '') + '.'])),
    '',
    'Global flags:',
    ...table(GLOBAL_FLAGS.map(f => [`${f.short ? `-${f.short}, ` : ''}--${f.name}`, f.description])),
    '',
    `Run "${BIN} <command> --help" for the flags of a command.`,
    '',
  ].join('\n');
}

const groupCommands = (group: string) => COMMANDS.filter(c => c.name.startsWith(`${group} `));

const groupUsage = (group: string) =>
  [`Usage: ${BIN} ${group} <command> [flags]`, '', 'Commands:', ...table(groupCommands(group).map(c => [c.name, c.summary])), ''].join('\n');

// Finds the command whose words start the arguments. Throws UsageError for an unknown command.
function findCommand(argv: string[]): { cmd: Command; rest: string[] } | { group: string } {
  for (const cmd of COMMANDS) {
    const words = cmd.name.split(' ');
    if (words.every((w, i) => argv[i] === w)) return { cmd, rest: argv.slice(words.length) };
  }
  const [first = '', second] = argv;
  const group = groupCommands(first);
  if (group.length === 0) throw new UsageError(`Unknown command "${first}".`);
  if (second !== undefined && HELP.includes(second)) return { group: first };
  if (second === undefined || second.startsWith('-')) {
    throw new UsageError(`"${BIN} ${first}" needs a command: ${group.map(c => c.name).join(', ')}.`);
  }
  throw new UsageError(`Unknown command "${first} ${second}".`);
}

const oneLine = (text: string) => terminalText(text.replace(/\s*\n\s*/g, ' ')).trim();

// Runs one CLI command. Returns the exit code: 0 for success, 1 for an error from djinni or the core, 2 for a usage error.
export async function runCli(argv: string[], io: CliIo, deps: ServerDeps): Promise<number> {
  const ctx = new Ctx(deps);
  let args = [...argv];
  let json = false;
  while (args[0] === '--json') {
    json = true;
    args = args.slice(1);
  }
  if (args.length === 0 || args[0] === 'help' || HELP.includes(args[0]!)) {
    io.stdout(mainUsage());
    return 0;
  }
  let scope = '';
  try {
    const found = findCommand(args);
    if ('group' in found) {
      io.stdout(groupUsage(found.group));
      return 0;
    }
    scope = ` ${found.cmd.name}`;
    const { values, args: positionals } = parseCommand(found.cmd, found.rest);
    if (values.help) {
      io.stdout(commandUsage(found.cmd));
      return 0;
    }
    return (await found.cmd.run(values, positionals, { ctx, io, json: json || values.json === true })) ?? 0;
  } catch (e) {
    if (e instanceof UsageError) {
      if (!scope && groupCommands(args[0]!).length) scope = ` ${args[0]}`;
      io.stderr(`${oneLine(e.message)} Run "${BIN}${scope} --help" for the usage.\n`);
      return 2;
    }
    if (e instanceof NotLoggedInError && !ctx.store.loadSession()) {
      io.stderr(`${NO_SESSION}\n`);
      return 1;
    }
    io.stderr(`${oneLine(e instanceof Error ? e.message : String(e))}\n`);
    return 1;
  }
}

// True when Node runs this file, also through the symlink of the npm bin.
function isEntry(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// Runs the CLI in a terminal and returns the exit code. The djinni and djinni-mcp bins use it.
export async function runTerminalCli(argv: string[], deps: ServerDeps = { store: new Store(), login: () => loginWithBrowser() }): Promise<number> {
  const io = createTerminalIo();
  try {
    return await runCli(argv, io, deps);
  } finally {
    io.close();
  }
}

if (isEntry()) process.exitCode = await runTerminalCli(process.argv.slice(2));
