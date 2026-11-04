import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import type { Tx } from "@/server/db";
import type { ApplicationRules } from "./rules";
import { frequencyOf, type AccrualRule, type YearEndRule } from "./accrual-rules";
import type { Level } from "@/server/modules/approvals/service";

/**
 * The leave policy document, generated from a plan's rules so it can never drift from what the system enforces.
 * `policyFor` builds plain-English sections (shown as a page); `policyPdf` lays the same sections out as an A4 PDF.
 */

export type PolicySection = { title: string; code: string; color: string; lines: string[] };
export type PolicyDoc = { plan: { id: string; name: string; description: string | null; yearStart: string }; company: string; generatedOn: string; intro: string[]; sections: PolicySection[]; holidays: string[] };

const YEAR: Record<string, string> = { jan: "1 January to 31 December", apr: "1 April to 31 March", joining_date: "each person's joining anniversary to the day before the next" };
const FREQ: Record<string, string> = { monthly: "every month", quarterly: "every quarter", half_yearly: "every half year", yearly: "once a year", upfront: "in full at the start of the leave year" };
const KIND: Record<string, string> = { regular: "regular leave with a yearly quota", incident: "event-based leave", comp_off: "compensatory off", unpaid: "unpaid leave" };
const APPROVER: Record<string, string> = { manager: "the reporting manager", l2_manager: "the manager's manager", role: "someone holding the role", employee: "a named person" };

