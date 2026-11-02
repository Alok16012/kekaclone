import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { amountInWords, inr } from "./rules";

const A4 = { w: 595.28, h: 841.89 };
const X = 48, W = A4.w - 2 * X;
const ink = rgb(0.11, 0.12, 0.14), muted = rgb(0.42, 0.44, 0.48), rule = rgb(0.85, 0.86, 0.88), band = rgb(0.95, 0.96, 0.97);

/** Standard PDF fonts only cover WinAnsi; swap anything else for something printable (₹ becomes "Rs."). */
function cleaner(font: PDFFont) {
  const cache = new Map<string, boolean>();
  return (text: string) => {
    let out = "";
    for (const ch of String(text).replace(/₹/g, "Rs.").replace(/[–—]/g, "-").replace(/ /g, " ")) {
      let ok = cache.get(ch);
      if (ok === undefined) { try { font.encodeText(ch); ok = true; } catch { ok = false; } cache.set(ch, ok); }
      out += ok ? ch : "?";
    }
    return out;
  };
}

class Writer {
  page!: PDFPage; y = 0; clean: (s: string) => string;
  constructor(public doc: PDFDocument, public r: PDFFont, public b: PDFFont, private header: string) { this.clean = cleaner(r); this.newPage(); }
  newPage() {
    this.page = this.doc.addPage([A4.w, A4.h]);
    this.y = A4.h - 48;
    this.text(this.header, X, this.y, 13, this.b);
    this.y -= 10;
    this.page.drawLine({ start: { x: X, y: this.y }, end: { x: A4.w - X, y: this.y }, thickness: 0.6, color: rule });
    this.y -= 18;
  }
  need(h: number) { if (this.y - h < 64) this.newPage(); }
  text(s: string, x: number, y: number, size = 9.5, font = this.r, color = ink) { this.page.drawText(this.clean(s), { x, y, size, font, color }); }
  right(s: string, xRight: number, y: number, size = 9.5, font = this.r, color = ink) {
    const t = this.clean(s); this.page.drawText(t, { x: xRight - font.widthOfTextAtSize(t, size), y, size, font, color });
  }
  fit(s: string, width: number, size = 9.5, font = this.r) {
    let t = this.clean(s);
    while (t.length > 1 && font.widthOfTextAtSize(t, size) > width) t = t.slice(0, -2) + ".";
    return t;
  }
  heading(s: string) { this.need(28); this.y -= 6; this.text(s, X, this.y, 11, this.b); this.y -= 14; }
  /** Two-column facts (label: value) */
  facts(pairs: [string, string][]) {
    const colW = W / 2;
    for (let i = 0; i < pairs.length; i += 2) {
      this.need(16);
      for (const [j, p] of [pairs[i], pairs[i + 1]].entries()) {
        if (!p) continue;
        const x = X + j * colW;
        this.text(p[0], x, this.y, 8.5, this.r, muted);
        this.text(this.fit(p[1], colW - 110), x + 105, this.y, 9.5, this.b);
      }
      this.y -= 15;
    }
  }
  /** Rows of [label, amount] side by side: left table and right table. */
  twoTables(leftTitle: string, left: [string, number][], rightTitle: string, right: [string, number][], leftTotal: [string, number], rightTotal: [string, number]) {
    const half = (W - 16) / 2, xl = X, xr = X + half + 16;
    this.need(24);
    this.page.drawRectangle({ x: X, y: this.y - 5, width: W, height: 18, color: band });
    this.text(leftTitle, xl + 6, this.y, 9.5, this.b); this.right("Amount", xl + half - 6, this.y, 9.5, this.b);
    this.text(rightTitle, xr + 6, this.y, 9.5, this.b); this.right("Amount", xr + half - 6, this.y, 9.5, this.b);
    this.y -= 18;
    const n = Math.max(left.length, right.length);
    for (let i = 0; i < n; i++) {
      this.need(15);
      const l = left[i], r = right[i];
      if (l) { this.text(this.fit(l[0], half - 90), xl + 6, this.y); this.right(inr(l[1], ""), xl + half - 6, this.y); }
      if (r) { this.text(this.fit(r[0], half - 90), xr + 6, this.y); this.right(inr(r[1], ""), xr + half - 6, this.y); }
      this.y -= 14;
    }
    this.page.drawLine({ start: { x: X, y: this.y + 8 }, end: { x: A4.w - X, y: this.y + 8 }, thickness: 0.5, color: rule });
    this.y -= 4;
    this.text(leftTotal[0], xl + 6, this.y, 9.5, this.b); this.right(inr(leftTotal[1], ""), xl + half - 6, this.y, 9.5, this.b);
    this.text(rightTotal[0], xr + 6, this.y, 9.5, this.b); this.right(inr(rightTotal[1], ""), xr + half - 6, this.y, 9.5, this.b);
    this.y -= 20;
  }
  table(headers: string[], rows: string[][], widths: number[], alignRight: boolean[]) {
    this.need(24);
    this.page.drawRectangle({ x: X, y: this.y - 5, width: W, height: 18, color: band });
    let x = X + 6;
    headers.forEach((h, i) => { if (alignRight[i]) this.right(h, x + widths[i] - 12, this.y, 9, this.b); else this.text(h, x, this.y, 9, this.b); x += widths[i]; });
    this.y -= 17;
    for (const r of rows) {
      this.need(14);
      x = X + 6;
      r.forEach((c, i) => { if (alignRight[i]) this.right(c, x + widths[i] - 12, this.y, 9); else this.text(this.fit(c, widths[i] - 8, 9), x, this.y, 9); x += widths[i]; });
      this.y -= 13;
    }
    this.y -= 8;
  }
  netBox(label: string, paise: number) {
    this.need(48);
    this.page.drawRectangle({ x: X, y: this.y - 26, width: W, height: 38, borderColor: rule, borderWidth: 0.8, color: band });
    this.text(label, X + 10, this.y - 2, 11, this.b);
    this.right(inr(paise), A4.w - X - 10, this.y - 2, 13, this.b);
    this.text(this.fit(amountInWords(paise), W - 20, 8.5), X + 10, this.y - 18, 8.5, this.r, muted);
    this.y -= 48;
  }
  note(s: string) {
    const words = this.clean(s).split(" ");
    let line = "";
    for (const w of words) {
      const t = line ? `${line} ${w}` : w;
      if (this.r.widthOfTextAtSize(t, 8) > W) { this.need(11); this.text(line, X, this.y, 8, this.r, muted); this.y -= 11; line = w; } else line = t;
    }
    if (line) { this.need(11); this.text(line, X, this.y, 8, this.r, muted); this.y -= 11; }
  }
  footer(s: string) {
    const pages = this.doc.getPages();
    pages.forEach((p, i) => p.drawText(this.clean(`${s} · Page ${i + 1} of ${pages.length}`), { x: X, y: 32, size: 7.5, font: this.r, color: muted }));
  }
}

