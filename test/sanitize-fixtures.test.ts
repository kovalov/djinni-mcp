import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'sanitize-fixtures.mjs');

// Writes the files to a new folder, runs the sanitizer on that folder and returns the new texts.
function sanitize(files: Record<string, string>): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'djinni-fixtures-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  execFileSync(process.execPath, [SCRIPT, dir], { stdio: 'pipe' });
  return Object.fromEntries(Object.keys(files).map(name => [name, readFileSync(join(dir, name), 'utf8')]));
}

const header = (name: string) => `<div class="user-name">\n        ${name}\n      </div>`;

describe('the fixture sanitizer replaces the user name', () => {
  test('replaces the name from the user-name block in every fixture', () => {
    const out = sanitize({
      'a.html': `${header('Ivan Petrenko')}<p>Hello, Ivan Petrenko</p>`,
      'b.html': '<p>Ivan Petrenko wrote</p>',
    });

    expect(out['a.html']).toBe(`${header('Test User')}<p>Hello, Test User</p>`);
    expect(out['b.html']).toBe('<p>Test User wrote</p>');
  });

  test('replaces the parts of the name, the upper case forms and the forms with underscores', () => {
    const out = sanitize({
      'a.html': header('Ivan Petrenko'),
      'b.html': '<p>Ivan, PETRENKO, IVAN PETRENKO, Ivan_Petrenko, IVAN_PETRENKO, Ivanka</p>',
    });

    expect(out['b.html']).toBe('<p>Test, USER, TEST USER, Test_User, TEST_USER, Ivanka</p>');
  });

  test('replaces the name in a data-cv-name attribute', () => {
    const out = sanitize({
      'a.html': header('Ivan Petrenko'),
      'b.html': '<input data-cv-name="Ivan_Petrenko - RevOps - CV.pdf"><input data-cv-name="CV Ivan Petrenko.pdf">',
    });

    expect(out['b.html']).toBe('<input data-cv-name="Test_User - RevOps - CV.pdf"><input data-cv-name="CV Test User.pdf">');
  });

  test('puts "Test User" into a user-name block with a placeholder and keeps the placeholders in other places', () => {
    const out = sanitize({ 'a.html': `${header('Test User')}${header('REDACTED')}<div class="user-name">TEXT_3</div><p>Test, REDACTED, TEXT_3</p>` });

    expect(out['a.html']).toBe(`${header('Test User')}${header('Test User')}<div class="user-name">Test User</div><p>Test, REDACTED, TEXT_3</p>`);
  });

  test('replaces the name in any element with the user-name class', () => {
    const out = sanitize({ 'a.html': '<span class="d-none user-name">Ivan Petrenko</span><p>Ivan Petrenko</p>' });

    expect(out['a.html']).toBe('<span class="d-none user-name">Test User</span><p>Test User</p>');
  });
});

describe('the fixture sanitizer replaces the logged-in candidate', () => {
  const page = [
    `<script>_paq.push(['setUserId', '999999']); _paq.push(['setCustomDimension', 2, 'https://djinni.co/q/abcdef1234/']);</script>`,
    '<a class="profile-head-view-public" href="/q/abcdef1234/" target="_blank">x</a>',
    '<div id="candidate-inbox-ws" data-ws-url="/ws/candidate/inbox/" data-candidate-id="999999"></div>',
  ].join('');

  test('finds the candidate ID and the own profile hash in the pages and replaces them in every fixture', () => {
    const out = sanitize({
      'a.html': page,
      'b.html': '<a hx-get="/api/jobs/1/?apply_stats&amp;candidate_id=999999" data-candidate-id="999999">x</a><script>{"candidate_id": 999999}</script>',
      'c.html': `<script>var d = { profileUrl: "https://djinni.co/q/abcdef1234/", 'url': 'http://djinni.co/q/abcdef1234' }</script>`,
    });

    expect(out['a.html']).toBe(page.replace(/999999/g, '100001').replace(/abcdef1234/g, '0000000000'));
    expect(out['b.html']).toBe('<a hx-get="/api/jobs/1/?apply_stats&amp;candidate_id=100001" data-candidate-id="100001">x</a><script>{"candidate_id": 100001}</script>');
    expect(out['c.html']).toBe(`<script>var d = { profileUrl: "https://djinni.co/q/0000000000/", 'url': 'http://djinni.co/q/0000000000' }</script>`);
  });

  test('keeps the hashes and the IDs of other candidates', () => {
    const other = '<a href="/q/a49535fea6/">Other</a><script>{"profileCandidateId": 555555}</script>';

    const out = sanitize({ 'a.html': page, 'b.html': other });

    expect(out['b.html']).toBe(other);
  });
});

