// Removes tokens and personal data from the test fixtures, in place.
//
// Run it after every capture:
//   node scripts/sanitize-fixtures.mjs [<folder>]
//
// The default folder is test/fixtures.
//
// The script is idempotent. test/fixtures.test.ts fails when a fixture
// still holds a value that this script replaces.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? join(import.meta.dirname, '..', 'test', 'fixtures');

// Replaces each text of the link content with "Recruiter <id>". A link with only text gets only "Recruiter <id>".
// In a link with child elements, the elements and the blank texts stay.
function recruiterText(inner, id) {
  const name = `Recruiter ${id}`;
  if (!inner.includes('<')) return name;
  return inner.replace(/(^|>)([^<]*)/g, (m, open, text) => (text.trim() ? `${open}${name}` : m));
}

const RULES = [
  [/(data-csrf-token=")[^"]*(")/g, '$1CSRF_TOKEN$2'],
  // hx-headers in an HTML attribute (&quot;) and as plain JSON (").
  [/(X-CSRFToken(?:&quot;|")\s*:\s*(?:&quot;|"))[^&"]*/g, '$1CSRF_TOKEN'],
  [/(name="csrfmiddlewaretoken" value=")[^"]*(")/g, '$1CSRF_TOKEN$2'],
  [/("csrfToken"\s*:\s*")[^"]*(")/g, '$1CSRF_TOKEN$2'],
  [/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g, (m, domain) => (domain === 'example.com' ? m : 'user@example.com')],
  [/https:\/\/cv\.djinni\.co\/[^"'\s<>&\\]+/g, 'https://cv.djinni.co/00/0000/CV.pdf'],
  [/((?:&amp;|[?&])(?:token|start|cv_access_token|hme)=)[^"'&\s<]+/g, '$1REDACTED'],
  // Intercom identity of the logged-in user.
  [/(user_hash\s*:\s*["'])[^"']*/g, '$1USER_HASH'],
  [/(created_at\s*:\s*)\d+/g, (_, k) => `${k}0`],
  // Satismeter account creation time.
  [/(\bcreatedAt\s*:\s*")[^"]*/g, (_, k) => `${k}2000-01-01T00:00:00`],
  // The token of the "unsubscribe from all emails" link. It is bound to the account.
  [/(\/unsubscribe\/)[^/"'\s<>?#]+/g, `$1${'0'.repeat(32)}`],
  [/("search_uid"\s*:\s*")[^"]*/g, (_, k) => `${k}${'0'.repeat(32)}`],
  // A CKEditor element shows the text of a textarea of the user's own form. The capture script redacts only the textarea.
  // The editor content has no div elements, so the content ends at the first </div>.
  [/(<div\b[^>]*\bcontenteditable="true"[^>]*>)[\s\S]*?(<\/div>)/g, '$1<p>REDACTED</p>$2'],
  // Recruiter names in links to recruiter pages /r/<id>-<slug>/. The name can be in a child element of the link.
  [/(<a href="(?:https:\/\/djinni\.co)?\/r\/(\d+)-[^"]*"[^>]*>)([\s\S]*?)(<\/a>)/g, (_, open, id, inner, close) => open + recruiterText(inner, id) + close],
];

// The djinni user ID of the logged-in user. The sanitizer reads it from the
// analytics settings in the pages and replaces it everywhere.
const USER_ID = '100002';
const findUserIds = texts => {
  const ids = new Set();
  for (const text of texts) {
    for (const m of text.matchAll(/\buser_?[iI]d\s*:\s*["']?(\d+)/g)) if (m[1] !== USER_ID) ids.add(m[1]);
  }
  return ids;
};

// The candidate ID of the logged-in user. The sanitizer reads it from the
// inbox socket element and the analytics settings in the pages, and replaces
// the number everywhere, also in candidate_id= values and in the JSON page data.
const CANDIDATE_ID = '100001';
const findCandidateIds = texts => {
  const ids = new Set();
  for (const text of texts) {
    for (const m of text.matchAll(/id="candidate-inbox-ws"[^>]*data-candidate-id="(\d+)"/g)) ids.add(m[1]);
    for (const m of text.matchAll(/setUserId['"],\s*['"]?(\d+)/g)) ids.add(m[1]);
  }
  ids.delete(CANDIDATE_ID);
  return ids;
};

// The hash of the public profile of the logged-in user. The sanitizer reads it from
// the "public profile" link of the profile header and from the analytics settings.
// The hashes of other candidates do not appear in these places, so they stay.
const PROFILE_HASH = '0000000000';
const findProfileHashes = texts => {
  const hashes = new Set();
  for (const text of texts) {
    for (const m of text.matchAll(/profile-head-view-public"[^>]*href="\/q\/([0-9a-f]+)\/"/g)) hashes.add(m[1]);
    for (const m of text.matchAll(/setCustomDimension['"],\s*2,\s*['"]https?:\/\/djinni\.co\/q\/([0-9a-f]+)/g)) hashes.add(m[1]);
    for (const m of text.matchAll(/profileUrl\s*:\s*"https?:\/\/djinni\.co\/q\/([0-9a-f]+)/g)) hashes.add(m[1]);
  }
  hashes.delete(PROFILE_HASH);
  return hashes;
};

// The initials of the logged-in user. The sanitizer reads them from the avatar of the navigation
// and of the account page, and replaces each data-initials attribute with these initials in every fixture.
// The avatars of other people (for example recruiters in the inbox) have other initials, so they stay.
const INITIALS = 'TU';
const findInitials = texts => {
  const found = new Set();
  for (const text of texts) {
    for (const m of text.matchAll(/id="(?:navbar-)?profile-picture-component"[^>]*?data-initials="([^"]*)"/g)) found.add(m[1]);
  }
  found.delete(INITIALS);
  found.delete('');
  return found;
};

// The name of the logged-in user. The page header shows it in an element with the class "user-name".
// The sanitizer replaces the name, each part of the name, their upper case forms
// and the forms with underscores in every fixture. In a data-cv-name attribute,
// it also replaces the forms in other letter cases.
const USER_NAME = 'Test User';
// The values of a user-name block that are already placeholders.
const NAME_PLACEHOLDER = /^(Test User|REDACTED(_\w+)?|TEXT_\d+)$/;
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// An element with the class "user-name". Group 3 is its text.
const USER_NAME_ELEMENT = /(<(\w+)\b[^>]*\bclass="[^"]*(?<![\w-])user-name(?![\w-])[^"]*"[^>]*>\s*)([^<]*?)(\s*<\/\2>)/g;
const findUserNames = texts => {
  const names = new Set();
  for (const text of texts) {
    for (const m of text.matchAll(USER_NAME_ELEMENT)) {
      const name = m[3].replace(/\s+/g, ' ').trim();
      if (name && !NAME_PLACEHOLDER.test(name)) names.add(name);
    }
  }
  return names;
};
// Puts the test name into each user-name element, also into an element with an older placeholder.
const setUserNameElements = text => text.replace(USER_NAME_ELEMENT, (m, open, _tag, name, close) => (name.trim() ? `${open}${USER_NAME}${close}` : m));

// The headline of the logged-in user. The sanitizer reads it from the h1 element of the profile header
// and replaces it in every fixture. The headlines in other places of the pages stay.
const HEADLINE = 'Test Position';
const findHeadlines = texts => {
  const found = new Set();
  for (const text of texts) {
    for (const m of text.matchAll(/<header class="profile-head[^"]*">[\s\S]*?<h1>\s*([^<]*?)\s*</g)) found.add(m[1]);
  }
  found.delete(HEADLINE);
  found.delete('');
  return found;
};

// Returns the pairs [form of the real name, form of the test name], the longest forms first.
const nameForms = name => {
  const real = name.split(' ');
  const test = USER_NAME.split(' ');
  // Each real part gets the test part at the same place. The parts after the last test part get the last test part.
  const testPart = i => test[Math.min(i, test.length - 1)];
  const pairs = [
    [real.join(' '), USER_NAME],
    [real.join('_'), test.join('_')],
    ...real.map((part, i) => [part, testPart(i)]),
  ];
  const all = pairs.flatMap(([r, t]) => [
    [r, t],
    [r.toUpperCase(), t.toUpperCase()],
  ]);
  return all.filter(([r]) => r.length >= 2).sort((a, b) => b[0].length - a[0].length);
};

// A form matches only as a whole word: no letter or digit just before it or just after it.
const wordPattern = (form, flags) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(form)}(?![\\p{L}\\p{N}])`, flags);

const replaceName = (text, name) => {
  let out = text.replace(/(data-cv-name=")([^"]*)(")/g, (_, a, value, b) => {
    let v = value;
    for (const [real, test] of nameForms(name)) v = v.replace(wordPattern(real, 'giu'), test);
    return a + v + b;
  });
  for (const [real, test] of nameForms(name)) out = out.replace(wordPattern(real, 'gu'), test);
  return out;
};

// Replaces the name of every recruiter object with "Recruiter <id>".
const renameRecruiters = value => {
  if (Array.isArray(value)) value.forEach(renameRecruiters);
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'recruiter' && child && typeof child === 'object' && 'name' in child) child.name = `Recruiter ${child.id}`;
      renameRecruiters(child);
    }
  }
};

const files = readdirSync(dir).filter(f => !f.startsWith('.') && statSync(join(dir, f)).isFile());
const texts = new Map(files.map(f => [f, readFileSync(join(dir, f), 'utf8')]));
const userIds = findUserIds(texts.values());
const userNames = findUserNames(texts.values());
const candidateIds = findCandidateIds(texts.values());
const profileHashes = findProfileHashes(texts.values());
const initials = findInitials(texts.values());
const headlines = findHeadlines(texts.values());

let changed = 0;
for (const [file, before] of texts) {
  const path = join(dir, file);
  let after = before;
  for (const [pattern, replacement] of RULES) after = after.replace(pattern, replacement);
  for (const id of userIds) after = after.replace(new RegExp(`(?<!\\d)${id}(?!\\d)`, 'g'), USER_ID);
  for (const id of candidateIds) after = after.replace(new RegExp(`(?<!\\d)${id}(?!\\d)`, 'g'), CANDIDATE_ID);
  for (const hash of profileHashes) after = after.replace(new RegExp(`(?<![0-9a-f])${hash}(?![0-9a-f])`, 'g'), PROFILE_HASH);
  for (const headline of headlines) after = after.replaceAll(headline, HEADLINE);
  for (const name of userNames) after = replaceName(after, name);
  after = setUserNameElements(after);
  for (const value of initials) after = after.replaceAll(`data-initials="${value}"`, `data-initials="${INITIALS}"`);
  if (/^api_.*\.json$/.test(file)) {
    const data = JSON.parse(after);
    renameRecruiters(data);
    after = JSON.stringify(data, null, 2) + (after.endsWith('\n') ? '\n' : '');
  }
  if (after !== before) {
    writeFileSync(path, after);
    changed++;
    console.log(`sanitized ${file}`);
  }
}
console.log(`${changed} file(s) changed`);
