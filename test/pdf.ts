import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

type Page = { text: string; links: string[] };

// Reads the text and the link targets of each page of a PDF with pdf.js.
export async function readPdf(data: Buffer): Promise<Page[]> {
  const task = getDocument({ data: new Uint8Array(data), disableFontFace: true, useSystemFonts: false });
  const doc = await task.promise;
  const pages: Page[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map(item => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : '')).join('');
    const links = (await page.getAnnotations()).map(a => a.url as string | undefined).filter((u): u is string => !!u);
    pages.push({ text, links });
  }
  await task.destroy();
  return pages;
}
