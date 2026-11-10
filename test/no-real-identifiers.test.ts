import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

// No file under test/ may hold the identity of the real djinni user who captured the fixtures.
// The real values are not stored in this repository. Two checks cover them:
// 1. The places that hold the identity of the logged-in user must hold a test value.
//    This check needs no real value.
// 2. If the environment variable DJINNI_PRIVATE_VALUES is set (comma-separated values, for example
//    the real candidate ID and the real profile hash), no file may hold one of these values.
//    Without the variable, this check is skipped.

const root = import.meta.dirname;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const files = walk(root);
const text = (file: string) => readFileSync(file, 'utf8');

// The sanitized fixtures use 100001 and 0000000000. The sanitizer tests use the made-up input values 999999 and abcdef1234.
const TEST_IDS = new Set(['100001', '999999']);
const TEST_HASHES = new Set(['0000000000', 'abcdef1234']);

const ID_PLACES = [
  /data-candidate-id="(\d+)"/g,
  /setUserId['"],\s*['"]?(\d+)/g,
  /candidate_id(?:=|"\s*:\s*)(\d+)/g,
  /"candidateId"\s*:\s*(\d+)/g,
];
const HASH_PLACES = [
  /profile-head-view-public"[^>]*href="\/q\/([0-9a-f]+)\/"/g,
  /setCustomDimension['"],\s*2,\s*['"]https?:\/\/djinni\.co\/q\/([0-9a-f]+)/g,
  /profileUrl\s*:\s*"https?:\/\/djinni\.co\/q\/([0-9a-f]+)/g,
];

// A finding names the kind of value only, so that a test failure does not print the value.
const findings = (content: string): string[] => [
  ...ID_PLACES.flatMap(p => [...content.matchAll(p)].filter(m => !TEST_IDS.has(m[1]!)).map(() => 'candidate ID')),
  ...HASH_PLACES.flatMap(p => [...content.matchAll(p)].filter(m => !TEST_HASHES.has(m[1]!)).map(() => 'own profile hash')),
];

// The secret values that the sanitizer replaces. A test file and a fixture may hold only a placeholder or a value that is clearly made up.
// A value is a placeholder when it is an upper case word (CSRF_TOKEN, REDACTED, SESS) or only zeros.
const V = '([A-Za-z0-9_.%+-]+)';
// The unsubscribe token can end with a slash or not.
const SECRET_PLACES: [string, RegExp][] = [
  ['unsubscribe token', new RegExp(`/unsubscribe/${V}`, 'g')],
  ['data-csrf-token', new RegExp(`data-csrf-token="${V}"`, 'g')],
  ['X-CSRFToken', new RegExp(`X-CSRFToken(?:&quot;|")\\s*:\\s*(?:&quot;|")${V}`, 'g')],
  ['csrfmiddlewaretoken', new RegExp(`name="csrfmiddlewaretoken" value="${V}"`, 'g')],
  ['csrfToken', new RegExp(`"csrfToken"\\s*:\\s*"${V}"`, 'g')],
  ['cookie value', new RegExp(`(?:csrftoken|sessionid)=${V}`, 'g')],
  ['cookie object', new RegExp(`name: '(?:csrftoken|sessionid)', value: '${V}'`, 'g')],
  ['user_hash', new RegExp(`user_hash\\s*:\\s*["']${V}`, 'g')],
  ['token, start, cv_access_token or hme', new RegExp(`(?:&amp;|[?&])(?:token|start|cv_access_token|hme)=${V}`, 'g')],
  ['search_uid', new RegExp(`"search_uid"\\s*:\\s*"${V}"`, 'g')],
  // A broad check that does not depend on the sanitizer rules: no long alphanumeric, base64 or base64url value may follow one of these words.
  ['long value', /(?:csrf|user_hash|token|hme|sessionid)[\s\S]{0,40}?([A-Za-z0-9_+/=-]{32,})/gi],
];
// Values that must be exactly one placeholder: email domains, and the account creation times of Intercom and Satismeter.
const EXACT_PLACES: [string, RegExp, string][] = [
  ['email', /[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g, 'example.com'],
  ['created_at', /\bcreated_at["']?\s*:\s*["']?([^"',\s}<]+)/g, '0'],
  ['createdAt', /\bcreatedAt["']?\s*:\s*"([^"]*)"/g, '2000-01-01T00:00:00'],
];
// The made-up values of the sanitizer tests.
const MADE_UP = new Set(['abcdefabcdefabcdefabcdefabcdefab', 'AbC-12_x']);
const placeholder = (v: string) => /^[A-Z][A-Z0-9_]*$/.test(v) || /^0+$/.test(v) || MADE_UP.has(v);
// The CV links must use the one placeholder link.
const CV_LINK = /https:\/\/cv\.djinni\.co\/([A-Za-z0-9_.%\/-]+)/g;

const secretFindings = (content: string): string[] => [
  ...SECRET_PLACES.flatMap(([kind, p]) => [...content.matchAll(p)].filter(m => !placeholder(m[1]!)).map(() => kind)),
  ...EXACT_PLACES.flatMap(([kind, p, allowed]) => [...content.matchAll(p)].filter(m => m[1] !== allowed).map(() => kind)),
  ...[...content.matchAll(CV_LINK)].filter(m => m[1] !== '00/0000/CV.pdf').map(() => 'cv.djinni.co link'),
];

describe('the files under test/ hold no secret values from a real page', () => {
  test('each token, session and CV link value is a placeholder or a made-up value', () => {
    const found = files.flatMap(f => secretFindings(text(f)).map(kind => `${relative(root, f)}: ${kind}`));

    expect(found).toEqual([]);
  });

  test('the check finds a real-looking value', () => {
    // The samples are joined at run time, so that this file does not hold a finding itself.
    expect(secretFindings('<a href="/unsubscribe/' + '9f8e7d6c5b4a39281706f5e4d3c2b1a0/">x</a>')).toEqual(['unsubscribe token']);
    expect(secretFindings('Cookie: csrftoken=' + 'Ab3dE6gH9jK2mN5p')).toEqual(['cookie value']);
  });

  test('the check finds an unsubscribe token without a trailing slash', () => {
    expect(secretFindings('<a href="https://djinni.co/unsubscribe/' + '9f8e7d6c5b4a39281706f5e4d3c2b1a0">x</a>')).toEqual(['unsubscribe token']);
  });

  test('the check finds an email address that is not at example.com', () => {
    expect(secretFindings('Write to ivan.petrenko' + '@gmail.com')).toEqual(['email']);
    expect(secretFindings('Write to user' + '@example.com')).toEqual([]);
  });

  test('the check finds a created_at or createdAt value that is not a placeholder', () => {
    expect(secretFindings('created_at: ' + '1699999999')).toEqual(['created_at']);
    expect(secretFindings('created' + 'At: "2023-05-04T10:11:12"')).toEqual(['createdAt']);
    expect(secretFindings('created_at: 0, createdAt: "2000-01-01T00:00:00"')).toEqual([]);
  });

  test('the broad check finds a long base64 or base64url value after csrf, user_hash, token, hme or sessionid', () => {
    // Each part has less than 32 characters, so that the check does not find this file.
    expect(secretFindings('sessionid ' + 'Ab3dE6gH9jK2mN5p-' + 'Ab3dE6gH9jK2mN5p_Ab3dE6gH9j')).toEqual(['long value']);
    expect(secretFindings('token: ' + 'Ab3dE6gH9jK2mN5p+' + 'Ab3dE6gH9jK2mN5p/Ab3dE6gH9j==')).toEqual(['long value']);
  });
});

describe('the files under test/ hold no real identity of the user', () => {
  test('the scan finds the test files and the fixtures', () => {
    expect(files.some(f => f.endsWith('.test.ts'))).toBe(true);
    expect(files.some(f => f.includes(`${join('fixtures', 'my_profile.html')}`))).toBe(true);
  });

  test('the places of the logged-in candidate ID and the own profile hash hold only test values', () => {
    const found = files.flatMap(f => findings(text(f)).map(kind => `${relative(root, f)}: ${kind}`));

    expect(found).toEqual([]);
  });

  const privateValues = (process.env.DJINNI_PRIVATE_VALUES ?? '')
    .split(',')
    .map(v => v.trim())
    .filter(v => v.length >= 4);

  test.skipIf(privateValues.length === 0)('no file holds a value of DJINNI_PRIVATE_VALUES', () => {
    const found = files.flatMap(f => {
      const content = text(f);
      return privateValues.filter(v => content.includes(v)).map((_, i) => `${relative(root, f)}: value ${i + 1}`);
    });

    expect(found).toEqual([]);
  });
});
