import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";

const clean = (s: string) => s.replace(/[^\x20-\x7e]/g, "?");

/** Landscape A4 completion certificate: name, course, date, a verification code in the footer. */
export async function renderCertificatePdf(a: { name: string; course: string; company: string; date: string; code: string }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Certificate · ${a.course}`); doc.setAuthor(a.company); doc.setCreator("erp"); doc.setProducer("erp");
  const r = await doc.embedFont(StandardFonts.Helvetica), b = await doc.embedFont(StandardFonts.HelveticaBold), i = await doc.embedFont(StandardFonts.HelveticaOblique);
  const W = 841.89, H = 595.28;
  const page = doc.addPage([W, H]);
  const ink = rgb(0.11, 0.12, 0.14), muted = rgb(0.42, 0.44, 0.48), accent = rgb(0.18, 0.36, 0.92);
  page.drawRectangle({ x: 24, y: 24, width: W - 48, height: H - 48, borderColor: accent, borderWidth: 2 });
  page.drawRectangle({ x: 32, y: 32, width: W - 64, height: H - 64, borderColor: rgb(0.85, 0.86, 0.88), borderWidth: 0.8 });
  const centre = (text: string, y: number, size: number, font: PDFFont, color = ink) => page.drawText(clean(text), { x: (W - font.widthOfTextAtSize(clean(text), size)) / 2, y, size, font, color });
  centre(a.company, H - 90, 13, r, muted);
  centre("CERTIFICATE OF COMPLETION", H - 150, 26, b, accent);
  centre("This certifies that", H - 210, 13, i, muted);
  centre(a.name, H - 258, 30, b);
  centre("has successfully completed", H - 300, 13, i, muted);
  const title = clean(a.course);
  let size = 22;
  while (b.widthOfTextAtSize(title, size) > W - 160 && size > 12) size -= 1;
  centre(title, H - 345, size, b);
  centre(`on ${a.date}`, H - 390, 13, r, muted);
  page.drawLine({ start: { x: W / 2 - 110, y: 118 }, end: { x: W / 2 + 110, y: 118 }, thickness: 0.8, color: rgb(0.6, 0.62, 0.66) });
  centre("Learning & Development", 102, 10, r, muted);
  page.drawText(clean(`Verification code ${a.code} · issued by erp`), { x: 44, y: 44, size: 8, font: r, color: muted });
  return doc.save();
}