const days = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)} ${Math.abs(n) === 1 ? "day" : "days"}`;

type RuleRow = { leave_type_id: string; name: string; code: string; kind: string; color: string; is_paid: boolean; yearly_quota: string | null; accrual: AccrualRule; application: ApplicationRules & { compOffExpiryDays?: number; compOffWindowDays?: number }; year_end: YearEndRule; approval: { auto?: boolean; levels?: Level[] } };

/** Sentences for one leave type's rules. Pure, so the page and the PDF say exactly the same thing. */
export function describeRule(r: RuleRow): string[] {
  const out: string[] = [];
  const quota = r.yearly_quota == null ? null : Number(r.yearly_quota);
  const a = r.application ?? {};
  out.push(`${r.name} (${r.code}) is ${KIND[r.kind] ?? r.kind}${r.is_paid ? ", paid" : ", unpaid"}.`);
  if (r.kind === "comp_off") {
    out.push(`You earn it by working on a weekly off or holiday: one day for each day worked. Claim it within ${a.compOffWindowDays ?? 30} days of the day you worked.`);
    out.push(a.compOffExpiryDays ? `Each credit must be used within ${a.compOffExpiryDays} days of approval; after that it lapses.` : "Credits don't expire.");
  } else if (r.kind === "incident" && quota == null) {
    out.push("It is granted by HR for a specific event (for example a wedding or a bereavement) with a window of dates to use it in. Days that are still unused when the window closes lapse.");
  } else if (quota == null) {
    out.push("There is no yearly limit.");
  } else {
    const acc = r.accrual ?? {};
    const freq = frequencyOf(acc);
    out.push(`You get ${days(quota)} a leave year, credited ${FREQ[freq]}${freq !== "upfront" && freq !== "yearly" && acc.day ? ` on day ${acc.day}` : ""}.`);
    const extras: string[] = [];
    if (acc.prorate_joining !== false) extras.push("people who join mid-year get a share for the months left in the year");
    if (acc.stop_in_probation) extras.push("nothing accrues while on probation");
    if (acc.cap_balance != null) extras.push(`accrual stops once the balance reaches ${days(acc.cap_balance)}`);
    if (acc.stop_after_days_taken != null) extras.push(`accrual stops for the rest of the year after ${days(acc.stop_after_days_taken)} have been taken`);
    if (extras.length) out.push(extras.map((e, i) => (i === 0 ? e[0].toUpperCase() + e.slice(1) : e)).join("; ") + ".");
    const ye = r.year_end ?? {};
    const carry = ye.carry ?? (ye.action === "carry" ? "all" : "none");
    const parts: string[] = [];
    if (carry === "all") parts.push("the whole unused balance carries forward to the next leave year");
    else if (carry === "upto") parts.push(`up to ${days(ye.carry_max ?? 0)} carry forward to the next leave year`);
    if (ye.encash_max) parts.push(`up to ${days(ye.encash_max)} ${parts.length ? "beyond that are" : "are"} encashed with salary`);
    out.push(parts.length ? `At year end, ${parts.join(", ")}, and the rest lapses.` : "At year end, unused days lapse; nothing carries forward.");
  }
  const apply: string[] = [];
  apply.push(a.allowHalfDay ? "Half days are allowed." : "Half days aren't allowed.");
  if (a.noticeDays) apply.push(`Apply at least ${a.noticeDays} ${a.noticeDays === 1 ? "day" : "days"} before the leave starts.`);
  apply.push(a.backdateDays == null ? "Past dates can't be applied for." : a.backdateDays === 0 ? "You can apply on the day itself but not for earlier dates." : `Past dates can be applied for up to ${a.backdateDays} days later.`);
  if (a.maxConsecutiveDays) apply.push(`At most ${days(a.maxConsecutiveDays)} in one request.`);
  if (a.negativeLimit) apply.push(`The balance may go up to ${days(a.negativeLimit)} below zero.`);
  if (a.attachmentAfterDays != null) apply.push(`Requests longer than ${days(a.attachmentAfterDays)} need a supporting document.`);
  if (a.sandwich?.enabled) apply.push(`Weekly offs and holidays that fall between leave days count as leave${a.sandwich.ignoreHalfDays ? " (not when either side is a half day)" : ""}.`);
  else apply.push("Weekly offs and holidays inside a leave period don't count.");
  out.push(apply.join(" "));
  const ap = r.approval ?? {};
  if (ap.auto) out.push("Requests are approved automatically.");
  else if (ap.levels?.length) out.push(`Requests go to ${ap.levels.map((l, i) => `${i + 1}. ${l.approver === "role" ? `${APPROVER.role} ${l.role ?? ""}`.trim() : APPROVER[l.approver] ?? l.approver}`).join(", then ")}.`);
  else out.push("Requests follow the company's leave approval workflow (usually the reporting manager).");
  return out;
}

/** Builds the document for a plan. Null when the plan doesn't exist. */
export async function policyFor(tx: Tx, planId: string, today: string): Promise<PolicyDoc | null> {
  const [plan] = await tx<{ id: string; name: string; description: string | null; year_start: string; company: string }[]>`
    select p.id, p.name, p.description, p.year_start, t.name as company from leave_plans p join tenants t on t.id = p.tenant_id where p.id = ${planId}`;
  if (!plan) return null;
  const rules = await tx<RuleRow[]>`
    select r.leave_type_id, t.name, t.code, t.kind, t.color, t.is_paid, r.yearly_quota, r.accrual, r.application, r.year_end, r.approval
    from leave_plan_rules r join leave_types t on t.id = r.leave_type_id where r.leave_plan_id = ${planId} order by t.kind = 'unpaid', t.name`;
  const lists = await tx<{ name: string; year: number; holidays: number; floaters: number; limit: number }[]>`
    select hl.name, hl.year, count(h.id) filter (where not h.is_floater)::int as holidays, count(h.id) filter (where h.is_floater)::int as floaters, hl.floater_limit as limit
    from holiday_lists hl left join holidays h on h.holiday_list_id = hl.id where hl.year = ${Number(today.slice(0, 4))} group by hl.id order by hl.name`;
  return {
    plan: { id: plan.id, name: plan.name, description: plan.description, yearStart: plan.year_start }, company: plan.company, generatedOn: today,
    intro: [
      `This document describes the ${plan.name} leave plan at ${plan.company}. It is generated from the rules set up in erp, so what you read here is what the system applies when you request leave.`,
      `The leave year runs from ${YEAR[plan.year_start] ?? plan.year_start}. Balances, requests and approvals are always available on your Leave page.`,
      ...(plan.description ? [plan.description] : []),
    ],
    sections: rules.map((r) => ({ title: r.name, code: r.code, color: r.color, lines: describeRule(r) })),
    holidays: lists.map((l) => `${l.name} (${l.year}): ${l.holidays} ${l.holidays === 1 ? "holiday" : "holidays"}${l.floaters ? `, plus ${l.floaters} optional of which you may pick ${l.limit}` : ""}.`),
  };
}

/** Standard PDF fonts only cover Latin-1-ish text; swap anything else for something printable. */
const printable = (font: PDFFont) => (text: string) => {
  let out = "";
  for (const ch of text.replace(/₹/g, "Rs.").replace(/[–—]/g, "-").replace(/[“”]/g, '"').replace(/’/g, "'")) {
    try { font.encodeText(ch); out += ch; } catch { out += "?"; }
  }
  return out;
};

/** The same sections as an A4 PDF: title, intro, one heading per leave type, holidays, page numbers. */
export async function policyPdf(doc: PolicyDoc): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${doc.plan.name} leave policy`); pdf.setAuthor(doc.company); pdf.setCreator("erp"); pdf.setProducer("erp");
  const regular = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const clean = printable(regular);
  const W = 595.28, H = 841.89, M = 60, width = W - M * 2;
  const ink = rgb(0.11, 0.12, 0.14), muted = rgb(0.42, 0.44, 0.48), rule = rgb(0.85, 0.86, 0.88);
  let page = pdf.addPage([W, H]), y = H - M;
  const header = () => {
    page.drawText(clean(doc.company), { x: M, y: H - 40, size: 10, font: bold, color: muted });
    page.drawLine({ start: { x: M, y: H - 48 }, end: { x: W - M, y: H - 48 }, thickness: 0.6, color: rule });
    y = H - M - 10;
  };
  header();
  const ensure = (need: number) => { if (y - need < M) { page = pdf.addPage([W, H]); header(); } };
  const wrap = (text: string, font: PDFFont, size: number) => {
    const words = clean(text).split(/\s+/), lines: string[] = [];
    let line = "";
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) > width && line) { lines.push(line); line = w; } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  };
  const para = (text: string, font: PDFFont, size: number, color = ink, gapAfter = 8) => {
    const lines = wrap(text, font, size), lh = size * 1.45;
    for (const l of lines) { ensure(lh); page.drawText(l, { x: M, y: y - size, size, font, color }); y -= lh; }
    y -= gapAfter;
  };
  para(`${doc.plan.name} leave policy`, bold, 20, ink, 4);
  para(`Generated on ${doc.generatedOn} from the rules in erp.`, regular, 10, muted, 14);
  for (const line of doc.intro) para(line, regular, 11);
  for (const s of doc.sections) {
    ensure(40);
    y -= 6;
    para(`${s.title} (${s.code})`, bold, 14, ink, 6);
    for (const line of s.lines) para(line, regular, 11);
  }
  if (doc.holidays.length) {
    ensure(40); y -= 6;
    para("Holidays", bold, 14, ink, 6);
    for (const line of doc.holidays) para(line, regular, 11);
  }
  const pages = pdf.getPages();
  pages.forEach((p, i) => p.drawText(`Page ${i + 1} of ${pages.length}`, { x: W - M - 60, y: 36, size: 9, font: regular, color: muted }));
  return pdf.save();
}
