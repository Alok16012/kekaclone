import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { inr, SECTION_LABEL, type Section } from "./rules";
import type { Form12bbData } from "./service";

const A4 = { w: 595.28, h: 841.89 };
const M = { x: 50, top: 60, bottom: 60 };

/** Standard fonts cover WinAnsi only: swap ₹ and anything unprintable. */
function cleaner(font: PDFFont) {
  const cache = new Map<string, boolean>();
  return (t: string) => {
    let out = "";
    for (const ch of t.replace(/₹/g, "Rs. ").replace(/[–—]/g, "-").replace(/ /g, " ")) {
      let ok = cache.get(ch);
      if (ok === undefined) { try { font.encodeText(ch); ok = true; } catch { ok = false; } cache.set(ch, ok); }
      out += ok ? ch : "?";
    }
    return out;
  };
}

const money = (p: number) => inr(p).replace("₹", "Rs. ");
const month = (m: string) => new Date(`${m.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });

/**
 * A summary of what the person declared for the year, laid out like the details Form 12BB asks for (rent, home loan,
 * Chapter VI-A) — written in erp's own words. It is a working copy for the person to check and sign, not the official form.
 */
export async function render12bb(d: Form12bbData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Declaration summary FY ${d.fy} - ${d.name}`); doc.setAuthor(d.company); doc.setCreator("erp"); doc.setProducer("erp");
  const r = await doc.embedFont(StandardFonts.Helvetica), b = await doc.embedFont(StandardFonts.HelveticaBold);
  const clean = cleaner(r);
  const ink = rgb(0.11, 0.12, 0.14), muted = rgb(0.42, 0.44, 0.48), line = rgb(0.85, 0.86, 0.88);
  const width = A4.w - M.x * 2;
  let page!: PDFPage, y = 0;
  const pages: PDFPage[] = [];
  const newPage = () => {
    page = doc.addPage([A4.w, A4.h]); pages.push(page);
    page.drawText(clean(d.company), { x: M.x, y: A4.h - 40, size: 10, font: b, color: muted });
    y = A4.h - M.top - 10;
  };
  const need = (h: number) => { if (y - h < M.bottom) newPage(); };
  const wrap = (text: string, font: PDFFont, size: number, max: number) => {
    const words = clean(text).split(/\s+/); const lines: string[] = []; let cur = "";
    for (const w of words) { const t = cur ? `${cur} ${w}` : w; if (font.widthOfTextAtSize(t, size) > max && cur) { lines.push(cur); cur = w; } else cur = t; }
    if (cur) lines.push(cur);
    return lines;
  };
  const text = (t: string, o: { size?: number; bold?: boolean; color?: typeof ink; indent?: number } = {}) => {
    const size = o.size ?? 10, font = o.bold ? b : r;
    for (const l of wrap(t, font, size, width - (o.indent ?? 0))) { need(size * 1.5); page.drawText(l, { x: M.x + (o.indent ?? 0), y, size, font, color: o.color ?? ink }); y -= size * 1.5; }
  };
  const heading = (t: string) => { y -= 8; need(30); page.drawText(clean(t), { x: M.x, y, size: 12, font: b, color: ink }); y -= 6; page.drawLine({ start: { x: M.x, y }, end: { x: A4.w - M.x, y }, thickness: 0.6, color: line }); y -= 14; };
  const row = (label: string, value: string, bold = false) => {
    const lines = wrap(label, bold ? b : r, 10, width - 130);
    need(lines.length * 15);
    lines.forEach((l, i) => page.drawText(l, { x: M.x, y: y - i * 15, size: 10, font: bold ? b : r, color: ink }));
    const v = clean(value);
    page.drawText(v, { x: A4.w - M.x - (bold ? b : r).widthOfTextAtSize(v, 10), y, size: 10, font: bold ? b : r, color: ink });
    y -= lines.length * 15;
  };

  newPage();
  page.drawText(clean(`Investment and rent declaration, FY ${d.fy}`), { x: M.x, y, size: 16, font: b, color: ink }); y -= 22;
  text(`Prepared by erp from what ${d.name} declared. These are the details the income-tax rules ask employees to give their employer (Form 12BB). Check them against the official form before signing.`, { color: muted, size: 9 });
  y -= 4;
  row("Employee", d.name); if (d.employeeNumber) row("Employee number", d.employeeNumber); if (d.designation) row("Designation", d.designation);
  row("PAN", d.panLast4 ? `ending ${d.panLast4}` : "Not given"); row("Tax regime chosen", d.regime === "new" ? "New regime" : "Old regime");
  row("Status", d.status === "draft" ? "Draft (not submitted)" : `Submitted${d.submittedAt ? " on " + new Date(d.submittedAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }) : ""}`);

  heading("1. House rent (for HRA)");
  if (!d.rent.length) text("No rent declared.", { color: muted });
  for (const [i, p] of d.rent.entries()) {
    row(`Home ${i + 1}: ${month(p.fromMonth)} to ${month(p.toMonth)} at ${money(p.monthlyRentPaise)} a month`, money(p.annualPaise), true);
    text(`Landlord: ${p.landlordName}${p.landlordPan ? `, PAN ${p.landlordPan}` : ", PAN not given"}`, { indent: 12 });
    text(`Address: ${p.landlordAddress}, ${p.city}${p.metro ? " (metro)" : ""}`, { indent: 12 });
  }
  if (d.rent.length) row("Total rent for the year", money(d.rent.reduce((s, p) => s + p.annualPaise, 0)), true);

  heading("2. Leave travel");
  text("Not collected in erp. Give your employer travel details separately if you claim it.", { color: muted });

  heading("3. Interest on a home loan (section 24(b))");
  if (!d.homeLoan || !d.homeLoan.interestPaise) text("No home loan declared.", { color: muted });
  else {
    row("Interest payable for the year", money(d.homeLoan.interestPaise), true);
    text(`Lender: ${d.homeLoan.lenderName}${d.homeLoan.lenderPan ? `, PAN ${d.homeLoan.lenderPan}` : ""}${d.homeLoan.lenderAddress ? `, ${d.homeLoan.lenderAddress}` : ""}`, { indent: 12 });
    text(`Property: ${d.homeLoan.propertyAddress}`, { indent: 12 });
  }

  heading("4. Deductions under Chapter VI-A");
  if (!d.chapterVIA.length) text("No investments or deductions declared.", { color: muted });
  const sections = [...new Set(d.chapterVIA.map((c) => c.section))];
  for (const s of sections) {
    text(SECTION_LABEL[s as Section] ?? s, { bold: true });
    for (const c of d.chapterVIA.filter((x) => x.section === s)) row(`   ${c.label}`, money(c.declaredPaise));
  }

  if (d.previous.incomePaise || d.other.savingsInterestPaise || d.other.depositInterestPaise || d.other.otherPaise) {
    heading("5. Other income and previous employer");
    if (d.previous.incomePaise) {
      row(`Salary from ${d.previous.employerName || "previous employer"}`, money(d.previous.incomePaise));
      row("Tax deducted by them", money(d.previous.tdsPaise));
    }
    if (d.other.savingsInterestPaise) row("Savings account interest", money(d.other.savingsInterestPaise));
    if (d.other.depositInterestPaise) row("Fixed deposit interest", money(d.other.depositInterestPaise));
    if (d.other.otherPaise) row(`Other: ${d.other.otherDescription}`, money(d.other.otherPaise));
  }

  heading("Confirmation");
  text(`I, ${d.name}, confirm that the information above is complete and correct to the best of my knowledge.`);
  y -= 24; need(40);
  page.drawLine({ start: { x: M.x, y }, end: { x: M.x + 200, y }, thickness: 0.6, color: line });
  page.drawLine({ start: { x: A4.w - M.x - 150, y }, end: { x: A4.w - M.x, y }, thickness: 0.6, color: line });
  y -= 12;
  page.drawText("Signature", { x: M.x, y, size: 9, font: r, color: muted });
  page.drawText("Place and date", { x: A4.w - M.x - 150, y, size: 9, font: r, color: muted });

  pages.forEach((p, i) => p.drawText(`Page ${i + 1} of ${pages.length}`, { x: A4.w - M.x - 60, y: 30, size: 8, font: r, color: muted }));
  return doc.save();
}
