import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';

// The form of contacts and CV files on /my/account/.
export const ACCOUNT_FORM = '#edit_contacts';

// A CV file in the profile, from /my/account/. djinni shows the "set as default" action only for a CV that is not the default CV.
export type ProfileCv = { id: string; name: string; isDefault: boolean; uploaded: string | null };
// A CV file from the list of all uploaded CV files on /my/resume/. "sharedLinks" is the number of links that were sent to recruiters.
export type UploadedCv = { id: string; name: string; uploaded: string | null; sharedLinks: number };
export type ResumePage = { cvs: UploadedCv[]; nextPage: number | null };

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
// djinni shows the date of a CV with a label ("Завантажено:" or "Оновлено:") or without a label.
const UPLOADED_PREFIX = /^(?:Завантажено|Оновлено|Uploaded|Updated):\s*/i;

// Removes the label and the file size ("• 0.1 MB") from the upload text. Returns null for an empty text.
function uploadedText(text: string): string | null {
  const value = collapse(text).split('•')[0]!.replace(UPLOADED_PREFIX, '').trim();
  return value === '' ? null : value;
}

const idOf = (elementId: string | undefined, prefix: string): string | null => {
  const m = new RegExp(`^${prefix}(\\d+)$`).exec(elementId ?? '');
  return m ? m[1]! : null;
};

export function parseProfileCvs($: cheerio.CheerioAPI): ProfileCv[] {
  const cvs: ProfileCv[] = [];
  $('#uploaded_cv_list [id^="uploaded_cv_"]').each((_, el) => {
    const id = idOf(el.attribs['id'], 'uploaded_cv_');
    if (!id) return;
    const card = $(el);
    cvs.push({
      id,
      name: collapse(card.find(`#cv_rename_${id} a`).first().text()),
      isDefault: card.find('[hx-post^="/ajax/cv_set_default/"]').length === 0,
      uploaded: uploadedText(card.find('.form-text small').first().text()),
    });
  });
  return cvs;
}

// The upload text of a row on /my/resume/ is the text after the upload icon, up to the next element.
function rowUploaded($: cheerio.CheerioAPI, row: cheerio.Cheerio<AnyNode>): string | null {
  const icon = row.find('use[href$="#upload"]').first().closest('svg').get(0);
  if (!icon) return null;
  let text = '';
  for (let node = icon.nextSibling; node && node.type === 'text'; node = node.nextSibling) text += $(node).text();
  return uploadedText(text);
}

export function parseResumePage(html: string): ResumePage {
  const $ = cheerio.load(html);
  const cvs: UploadedCv[] = [];
  $('[id^="cv_file_row_"]').each((_, el) => {
    const id = idOf(el.attribs['id'], 'cv_file_row_');
    if (!id) return;
    const row = $(el);
    cvs.push({
      id,
      name: collapse(row.find(`#cv_rename_${id} a`).first().text()),
      uploaded: rowUploaded($, row),
      sharedLinks: row.find('[id^="cv_shared_row_"]').length,
    });
  });
  const next = /[?&]page=(\d+)/.exec($('.pagination.justify-content-end a[href]').first().attr('href') ?? '');
  return { cvs, nextPage: next ? Number(next[1]) : null };
}
