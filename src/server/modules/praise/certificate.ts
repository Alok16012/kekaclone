import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import type { Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { getPost } from "@/server/modules/engage/service";
import { wrapWords } from "./rules";

/** Standard fonts only print Latin-1-ish text; swap anything else for "?" (₹ → Rs.). */
const printable = (font: PDFFont) => (t: string) => [...t.replace(/₹/g, "Rs.").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")]
  .map((ch) => { try { font.encodeText(ch); return ch; } catch { return "?"; } }).join("");

/**
 * Certificate for one recipient of a praise post: A4 landscape, double border, the badge, the message, who gave it.
 * Anyone who can see the praise on the wall can download it (same visibility as the post). Null when not visible.
 */
export async function praiseCertificate(tx: Tx, actor: Actor, postId: string, recipientId: string) {
  const post = await getPost(tx, actor, postId);
  if (!post || post.kind !== "praise") return null;
  const to = post.recipients.find((r) => r.id === recipientId);
  if (!to) return null;
  const doc = await PDFDocument.create();
  doc.setTitle(`Certificate of appreciation for ${to.name}`); doc.setAuthor(actor.tenant.name); doc.setCreator("erp"); doc.setProducer("erp");
  const page = doc.addPage([841.89, 595.28]);
  const { width: W, height: H } = page.getSize();
  const reg = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold), serif = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const p = printable(reg);
  const ink = rgb(0.11, 0.12, 0.14), muted = rgb(0.42, 0.44, 0.48), accent = rgb(0.18, 0.36, 0.92);
  page.drawRectangle({ x: 24, y: 24, width: W - 48, height: H - 48, borderColor: accent, borderWidth: 3 });
  page.drawRectangle({ x: 34, y: 34, width: W - 68, height: H - 68, borderColor: accent, borderWidth: 0.8 });
  const center = (text: string, y: number, font: PDFFont, size: number, color = ink) => {
    const t = p(text);
    page.drawText(t, { x: (W - font.widthOfTextAtSize(t, size)) / 2, y, size, font, color });
  };
  center(actor.tenant.name.toUpperCase(), H - 92, bold, 12, muted);
  center("Certificate of appreciation", H - 150, bold, 34);
  center("presented to", H - 192, serif, 16, muted);
  center(to.name, H - 240, bold, 30, accent);
  if (post.badge) center(`for being "${post.badge.name}"`, H - 274, serif, 16);
  const lines = wrapWords(p((post.body ?? "").replace(/\s+/g, " ").trim()), (s) => reg.widthOfTextAtSize(s, 13), W - 220, 5);
  lines.forEach((l, i) => center(l, H - 316 - i * 20, reg, 13));
  const date = new Date(post.publishedAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
  page.drawLine({ start: { x: 120, y: 112 }, end: { x: 330, y: 112 }, thickness: 0.6, color: muted });
  page.drawText(p(post.author.name), { x: 120, y: 92, size: 13, font: bold, color: ink });
  page.drawText("With thanks from", { x: 120, y: 120, size: 10, font: reg, color: muted });
  page.drawLine({ start: { x: W - 330, y: 112 }, end: { x: W - 120, y: 112 }, thickness: 0.6, color: muted });
  page.drawText(p(date), { x: W - 330, y: 92, size: 13, font: bold, color: ink });
  page.drawText("Date", { x: W - 330, y: 120, size: 10, font: reg, color: muted });
  const bytes = await doc.save();
  return { bytes, filename: `appreciation-${to.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.pdf` };
}
