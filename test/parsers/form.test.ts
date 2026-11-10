import { describe, expect, test } from 'vitest';
import { serializeForm } from '../../src/parsers/form.ts';
import { fixture } from '../helpers.ts';

const form = (inner: string, attrs = 'id="f"') => `<html><body><form ${attrs}>${inner}</form></body></html>`;

describe('serializeForm on the profile page', () => {
  const fields = serializeForm(fixture('my_profile.html'), '#js-profile-form');
  const names = fields.map(([name]) => name);
  const values = (name: string) => fields.filter(([n]) => n === name).map(([, v]) => v);

  test('returns the fields of the profile form in the order of the page', () => {
    expect(names.slice(0, 6)).toEqual(['position', 'primary_keyword_cache', '_tms_primary_keyword', 'primary_keyword_suggestion', 'suggestion_action', 'salary_min']);
    expect(names.slice(-4)).toEqual(['lang_communicate', 'lang_communicate', 'preferred_comm', 'csrfmiddlewaretoken']);
    expect(fields).toHaveLength(51);
  });

  test('gives the text, number, hidden and textarea values', () => {
    expect(values('position')).toEqual(['REDACTED_position']);
    expect(values('salary_min')).toEqual(['3500']);
    expect(values('_tms_primary_keyword')).toEqual(['ML AI']);
    expect(values('suggestion_action')).toEqual(['MANUAL']);
    expect(values('moreinfo')).toEqual(['REDACTED_moreinfo']);
    expect(values('highlights')).toEqual(['REDACTED_highlights']);
    expect(values('looking_for')).toEqual(['REDACTED_looking_for']);
    expect(values('location')).toEqual(['']);
    expect(values('csrfmiddlewaretoken')).toEqual(['CSRF_TOKEN']);
  });

  test('gives an empty value for a number input whose value is not a number', () => {
    // The page renders the empty hourly rate as "None". A browser sends it as an empty value.
    expect(values('salary_hour')).toEqual(['']);
  });

  test('gives the selected option of each select', () => {
    expect(values('primary_keyword_cache')).toEqual(['ML AI']);
    expect(values('experience_years')).toEqual(['10']);
    expect(values('language_knowledge[0][code]')).toEqual(['eng']);
    expect(values('language_knowledge[0][level]')).toEqual(['B2']);
    expect(values('language_knowledge[1][code]')).toEqual(['ukr']);
    expect(values('language_knowledge[1][level]')).toEqual(['native']);
    expect(values('country_code')).toEqual(['UKR']);
    expect(values('preferred_comm')).toEqual(['djinni']);
  });

  test('gives only the checked checkboxes', () => {
    expect(values('format_options')).toEqual(['remote']);
    expect(values('employment_options')).toEqual(['parttime']);
    expect(values('lang_communicate')).toEqual(['uk', 'en']);
    expect(names).not.toContain('domain_zones');
    expect(names).not.toContain('uninterested_company_types');
    expect(names).not.toContain('is_defender');
    expect(names).not.toContain('has_mobilization_deferment');
  });

  test('gives the rows of the skills, the domains and the certifications', () => {
    expect(fields.filter(([n]) => n.startsWith('skills_experience[')).slice(0, 4)).toEqual([
      ['skills_experience[0][skill]', 'CRM'],
      ['skills_experience[0][experience_years]', ''],
      ['skills_experience[1][skill]', 'Zapier'],
      ['skills_experience[1][experience_years]', ''],
    ]);
    expect(names.filter(n => n.startsWith('skills_experience['))).toHaveLength(24);
    expect(values('domain_experience[0][domain]')).toEqual(['']);
    expect(values('certifications[0][name]')).toEqual(['']);
  });

  test('leaves out the unchecked radios, the disabled select, the inputs without a name and the buttons', () => {
    expect(names).not.toContain('__tms__tms_primary_keyword');
    expect(names.every(n => n !== '')).toBe(true);
    expect(fields.every(([, v]) => typeof v === 'string')).toBe(true);
  });

  test('throws when the page has no form for the selector', () => {
    expect(() => serializeForm(fixture('my_profile.html'), '#nope')).toThrow('The page has no form for the selector "#nope".');
  });
});

describe('serializeForm on the raw profile page from the server', () => {
  // The raw HTML has no input for the category widget. Its JavaScript adds the hidden input in the browser.
  const raw = serializeForm(fixture('my_profile_raw.html'), '#js-profile-form');

  test('adds the category widget field with the selected key, once, at the place of the widget', () => {
    expect(raw.filter(([n]) => n === '_tms_primary_keyword')).toEqual([['_tms_primary_keyword', 'ML AI']]);
    expect(raw.map(([n]) => n).slice(0, 4)).toEqual(['position', 'primary_keyword_cache', '_tms_primary_keyword', 'primary_keyword_suggestion']);
  });

  test('gives the same fields as the page after JavaScript', () => {
    expect(raw).toEqual(serializeForm(fixture('my_profile.html'), '#js-profile-form'));
  });
});

const tree = (attrs: string, selected: string[]) =>
  `<div data-tree-multiselect ${attrs}><script type="application/json" class="tms-data">${JSON.stringify({ groups: [], selected, excluded: [] })}</script></div>`;

