import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { Store } from '../src/store.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'djinni-mcp-'));
});

describe('Store session', () => {
  test('returns null when no session is saved', () => {
    expect(new Store(dir).loadSession()).toBeNull();
  });

  test('saves the session so that only the owner can read it', () => {
    const store = new Store(dir);
    store.saveSession({ cookies: [{ name: 'sessionid', value: 'S', domain: '.djinni.co', path: '/' }] });

    expect(new Store(dir).loadSession()?.cookies[0]?.value).toBe('S');
    expect(statSync(join(dir, 'state.json')).mode & 0o777).toBe(0o600);
  });

  test('returns null when the session file is not valid JSON', () => {
    writeFileSync(join(dir, 'state.json'), 'not json');

    expect(new Store(dir).loadSession()).toBeNull();
  });
});

describe('Store JSON documents', () => {
  test('reads back a document that it wrote', () => {
    const store = new Store(dir);
    store.writeJson('watches.json', [{ id: 'w1' }]);

    expect(store.readJson('watches.json', [])).toEqual([{ id: 'w1' }]);
  });

  test('writes a document so that only the owner can read it', () => {
    new Store(dir).writeJson('watches.json', []);

    expect(statSync(join(dir, 'watches.json')).mode & 0o777).toBe(0o600);
  });

  test('makes the data folder private at the first write', () => {
    chmodSync(dir, 0o755);

    new Store(dir).writeJson('watches.json', []);

    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  test('makes a new data folder private', () => {
    const home = join(dir, 'home');

    new Store(home).writeJson('watches.json', []);

    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  test('returns the fallback when the document does not exist', () => {
    expect(new Store(dir).readJson('missing.json', { a: 1 })).toEqual({ a: 1 });
  });
});

describe('Store documents in a subfolder', () => {
  test('writes a document in a subfolder that does not exist yet', () => {
    const store = new Store(dir);
    store.writeJson('drafts/a1.json', { id: 'a1' }, 0o600);

    expect(store.readJson('drafts/a1.json', null)).toEqual({ id: 'a1' });
    expect(statSync(join(dir, 'drafts', 'a1.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'drafts')).mode & 0o777).toBe(0o700);
  });

  test('lists the JSON documents of a subfolder by name', () => {
    const store = new Store(dir);
    store.writeJson('drafts/b2.json', {});
    store.writeJson('drafts/a1.json', {});
    writeFileSync(join(dir, 'drafts', 'notes.txt'), 'x');

    expect(store.listJson('drafts')).toEqual(['drafts/a1.json', 'drafts/b2.json']);
  });

  test('lists no documents for a subfolder that does not exist', () => {
    expect(new Store(dir).listJson('drafts')).toEqual([]);
  });

  test('removes a document, and ignores a document that does not exist', () => {
    const store = new Store(dir);
    store.writeJson('drafts/a1.json', {});

    store.remove('drafts/a1.json');
    store.remove('drafts/a1.json');

    expect(store.readJson('drafts/a1.json', null)).toBeNull();
  });
});

describe('Store atomic writes', () => {
  // Another process reads and parses state.json in a loop until the stop file exists.
  // It prints the number of reads and the number of reads that found no file or no valid JSON.
  const READER = `
    const { existsSync, readFileSync } = require('node:fs');
    const [file, stop] = process.argv.slice(1);
    let reads = 0, bad = 0;
    process.stdout.write('ready\\n');
    while (!existsSync(stop)) {
      reads++;
      try { if (!Array.isArray(JSON.parse(readFileSync(file, 'utf8')).cookies)) bad++; } catch { bad++; }
    }
    process.stdout.write(JSON.stringify({ reads, bad }));
  `;

  test('a reader in another process never sees a partial or missing state.json during the writes', async () => {
    const store = new Store(dir);
    // A large session makes each write take longer, so that a write that is not atomic is easy to see.
    const state = (n: number) => ({ cookies: Array.from({ length: 2000 }, (_, i) => ({ name: `c${i}`, value: `v${n}-${i}`, domain: 'djinni.co', path: '/' })) });
    store.saveSession(state(0));
    const stop = join(dir, 'stop');
    const reader = spawn(process.execPath, ['-e', READER, join(dir, 'state.json'), stop]);
    let out = '';
    reader.stdout.on('data', c => (out += String(c)));
    await new Promise<void>(resolve => reader.stdout.once('data', () => resolve()));

    const end = Date.now() + 1000;
    for (let n = 1; Date.now() < end; n++) store.saveSession(state(n));
    writeFileSync(stop, '');
    await new Promise(resolve => reader.once('exit', resolve));

    const result = JSON.parse(out.slice(out.indexOf('{'))) as { reads: number; bad: number };
    expect(result.reads).toBeGreaterThan(10);
    expect(result.bad).toBe(0);
    expect(new Store(dir).loadSession()?.cookies).toHaveLength(2000);
  }, 20_000);

  test('leaves no temporary file and keeps the mode of the document', () => {
    const store = new Store(dir);

    store.writeJson('drafts/a1.json', { id: 'a1' });
    store.writeJson('drafts/a1.json', { id: 'a1', v: 2 });

    expect(readdirSync(join(dir, 'drafts'))).toEqual(['a1.json']);
    expect(statSync(join(dir, 'drafts', 'a1.json')).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dir, 'drafts', 'a1.json'))).toBe(true);
  });
});
