import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from 'vitest';

test('the stdio entry point starts an MCP server with the djinni tools', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', join(import.meta.dirname, '..', 'src', 'index.ts')],
    env: { ...process.env, DJINNI_MCP_HOME: mkdtempSync(join(tmpdir(), 'djinni-mcp-')) } as Record<string, string>,
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(['djinni_login', 'djinni_whoami']));
  } finally {
    await client.close();
  }
}, 30_000);

test('the stdio entry point runs the djinni CLI when it gets arguments', async () => {
  const env = { ...process.env, DJINNI_MCP_HOME: mkdtempSync(join(tmpdir(), 'djinni-mcp-')) };

  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', join(import.meta.dirname, '..', 'src', 'index.ts'), '--help'], { env });

  expect(stdout).toMatch(/^Usage: npx djinni-mcp <command>/);
}, 30_000);
