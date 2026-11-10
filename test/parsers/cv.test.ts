import * as cheerio from 'cheerio';
import { describe, expect, test } from 'vitest';
import { parseProfileCvs, parseResumePage } from '../../src/parsers/cv.ts';
import { fixture } from '../helpers.ts';

const ACCOUNT = fixture('my_account_raw.html');
const RESUME = fixture('my_resume_raw.html');

describe('parseProfileCvs', () => {
  test('returns the CV files in the profile from the account page', () => {
    expect(parseProfileCvs(cheerio.load(ACCOUNT))).toEqual([{ id: '2705342', name: 'TEXT_1', isDefault: false, uploaded: 'TEXT_2' }]);
  });

  test('marks a CV without the "set as default" action as the default CV', () => {
    const $ = cheerio.load(ACCOUNT);
    $('[hx-post^="/ajax/cv_set_default/"]').remove();

    expect(parseProfileCvs($)[0]!.isDefault).toBe(true);
  });

  test('removes the "Завантажено:" prefix from the upload date', () => {
    const $ = cheerio.load(ACCOUNT);
    $('#uploaded_cv_2705342 .form-text small').text('Завантажено: 29 вересня 2026');

    expect(parseProfileCvs($)[0]!.uploaded).toBe('29 вересня 2026');
  });

  test.each([['Оновлено: 25 липня 2025'], ['Updated: 25 липня 2025'], ['Uploaded: 25 липня 2025']])(
    'removes the date label from the date text %j',
    text => {
      const $ = cheerio.load(ACCOUNT);
      $('#uploaded_cv_2705342 .form-text small').text(text);

      expect(parseProfileCvs($)[0]!.uploaded).toBe('25 липня 2025');
    },
  );

  test('returns an empty list for a profile without CV files', () => {
    const $ = cheerio.load(ACCOUNT);
    $('[id^="uploaded_cv_2"]').remove();

    expect(parseProfileCvs($)).toEqual([]);
  });
});

describe('parseResumePage', () => {
  const page = parseResumePage(RESUME);

  test('returns each CV file of the page with its name, upload date and number of shared links', () => {
    expect(page.cvs).toHaveLength(10);
    expect(page.cvs[0]).toEqual({ id: '2766722', name: 'TEXT_5', uploaded: 'TEXT_6', sharedLinks: 1 });
    expect(page.cvs.find(c => c.id === '2705342')).toEqual({ id: '2705342', name: 'TEXT_135', uploaded: 'TEXT_136', sharedLinks: expect.any(Number) });
  });

  test('counts all shared links of a CV file', () => {
    const $ = cheerio.load(RESUME);
    const row = $('#cv_file_row_2766722');
    row.find('[id^="cv_shared_row_"]').first().after('<div id="cv_shared_row_1" class="row"></div><div id="cv_shared_row_2" class="row"></div>');

    expect(parseResumePage($.html()).cvs[0]!.sharedLinks).toBe(3);
  });

  test('takes the upload date without the prefix and without the file size', () => {
    const html = RESUME.replace('TEXT_6<svg', '\n Завантажено: 10:31 06.11.26\n    \n        • 0.1 MB\n      <svg');

    expect(parseResumePage(html).cvs[0]!.uploaded).toBe('10:31 06.11.26');
  });

  test('returns the number of the next page', () => {
    expect(page.nextPage).toBe(2);
  });

  test('returns no next page on the last page', () => {
    const $ = cheerio.load(RESUME);
    $('.pagination.justify-content-end').empty();

    expect(parseResumePage($.html()).nextPage).toBeNull();
  });
});
