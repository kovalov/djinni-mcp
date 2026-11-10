import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import { DJINNI_URL } from '../http.ts';
import { htmlToText } from './jobs.ts';
import { cleanText } from './me.ts';

// One conversation in the inbox list of /my/inbox/.
// "label" is the company or the recruiter. "unread" is null when the list does not tell whether the thread is unread.
export type InboxThreadSummary = {
  id: string;
  url: string;
  label: string;
  jobTitle: string | null;
  preview: string;
  date: string;
  unread: boolean | null;
};

// "candidate" is a message of the user. "recruiter" is a message of the other side.
export type InboxMessage = { id: string; side: 'candidate' | 'recruiter'; author: string; date: string; text: string };

export const threadUrl = (id: string) => `${DJINNI_URL}/my/inbox/${id}/`;

// The parts of an element without the dot separators, joined with " · ". For example "Company · Recruiter".
function dotted($: cheerio.CheerioAPI, el: cheerio.Cheerio<Element>): string {
  return el
    .contents()
    .toArray()
    .filter(node => !(node.type === 'tag' && $(node).hasClass('dot')))
    .map(node => cleanText($(node).text()))
    .filter(text => text !== '')
    .join(' · ');
}

// The date text with a space before the unit, for example "3 дні".
function dateText($: cheerio.CheerioAPI, el: cheerio.Cheerio<Element>): string {
  const copy = el.clone();
  copy.find('.js-unit').each((_, unit) => {
    $(unit).replaceWith(` ${$(unit).text()}`);
  });
  return cleanText(copy.text());
}

const THREAD_ID = /^mt-(\d+)$/;

// Reads the threads of an inbox page. The order is the order of the page.
export function parseInboxList(html: string): InboxThreadSummary[] {
  const $ = cheerio.load(html);
  return $('div.proposal.js-proposal')
    .toArray()
    .flatMap(el => {
      const id = THREAD_ID.exec($(el).attr('id') ?? '')?.[1];
      if (!id) return [];
      const item = $(el);
      const company = item.find('.company_name a').first();
      const job = item.find('.job_title a').first();
      return [
        {
          id,
          url: threadUrl(id),
          label: company.length ? dotted($, company) : '',
          jobTitle: job.length ? dotted($, job) || null : null,
          preview: cleanText(item.find('.main .message-text-inner').first().text()),
          date: dateText($, item.find('.date .js-date-value').first()),
          unread: null,
        },
      ];
    });
}

// A userpic is the same for all messages of one person: the color, the initials and the photo.
function userpicKey($: cheerio.CheerioAPI, el: cheerio.Cheerio<Element>): string | null {
  if (el.length === 0) return null;
  const color = (el.attr('class') ?? '').split(/\s+/).find(c => c.startsWith('userpic-color')) ?? '';
  return [color, el.attr('data-initials') ?? '', el.find('img').attr('src') ?? ''].join('|');
}

const MESSAGE_ID = /^msg_(\d+)$/;

// Reads the messages of a thread page in the order of the page.
// A message with the userpic of the logged-in user (the navbar userpic) is a message of the candidate.
export function parseInboxThread(html: string): InboxMessage[] {
  const $ = cheerio.load(html);
  const me = userpicKey($, $('#navbar-profile-picture-component').first());
  return $('.thread-messages-list .thread-message')
    .toArray()
    .flatMap(el => {
      const id = MESSAGE_ID.exec($(el).attr('id') ?? '')?.[1];
      if (!id) return [];
      const msg = $(el);
      const head = msg.children('.row').first();
      const text = msg
        .find('.chat .thread-message-body')
        .toArray()
        .map(body => htmlToText($(body).html() ?? ''))
        .filter(t => t !== '')
        .join('\n\n');
      const side: InboxMessage['side'] = me !== null && userpicKey($, head.find('.userpic-wrapper').first()) === me ? 'candidate' : 'recruiter';
      return [{ id, side, author: cleanText(head.find('.font-weight-500').first().text()), date: dateText($, head.find('small').first()), text }];
    });
}

// True when the pagination of an inbox page has a link to the given page.
export function hasInboxPage(html: string, page: number): boolean {
  const $ = cheerio.load(html);
  return $('.pagination a[href]')
    .toArray()
    .some(a => new URLSearchParams(($(a).attr('href') ?? '').split('?')[1] ?? '').get('page') === String(page));
}