export type PayslipDoc = {
  company: string; legalEntity: string; monthLabel: string;
  employee: { name: string; number: string; designation: string | null; department: string | null; joining: string; pan: string | null; uan: string | null; bank: string | null };
  days: { period: number; payable: number; lop: number };
  earnings: [string, number][]; deductions: [string, number][]; gross: number; totalDeductions: number; net: number;
  employer: [string, number][];
  ytd: { gross: number; deductions: number; tds: number; pf: number; net: number; months: number };
  unverified: boolean;
};

export async function renderPayslip(d: PayslipDoc): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Payslip ${d.monthLabel} - ${d.employee.name}`); doc.setAuthor(d.company); doc.setCreator("erp"); doc.setProducer("erp");
  const w = new Writer(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold), d.company);
  w.text(`Payslip for ${d.monthLabel}`, X, w.y, 15, w.b); w.y -= 14;
  w.text(d.legalEntity, X, w.y, 9, w.r, muted); w.y -= 20;
  w.facts([
    ["Employee", d.employee.name], ["Employee number", d.employee.number],
    ["Designation", d.employee.designation ?? "-"], ["Department", d.employee.department ?? "-"],
    ["Date of joining", d.employee.joining], ["PAN", d.employee.pan ?? "Not on file"],
    ["UAN", d.employee.uan ?? "-"], ["Bank account", d.employee.bank ?? "Not on file"],
    ["Days in period", String(d.days.period)], ["Days paid", String(d.days.payable)],
    ["Loss of pay days", String(d.days.lop)],
  ]);
  w.y -= 6;
  w.twoTables("Earnings", d.earnings, "Deductions", d.deductions, ["Gross earnings", d.gross], ["Total deductions", d.totalDeductions]);
  w.netBox("Net pay", d.net);
  if (d.employer.length) {
    w.heading("Paid by the company on your behalf");
    w.table(["Contribution", "Amount"], d.employer.map(([l, p]) => [l, inr(p, "")]), [W * 0.7, W * 0.3], [false, true]);
  }
  w.heading(`Year to date (${d.ytd.months} ${d.ytd.months === 1 ? "month" : "months"} this financial year)`);
  w.table(["Gross earnings", "Deductions", "Income tax", "Provident fund", "Net pay"], [[inr(d.ytd.gross, ""), inr(d.ytd.deductions, ""), inr(d.ytd.tds, ""), inr(d.ytd.pf, ""), inr(d.ytd.net, "")]],
    Array(5).fill(W / 5), Array(5).fill(true));
  w.note("This payslip is generated by erp and needs no signature. Amounts are in Indian rupees.");
  if (d.unverified) w.note("Statutory deductions (PF, ESI, professional tax, LWF and income tax) were worked out on rates your employer has not yet had verified by a chartered accountant. Ask payroll if anything looks wrong.");
  w.footer(`${d.company} · Payslip ${d.monthLabel} · ${d.employee.number}`);
  return doc.save();
}

export type FnfDoc = {
  company: string; legalEntity: string;
  employee: { name: string; number: string; designation: string | null; department: string | null; joining: string; lastDay: string; reason: string | null };
  items: { label: string; side: "earning" | "deduction"; paise: number; action: string; note?: string | null }[];
  net: number; finalizedOn: string; unverified: boolean;
};

export async function renderFnfStatement(d: FnfDoc): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Full and final settlement - ${d.employee.name}`); doc.setAuthor(d.company); doc.setCreator("erp"); doc.setProducer("erp");
  const w = new Writer(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold), d.company);
  w.text("Full and final settlement statement", X, w.y, 15, w.b); w.y -= 14;
  w.text(d.legalEntity, X, w.y, 9, w.r, muted); w.y -= 20;
  w.facts([
    ["Employee", d.employee.name], ["Employee number", d.employee.number],
    ["Designation", d.employee.designation ?? "-"], ["Department", d.employee.department ?? "-"],
    ["Date of joining", d.employee.joining], ["Last working day", d.employee.lastDay],
    ["Reason", d.employee.reason ?? "-"], ["Settled on", d.finalizedOn],
  ]);
  const pay = (s: string) => d.items.filter((i) => i.side === s && i.action === "pay").map((i): [string, number] => [i.label, i.paise]);
  const earn = pay("earning"), ded = pay("deduction");
  w.twoTables("Amounts due to you", earn, "Amounts recovered", ded, ["Total due", earn.reduce((t, x) => t + x[1], 0)], ["Total recovered", ded.reduce((t, x) => t + x[1], 0)]);
  w.netBox(d.net >= 0 ? "Net amount payable to you" : "Net amount you owe the company", Math.abs(d.net));
  const other = d.items.filter((i) => i.action !== "pay");
  if (other.length) {
    w.heading("Not included above");
    w.table(["Item", "Status", "Amount"], other.map((i) => [i.label, i.action === "paid_outside" ? "Paid separately" : "Not applied", inr(i.paise, "")]), [W * 0.55, W * 0.2, W * 0.25], [false, false, true]);
  }
  w.note("Gratuity, leave encashment and statutory figures were worked out by erp from your records. Contact HR or payroll if anything here doesn't match what you expect.");
  if (d.unverified) w.note("The statutory rates used (including gratuity) have not yet been verified by a chartered accountant.");
  w.footer(`${d.company} · Full and final settlement · ${d.employee.number}`);
  return doc.save();
}
