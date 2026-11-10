import { PassThrough } from 'node:stream';
import { expect, test } from 'vitest';
import { createTerminalIo } from '../../src/cli/io.ts';

// Collects all text that the prompts write.
function capture() {
  const stream = new PassThrough();
  let text = '';
  stream.on('data', chunk => (text += String(chunk)));
  return { stream, text: () => text };
}

test('reads the answers of two prompts from one input', async () => {
  const input = new PassThrough();
  const prompts = capture();
  const io = createTerminalIo({ input, output: prompts.stream, stdout: new PassThrough(), stderr: new PassThrough() });
  input.write('user@example.com\nhunter2\n');

  const email = await io.prompt('Email: ');
  const password = await io.promptHidden('Password: ');
  io.close();

  expect([email, password]).toEqual(['user@example.com', 'hunter2']);
  expect(prompts.text()).toContain('Email: ');
  expect(prompts.text()).toContain('Password: ');
});

test('does not show the typed characters of a hidden answer on a terminal', async () => {
  // A fake terminal: readline echoes each typed character to the output.
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input });
  const prompts = capture();
  const io = createTerminalIo({ input, output: prompts.stream, stdout: new PassThrough(), stderr: new PassThrough() });

  const email = io.prompt('Email: ');
  input.write('visible@example.com\r');
  await email;
  const password = io.promptHidden('Password: ');
  input.write('hunter2\r');
  const value = await password;
  io.close();

  expect(value).toBe('hunter2');
  expect(prompts.text()).toContain('visible@example.com');
  expect(prompts.text()).toContain('Password: ');
  expect(prompts.text()).not.toContain('hunter2');
});

test('writes the command output to stdout and the errors to stderr', () => {
  const stdout = capture();
  const stderr = capture();
  const io = createTerminalIo({ input: new PassThrough(), output: new PassThrough(), stdout: stdout.stream, stderr: stderr.stream });

  io.stdout('result\n');
  io.stderr('error\n');
  io.close();

  expect(stdout.text()).toBe('result\n');
  expect(stderr.text()).toBe('error\n');
});

test('closes the readline interface after each answer, so that Ctrl+C goes to the process again', async () => {
  const rawModes: boolean[] = [];
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: (mode: boolean) => {
      rawModes.push(mode);
      return input;
    },
  });
  const io = createTerminalIo({ input, output: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });

  const password = io.promptHidden('Password: ');
  input.write('hunter2\r');
  await password;

  expect(rawModes.at(-1)).toBe(false);
  expect(input.listenerCount('keypress')).toBe(0);
  io.close();
});

test('gives the buffered lines to the next prompts and then fails at the end of the input', async () => {
  const input = new PassThrough();
  const io = createTerminalIo({ input, output: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  input.end('one\ntwo\n');

  const first = await io.prompt('First: ');
  const second = await io.prompt('Second: ');
  const third = await io.prompt('Third: ').catch((e: unknown) => e);
  io.close();

  expect([first, second]).toEqual(['one', 'two']);
  expect((third as Error).message).toBe('The input ended before the answer.');
});

test.each([
  [true, true, true],
  [true, false, false],
  [false, true, false],
  [false, false, false],
])('isInteractive is true only when stdin and stdout are terminals (stdin %s, stdout %s)', (inTty, outTty, expected) => {
  const input = Object.assign(new PassThrough(), { isTTY: inTty });
  const stdout = Object.assign(new PassThrough(), { isTTY: outTty });
  const io = createTerminalIo({ input, output: new PassThrough(), stdout, stderr: new PassThrough() });

  expect(io.isInteractive).toBe(expected);
  io.close();
});
