import { describe, expect, test } from 'vitest';
import { Ctx } from '../../src/context.ts';
import { createDraft, listDrafts } from '../../src/core/drafts.ts';
import { callTool, callToolJson, connect, tempStore } from '../helpers.ts';

// The MCP contract of the draft tools. The behavior of the drafts is in test/core/drafts.test.ts.

const now = () => new Date('2026-11-10T12:00:00.000Z');

async function setup() {
  const store = tempStore();
  const ctx = new Ctx({ store, now });
  const draft = createDraft(ctx, 'profile', { secret: 'form fields' }, { diff: [] });
  // The draft tools send no request. The base URL is a closed local port, so that a request can never reach djinni.co.
  const client = await connect({ store, now, baseUrl: 'http://127.0.0.1:9', minIntervalMs: 0 });
  return { ctx, client, draft };
}

describe('list_drafts', () => {
  test('is a read-only tool that lists the drafts without the payload', async () => {
    const { client, draft } = await setup();

    const tool = (await client.listTools()).tools.find(t => t.name === 'list_drafts')!;
    const drafts = await callToolJson(client, 'list_drafts');

    expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(drafts).toEqual([{ id: draft.id, kind: 'profile', createdAt: draft.createdAt, expiresAt: draft.expiresAt, preview: { diff: [] } }]);
  });
});

describe('delete_draft', () => {
  test('deletes a draft on this computer only', async () => {
    const { ctx, client, draft } = await setup();

    const tool = (await client.listTools()).tools.find(t => t.name === 'delete_draft')!;
    const result = await callToolJson(client, 'delete_draft', { draft_id: draft.id });

    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    expect(result).toEqual({ deleted: draft.id });
    expect(listDrafts(ctx)).toEqual([]);
  });

  test('returns an error for an unknown draft ID', async () => {
    const { client } = await setup();

    expect(await callTool(client, 'delete_draft', { draft_id: '00000000' })).toEqual({
      text: 'The draft ID "00000000" is not known. List the drafts to see the IDs.',
      isError: true,
    });
  });
});
