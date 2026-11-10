import { randomUUID } from 'node:crypto';
import { buildJobsQuery, parseJobsPage, type ApiJobsPage, type JobFilters, type JobSummary } from '../parsers/jobs.ts';
import type { Ctx, ReadClient } from '../context.ts';
import { hiddenJobs } from './jobs.ts';
import type { Store } from '../store.ts';

// A watch is a saved set of job filters. A check returns the jobs that the user did not see before.
export type Watch = { id: string; name: string; filters: JobFilters; createdAt: string; lastCheckedAt: string | null };
// A failed check of one watch gives an error and does not change the seen jobs of that watch.
export type WatchCheck = ({ watch: Watch; firstCheck: boolean; newJobs: JobSummary[] } | { watch: Watch; error: string }) & { warning?: string };
// Sends GET to a djinni API path and returns the parsed JSON body.
export type FetchJson = (path: string) => Promise<unknown>;
// Returns the IDs of the jobs that the user hid. A check leaves out these jobs.
export type HiddenIds = () => Promise<Set<string>>;

const noHiddenIds: HiddenIds = async () => new Set();

const WATCHES_FILE = 'watches.json';
const SEEN_FILE = 'seen.json';
const MAX_SEEN_PER_WATCH = 5000;
const MAX_PAGES_PER_CHECK = 5;

type SeenIds = Record<string, string[]>;

export class Watches {
  constructor(
    private readonly store: Store,
    private readonly now: () => Date,
  ) {}

  list(): Watch[] {
    return this.store.readJson<Watch[]>(WATCHES_FILE, []);
  }

  create(name: string, filters: JobFilters): Watch {
    const watch: Watch = { id: randomUUID().slice(0, 8), name, filters, createdAt: this.now().toISOString(), lastCheckedAt: null };
    this.store.writeJson(WATCHES_FILE, [...this.list(), watch]);
    return watch;
  }

  delete(id: string): void {
    this.find(id);
    this.store.writeJson(
      WATCHES_FILE,
      this.list().filter(w => w.id !== id),
    );
    const seen = this.seen();
    delete seen[id];
    this.store.writeJson(SEEN_FILE, seen);
  }

  // Checks one watch, or all watches when no ID is given.
  async check(fetchJson: FetchJson, opts: { id?: string; markSeen?: boolean } = {}, hiddenIds: HiddenIds = noHiddenIds): Promise<WatchCheck[]> {
    const targets = opts.id === undefined ? this.list() : [this.find(opts.id)];
    const results: WatchCheck[] = [];
    for (const watch of targets) {
      const seen = this.seen();
      const known = seen[watch.id];
      let newJobs: JobSummary[];
      try {
        newJobs = await this.readNewJobs(fetchJson, hiddenIds, watch.filters, new Set(known ?? []));
      } catch (e) {
        results.push({ watch, error: e instanceof Error ? e.message : String(e) });
        continue;
      }
      if (opts.markSeen !== false) {
        seen[watch.id] = [...newJobs.map(j => j.id), ...(known ?? [])].slice(0, MAX_SEEN_PER_WATCH);
        this.store.writeJson(SEEN_FILE, seen);
      }
      const checked: Watch = { ...watch, lastCheckedAt: this.now().toISOString() };
      this.store.writeJson(
        WATCHES_FILE,
        this.list().map(w => (w.id === watch.id ? checked : w)),
      );
      results.push({ watch: checked, firstCheck: known === undefined, newJobs });
    }
    return results;
  }

  // Reads the pages from offset 0 until a page has only seen jobs, the last page, or the page limit.
  // A hidden job is not a new job and is not kept as seen, so it can be new after the user shows it again.
  // For the stop rule, a hidden job that is not seen counts as unseen, so a page of new hidden jobs does not stop the read.
  private async readNewJobs(fetchJson: FetchJson, hiddenIds: HiddenIds, filters: JobFilters, seenIds: Set<string>): Promise<JobSummary[]> {
    const newJobs: JobSummary[] = [];
    let offset = 0;
    for (let i = 0; i < MAX_PAGES_PER_CHECK; i++) {
      const page = parseJobsPage((await fetchJson(`/api/jobs/?${buildJobsQuery({ ...filters, offset })}`)) as ApiJobsPage);
      const hidden = await hiddenIds();
      const unseen = page.jobs.filter(j => !seenIds.has(j.id));
      for (const j of unseen) seenIds.add(j.id);
      newJobs.push(...unseen.filter(j => !hidden.has(j.id)));
      if (unseen.length === 0 || !page.hasNextPage || page.jobs.length === 0) break;
      offset = page.offset + page.jobs.length;
    }
    return newJobs;
  }

  private find(id: string): Watch {
    const watch = this.list().find(w => w.id === id);
    if (!watch) throw new Error(`The watch ID "${id}" is not known. List the watches to see the IDs.`);
    return watch;
  }

  private seen(): SeenIds {
    return this.store.readJson<SeenIds>(SEEN_FILE, {});
  }
}

const watches = (ctx: Ctx) => new Watches(ctx.store, () => ctx.now());

export const listWatches = (ctx: Ctx): Watch[] => watches(ctx).list();

export const createWatch = (ctx: Ctx, name: string, filters: JobFilters): Watch => watches(ctx).create(name, filters);

export function deleteWatch(ctx: Ctx, id: string): { deleted: string } {
  watches(ctx).delete(id);
  return { deleted: id };
}

// The check asks djinni for the session only when a watch is checked.
// With a saved session that is not valid, each result gets the session warning.
export async function checkWatches(ctx: Ctx, opts: { id?: string; markSeen?: boolean } = {}): Promise<WatchCheck[]> {
  let read: Promise<ReadClient> | undefined;
  const fetchJson = async (path: string) => {
    read ??= ctx.readClient();
    return (await read).client.getJson(path);
  };
  // The hidden jobs need the session check of the first API read: without a valid session they are not read.
  // A failed read of the hidden jobs gives an empty set and a warning for each result, not an error.
  let hiddenWarning: string | undefined;
  const hidden = async () => {
    await read;
    const result = await hiddenJobs(ctx);
    hiddenWarning ??= result.warning;
    return result.ids;
  };
  const results = await watches(ctx).check(fetchJson, opts, hidden);
  const sessionWarning = read ? (await read.catch(() => undefined))?.warning : undefined;
  const warning = [sessionWarning, hiddenWarning].filter(Boolean).join(' ');
  return warning ? results.map(r => ({ ...r, warning })) : results;
}