describe('serializeForm tree widgets', () => {
  test('gives one field for a single widget', () => {
    const html = form(`<input name="a" value="1">${tree('data-name="_tms_k" data-mode="single"', ['ML AI'])}<input name="b" value="2">`);

    expect(serializeForm(html, '#f')).toEqual([['a', '1'], ['_tms_k', 'ML AI'], ['b', '2']]);
  });

  test('gives one comma-joined field for a multi widget with the comma value format', () => {
    const html = form(tree('data-name="t" data-mode="multi" data-value-format="comma"', ['Python', 'Go']));

    expect(serializeForm(html, '#f')).toEqual([['t', 'Python,Go']]);
  });

  test('gives one field for each value of a multi widget', () => {
    const html = form(tree('data-name="t" data-mode="multi"', ['Python', 'Go']));

    expect(serializeForm(html, '#f')).toEqual([['t', 'Python'], ['t', 'Go']]);
  });

  test('gives nothing for a widget without a selected value', () => {
    expect(serializeForm(form(tree('data-name="t" data-mode="single"', [])), '#f')).toEqual([]);
  });

  test('adds no field when the form already has an input with the widget name', () => {
    const html = form(`${tree('data-name="t" data-mode="single"', ['A'])}<input type="hidden" name="t" value="A">`);

    expect(serializeForm(html, '#f')).toEqual([['t', 'A']]);
  });

  test('adds no field for a widget outside the form', () => {
    const html = `${tree('data-name="t" data-mode="single"', ['A'])}${form('<input name="a" value="1">')}`;

    expect(serializeForm(html, '#f')).toEqual([['a', '1']]);
  });
});

describe('serializeForm rules', () => {
  test('gives only the last checked radio of a group with the same name', () => {
    const html = form('<input type="radio" name="r" value="1" checked><input name="x" value="x"><input type="radio" name="r" value="2" checked>');

    expect(serializeForm(html, '#f')).toEqual([['x', 'x'], ['r', '2']]);
  });

  test('gives nothing for a list box select without a selected option', () => {
    const html = form('<select name="s" size="3"><option value="a">A</option></select><select name="t" size="1"><option value="b">B</option></select>');

    expect(serializeForm(html, '#f')).toEqual([['t', 'b']]);
  });

  test('gives the selected option of a list box select', () => {
    const html = form('<select name="s" size="3"><option value="a">A</option><option value="b" selected>B</option></select>');

    expect(serializeForm(html, '#f')).toEqual([['s', 'b']]);
  });

  test('gives the first option of a select without a selected option', () => {
    const html = form('<select name="s"><option value="a">A</option><option value="b">B</option></select>');

    expect(serializeForm(html, '#f')).toEqual([['s', 'a']]);
  });

  test('uses the option text when an option has no value attribute', () => {
    const html = form('<select name="s"><option>  First\n option </option></select>');

    expect(serializeForm(html, '#f')).toEqual([['s', 'First option']]);
  });

  test('gives each selected option of a multiple select, and nothing when none is selected', () => {
    const html = form(
      '<select name="m" multiple><option value="a" selected>A</option><option value="b">B</option><option value="c" selected>C</option></select>' +
        '<select name="n" multiple><option value="x">X</option></select>',
    );

    expect(serializeForm(html, '#f')).toEqual([['m', 'a'], ['m', 'c']]);
  });

  test('gives the checked radio and "on" for a checkbox without a value', () => {
    const html = form(
      '<input type="radio" name="r" value="1"><input type="radio" name="r" value="2" checked><input type="checkbox" name="c" checked>',
    );

    expect(serializeForm(html, '#f')).toEqual([['r', '2'], ['c', 'on']]);
  });

  test('leaves out the disabled fields, the fields in a disabled fieldset, the buttons and the file inputs', () => {
    const html = form(
      '<input name="a" value="1" disabled><fieldset disabled><input name="b" value="2"></fieldset>' +
        '<button name="go" value="x">Go</button><input type="submit" name="s" value="Send"><input type="reset" name="r">' +
        '<input type="image" name="i"><input type="button" name="bb" value="b"><input type="file" name="cv">' +
        '<select name="d"><option value="x" disabled>X</option><option value="y">Y</option></select>' +
        '<select name="ds"><option value="x" disabled selected>X</option><option value="y">Y</option></select><input name="ok" value="3">',
    );

    expect(serializeForm(html, '#f')).toEqual([['d', 'y'], ['ok', '3']]);
  });

  test('gives the textarea text with CRLF line breaks, as a browser sends it', () => {
    const html = form('<textarea name="t">\nline 1\nline 2\r\nline 3</textarea>');

    expect(serializeForm(html, '#f')).toEqual([['t', 'line 1\r\nline 2\r\nline 3']]);
  });

  test('removes the line breaks from a text input value and keeps the valid numbers', () => {
    const html = form('<input name="t" value="a&#10;b"><input type="number" name="n" value="-1.5"><input type="number" name="e" value="1e3">');

    expect(serializeForm(html, '#f')).toEqual([['t', 'ab'], ['n', '-1.5'], ['e', '1e3']]);
  });

  test('includes a field outside the form that names the form with the form attribute', () => {
    const html = `<input name="before" value="0" form="f">${form('<input name="in" value="1">')}<input name="after" value="2" form="f"><input name="other" value="3">`;

    expect(serializeForm(html, '#f')).toEqual([['before', '0'], ['in', '1'], ['after', '2']]);
  });

  test('leaves out a field inside the form that names another form', () => {
    const html = form('<input name="in" value="1"><input name="away" value="2" form="g">');

    expect(serializeForm(html, '#f')).toEqual([['in', '1']]);
  });
});
