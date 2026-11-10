import { existsSync, statSync, writeFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { Ctx } from '../../src/context.ts';
import { createDraft, deleteDraft, getDraft, listDrafts } from '../../src/core/drafts.ts';
import { tempStore } from '../helpers.ts';

let time = new Date('2026-11-10T12:00:00.000Z');
const ctxAt = (store = tempStore()) => new Ctx({ store, now: () => time });
const later = (ms: number) => (time = new Date(time.getTime() + ms));
const HOUR = 3600_000;

describe('createDraft', () => {
  test('saves a draft that expires 24 hours later in the drafts folder', () => {
    time = new Date('2026-11-10T12:00:00.000Z');
    const ctx = ctxAt();

    const draft = createDraft(ctx, 'profile', { fields: [['a', '1']] }, { diff: [] });

    expect(draft).toEqual({
      id: draft.id,
      kind: 'profile',
      createdAt: '2026-11-10T12:00:00.000Z',
      expiresAt: '2026-11-11T12:00:00.000Z',
      payload: { fields: [['a', '1']] },
      preview: { diff: [] },
    });
    expect(draft.id).toMatch(/^[0-9a-f]{8}$/);
    const file = ctx.store.path('drafts', `${draft.id}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test('gives each draft its own ID', () => {
    const ctx = ctxAt();
    const ids = new Set(Array.from({ length: 20 }, () => createDraft(ctx, 'profile', {}, {}).id));

    expect(ids.size).toBe(20);
  });
});

describe('getDraft', () => {
  test('returns a saved draft', () => {
    time = new Date('2026-11-10T12:00:00.000Z');
    const ctx = ctxAt();
    const draft = createDraft(ctx, 'profile', { x: 1 }, 'preview');

    expect(getDraft(ctx, draft.id)).toEqual(draft);
    expect(getDraft(ctx, draft.id, 'profile')).toEqual(draft);
  });

  test('refuses an unknown ID', () => {
    expect(() => getDraft(ctxAt(), 'abcd1234')).toThrow('The draft ID "abcd1234" is not known. List the drafts to see the IDs.');
  });

  test.each([['../state'], ['a/b'], [''], ['ABCD1234']])('refuses the ID %j that is not a draft ID', id => {
    expect(() => getDraft(ctxAt(), id)).toThrow(`The draft ID "${id}" is not known. List the drafts to see the IDs.`);
  });

  test('refuses a draft of another kind', () => {
    const ctx = ctxAt();
    const draft = createDraft(ctx, 'cv', {}, {});

    expect(() => getDraft(ctx, draft.id, 'profile')).toThrow(`The draft "${draft.id}" is a cv draft, not a profile draft.`);
  });

  test('refuses and deletes an expired draft', () => {
    time = new Date('2026-11-10T12:00:00.000Z');
    const ctx = ctxAt();
    const draft = createDraft(ctx, 'profile', {}, {});
    later(24 * HOUR + 1);

    expect(() => getDraft(ctx, draft.id)).toThrow(`The draft "${draft.id}" expired at 2026-11-11T12:00:00.000Z. Make a new draft.`);
    expect(existsSync(ctx.store.path('drafts', `${draft.id}.json`))).toBe(false);
  });

  test('accepts a draft until the moment it expires', () => {
    time = new Date('2026-11-10T12:00:00.000Z');
    const ctx = ctxAt();
    const draft = createDraft(ctx, 'profile', {}, {});
    later(24 * HOUR - 1);

    expect(getDraft(ctx, draft.id).id).toBe(draft.id);
  });
});

describe('listDrafts', () => {
  test('lists the drafts that did not expire, oldest first, and deletes the expired drafts', () => {
    time = new Date('2026-11-10T12:00:00.000Z');
    const ctx = ctxAt();
    const old = createDraft(ctx, 'profile', {}, {});
    later(2 * HOUR);
    const a = createDraft(ctx, 'profile', {}, {});
    later(HOUR);
    const b = createDraft(ctx, 'cv', {}, {});
    later(22 * HOUR + 1);

    expect(listDrafts(ctx).map(d => d.id)).toEqual([a.id, b.id]);
    expect(existsSync(ctx.store.path('drafts', `${old.id}.json`))).toBe(false);
  });

  test('returns no drafts when the drafts folder does not exist', () => {
    expect(listDrafts(ctxAt())).toEqual([]);
  });

  test('ignores a draft file that is not valid', () => {
    time = new Date('2026-11-10T12:00:00.000Z');
    const ctx = ctxAt();
    const draft = createDraft(ctx, 'profile', {}, {});
    writeFileSync(ctx.store.path('drafts', 'deadbeef.json'), 'not json');

    expect(listDrafts(ctx).map(d => d.id)).toEqual([draft.id]);
  });
});

describe('damaged draft files', () => {
  test.each([
    ['an expiresAt that is not a date', { expiresAt: 'soon' }],
    ['no createdAt', { createdAt: undefined }],
    ['a createdAt that is not a date', { createdAt: 42 }],
  ])('list skips a draft with %s, and get refuses it', (_label, damage) => {
    time = new Date('2026-11-10T12:00:00.000Z');
    const ctx = ctxAt();
    const good = createDraft(ctx, 'profile', {}, {});
    const bad = { id: 'deadbeef', kind: 'profile', createdAt: '2026-11-10T12:00:00.000Z', expiresAt: '2026-11-11T12:00:00.000Z', payload: {}, preview: {}, ...damage };
    writeFileSync(ctx.store.path('drafts', 'deadbeef.json'), JSON.stringify(bad));

    expect(listDrafts(ctx).map(d => d.id)).toEqual([good.id]);
    expect(() => getDraft(ctx, 'deadbeef')).toThrow('The draft ID "deadbeef" is not known.');
  });
});

describe('deleteDraft', () => {
  test('deletes a draft', () => {
    const ctx = ctxAt();
    const draft = createDraft(ctx, 'profile', {}, {});

    expect(deleteDraft(ctx, draft.id)).toEqual({ deleted: draft.id });
    expect(() => getDraft(ctx, draft.id)).toThrow('is not known');
  });

  test('refuses an unknown ID', () => {
    expect(() => deleteDraft(ctxAt(), 'abcd1234')).toThrow('The draft ID "abcd1234" is not known. List the drafts to see the IDs.');
  });
});
