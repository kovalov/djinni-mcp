import { afterEach, describe, expect, test } from 'vitest';
import { callTool, callToolJson, connect, fixture, loggedInStore, startFakeDjinni, type FakeDjinni, type Route } from '../helpers.ts';

// The MCP contract of the profile tools: names, annotations, descriptions, input validation and output shape.
// The behavior of the operations is in test/core/profile.test.ts.

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

const PROFILE = fixture('my_profile.html');
const now = () => new Date('2026-11-10T12:00:00.000Z');

async function setup(routes: Record<string, Route> = {}) {
  djinni = await startFakeDjinni({ 'GET /my/profile/': PROFILE, 'POST /my/profile/': { status: 302, headers: { location: '/my/profile/' } }, ...routes });
  return connect({ store: loggedInStore(), baseUrl: djinni.url, minIntervalMs: 0, now });
}

const posts = () => djinni.requests.filter(r => r.method === 'POST');

describe('profile tool list', () => {
  test('registers get_my_profile as a read-only tool', async () => {
    const client = await setup();
    const { tools } = await client.listTools();

    expect(tools.find(t => t.name === 'get_my_profile')!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });

  test('registers prepare_profile_update as a tool that changes nothing on djinni', async () => {
    const client = await setup();
    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'prepare_profile_update')!;

    expect(tool.description).toBe(
      'Make a draft of a profile change. This tool changes nothing on djinni. Show the full diff to the user and ask for an explicit approval. ' +
        'Never add facts that the user did not confirm. Djinni blocks accounts for false profile data.',
    );
    expect(tool.annotations).toMatchObject({ destructiveHint: false, openWorldHint: true });
    const changes = (tool.inputSchema.properties as Record<string, any>).changes;
    expect(Object.keys(changes.properties)).toContain('workExperience');
    expect(changes.properties.formats.type).toBe('array');
    expect(changes.additionalProperties).toBe(false);
  });

  test('registers submit_profile_update as a destructive tool that needs confirm', async () => {
    const client = await setup();
    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'submit_profile_update')!;

    expect(tool.description).toBe(
      'Send an approved profile draft to djinni. Call this tool only after the user approved this exact draft in the chat. Set confirm to true only then.',
    );
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    expect(tool.inputSchema.required).toEqual(['draft_id', 'confirm']);
  });

  test('the profile tool descriptions have no semicolons', async () => {
    const client = await setup();
    const { tools } = await client.listTools();

    for (const name of ['get_my_profile', 'prepare_profile_update', 'submit_profile_update']) {
      expect(tools.find(t => t.name === name)!.description).not.toContain(';');
    }
  });
});

describe('get_my_profile', () => {
  test('returns the structured profile with the options as JSON', async () => {
    const client = await setup();

    const profile = await callToolJson(client, 'get_my_profile');

    expect(profile).toMatchObject({ position: 'REDACTED_position', formats: ['remote'], category: { value: 'ML AI' } });
    expect(profile.options.formats).toHaveLength(3);
  });
});

describe('prepare_profile_update', () => {
  test('returns the draft ID and the diff and sends no POST', async () => {
    const client = await setup();

    const result = await callToolJson(client, 'prepare_profile_update', { changes: { location: 'Lviv' } });

    expect(result).toEqual({ draftId: expect.any(String), expiresAt: '2026-11-11T12:00:00.000Z', diff: [{ field: 'location', old: '(empty)', new: 'Lviv' }] });
    expect(posts()).toEqual([]);
  });

  test('returns a tool error for an invalid value', async () => {
    const client = await setup();

    const res = await callTool(client, 'prepare_profile_update', { changes: { formats: ['moon'] } });

    expect(res.isError).toBe(true);
    expect(res.text).toContain('"moon" is not an allowed value for formats.');
  });

  test('refuses an unknown key', async () => {
    const client = await setup();

    const res = await callTool(client, 'prepare_profile_update', { changes: { nickname: 'x' } });

    expect(res.isError).toBe(true);
    expect(djinni.requests).toEqual([]);
  });
});

describe('submit_profile_update', () => {
  test('refuses confirm false and sends no POST', async () => {
    const client = await setup();
    const { draftId } = await callToolJson(client, 'prepare_profile_update', { changes: { location: 'Lviv' } });

    const res = await callTool(client, 'submit_profile_update', { draft_id: draftId, confirm: false });

    expect(res.isError).toBe(true);
    expect(posts()).toEqual([]);
  });

  test('refuses a call without confirm', async () => {
    const client = await setup();
    const { draftId } = await callToolJson(client, 'prepare_profile_update', { changes: { location: 'Lviv' } });

    const res = await callTool(client, 'submit_profile_update', { draft_id: draftId });

    expect(res.isError).toBe(true);
    expect(posts()).toEqual([]);
  });

  test('sends the draft with confirm true and returns the result', async () => {
    const client = await setup();
    const { draftId } = await callToolJson(client, 'prepare_profile_update', { changes: { location: 'Lviv' } });
    djinni.routes.set('POST /my/profile/', () => {
      djinni.routes.set('GET /my/profile/', PROFILE.replace('name="location" id="location" autocomplete="off" data-provide="" maxlength="255" class="form-control js-update-avg-salary" value=""', 'name="location" id="location" autocomplete="off" data-provide="" maxlength="255" class="form-control js-update-avg-salary" value="Lviv"'));
      return { status: 302, headers: { location: '/my/profile/' } };
    });

    const result = await callToolJson(client, 'submit_profile_update', { draft_id: draftId, confirm: true });

    expect(result).toEqual({ ok: true, changed: ['location'], mismatches: [] });
    expect(posts()).toHaveLength(1);
  });
});
