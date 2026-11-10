import { runCli } from '../../src/cli/index.ts';
import type { CliIo } from '../../src/cli/io.ts';
import type { ServerDeps } from '../../src/context.ts';

// A CliIo that records the output and gives the prepared answers to the prompts.
export type FakeIo = CliIo & { out: () => string; err: () => string; questions: string[] };

// "interactive" is false for an io without a terminal, for example a pipe. The default is true.
export function fakeIo(answers: { prompt?: string[]; hidden?: string[]; interactive?: boolean } = {}): FakeIo {
  const out: string[] = [];
  const err: string[] = [];
  const prompts = [...(answers.prompt ?? [])];
  const hidden = [...(answers.hidden ?? [])];
  const questions: string[] = [];
  return {
    isInteractive: answers.interactive ?? true,
    stdout: text => void out.push(text),
    stderr: text => void err.push(text),
    prompt: async question => {
      questions.push(question);
      return prompts.shift() ?? '';
    },
    promptHidden: async question => {
      questions.push(question);
      return hidden.shift() ?? '';
    },
    out: () => out.join(''),
    err: () => err.join(''),
    questions,
  };
}

export type CliRun = { code: number; out: string; err: string; io: FakeIo };

export async function cli(argv: string[], deps: ServerDeps, io: FakeIo = fakeIo()): Promise<CliRun> {
  const code = await runCli(argv, io, deps);
  return { code, out: io.out(), err: io.err(), io };
}
