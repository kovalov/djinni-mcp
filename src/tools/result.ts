import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const json = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

export const error = (message: string): CallToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

// Runs a tool handler and turns a thrown error into a tool error result.
export const safely =
  <A>(fn: (args: A) => Promise<CallToolResult>) =>
  async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (e) {
      return error(e instanceof Error ? e.message : String(e));
    }
  };
