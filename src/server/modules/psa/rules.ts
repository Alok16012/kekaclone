/** Pure rules for projects, weekly timesheets and invoices. No database, no clock: callers pass today. */
import { addDaysISO, fromISO, type ISODate } from "@/lib/dates";

export const BILLING_MODELS = ["time_and_materials", "retainer", "fixed", "non_billable"] as const;
export type BillingModel = (typeof BILLING_MODELS)[number];
export const BILLING_LABEL: Record<BillingModel, string> = {
  time_and_materials: "Time and materials", retainer: "Monthly retainer", fixed: "Fixed price (milestones)", non_billable: "Not billable",
};
export const PROJECT_STATUSES = ["active", "on_hold", "completed", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = { active: "Active", on_hold: "On hold", completed: "Completed", archived: "Archived" };

export type TimesheetStatus = "draft" | "submitted" | "approved" | "rejected";
export const TIMESHEET_STATUS_LABEL: Record<TimesheetStatus, string> = { draft: "Draft", submitted: "Waiting for approval", approved: "Approved", rejected: "Sent back" };

export type InvoiceStatus = "draft" | "sent" | "paid" | "void";
export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = { draft: "Draft", sent: "Sent", paid: "Paid", void: "Void" };

export type Policy = {
  cadence: "weekly" | "daily";
  min_minutes_per_day: number; min_minutes_per_week: number; max_minutes_per_day: number;
  lock_after_days: number | null; approver: "project" | "manager"; allow_future: boolean; require_note: boolean;
};
export const DEFAULT_POLICY: Policy = {
  cadence: "weekly", min_minutes_per_day: 0, min_minutes_per_week: 0, max_minutes_per_day: 720, lock_after_days: 30, approver: "project", allow_future: false, require_note: false,
};

export type Problem = { field: string; message: string };

// ---------- weeks ----------
/** Monday of the week that holds this date. */
export function weekStartOf(date: ISODate): ISODate {
  const dow = fromISO(date).getUTCDay();            // 0 = Sunday
  return addDaysISO(date, dow === 0 ? -6 : 1 - dow);
}
export const weekDays = (weekStart: ISODate): ISODate[] => Array.from({ length: 7 }, (_, i) => addDaysISO(weekStart, i));
export const isWeekStart = (d: ISODate) => /^\d{4}-\d{2}-\d{2}$/.test(d) && fromISO(d).getUTCDay() === 1;

/** A week is locked when its last day is more than `lockAfterDays` days before today (null = never). */
export function isWeekLocked(weekStart: ISODate, today: ISODate, lockAfterDays: number | null) {
  if (lockAfterDays == null) return false;
  return addDaysISO(weekStart, 6 + lockAfterDays) < today;
}

export function fmtWeek(weekStart: ISODate) {
  const f = (d: ISODate, o: Intl.DateTimeFormatOptions) => fromISO(d).toLocaleDateString("en-IN", { ...o, timeZone: "UTC" });
  const end = addDaysISO(weekStart, 6);
  return weekStart.slice(0, 7) === end.slice(0, 7)
    ? `${f(weekStart, { day: "numeric" })}–${f(end, { day: "numeric", month: "short", year: "numeric" })}`
    : `${f(weekStart, { day: "numeric", month: "short" })} – ${f(end, { day: "numeric", month: "short", year: "numeric" })}`;
}

// ---------- durations ----------
/** "8", "8.5", "8:30", "8h 30m", "45m" → minutes. Empty → 0. Anything else → null. */
export function parseDuration(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return 0;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{1,2}):([0-5]\d)$/))) return Number(m[1]) * 60 + Number(m[2]);
  if ((m = s.match(/^(\d{1,2}(?:\.\d{1,2})?)h?$/))) return Math.round(Number(m[1]) * 60);
  if ((m = s.match(/^(?:(\d{1,2})h)?\s*(?:(\d{1,3})m)?$/)) && (m[1] || m[2])) return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
  return null;
}
export function formatMinutes(min: number) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}
export const hours = (min: number) => Math.round((min / 60) * 100) / 100;

// ---------- the grid ----------
export type GridRow = { projectId: string; taskId: string | null; billable: boolean; note: string; minutes: number[] };

