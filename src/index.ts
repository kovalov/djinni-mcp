#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runTerminalCli } from './cli/index.ts';
import { loginWithBrowser } from './login.ts';
import { createServer } from './server.ts';
import { Store } from './store.ts';

// Without arguments, this bin starts the MCP server. With arguments, it runs the djinni CLI,
// so that "npx djinni-mcp login" runs the login of this package.
const args = process.argv.slice(2);
if (args.length > 0) {
  process.exitCode = await runTerminalCli(args);
} else {
  const server = createServer({ store: new Store(), login: () => loginWithBrowser() });
  await server.connect(new StdioServerTransport());
}
