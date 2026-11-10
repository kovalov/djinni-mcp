import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// The fixtures are captured from a real djinni session. These checks make sure
// that `node scripts/sanitize-fixtures.mjs` ran after the capture.
const dir = join(import.meta.dirname, 'fixtures');
const files = readdirSync(dir).filter(f => !f.startsWith('.') && statSync(join(dir, f)).isFile());

// Each check finds values with `pattern`. Group 1 is the value. A value that
// `allowed` does not accept is a finding.
type Check = { name: string; pattern: RegExp; allowed: string | ((m: RegExpMatchArray) => boolean) };

// The texts between the tags of an HTML fragment, without the blank texts.
const texts = (html: string) =>
  html
    .split(/<[^>]*>/)
    .map(t => t.trim())
    .filter(Boolean);

const CHECKS: Check[] = [
  { name: 'data-csrf-token value', pattern: /data-csrf-token="([^"]*)"/g, allowed: 'CSRF_TOKEN' },
  { name: 'X-CSRFToken value', pattern: /X-CSRFToken(?:&quot;|")\s*:\s*(?:&quot;|")([^&"]*)/g, allowed: 'CSRF_TOKEN' },
  { name: 'csrfmiddlewaretoken value', pattern: /name="csrfmiddlewaretoken" value="([^"]*)"/g, allowed: 'CSRF_TOKEN' },
  { name: 'csrfToken value', pattern: /"csrfToken"\s*:\s*"([^"]*)"/g, allowed: 'CSRF_TOKEN' },
  { name: 'email domain', pattern: /[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g, allowed: 'example.com' },
  { name: 'cv.djinni.co link', pattern: /(https:\/\/cv\.djinni\.co\/[^"'\s<>&\\]+)/g, allowed: 'https://cv.djinni.co/00/0000/CV.pdf' },
  { name: 'token, start or cv_access_token value', pattern: /(?:&amp;|[?&])(?:token|start|cv_access_token)=([^"'&\s<]+)/g, allowed: 'REDACTED' },
  { name: 'hme value', pattern: /(?:&amp;|[?&])hme=([^"'&\s<]+)/g, allowed: 'REDACTED' },
  { name: 'Intercom user_hash', pattern: /user_hash\s*:\s*["']([^"']*)/g, allowed: 'USER_HASH' },
  { name: 'Intercom created_at', pattern: /created_at\s*:\s*(\d+)/g, allowed: '0' },
  { name: 'analytics user_id', pattern: /\buser_id\s*:\s*["']?(\d+)/g, allowed: '100002' },
  { name: 'analytics userId', pattern: /\buserId\s*:\s*["']?(\d+)/g, allowed: '100002' },
  { name: 'Satismeter createdAt', pattern: /\bcreatedAt\s*:\s*"([^"]*)"/g, allowed: '2000-01-01T00:00:00' },
  // The logged-in candidate and the own public profile. The sanitizer replaces them with 100001 and /q/0000000000/.
  { name: 'data-candidate-id', pattern: /data-candidate-id="([^"]*)"/g, allowed: '100001' },
  { name: 'analytics setUserId', pattern: /setUserId['"],\s*['"]?(\d+)/g, allowed: '100001' },
  { name: 'candidate_id value', pattern: /candidate_id(?:=|"\s*:\s*)(\d+)/g, allowed: '100001' },
  { name: 'candidateId value', pattern: /"candidateId"\s*:\s*(\d+)/g, allowed: '100001' },
  { name: 'own public profile link', pattern: /profile-head-view-public"[^>]*href="\/q\/([0-9a-f]+)\/"/g, allowed: '0000000000' },
  { name: 'own public profile in analytics', pattern: /setCustomDimension['"],\s*2,\s*['"]https?:\/\/djinni\.co\/q\/([0-9a-f]+)/g, allowed: '0000000000' },
  { name: 'own public profile URL', pattern: /profileUrl\s*:\s*"https?:\/\/djinni\.co\/q\/([0-9a-f]+)/g, allowed: '0000000000' },
  { name: 'unsubscribe token', pattern: /\/unsubscribe\/([^/"'\s<>?#]+)/g, allowed: '00000000000000000000000000000000' },
  { name: 'search_uid', pattern: /"search_uid"\s*:\s*"([^"]*)"/g, allowed: '00000000000000000000000000000000' },
  // The initials of the logged-in user in the avatar of the navigation and of the account page. The sanitizer replaces them with TU.
  { name: 'own initials', pattern: /id="(?:navbar-)?profile-picture-component"[^>]*?data-initials="([^"]*)"/g, allowed: 'TU' },
  // A CKEditor element shows the text of a textarea of the user's own form. Its content must be one REDACTED paragraph.
  { name: 'rich text editor content', pattern: /<div\b[^>]*\bcontenteditable="true"[^>]*>([\s\S]*?)<\/div>/g, allowed: '<p>REDACTED</p>' },
  // The headline of the logged-in user in the profile header. The sanitizer replaces it with "Test Position".
  { name: 'own headline', pattern: /<header class="profile-head[^"]*">[\s\S]*?<h1>\s*([^<]*?)\s*</g, allowed: 'Test Position' },
  // The link text can be in child elements of the link. Each text in the link must be "Recruiter <id>".
  {
    name: 'recruiter link text',
    pattern: /<a href="(?:https:\/\/djinni\.co)?\/r\/(\d+)-[^"]*"[^>]*>([\s\S]*?)<\/a>/g,
    allowed: m => texts(m[2]!).every(t => t === `Recruiter ${m[1]}`),
  },
  // A broad check that does not depend on the sanitizer rules: no long
  // alphanumeric, base64 or base64url value may follow one of these words.
  { name: 'long value after csrf, user_hash, token or hme', pattern: /(?:csrf|user_hash|token|hme)[\s\S]{0,40}?([A-Za-z0-9_+/=-]{32,})/gi, allowed: () => false },
];

const PLACEHOLDERS = new Set(['00000000000000000000000000000000']);

const findings = (text: string): string[] => {
  const found: string[] = [];
  for (const { name, pattern, allowed } of CHECKS) {
    for (const m of text.matchAll(pattern)) {
      const value = m[1]!;
      const ok = typeof allowed === 'string' ? value === allowed : allowed(m) || PLACEHOLDERS.has(value);
      if (!ok) found.push(`${name}: ${value.slice(0, 6)}...`);
    }
  }
  return found;
};

// The sanitizer puts "Test User" into each element with the user-name class. No other value is allowed there.
const USER_NAME = /<(\w+)\b[^>]*\bclass="[^"]*(?<![\w-])user-name(?![\w-])[^"]*"[^>]*>([^<]*)<\/\1>/g;

const userNameFindings = (text: string): string[] =>
  [...text.matchAll(USER_NAME)]
    .map(m => m[2]!.replace(/\s+/g, ' ').trim())
    .filter(name => name !== 'Test User')
    .map(name => `user-name: ${name.slice(0, 6)}...`);

// Collects the name of every recruiter object in a JSON value.
const recruiterNames = (value: unknown, out: string[] = []): string[] => {
  if (Array.isArray(value)) value.forEach(v => recruiterNames(v, out));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'recruiter' && child && typeof child === 'object' && 'name' in child) out.push(String(child.name));
      recruiterNames(child, out);
    }
  }
  return out;
};

describe('the user-name check', () => {
  test('finds a name other than "Test User" in a user-name block', () => {
    expect(userNameFindings('<div class="user-name">\n  Ivan Petrenko\n</div>')).toEqual(['user-name: Ivan P...']);
  });

  test('accepts only "Test User"', () => {
    expect(userNameFindings('<div class="user-name"> Test User </div>')).toEqual([]);
  });

  test('finds a placeholder in a user-name block', () => {
    expect(userNameFindings('<div class="user-name">REDACTED</div><div class="user-name">TEXT_3</div>')).toEqual(['user-name: REDACT...', 'user-name: TEXT_3...']);
  });

  test('finds a name in any element with the user-name class', () => {
    expect(userNameFindings('<span class="d-none user-name" title="x">Ivan Petrenko</span>')).toEqual(['user-name: Ivan P...']);
  });
});

describe('the checks find real-looking values', () => {
  // The samples are joined at run time, so that this file does not hold a finding itself.
  test('the broad check finds a long base64 or base64url value', () => {
    // Each part has less than 32 characters, so that the broad check of test/no-real-identifiers.test.ts does not find this file.
    expect(findings('csrf: ' + 'Ab3dE6gH9jK2mN5p-' + 'Ab3dE6gH9jK2mN5p_Ab3dE6gH9j')).toEqual(['long value after csrf, user_hash, token or hme: Ab3dE6...']);
    expect(findings('token: ' + 'Ab3dE6gH9jK2mN5p+' + 'Ab3dE6gH9jK2mN5p/Ab3dE6gH9j==')).toEqual(['long value after csrf, user_hash, token or hme: Ab3dE6...']);
  });

  test('the initials check finds the initials of the logged-in user in the navigation avatar', () => {
    expect(findings('<div id="navbar-profile-picture-component" class="userpic" data-initials="IP">')).toEqual(['own initials: IP...']);
    expect(findings('<div id="profile-picture-component" class="userpic" data-initials="TU">')).toEqual([]);
  });

  test('the headline check finds a headline other than "Test Position" in the profile header', () => {
    expect(findings('<header class="profile-head">\n<div><h1>RevOps Lead \n<span>x</span></h1>')).toEqual(['own headline: RevOps...']);
    expect(findings('<header class="profile-head st-active">\n<div><h1>Test Position \n<span>x</span></h1>')).toEqual([]);
  });

  test('the editor check finds text in a contenteditable element', () => {
    expect(findings('<div class="ck-content" contenteditable="true"><ul><li>' + 'Built 50 automations.</li></ul></div>')).toEqual(['rich text editor content: <ul><l...']);
    expect(findings('<div class="ck-content" contenteditable="true"><p>REDACTED</p></div>')).toEqual([]);
  });

  test('the recruiter check finds a name in a child element of the link', () => {
    expect(findings('<a href="/r/123-hr/" target="_blank"><img src="a.png"><span>' + 'Ivan Petrenko</span></a>')).toEqual(['recruiter link text: 123...']);
  });

  test('the recruiter check accepts "Recruiter <id>" in a child element', () => {
    expect(findings('<a href="/r/123-hr/"><img src="a.png">\n  <span>Recruiter 123</span>\n</a>')).toEqual([]);
  });
});

describe('test fixtures hold no secrets', () => {
  test('the fixture directory is not empty', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    test(file, () => {
      const text = readFileSync(join(dir, file), 'utf8');
      expect([...findings(text), ...userNameFindings(text)]).toEqual([]);
    });
  }

  test('the JSON fixtures hold only "Recruiter <digits>" recruiter names', () => {
    const names = files.filter(f => /^api_.*\.json$/.test(f)).flatMap(f => recruiterNames(JSON.parse(readFileSync(join(dir, f), 'utf8'))));

    expect(names.length).toBeGreaterThan(0);
    expect(names.filter(n => !/^Recruiter \d+$/.test(n))).toEqual([]);
  });
});
