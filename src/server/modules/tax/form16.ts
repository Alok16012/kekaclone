import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { audit } from "@/server/modules/audit/service";
import { saveFile } from "@/server/storage";
import { isPayrollAdmin } from "@/server/modules/payroll/access";
import { loadTaxRates, ratesNeedVerification } from "@/server/modules/statutory/service";
import { allowedDeductions, annualTax, type AnnualTaxResult, type TaxDeductions } from "@/server/modules/statutory/rules";
import { ageBandFor } from "@/server/modules/payrun/rules";
import { fyEnd, fyLabel, inr } from "./rules";
import { getTaxInputs, panMap } from "./service";

const N = (v: bigint | number | string | null | undefined) => (v == null ? 0 : Number(v));

export type YearSummary = {
  employeeId: string; name: string; number: string; designation: string | null; pan: string | null; regime: "old" | "new"; fyStart: string; fy: string;
  from: string; to: string; months: number;
  grossSalaryPaise: number; taxableSalaryPaise: number; exemptSalaryPaise: number; hraExemptPaise: number; fbpExemptPaise: number;
  professionalTaxPaise: number; employeePfPaise: number; tdsPaise: number;
  previous: { incomePaise: number; tdsPaise: number; pfPaise: number; ptPaise: number }; otherIncomePaise: number;
  deductions: TaxDeductions; chapterVIAPaise: number; tax: AnnualTaxResult;
  byMonth: { month: string; grossPaise: number; taxablePaise: number; tdsPaise: number }[];
  declarationStatus: "none" | "draft" | "submitted";
};

/**
 * One person's year as the tax return and Form 16 Part B see it: pay from finalised runs, exemptions and deductions
 * from the submitted declaration (verified amounts once proofs are final), tax by the statutory engine. Rates and
 * limits are the unverified ones in statutory_rates; the caller labels the output accordingly.
 */
export async function yearSummary(tx: Tx, employeeId: string, fyStart: string): Promise<YearSummary | null> {
  const end = fyEnd(fyStart);
  const [e] = await tx<{ id: string; display_name: string; employee_number: string; designation: string | null; dob: string | null }[]>`
    select e.id, e.display_name, e.employee_number, d.title as designation, e.dob::text from employees e left join designations d on d.id = e.designation_id where e.id = ${employeeId}`;
  if (!e) return null;
  const rows = await tx<{ month: string; gross: string; taxable: string; tds: string; pt: string; pf: string }[]>`
    select r.period_month::text as month, sum(l.gross_paise)::text as gross, sum((l.statutory->>'taxablePaise')::bigint)::text as taxable,
      sum(coalesce((l.statutory->'tds'->>'monthlyPaise')::bigint, 0))::text as tds, sum(coalesce((l.statutory->'pt'->>'amountPaise')::bigint, 0))::text as pt,
      sum(coalesce((l.statutory->'pf'->>'employeePaise')::bigint, 0))::text as pf
    from payroll_lines l join payroll_runs r on r.id = l.run_id
    where l.employee_id = ${employeeId} and r.status in ('finalized','payslips_released','paid') and l.action in ('process','hold_payout','paid_outside')
      and r.period_month between ${fyStart} and ${end}
    group by r.period_month order by r.period_month`;
  if (!rows.length) return null;
  const inputs = await getTaxInputs(tx, employeeId, fyStart, { asOf: end });
  const gross = rows.reduce((t, r) => t + N(r.gross), 0), taxable = rows.reduce((t, r) => t + N(r.taxable), 0);
  const pt = rows.reduce((t, r) => t + N(r.pt), 0), pf = rows.reduce((t, r) => t + N(r.pf), 0), tds = rows.reduce((t, r) => t + N(r.tds), 0);
  const prev = inputs.previousEmployer;
  const declared = inputs.status === "submitted";
  const deductions: TaxDeductions = {
    ...(declared ? inputs.taxDeductions : {}),
    section80CPaise: (declared ? inputs.taxDeductions.section80CPaise ?? 0 : 0) + pf + (declared ? prev.pfPaise : 0),
    professionalTaxPaise: pt + (declared ? prev.ptPaise : 0),
    hraExemptPaise: declared ? inputs.hraExemptionPaise : 0,
    otherExemptionsPaise: declared ? inputs.fbp.exemptPaise : 0,
  };
  const config = (await loadTaxRates(tx, fyLabel(fyStart), inputs.regime)).config;
  const other = declared ? inputs.otherIncomePaise : 0, prevIncome = declared ? prev.incomePaise : 0;
  const tax = annualTax({ config, grossIncomePaise: taxable + prevIncome + other, deductions, ageBand: ageBandFor(e.dob, fyStart) });
  const chapterVIA = allowedDeductions(config, { section80CPaise: deductions.section80CPaise, otherChapterVIAPaise: deductions.otherChapterVIAPaise, homeLoanInterestPaise: deductions.homeLoanInterestPaise, employerNpsPaise: deductions.employerNpsPaise });
  const pan = (await panMap(tx, (await tx<{ t: string }[]>`select app_tenant() as t`)[0].t));
  const myPan = [...pan.entries()].find(([, id]) => id === employeeId)?.[0] ?? null;
  return {
    employeeId, name: e.display_name, number: e.employee_number, designation: e.designation, pan: myPan, regime: inputs.regime, fyStart, fy: fyLabel(fyStart),
    from: rows[0].month, to: end, months: rows.length,
    grossSalaryPaise: gross, taxableSalaryPaise: taxable, exemptSalaryPaise: gross - taxable, hraExemptPaise: deductions.hraExemptPaise ?? 0, fbpExemptPaise: deductions.otherExemptionsPaise ?? 0,
    professionalTaxPaise: pt, employeePfPaise: pf, tdsPaise: tds,
    previous: { incomePaise: prevIncome, tdsPaise: declared ? prev.tdsPaise : 0, pfPaise: declared ? prev.pfPaise : 0, ptPaise: declared ? prev.ptPaise : 0 }, otherIncomePaise: other,
    deductions, chapterVIAPaise: chapterVIA, tax,
    byMonth: rows.map((r) => ({ month: r.month, grossPaise: N(r.gross), taxablePaise: N(r.taxable), tdsPaise: N(r.tds) })),
    declarationStatus: inputs.status,
  };
}

