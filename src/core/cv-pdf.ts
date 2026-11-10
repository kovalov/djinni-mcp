import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { marked, type Token, type Tokens } from 'marked';
import PDFDocument from 'pdfkit';

// DejaVu Sans has the Latin and the Cyrillic glyphs. The npm package "dejavu-fonts-ttf" ships the TTF files.
const FONT_DIR = join(dirname(createRequire(import.meta.url).resolve('dejavu-fonts-ttf/package.json')), 'ttf');
const FONTS = {
  regular: join(FONT_DIR, 'DejaVuSans.ttf'),
  bold: join(FONT_DIR, 'DejaVuSans-Bold.ttf'),
  italic: join(FONT_DIR, 'DejaVuSans-Oblique.ttf'),
  boldItalic: join(FONT_DIR, 'DejaVuSans-BoldOblique.ttf'),
};
type FontName = keyof typeof FONTS;

const MARGIN = 50;
const BODY_SIZE = 10.5;
const HEADING_SIZES: Record<number, number> = { 1: 20, 2: 14, 3: 12 };
const LIST_INDENT = 16;
const TEXT_COLOR = '#111111';
const LINK_COLOR = '#1a4fd6';
const RULE_COLOR = '#999999';

// A piece of text with one style. A link has its target.
type Span = { text: string; bold: boolean; italic: boolean; link: string | null };
type Style = Omit<Span, 'text'>;

const PLAIN: Style = { bold: false, italic: false, link: null };

// The token types that the renderer writes. Other types (for example tables and HTML) stop the render, so that no content is lost.
const SUPPORTED = new Set([
  'space', 'heading', 'paragraph', 'text', 'list', 'list_item', 'blockquote', 'code', 'hr', 'def', 'checkbox',
  'strong', 'em', 'link', 'br', 'escape', 'codespan', 'del',
]);

function checkTokens(tokens: Token[] | undefined): void {
  for (const token of tokens ?? []) {
    if (!SUPPORTED.has(token.type)) {
      throw new Error(
        `The Markdown has a token of the type "${token.type}". The CV renderer does not support this type. ` +
          'Write this part as headings, paragraphs or lists.',
      );
    }
    const t = token as Tokens.Generic;
    checkTokens(t.tokens);
    if (token.type === 'list') checkTokens((token as Tokens.List).items);
  }
}

// Only these link targets become links in the PDF. A link with another scheme (for example javascript: or file:) stays plain text.
const safeLink = (href: string): string | null => (/^(https?|mailto):/i.test(href.trim()) ? href.trim() : null);

