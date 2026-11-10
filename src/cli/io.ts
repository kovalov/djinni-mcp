import { createInterface, type Interface } from 'node:readline';
import { Writable, type Readable } from 'node:stream';

// The input and output of the CLI. The commands use only this type, so that the tests can give a fake.
export type CliIo = {
  // True only when stdin and stdout are terminals. A pipe (for example from an agent) is not interactive.
  isInteractive: boolean;
  stdout(text: string): void;
  stderr(text: string): void;
  prompt(question: string): Promise<string>;
  // Asks a question and does not show the typed answer, for example a password.
  promptHidden(question: string): Promise<string>;
};

export type TerminalStreams = {
  input: Readable & { isTTY?: boolean };
  // The prompts go here. Use stderr, so that stdout has only the result.
  output: Writable;
  stdout: Writable & { isTTY?: boolean };
  stderr: Writable;
};

const processStreams = (): TerminalStreams => ({ input: process.stdin, output: process.stderr, stdout: process.stdout, stderr: process.stderr });

// Makes the CLI input and output for a terminal. Call close() at the end, so that stdin does not keep the process alive.
// Each prompt opens a readline interface and closes it after the answer. So the terminal is not in raw mode
// while the command works, Ctrl+C stops the process, and no answer stays in a readline history.
export function createTerminalIo(streams: TerminalStreams = processStreams()): CliIo & { close(): void } {
  let rl: Interface | null = null;
  let muted = false;
  // True after the input ended or the user pressed Ctrl+C during a prompt.
  let ended = false;
  let canceled = false;
  let closingAfterAnswer = false;
  // Piped input can give more than one line at once. Keep the lines until a prompt takes them.
  const queue: string[] = [];
  const waiting: { resolve: (line: string) => void; reject: (e: Error) => void }[] = [];
  const endError = () => new Error(canceled ? 'Canceled.' : 'The input ended before the answer.');
  // Readline echoes the typed characters to this stream. For a hidden answer, it drops them.
  const echo = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) streams.output.write(chunk);
      done();
    },
  });

  const open = (): Interface => {
    if (rl) return rl;
    const r = createInterface({ input: streams.input, output: echo, terminal: streams.input.isTTY === true, historySize: 0 });
    r.on('line', line => {
      const next = waiting.shift();
      if (next) next.resolve(line);
      else queue.push(line);
    });
    r.on('SIGINT', () => {
      canceled = true;
      r.close();
    });
    r.on('close', () => {
      if (rl === r) rl = null;
      if (closingAfterAnswer) return;
      ended = true;
      for (const next of waiting.splice(0)) next.reject(endError());
    });
    rl = r;
    return r;
  };

  const release = () => {
    closingAfterAnswer = true;
    rl?.close();
    closingAfterAnswer = false;
  };

  const nextLine = (): Promise<string> => {
    const line = queue.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (ended) return Promise.reject(endError());
    return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  };

  const ask = async (question: string, hidden: boolean): Promise<string> => {
    if (ended) {
      streams.output.write(question);
    } else {
      const r = open();
      r.setPrompt(question);
      r.prompt();
      // Readline writes the question at once. Mute only the answer.
      muted = hidden;
    }
    try {
      return await nextLine();
    } finally {
      if (muted) {
        muted = false;
        streams.output.write('\n');
      }
      release();
    }
  };

  return {
    isInteractive: streams.input.isTTY === true && streams.stdout.isTTY === true,
    stdout: text => void streams.stdout.write(text),
    stderr: text => void streams.stderr.write(text),
    prompt: question => ask(question, false),
    promptHidden: question => ask(question, true),
    close: release,
  };
}
