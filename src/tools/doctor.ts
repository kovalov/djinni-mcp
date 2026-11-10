import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Ctx } from '../context.ts';
import { runDoctor } from '../core/doctor.ts';
import { json, safely } from './result.ts';

export function registerDoctorTools(server: McpServer, ctx: Ctx) {
  server.registerTool(
    'djinni_doctor',
    {
      title: 'Check the djinni pages',
      description:
        'Run a live self-check of the djinni session, the jobs API and the djinni pages that the tools read. ' +
        'This tool sends only GET requests and never opens an inbox conversation. ' +
        'Each step has ok and a detail. A failed step can mean that djinni changed a page and a tool for that page does not work. ' +
        'Use this tool when a tool gives an unexpected result.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safely(async () => json(await runDoctor(ctx))),
  );
}