// Flattens the inline tokens of marked into spans. Inline HTML is left out.
function spans(tokens: Token[] | undefined, style: Style = PLAIN): Span[] {
  const out: Span[] = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'strong':
        out.push(...spans((token as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case 'em':
        out.push(...spans((token as Tokens.Em).tokens, { ...style, italic: true }));
        break;
      case 'link':
        out.push(...spans((token as Tokens.Link).tokens, { ...style, link: safeLink((token as Tokens.Link).href) }));
        break;
      case 'br':
        out.push({ ...style, text: '\n' });
        break;
      default: {
        const t = token as Tokens.Generic;
        if (Array.isArray(t.tokens) && t.tokens.length > 0) out.push(...spans(t.tokens, style));
        else if (typeof t.text === 'string') out.push({ ...style, text: t.text });
      }
    }
  }
  return out.filter(s => s.text !== '');
}

const fontOf = (s: Style): FontName => (s.bold && s.italic ? 'boldItalic' : s.bold ? 'bold' : s.italic ? 'italic' : 'regular');

class Writer {
  constructor(private readonly doc: PDFKit.PDFDocument) {}

  private get width(): number {
    return this.doc.page.width - 2 * MARGIN;
  }

  // Writes the spans as one paragraph that starts at x.
  text(list: Span[], size: number, x = MARGIN, base: Partial<Style> = {}): void {
    const doc = this.doc;
    const items = list.map(s => ({ ...s, ...base, link: s.link }));
    if (items.length === 0) return;
    doc.fontSize(size);
    items.forEach((s, i) => {
      doc.font(fontOf(s)).fillColor(s.link ? LINK_COLOR : TEXT_COLOR);
      const options: PDFKit.Mixins.TextOptions = { width: this.width - (x - MARGIN), continued: i < items.length - 1, link: s.link, underline: s.link !== null };
      if (i === 0) doc.text(s.text, x, doc.y, options);
      else doc.text(s.text, options);
    });
    doc.x = MARGIN;
  }

  block(token: Token, depth = 0): void {
    const doc = this.doc;
    switch (token.type) {
      case 'heading': {
        const t = token as Tokens.Heading;
        const size = HEADING_SIZES[t.depth] ?? BODY_SIZE;
        if (doc.y > MARGIN) doc.moveDown(t.depth === 1 ? 0.2 : 0.6);
        this.text(spans(t.tokens), size, MARGIN, { bold: true });
        doc.moveDown(0.3);
        break;
      }
      case 'paragraph':
      case 'text':
        this.text(spans((token as Tokens.Paragraph).tokens ?? [{ type: 'text', raw: '', text: (token as Tokens.Text).text }]), BODY_SIZE, MARGIN + depth * LIST_INDENT);
        doc.moveDown(0.4);
        break;
      case 'list':
        this.list(token as Tokens.List, depth);
        doc.moveDown(0.3);
        break;
      case 'blockquote':
        for (const child of (token as Tokens.Blockquote).tokens) this.block(child, depth + 1);
        break;
      case 'code':
        this.text([{ ...PLAIN, text: (token as Tokens.Code).text }], BODY_SIZE, MARGIN + depth * LIST_INDENT);
        doc.moveDown(0.4);
        break;
      case 'hr': {
        const y = doc.y + 4;
        doc.moveTo(MARGIN, y).lineTo(doc.page.width - MARGIN, y).lineWidth(0.5).strokeColor(RULE_COLOR).stroke();
        doc.y = y + 8;
        break;
      }
      default:
        break;
    }
  }

  // Writes each item with its marker. The marker hangs left of the item text.
  private list(list: Tokens.List, depth: number): void {
    const doc = this.doc;
    const start = typeof list.start === 'number' ? list.start : 1;
    const x = MARGIN + (depth + 1) * LIST_INDENT;
    list.items.forEach((item, i) => {
      const marker = list.ordered ? `${start + i}.` : '•';
      const [first, ...rest] = item.tokens;
      doc.font('regular').fontSize(BODY_SIZE).fillColor(TEXT_COLOR);
      // The marker and the first line of the item go on the same page.
      if (doc.y + doc.currentLineHeight(true) > doc.page.maxY()) doc.addPage();
      const y = doc.y;
      doc.text(marker, x - LIST_INDENT, y, { width: LIST_INDENT - 2, lineBreak: false });
      doc.x = MARGIN;
      doc.y = y;
      if (first && (first.type === 'text' || first.type === 'paragraph')) {
        this.text(spans((first as Tokens.Text).tokens ?? [first]), BODY_SIZE, x);
        doc.moveDown(0.15);
      } else if (first) this.block(first, depth + 1);
      for (const child of rest) {
        if (child.type === 'list') this.list(child as Tokens.List, depth + 1);
        else this.block(child, depth + 1);
      }
    });
  }
}

// Renders Markdown to a PDF: headings (#, ##, ###), paragraphs, bullet and numbered lists, bold, italic and links.
// Returns the bytes and the page count.
export async function markdownToPdf(markdown: string): Promise<{ data: Buffer; pages: number }> {
  const tokens = marked.lexer(markdown);
  if (!tokens.some(t => t.type !== 'space')) throw new Error('The Markdown has no text.');
  checkTokens(tokens);
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, info: { Title: 'CV', Producer: 'djinni-mcp', Creator: 'djinni-mcp' } });
  for (const [name, file] of Object.entries(FONTS)) doc.registerFont(name, file);
  let pages = 1;
  doc.on('pageAdded', () => pages++);
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const writer = new Writer(doc);
  for (const token of tokens) writer.block(token);
  doc.end();
  return { data: await done, pages };
}
