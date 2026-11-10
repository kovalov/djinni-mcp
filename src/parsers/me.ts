import * as cheerio from 'cheerio';

export type Whoami = { candidateId: string; headline: string; publicProfilePath: string | null };

export const cleanText = (s: string) => s.replace(/\s+/g, ' ').trim();

// Reads the identity of the logged-in candidate from any /my/ page.
export function parseWhoami(html: string): Whoami | null {
  const $ = cheerio.load(html);
  const candidateId = $('[data-candidate-id]').first().attr('data-candidate-id');
  if (!candidateId) return null;
  const h1 = $('h1').first().clone();
  h1.find('span').remove();
  return {
    candidateId,
    headline: cleanText(h1.text()),
    publicProfilePath: $('a[href^="/q/"]').first().attr('href') ?? null,
  };
}