/** Entry-level checks that apply on every save. */
export function validateGrid(rows: GridRow[], policy: Policy, ctx: { weekStart: ISODate; today: ISODate }): Problem[] {
  const problems: Problem[] = [];
  const days = weekDays(ctx.weekStart);
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const key = `${r.projectId}:${r.taskId ?? ""}`;
    if (seen.has(key)) problems.push({ field: `rows.${i}`, message: "This project and task is already on another row. Merge them." });
    seen.add(key);
    if (r.minutes.length !== 7) problems.push({ field: `rows.${i}`, message: "Each row needs seven days." });
    r.minutes.forEach((m, d) => {
      if (!Number.isInteger(m) || m < 0 || m > 1440) problems.push({ field: `rows.${i}.${d}`, message: "Hours must be between 0 and 24." });
      if (m > 0 && !policy.allow_future && days[d] > ctx.today) problems.push({ field: `rows.${i}.${d}`, message: "You can't log time for a day that hasn't happened yet." });
    });
    if (policy.require_note && r.minutes.some((m) => m > 0) && !r.note.trim()) problems.push({ field: `rows.${i}.note`, message: "Add a note saying what you worked on." });
    if (r.note.length > 500) problems.push({ field: `rows.${i}.note`, message: "Keep the note under 500 characters." });
  });
  for (let d = 0; d < 7; d++) {
    const total = rows.reduce((t, r) => t + (r.minutes[d] ?? 0), 0);
    if (total > policy.max_minutes_per_day) problems.push({ field: `day.${d}`, message: `${formatMinutes(total)} on ${days[d]} is over the ${formatMinutes(policy.max_minutes_per_day)} daily limit.` });
  }
  return problems;
}

/** Extra checks when submitting: the minimums, counted on weekdays only. */
export function validateSubmit(rows: GridRow[], policy: Policy, ctx: { weekStart: ISODate; today: ISODate }): Problem[] {
  const problems: Problem[] = [];
  const days = weekDays(ctx.weekStart);
  const dayTotals = days.map((_, d) => rows.reduce((t, r) => t + (r.minutes[d] ?? 0), 0));
  const total = dayTotals.reduce((a, b) => a + b, 0);
  if (total === 0) problems.push({ field: "form", message: "Log some hours before submitting." });
  if (policy.cadence === "daily" && policy.min_minutes_per_day > 0) {
    days.forEach((day, d) => {
      const dow = fromISO(day).getUTCDay();
      if (dow === 0 || dow === 6 || day > ctx.today) return;
      if (dayTotals[d] < policy.min_minutes_per_day) problems.push({ field: `day.${d}`, message: `${day} has ${formatMinutes(dayTotals[d])}, below the ${formatMinutes(policy.min_minutes_per_day)} daily minimum.` });
    });
  }
  if (policy.min_minutes_per_week > 0 && total < policy.min_minutes_per_week) {
    problems.push({ field: "form", message: `This week has ${formatMinutes(total)}, below the ${formatMinutes(policy.min_minutes_per_week)} weekly minimum.` });
  }
  return problems;
}

export type EntryLike = { minutes: number; is_billable: boolean; project_id: string };
export function summarize(entries: EntryLike[]) {
  const byProject = new Map<string, number>();
  let total = 0, billable = 0;
  for (const e of entries) {
    total += e.minutes;
    if (e.is_billable) billable += e.minutes;
    byProject.set(e.project_id, (byProject.get(e.project_id) ?? 0) + e.minutes);
  }
  return { total, billable, byProject };
}

/** Which timesheet actions the viewer may take. Approving your own sheet is never allowed. */
export function timesheetActions(s: { status: TimesheetStatus; locked: boolean; invoiced: boolean }, viewer: { owner: boolean; admin: boolean }) {
  return {
    edit: viewer.owner && !s.locked && (s.status === "draft" || s.status === "rejected"),
    submit: viewer.owner && !s.locked && (s.status === "draft" || s.status === "rejected"),
    withdraw: viewer.owner && s.status === "submitted",
    reopen: viewer.admin && s.status === "approved" && !s.invoiced,
  };
}

// ---------- invoices ----------
export type InvoiceLine = { description: string; quantity: number; unit_paise: number; amount_paise: number; employee_id?: string; milestone_id?: string };

export function invoiceNumber(n: number) { return `INV-${String(n).padStart(4, "0")}`; }
export const roundPaise = (x: number) => Math.round(x);