// ---------------------------------------------------------------- the PDF
const A4 = { w: 595.28, h: 841.89 }, X = 50, W = A4.w - 2 * X;
function cleaner(font: PDFFont) {
  const cache = new Map<string, boolean>();
  return (t: string) => { let out = ""; for (const ch of String(t).replace(/₹/g, "Rs. ").replace(/[–—]/g, "-").replace(/ /g, " ")) { let ok = cache.get(ch); if (ok === undefined) { try { font.encodeText(ch); ok = true; } catch { ok = false; } cache.set(ch, ok); } out += ok ? ch : "?"; } return out; };
}
const money = (p: number) => inr(p).replace("₹", "Rs. ");

/** Form 16 Part B laid out in erp's own words: salary, exemptions, deductions and tax for the year, with the unverified-rates note. */
export async function renderForm16PartB(s: YearSummary, a: { company: string; legalEntity: string | null; generatedOn: string; unverified: boolean }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Form 16 Part B FY ${s.fy} - ${s.name}`); doc.setAuthor(a.company); doc.setCreator("erp"); doc.setProducer("erp");
  const r = await doc.embedFont(StandardFonts.Helvetica), b = await doc.embedFont(StandardFonts.HelveticaBold);
  const clean = cleaner(r);
  const ink = rgb(0.11, 0.12, 0.14), muted = rgb(0.42, 0.44, 0.48), line = rgb(0.85, 0.86, 0.88), band = rgb(0.95, 0.96, 0.97);
  let page!: PDFPage, y = 0;
  const pages: PDFPage[] = [];
  const newPage = () => { page = doc.addPage([A4.w, A4.h]); pages.push(page); page.drawText(clean(a.company), { x: X, y: A4.h - 40, size: 10, font: b, color: muted }); y = A4.h - 70; };
  const need = (h: number) => { if (y - h < 60) newPage(); };
  const text = (t: string, o: { size?: number; bold?: boolean; color?: typeof ink } = {}) => { need(16); page.drawText(clean(t), { x: X, y, size: o.size ?? 10, font: o.bold ? b : r, color: o.color ?? ink }); y -= (o.size ?? 10) * 1.5; };
  const wrap = (t: string, size = 9) => { const words = clean(t).split(" "); let cur = ""; for (const w of words) { const n = cur ? `${cur} ${w}` : w; if (r.widthOfTextAtSize(n, size) > W) { need(14); page.drawText(cur, { x: X, y, size, font: r, color: muted }); y -= size * 1.5; cur = w; } else cur = n; } if (cur) { need(14); page.drawText(cur, { x: X, y, size, font: r, color: muted }); y -= size * 1.5; } };
  const heading = (t: string) => { y -= 6; need(30); page.drawRectangle({ x: X, y: y - 5, width: W, height: 18, color: band }); page.drawText(clean(t), { x: X + 6, y, size: 10.5, font: b, color: ink }); y -= 22; };
  const row = (label: string, value: string, bold = false) => { need(16); const f = bold ? b : r; page.drawText(clean(label), { x: X + 6, y, size: 9.5, font: f, color: ink }); const v = clean(value); page.drawText(v, { x: A4.w - X - 6 - f.widthOfTextAtSize(v, 9.5), y, size: 9.5, font: f, color: ink }); y -= 15; };
  const rule = () => { page.drawLine({ start: { x: X, y: y + 10 }, end: { x: A4.w - X, y: y + 10 }, thickness: 0.5, color: line }); };

  newPage();
  text(`Form 16 Part B (salary and tax details), FY ${s.fy}`, { size: 15, bold: true });
  text(`Prepared by erp for ${s.name} from finalised payroll and the submitted tax declaration. This is erp's working statement in the layout of Part B; the Part B your employer signs is issued from TRACES data.`, { size: 9, color: muted });
  y -= 4;
  row("Employee", s.name); row("Employee number", s.number); if (s.designation) row("Designation", s.designation);
  row("PAN", s.pan ?? "Not on file"); row("Employer", `${a.company}${a.legalEntity ? ` (${a.legalEntity})` : ""}`);
  row("Period", `${s.from} to ${s.to} (${s.months} ${s.months === 1 ? "month" : "months"} paid)`); row("Tax regime", s.regime === "new" ? "New regime (115BAC)" : "Old regime");

  heading("1. Gross salary");
  row("(a) Salary as per section 17(1), paid through payroll", money(s.grossSalaryPaise));
  row("Total gross salary", money(s.grossSalaryPaise), true);
  heading("2. Allowances exempt under section 10");
  row("(a) House rent allowance (10(13A))", money(s.hraExemptPaise));
  row("(b) Flexible benefits declared and other exempt components", money(s.fbpExemptPaise + s.exemptSalaryPaise));
  row("Total exemptions", money(s.hraExemptPaise + s.fbpExemptPaise + s.exemptSalaryPaise), true);
  heading("3. Balance and deductions under section 16");
  row("Salary after exemptions", money(s.grossSalaryPaise - s.hraExemptPaise - s.fbpExemptPaise - s.exemptSalaryPaise));
  row("(a) Standard deduction (16(ia))", money(s.tax.standardDeductionPaise));
  row("(b) Tax on employment / professional tax (16(iii))", money(Math.min(s.deductions.professionalTaxPaise ?? 0, s.tax.regime === "new" ? 0 : s.deductions.professionalTaxPaise ?? 0)));
  heading("4. Other income reported by the employee");
  row("Income from previous employer", money(s.previous.incomePaise));
  row("Other income declared", money(s.otherIncomePaise));
  heading("5. Deductions under chapter VI-A");
  row("(a) Section 80C / 80CCC / 80CCD(1), incl. provident fund (capped)", money(Math.min(s.deductions.section80CPaise ?? 0, s.tax.regime === "new" ? 0 : Number.MAX_SAFE_INTEGER)));
  row("(b) Section 80D, 80CCD(1B), 80E and others", money(s.tax.regime === "new" ? 0 : s.deductions.otherChapterVIAPaise ?? 0));
  row("(c) Interest on home loan (24(b))", money(s.tax.regime === "new" ? 0 : s.deductions.homeLoanInterestPaise ?? 0));
  row("Total chapter VI-A deductions allowed", money(s.chapterVIAPaise), true);
  heading("6. Tax on total income");
  row("Total taxable income", money(s.tax.taxableIncomePaise), true);
  row("Tax on total income", money(s.tax.slabTaxPaise)); row("Rebate under section 87A", money(s.tax.rebatePaise)); row("Surcharge", money(s.tax.surchargePaise)); row("Health and education cess", money(s.tax.cessPaise));
  row("Tax payable", money(s.tax.totalTaxPaise), true);
  rule();
  heading("7. Tax deducted at source");
  row("Deducted by this employer (sections 192)", money(s.tdsPaise));
  row("Deducted by previous employer (as declared)", money(s.previous.tdsPaise));
  const diff = s.tax.totalTaxPaise - s.tdsPaise - s.previous.tdsPaise;
  row(diff > 0 ? "Shortfall (tax still payable)" : "Excess deducted (refund due with the return)", money(Math.abs(diff)), true);

  heading("Month by month");
  for (const m of s.byMonth) row(`${m.month.slice(0, 7)}: gross ${money(m.grossPaise)}, taxable ${money(m.taxablePaise)}`, money(m.tdsPaise));
  y -= 8;
  wrap(`Generated by erp on ${a.generatedOn}. ${s.declarationStatus === "submitted" ? "Deductions come from the employee's submitted declaration; after the proof window only verified amounts count." : "No tax declaration was submitted, so only the standard deduction, provident fund and professional tax are counted."}`);
  if (a.unverified) wrap("UNVERIFIED: the income-tax slabs, limits and rounding used here come from erp's statutory rates, which a chartered accountant has not verified for this company. Check every figure against the official Part B before relying on it.");
  pages.forEach((p, i) => p.drawText(clean(`${a.company} · Form 16 Part B FY ${s.fy} · ${s.number} · Page ${i + 1} of ${pages.length}`), { x: X, y: 30, size: 7.5, font: r, color: muted }));
  return doc.save();
}

