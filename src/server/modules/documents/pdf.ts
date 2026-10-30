import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { htmlToBlocks, type Run } from "./rules";

const A4 = { w: 595.28, h: 841.89 };
const M = { x: 64, top: 72, bottom: 72 };
const SIZE = { p: 11, li: 11, h2: 16, h3: 13 };
const LEAD = 1.45;

type Fonts = { r: PDFFont; b: PDFFont; i: PDFFont; bi: PDFFont };
const fontFor = (f: Fonts, run: Run) => (run.bold && run.italic ? f.bi : run.bold ? f.b : run.italic ? f.i : f.r);

/** Standard PDF fonts only cover Latin-1-ish text (WinAnsi); swap anything else for something printable. */
function printable(font: PDFFont, cache: Map<string, boolean>) {
  return (text: string) => {
    let out = "";
    for (const ch of text.replace(/₹/g, "Rs.").replace(/ /g, " ")) {
      let ok = cache.get(ch);
      if (ok === undefined) { try { font.encodeText(ch); ok = true; } catch { ok = false; } cache.set(ch, ok); }
      out += ok ? ch : "?";
    }
    return out;
  };
}

/**
 * Letter HTML (sanitised, placeholders merged) → A4 PDF: company name as a header, wrapped paragraphs,
 * headings and lists, bold/italic/underline, page numbers in the footer.
 */
export async function renderLetterPdf(a: { html: string; title: string; company: string; footer: string }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(a.title); doc.setAuthor(a.company); doc.setCreator("erp"); doc.setProducer("erp");
  const f: Fonts = {
    r: await doc.embedFont(StandardFonts.Helvetica), b: await doc.embedFont(StandardFonts.HelveticaBold),
    i: await doc.embedFont(StandardFonts.HelveticaOblique), bi: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
  };
  const clean = printable(f.r, new Map());
  const ink = rgb(0.11, 0.12, 0.14), muted = rgb(0.42, 0.44, 0.48), rule = rgb(0.85, 0.86, 0.88);
  const width = A4.w - M.x * 2;
  const pages: PDFPage[] = [];
  let page!: PDFPage, y = 0;
  const newPage = () => {
    page = doc.addPage([A4.w, A4.h]); pages.push(page);
    page.drawText(clean(a.company), { x: M.x, y: A4.h - 48, size: 12, font: f.b, color: ink });
    page.drawLine({ start: { x: M.x, y: A4.h - 56 }, end: { x: A4.w - M.x, y: A4.h - 56 }, thickness: 0.6, color: rule });
    y = A4.h - M.top - 8;
  };
  newPage();

  for (const block of htmlToBlocks(a.html)) {
    const size = SIZE[block.kind];
    const lineH = size * LEAD;
    const indent = block.kind === "li" ? 18 : 0;
    const runs = block.kind === "h2" || block.kind === "h3" ? block.runs.map((r) => ({ ...r, bold: true })) : block.runs;
    // words with their style; "\n" forces a break
    const words: { text: string; run: Run; space: boolean }[] = [];
    for (const r of runs) {
      if (r.text === "\n") { words.push({ text: "\n", run: r, space: false }); continue; }
      const parts = clean(r.text).split(/( +)/);
      for (const p of parts) {
        if (!p) continue;
        if (/^ +$/.test(p)) { if (words.length) words[words.length - 1].space = true; continue; }
        words.push({ text: p, run: r, space: false });
      }
    }
    const lines: { text: string; run: Run; x: number }[][] = [[]];
    let x = 0;
    for (const w of words) {
      if (w.text === "\n") { lines.push([]); x = 0; continue; }
      const font = fontFor(f, w.run);
      const ww = font.widthOfTextAtSize(w.text, size);
      const sw = w.space ? font.widthOfTextAtSize(" ", size) : 0;
      if (x > 0 && x + ww > width - indent) { lines.push([]); x = 0; }
      // a single word longer than the line: hard-split it
      let text = w.text;
      while (font.widthOfTextAtSize(text, size) > width - indent) {
        let cut = text.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(text.slice(0, cut), size) > width - indent) cut--;
        lines[lines.length - 1].push({ text: text.slice(0, cut), run: w.run, x: 0 });
        lines.push([]); text = text.slice(cut);
      }
      lines[lines.length - 1].push({ text, run: w.run, x });
      x += font.widthOfTextAtSize(text, size) + sw;
    }
    if (block.kind === "h2" || block.kind === "h3") y -= size * 0.5;
    for (const [li, line] of lines.entries()) {
      if (y - lineH < M.bottom) newPage();
      y -= lineH;
      if (li === 0 && block.marker) page.drawText(block.marker, { x: M.x + 2, y, size, font: f.r, color: ink });
      for (const seg of line) {
        const font = fontFor(f, seg.run);
        page.drawText(seg.text, { x: M.x + indent + seg.x, y, size, font, color: ink });
        if (seg.run.underline) {
          const w = font.widthOfTextAtSize(seg.text, size);
          page.drawLine({ start: { x: M.x + indent + seg.x, y: y - 1.5 }, end: { x: M.x + indent + seg.x + w, y: y - 1.5 }, thickness: 0.5, color: ink });
        }
      }
    }
    y -= block.kind === "li" ? size * 0.25 : size * 0.8;
  }

  pages.forEach((p, i) => {
    const label = clean(`${a.footer} · Page ${i + 1} of ${pages.length}`);
    p.drawText(label, { x: M.x, y: 36, size: 8, font: f.r, color: muted });
  });
  return doc.save();
}
