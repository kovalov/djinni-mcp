import { execFile } from 'node:child_process';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const run = promisify(execFile);

test('the djinni entry point prints the usage', async () => {
  const entry = join(import.meta.dirname, '..', '..', 'src', 'cli', 'index.ts');
  const env = { ...process.env, DJINNI_MCP_HOME: mkdtempSync(join(tmpdir(), 'djinni-mcp-')) };

  const { stdout } = await run(process.execPath, ['--import', 'tsx', entry, '--help'], { env });

  expect(stdout).toMatch(/^Usage: npx djinni-mcp <command>/);
}, 30_000);

test('the djinni entry point exits with 2 for a usage error', async () => {
  const entry = join(import.meta.dirname, '..', '..', 'src', 'cli', 'index.ts');
  const env = { ...process.env, DJINNI_MCP_HOME: mkdtempSync(join(tmpdir(), 'djinni-mcp-')) };

  const err = (await run(process.execPath, ['--import', 'tsx', entry, 'fly'], { env }).catch((e: unknown) => e)) as { code: number; stderr: string };

  expect(err.code).toBe(2);
  expect(err.stderr).toContain('Unknown command "fly"');
}, 30_000);

// The global install links the bin "djinni" to the CLI entry point.
async function runGlobalAlias(args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'djinni-mcp-bin-'));
  const alias = join(dir, 'djinni');
  symlinkSync(join(import.meta.dirname, '..', '..', 'src', 'cli', 'index.ts'), alias);
  const env = { ...process.env, DJINNI_MCP_HOME: mkdtempSync(join(tmpdir(), 'djinni-mcp-')) };
  return run(process.execPath, ['--import', 'tsx', alias, ...args], { env }).catch((e: unknown) => e as { code: number; stdout: string; stderr: string });
}

test('the global alias "djinni" names itself in the usage', async () => {
  const { stdout } = await runGlobalAlias(['--help']);

  expect(stdout).toMatch(/^Usage: djinni <command>/);
  expect(stdout).toContain('Run "djinni <command> --help" for the flags of a command.');
}, 30_000);

test('the global alias "djinni" names itself in the login hint', async () => {
  const { stderr } = await runGlobalAlias(['whoami']);

  expect(stderr).toBe('No djinni session. Run in a separate terminal window: djinni login\n');
}, 30_000);