// ---------------------------------------------------------------- generate and store

/** Generate (or regenerate) Part B PDFs for the year. Company-wide action; people without finalised pay in the year are skipped. */
export async function generatePartB(tx: Tx, actor: Actor, fyStart: string, employeeIds: string[] | "all") {
  if (!/^\d{4}-04-01$/.test(fyStart)) throw new AppError("invalid", "Pick a financial year.");
  if (!isPayrollAdmin(actor)) throw new AppError("forbidden", "Only payroll admins for the whole company can generate Form 16 Part B.");
  const [t] = await tx<{ name: string }[]>`select name from tenants where id = ${actor.tenant.id}`;
  const unverified = await ratesNeedVerification(tx);
  const people = employeeIds === "all"
    ? await tx<{ id: string }[]>`select distinct l.employee_id as id from payroll_lines l join payroll_runs r on r.id = l.run_id where r.status in ('finalized','payslips_released','paid') and r.period_month between ${fyStart} and ${fyEnd(fyStart)}`
    : employeeIds.map((id) => ({ id }));
  const today = new Date().toISOString().slice(0, 10);
  const done: { employeeId: string; name: string }[] = [], skipped: { employeeId: string; reason: string }[] = [], removed: string[] = [];
  for (const p of people) {
    const s = await yearSummary(tx, p.id, fyStart);
    if (!s) { skipped.push({ employeeId: p.id, reason: "No finalised pay in this financial year." }); continue; }
    const [le] = await tx<{ name: string }[]>`select le.name from employees e join pay_groups g on g.id = e.pay_group_id join legal_entities le on le.id = g.legal_entity_id where e.id = ${p.id}`;
    const bytes = await renderForm16PartB(s, { company: t?.name ?? actor.tenant.name, legalEntity: le?.name ?? null, generatedOn: today, unverified });
    const fileId = await saveFile(tx, { tenantId: actor.tenant.id, userId: actor.userId, name: `Form 16 Part B FY ${s.fy} ${s.number}.pdf`, mime: "application/pdf", bytes, ext: "pdf" });
    const [prev] = await tx<{ part_b_file_id: string | null }[]>`select part_b_file_id from form16_documents where employee_id = ${p.id} and fy_start = ${fyStart}`;
    await tx`
      insert into form16_documents (tenant_id, employee_id, fy_start, part_b_file_id) values (${actor.tenant.id}, ${p.id}, ${fyStart}, ${fileId})
      on conflict (employee_id, fy_start) do update set part_b_file_id = excluded.part_b_file_id, published_at = null, published_by = null, updated_at = now()`;
    if (prev?.part_b_file_id) removed.push(...(await tx<{ storage_key: string }[]>`delete from files where id = ${prev.part_b_file_id} returning storage_key`).map((r) => r.storage_key));
    done.push({ employeeId: p.id, name: s.name });
  }
  await audit(tx, actor, { entityType: "form16", entityId: null, action: "form16.part_b_generated", diff: { fyStart, generated: done.length, skipped: skipped.length } });
  return { generated: done, skipped, removedKeys: removed };
}
