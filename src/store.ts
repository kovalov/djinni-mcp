import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { StorageState } from './session.ts';

// The local data folder. Set DJINNI_MCP_HOME to use a different folder.
export const defaultHome = () => process.env.DJINNI_MCP_HOME ?? join(homedir(), '.djinni-mcp');

export class Store {
  // True after the first write made the data folder private.
  private secured = false;

  constructor(readonly dir: string = defaultHome()) {}

  path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  loadSession(): StorageState | null {
    const state = this.readJson<StorageState | null>('state.json', null);
    return state && Array.isArray(state.cookies) ? state : null;
  }

  saveSession(state: StorageState): void {
    this.writeJson('state.json', state, 0o600);
  }

  readJson<T>(name: string, fallback: T): T {
    const file = this.path(name);
    if (!existsSync(file)) return fallback;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  // The data folder holds the session, the drafts and the logs, so only the owner can read the folder and each document.
  writeJson(name: string, value: unknown, mode = 0o600): void {
    const file = this.path(name);
    if (!this.secured) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      chmodSync(this.dir, 0o700);
      this.secured = true;
    }
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // Another process can read the document at any time, for example state.json. The new content goes to a temporary file
    // in the same folder first. The rename then replaces the document in one step, so a reader sees the old or the new content.
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(value, null, 2), { mode, flag: 'wx' });
      chmodSync(tmp, mode);
      renameSync(tmp, file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  // Returns the names of the JSON documents in a subfolder, sorted. The names include the subfolder.
  listJson(folder: string): string[] {
    const dir = this.path(folder);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .map(f => `${folder}/${f}`);
  }

  // Removes a document. A document that does not exist is not an error.
  remove(name: string): void {
    rmSync(this.path(name), { force: true });
  }
}
