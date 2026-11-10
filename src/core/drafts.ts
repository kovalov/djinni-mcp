import { randomBytes } from 'node:crypto';
import type { Ctx } from '../context.ts';
import type { Store } from '../store.ts';

// A draft is a change that the user must approve before a "submit" operation sends it to djinni.
// The "kind" tells which operation owns the draft, for example "profile". The "payload" is what that operation sends.
// The "preview" is what the user sees before the approval, for example a diff.
export type Draft<P = unknown, V = unknown> = {
  id: string;
  kind: string;
  createdAt: string;
  expiresAt: string;
  payload: P;
  preview: V;
};

const FOLDER = 'drafts';
const LIFETIME_MS = 24 * 60 * 60 * 1000;
// A draft ID has 8 characters 0-9 and a-f, so it cannot change the path of the draft file.
const ID = /^[0-9a-f]{8}$/;

const fileOf = (id: string) => `${FOLDER}/${id}.json`;
const unknownId = (id: string) => new Error(`The draft ID "${id}" is not known. List the drafts to see the IDs.`);

const isDate = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));

// A damaged draft file (for example without valid dates) is not a draft.
const isDraft = (value: unknown): value is Draft =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Draft).id === 'string' &&
  ID.test((value as Draft).id) &&
  typeof (value as Draft).kind === 'string' &&
  isDate((value as Draft).createdAt) &&
  isDate((value as Draft).expiresAt);

// Keeps the drafts as one JSON file for each draft in the drafts folder. Only the owner can read the files.
export class Drafts {
  constructor(
    private readonly store: Store,
    private readonly now: () => Date,
  ) {}

  create<P, V>(kind: string, payload: P, preview: V): Draft<P, V> {
    let id: string;
    do id = randomBytes(4).toString('hex');
    while (this.read(id) !== null);
    const createdAt = this.now();
    const draft: Draft<P, V> = {
      id,
      kind,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + LIFETIME_MS).toISOString(),
      payload,
      preview,
    };
    this.store.writeJson(fileOf(id), draft, 0o600);
    return draft;
  }

  // Returns the draft. Refuses an unknown ID, a draft of another kind and an expired draft. An expired draft is deleted.
  get<P = unknown, V = unknown>(id: string, kind?: string): Draft<P, V> {
    const draft = this.read(id);
    if (!draft) throw unknownId(id);
    if (this.expired(draft)) {
      this.store.remove(fileOf(id));
      throw new Error(`The draft "${id}" expired at ${draft.expiresAt}. Make a new draft.`);
    }
    if (kind !== undefined && draft.kind !== kind) throw new Error(`The draft "${id}" is a ${draft.kind} draft, not a ${kind} draft.`);
    return draft as Draft<P, V>;
  }

  // Returns the drafts that did not expire, oldest first. Deletes the expired drafts.
  list(): Draft[] {
    const drafts: Draft[] = [];
    for (const file of this.store.listJson(FOLDER)) {
      const draft = this.store.readJson<unknown>(file, null);
      if (!isDraft(draft) || file !== fileOf(draft.id)) continue;
      if (this.expired(draft)) this.store.remove(file);
      else drafts.push(draft);
    }
    return drafts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  delete(id: string): void {
    if (!this.read(id)) throw unknownId(id);
    this.store.remove(fileOf(id));
  }

  private read(id: string): Draft | null {
    if (!ID.test(id)) return null;
    const draft = this.store.readJson<unknown>(fileOf(id), null);
    return isDraft(draft) && draft.id === id ? draft : null;
  }

  private expired(draft: Draft): boolean {
    return this.now().getTime() >= Date.parse(draft.expiresAt);
  }
}

const drafts = (ctx: Ctx) => new Drafts(ctx.store, () => ctx.now());

export const createDraft = <P, V>(ctx: Ctx, kind: string, payload: P, preview: V): Draft<P, V> => drafts(ctx).create(kind, payload, preview);

export const getDraft = <P = unknown, V = unknown>(ctx: Ctx, id: string, kind?: string): Draft<P, V> => drafts(ctx).get<P, V>(id, kind);

export const listDrafts = (ctx: Ctx): Draft[] => drafts(ctx).list();

export function deleteDraft(ctx: Ctx, id: string): { deleted: string } {
  drafts(ctx).delete(id);
  return { deleted: id };
}