describe('the fixture sanitizer replaces the unsubscribe token', () => {
  test('replaces the token of every /unsubscribe/<token>/ path with 32 zeros', () => {
    const out = sanitize({ 'a.html': '<a href="/unsubscribe/abcdefabcdefabcdefabcdefabcdefab/">x</a><a href="https://djinni.co/unsubscribe/AbC-12_x/">y</a>' });

    expect(out['a.html']).toBe(`<a href="/unsubscribe/${'0'.repeat(32)}/">x</a><a href="https://djinni.co/unsubscribe/${'0'.repeat(32)}/">y</a>`);
  });
});

describe('the fixture sanitizer replaces the recruiter names', () => {
  test('replaces the text of a recruiter link', () => {
    const out = sanitize({ 'a.html': '<a href="/r/123-hr-at-acme/" target="_blank">Ivan Petrenko</a>' });

    expect(out['a.html']).toBe('<a href="/r/123-hr-at-acme/" target="_blank">Recruiter 123</a>');
  });

  test('replaces the text in the child elements of a recruiter link and keeps the elements', () => {
    const out = sanitize({ 'a.html': '<a href="https://djinni.co/r/123-hr/"><img src="a.png" alt="">\n  <span class="name">Ivan Petrenko</span>\n</a><p>after</p>' });

    expect(out['a.html']).toBe('<a href="https://djinni.co/r/123-hr/"><img src="a.png" alt="">\n  <span class="name">Recruiter 123</span>\n</a><p>after</p>');
  });
});

describe('the fixture sanitizer replaces the initials of the logged-in user', () => {
  const avatar = (id: string, initials: string) => `<div id="${id}" class="userpic-wrapper userpic_sm" data-initials="${initials}" style="x">\n</div>`;

  test('finds the initials in the navigation avatar and replaces them with TU in every fixture', () => {
    const out = sanitize({
      'a.html': avatar('navbar-profile-picture-component', 'IP') + avatar('', 'IP') + avatar('', 'OK'),
      'b.html': avatar('profile-picture-component', 'IP') + '<p data-initials="IP">IP</p>',
    });

    expect(out['a.html']).toBe(avatar('navbar-profile-picture-component', 'TU') + avatar('', 'TU') + avatar('', 'OK'));
    expect(out['b.html']).toBe(avatar('profile-picture-component', 'TU') + '<p data-initials="TU">IP</p>');
  });

  test('keeps the initials of other people when no navigation avatar has them', () => {
    const files = { 'a.html': avatar('navbar-profile-picture-component', 'TU') + avatar('', 'OK') };

    expect(sanitize(files)).toEqual(files);
  });
});

describe('the fixture sanitizer replaces the text of the rich text editors', () => {
  // The page shows the text of a textarea also in a CKEditor element. The capture script redacts only the textarea.
  const editor = (inner: string) => `<div class="ck ck-content ck-editor__editable" role="textbox" contenteditable="true">${inner}</div></div>`;

  test('replaces the content of every contenteditable element with one REDACTED paragraph', () => {
    const out = sanitize({ 'a.html': editor('<ul><li><span>Built 50 automations.</span></li></ul><p>Ivan</p>') + '<p>after</p>' });

    expect(out['a.html']).toBe(editor('<p>REDACTED</p>') + '<p>after</p>');
  });

  test('keeps a contenteditable element that holds only the placeholder', () => {
    const files = { 'a.html': editor('<p>REDACTED</p>') };

    expect(sanitize(files)).toEqual(files);
  });
});

describe('the fixture sanitizer replaces the headline of the logged-in user', () => {
  const head = (headline: string) => `<header class="profile-head st-active">\n  <div class="mb-2">\n    <h1>${headline} \n  <span class="badge">x</span></h1>`;

  test('finds the headline in the profile header and replaces it with "Test Position" in every fixture', () => {
    const out = sanitize({
      'a.html': head('RevOps Lead / Sales Analyst'),
      'b.html': '<h2><a href="/q/0000000000/">\n  RevOps Lead / Sales Analyst\n</a></h2>',
    });

    expect(out['a.html']).toBe(head('Test Position'));
    expect(out['b.html']).toBe('<h2><a href="/q/0000000000/">\n  Test Position\n</a></h2>');
  });

  test('keeps the headlines of other pages when no profile header has them', () => {
    const files = { 'a.html': head('Test Position'), 'b.html': '<h1>Python Developer</h1>' };

    expect(sanitize(files)).toEqual(files);
  });
});
