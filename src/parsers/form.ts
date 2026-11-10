import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import type { FormField } from '../http.ts';

// The input types that a browser never puts in the form data of a normal submit.
const SKIPPED_INPUT_TYPES = new Set(['submit', 'reset', 'button', 'image', 'file']);
// The input types whose value cannot hold line breaks.
const SINGLE_LINE_TYPES = new Set(['text', 'search', 'tel', 'url', 'email', 'password']);
// A valid floating-point number of HTML. Other values of a number input become empty.
const HTML_NUMBER = /^-?(\d+(\.\d+)?|\.\d+)([eE][-+]?\d+)?$/;

// A tree select widget of djinni. Its JavaScript adds the input in the browser, so the raw HTML has only the widget.
// The widget keeps the selected values in a JSON script. "data-name" is the name of the field.
export const TREE_WIDGET = '[data-tree-multiselect][data-name]';
const TREE_DATA = 'script.tms-data';

const CONTROL_TAGS = new Set(['input', 'select', 'textarea']);
const isRadio = (el: Element) => el.tagName === 'input' && (el.attribs['type'] ?? '').toLowerCase() === 'radio';

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
const toCrlf = (s: string) => s.replace(/\r\n|\r|\n/g, '\r\n');

// Returns the fields of the form that the selector finds, as a browser submits them:
// the text, number, hidden and textarea values, only the checked checkboxes and radios,
// the selected options of each select (the first option when a drop-down select has no selected option),
// the field of each tree widget that the page JavaScript adds (see TREE_WIDGET),
// only the last checked radio of a group,
// and no disabled fields, no buttons and no file inputs. The fields keep the order of the page.
// A field outside the form counts when its form attribute names the ID of the form.
// The page can be HTML or a page that cheerio already loaded, for example a page with changed fields.
export function serializeForm(page: string | cheerio.CheerioAPI, selector: string): FormField[] {
  const $ = typeof page === 'string' ? cheerio.load(page) : page;
  const form = $(selector).filter('form').first();
  if (form.length === 0) throw new Error(`The page has no form for the selector "${selector}".`);
  const formEl = form.get(0)!;
  const formId = form.attr('id');

  const owner = (el: Element): boolean => {
    const attr = $(el).attr('form');
    if (attr !== undefined) return attr === formId;
    return $(el).closest('form').get(0) === formEl;
  };

  const controls = $('input, select, textarea').toArray().filter(owner);
  const names = new Set(controls.map(el => el.attribs['name']).filter(n => n));
  // A browser keeps only the last checked radio of a group with the same name.
  const checkedRadio = new Map<string, Element>();
  for (const el of controls) {
    if (isRadio(el) && el.attribs['checked'] !== undefined && el.attribs['name']) checkedRadio.set(el.attribs['name'], el);
  }

  const fields: FormField[] = [];
  $(`input, select, textarea, ${TREE_WIDGET}`).each((_, el) => {
    if (!owner(el) || isDisabled($, el)) return;
    if (!CONTROL_TAGS.has(el.tagName)) {
      const name = el.attribs['data-name']!;
      // After JavaScript, the page has an input for the widget. Then the input gives the field.
      if (!names.has(name)) fields.push(...treeFields($, el).map(v => [name, v] as FormField));
      return;
    }
    const control = $(el);
    const name = control.attr('name');
    if (!name) return;
    if (el.tagName === 'select') {
      for (const value of selectedValues($, el)) fields.push([name, value]);
      return;
    }
    if (el.tagName === 'textarea') {
      fields.push([name, toCrlf(control.text())]);
      return;
    }
    const type = (control.attr('type') ?? 'text').toLowerCase();
    if (SKIPPED_INPUT_TYPES.has(type)) return;
    if (type === 'radio') {
      if (checkedRadio.get(name) === el) fields.push([name, control.attr('value') ?? 'on']);
      return;
    }
    if (type === 'checkbox') {
      if (control.attr('checked') !== undefined) fields.push([name, control.attr('value') ?? 'on']);
      return;
    }
    const value = control.attr('value') ?? '';
    if (type === 'number') fields.push([name, HTML_NUMBER.test(value.trim()) ? value.trim() : '']);
    else if (SINGLE_LINE_TYPES.has(type)) fields.push([name, value.replace(/[\r\n]/g, '')]);
    else fields.push([name, value]);
  });
  return fields;
}

// Reads the "selected" list of the JSON script of a tree widget. Returns an empty list when the JSON is not valid.
export function treeSelection($: cheerio.CheerioAPI, widget: Element): string[] {
  try {
    const data = JSON.parse($(widget).children(TREE_DATA).first().text() || '{}') as { selected?: unknown };
    return Array.isArray(data.selected) ? data.selected.map(String) : [];
  } catch {
    return [];
  }
}

// Writes the "selected" list of the JSON script of a tree widget. The other keys of the JSON stay the same.
export function setTreeSelection($: cheerio.CheerioAPI, widget: Element, values: string[]): void {
  const script = $(widget).children(TREE_DATA).first();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(script.text() || '{}') as Record<string, unknown>;
  } catch {
    data = {};
  }
  script.text(JSON.stringify({ ...data, selected: values }));
}

// The fields of a tree widget, as its JavaScript makes them: one value for data-mode="single",
// one comma-joined value for data-mode="multi" with data-value-format="comma", else one field for each value.
function treeFields($: cheerio.CheerioAPI, widget: Element): string[] {
  const selected = treeSelection($, widget);
  if (selected.length === 0) return [];
  if (widget.attribs['data-mode'] !== 'multi') return [selected.at(-1)!];
  return widget.attribs['data-value-format'] === 'comma' ? [selected.join(',')] : selected;
}

// A field is disabled by its own attribute, or by a disabled fieldset around it when it is not in the first legend of that fieldset.
function isDisabled($: cheerio.CheerioAPI, el: Element): boolean {
  if ($(el).attr('disabled') !== undefined) return true;
  return $(el)
    .parents('fieldset[disabled]')
    .toArray()
    .some(fieldset => {
      const legend = $(fieldset).children('legend').first().get(0);
      return !legend || !$(el).parents().toArray().includes(legend as AnyNode as Element);
    });
}

const optionValue = ($: cheerio.CheerioAPI, option: Element) => option.attribs['value'] ?? collapse($(option).text());

// A browser selects the options with the selected attribute, but it does not submit a disabled option.
function selectedValues($: cheerio.CheerioAPI, select: Element): string[] {
  const options = $(select).find('option').toArray();
  const enabled = (o: Element) => $(o).attr('disabled') === undefined && $(o).closest('optgroup[disabled]').length === 0;
  const selected = options.filter(o => $(o).attr('selected') !== undefined);
  // A single select shows the last selected option. A drop-down select without a selected option shows the first enabled option.
  // A list box (size > 1) without a selected option shows none.
  const listBox = Number($(select).attr('size') ?? '1') > 1;
  const shown =
    $(select).attr('multiple') !== undefined ? selected : [selected.at(-1) ?? (listBox ? undefined : options.find(enabled))].filter(o => o !== undefined);
  return shown.filter(enabled).map(o => optionValue($, o));
}