/** T&M lines: one per person, hours × their bill rate on the project. Missing rates come out as zero so finance sees them. */
export function tmLines(entries: { employee_id: string; employee: string; minutes: number; bill_rate_paise: number | null }[]): { lines: InvoiceLine[]; missingRates: string[] } {
  const byPerson = new Map<string, { employee: string; minutes: number; rate: number | null }>();
  for (const e of entries) {
    const cur = byPerson.get(e.employee_id) ?? { employee: e.employee, minutes: 0, rate: e.bill_rate_paise };
    cur.minutes += e.minutes;
    byPerson.set(e.employee_id, cur);
  }
  const lines: InvoiceLine[] = [], missingRates: string[] = [];
  for (const [employee_id, p] of byPerson) {
    const qty = hours(p.minutes);
    const rate = p.rate ?? 0;
    if (p.rate == null) missingRates.push(p.employee);
    lines.push({ description: `${p.employee} · ${qty} h`, quantity: qty, unit_paise: rate, amount_paise: roundPaise(qty * rate), employee_id });
  }
  lines.sort((a, b) => a.description.localeCompare(b.description));
  return { lines, missingRates };
}

export function totals(lines: InvoiceLine[], taxRateBp: number) {
  const subtotal = lines.reduce((t, l) => t + l.amount_paise, 0);
  const tax = roundPaise((subtotal * taxRateBp) / 10000);
  return { subtotal, tax, total: subtotal + tax };
}

const INVOICE_FLOW: Record<InvoiceStatus, InvoiceStatus[]> = { draft: ["sent", "void"], sent: ["paid", "void"], paid: [], void: [] };
export const canMoveInvoice = (from: InvoiceStatus, to: InvoiceStatus) => INVOICE_FLOW[from].includes(to);

/** "Acme Website Revamp" → "AWR"; falls back to the first letters of the name. */
export function projectCodeFrom(name: string) {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const code = words.length >= 2 ? words.map((w) => w[0]).join("").slice(0, 6) : (words[0] ?? "").slice(0, 6);
  return code || "PRJ";
}

export function validateProject(p: { name: string; code: string; billingModel: string; retainerPaise: number | null; startDate: string | null; endDate: string | null; currency: string }): Problem[] {
  const out: Problem[] = [];
  if (!p.name.trim()) out.push({ field: "name", message: "Give the project a name." });
  if (p.name.length > 120) out.push({ field: "name", message: "Keep the name under 120 characters." });
  if (!/^[A-Z0-9-]{2,12}$/.test(p.code)) out.push({ field: "code", message: "Code: 2–12 capital letters, digits or dashes." });
  if (!(BILLING_MODELS as readonly string[]).includes(p.billingModel)) out.push({ field: "billingModel", message: "Pick a billing model." });
  if (p.billingModel === "retainer" && (!p.retainerPaise || p.retainerPaise <= 0)) out.push({ field: "retainerPaise", message: "A retainer needs a monthly amount." });
  if (p.startDate && p.endDate && p.endDate < p.startDate) out.push({ field: "endDate", message: "The end date can't be before the start." });
  if (!/^[A-Z]{3}$/.test(p.currency)) out.push({ field: "currency", message: "Currency is a 3-letter code like INR." });
  return out;
}

export function validateClient(c: { name: string; gstin: string | null }): Problem[] {
  const out: Problem[] = [];
  if (!c.name.trim()) out.push({ field: "name", message: "Give the client a name." });
  if (c.name.length > 120) out.push({ field: "name", message: "Keep the name under 120 characters." });
  if (c.gstin && !/^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$/.test(c.gstin)) out.push({ field: "gstin", message: "That doesn't look like a 15-character GSTIN." });
  return out;
}

export function validatePolicy(p: Policy): Problem[] {
  const out: Problem[] = [];
  const int = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!int(p.min_minutes_per_day, 0, 1440)) out.push({ field: "min_minutes_per_day", message: "Daily minimum must be 0–24 hours." });
  if (!int(p.min_minutes_per_week, 0, 10080)) out.push({ field: "min_minutes_per_week", message: "Weekly minimum must be 0–168 hours." });
  if (!int(p.max_minutes_per_day, 60, 1440)) out.push({ field: "max_minutes_per_day", message: "Daily limit must be 1–24 hours." });
  if (p.min_minutes_per_day > p.max_minutes_per_day) out.push({ field: "min_minutes_per_day", message: "The daily minimum can't be above the daily limit." });
  if (p.lock_after_days != null && !int(p.lock_after_days, 0, 365)) out.push({ field: "lock_after_days", message: "Lock after 0–365 days, or leave it empty." });
  if (!["weekly", "daily"].includes(p.cadence)) out.push({ field: "cadence", message: "Pick weekly or daily." });
  if (!["project", "manager"].includes(p.approver)) out.push({ field: "approver", message: "Pick who approves." });
  return out;
}

export function formatINR(paise: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(paise / 100);
}
