/**
 * Expense rules: money parsing, mileage / per-diem amounts, policy checks, advance settlement, claim states, reports, CSV.
 * Pure (no I/O). All money is integer paise; amounts are computed with integers only, rounding half up to the paisa.
 */

// ---------- money ----------
const MAX_PAISE = 1_000_000_000_00;   // ₹1,00,00,00,000 per line: far above any real expense, well inside Number precision

/** "1,234.50" / "₹ 1234.5" / "1234" → paise. Null for empty, negative, more than two decimals or silly sizes. */
export function parseRupees(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  const s = String(input).replace(/[₹,\s]/g, "");
  const m = /^(\d{1,12})(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return null;
  const paise = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return paise > MAX_PAISE ? null : paise;
}

/** Distance in hundredths of a km ("12.5" → 1250). At most two decimals, up to 99,999.99 km. */
export function parseKm(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  const m = /^(\d{1,5})(?:\.(\d{0,2}))?$/.exec(String(input).replace(/[,\s]/g, ""));
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** Days for a per-diem line in halves ("1.5" → 3). Whole or half days, 0.5 to 31. */
export function parseHalfDays(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  const m = /^(\d{1,2})(?:\.(0|5|00|50))?$/.exec(String(input).trim());
  if (!m) return null;
  const halves = Number(m[1]) * 2 + (m[2]?.startsWith("5") ? 1 : 0);
  return halves >= 1 && halves <= 62 ? halves : null;
}

/** Integer division rounding half up (both operands non-negative). */
export const divRound = (num: number, den: number) => Math.floor((num * 2 + den) / (den * 2));

/** Mileage: km × rate per km, rounded half up to the paisa. */
export const mileagePaise = (kmHundredths: number, ratePerKmPaise: number) => divRound(kmHundredths * ratePerKmPaise, 100);

/** Per diem: days × daily rate (half days allowed), rounded half up to the paisa. */
export const perDiemPaise = (halfDays: number, dailyRatePaise: number) => divRound(halfDays * dailyRatePaise, 2);

export function inr(paise: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(paise / 100);
}
/** Hundredths of a km → "12.5 km". */
export const kmLabel = (h: number) => `${(h / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })} km`;
/** Plain rupees for inputs: 123450 → "1234.50". */
export const rupeesText = (paise: number | null | undefined) => (paise == null ? "" : `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, "0")}`);

// ---------- categories ----------
export const CATEGORY_KINDS = [
  { value: "general", label: "General", hint: "Enter the amount on the receipt" },
  { value: "mileage", label: "Mileage", hint: "Distance × rate per km" },
  { value: "travel", label: "Travel", hint: "Flights, trains, cabs and hotels" },
  { value: "per_diem", label: "Per diem", hint: "Days away × daily allowance" },
] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number]["value"];
export const LIMIT_PERIODS = [
  { value: "claim", label: "per claim" },
  { value: "day", label: "per day" },
  { value: "month", label: "per month" },
  { value: "year", label: "per year" },
] as const;
export type LimitPeriod = (typeof LIMIT_PERIODS)[number]["value"];

export type Category = {
  id: string; name: string; kind: CategoryKind;
  limit_paise: number | null; limit_period: LimitPeriod | null;
  rate_per_km_paise: number | null; receipt_required_above_paise: number | null; gl_code: string | null;
};

export type CategoryInput = {
  name: string; kind: CategoryKind; limitPaise: number | null; limitPeriod: LimitPeriod | null;
  ratePerKmPaise: number | null; receiptAbovePaise: number | null; glCode: string | null;
};

/** Checks a category definition. Returns the first problem as { field, message }, or null when it's fine. */
export function categoryProblem(c: CategoryInput): { field: string; message: string } | null {
  if (!c.name.trim()) return { field: "name", message: "Give the category a name." };
  if (c.limitPaise != null && c.limitPaise <= 0) return { field: "limitPaise", message: "A limit must be more than zero." };
  if (c.limitPaise != null && !c.limitPeriod) return { field: "limitPeriod", message: "Say whether the limit is per claim, day, month or year." };
  if (c.kind === "mileage" && !(c.ratePerKmPaise && c.ratePerKmPaise > 0)) return { field: "ratePerKmPaise", message: "Mileage needs a rate per km." };
  if (c.kind === "per_diem" && !(c.limitPaise && c.limitPeriod === "day")) return { field: "limitPaise", message: "Per diem needs a daily allowance (a limit per day)." };
  if (c.receiptAbovePaise != null && c.receiptAbovePaise < 0) return { field: "receiptAbovePaise", message: "Use zero or more." };
  if (c.glCode && !/^[A-Za-z0-9._\-/ ]{1,30}$/.test(c.glCode)) return { field: "glCode", message: "Use up to 30 letters, numbers, dots or dashes." };
  return null;
}

// ---------- policy checks ----------
export type ViolationCode = "receipt_missing" | "future_dated" | "late" | "duplicate" | "over_limit_claim" | "over_limit_day" | "over_limit_month" | "over_limit_year";
/** These stop a claim from being submitted. The rest are shown to the employee and flagged to approvers. */
export const BLOCKING: ReadonlySet<ViolationCode> = new Set(["receipt_missing", "future_dated"]);

export type Line = { id: string; categoryId: string; claimId: string | null; spentOn: string; amountPaise: number; receipts: number; merchant: string | null };
export type PolicyRules = { allowFutureDated: boolean; submissionDeadlineDays: number | null };

const dayDiff = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);

/**
 * Problems with one expense line. `others` are the person's other live lines (unclaimed, or in claims that weren't
 * rejected), used for per-day / month / year limits, duplicates, and the claim limit (lines in the same claim).
 */
export function checkLine(line: Line, cat: Category, policy: PolicyRules, today: string, others: Line[]): ViolationCode[] {
  const out: ViolationCode[] = [];
  if (cat.receipt_required_above_paise != null && line.amountPaise > cat.receipt_required_above_paise && line.receipts === 0) out.push("receipt_missing");
  if (!policy.allowFutureDated && line.spentOn > today) out.push("future_dated");
  if (policy.submissionDeadlineDays != null && dayDiff(line.spentOn, today) > policy.submissionDeadlineDays) out.push("late");
  const same = others.filter((o) => o.id !== line.id && o.categoryId === line.categoryId);
  const norm = (s: string | null) => (s ?? "").trim().toLowerCase();
  if (same.some((o) => o.spentOn === line.spentOn && o.amountPaise === line.amountPaise && norm(o.merchant) === norm(line.merchant))) out.push("duplicate");
  // per diem amounts are worked out from the daily allowance, so the allowance isn't also a limit on the line
  if (cat.kind !== "per_diem" && cat.limit_paise != null && cat.limit_period) {
    const inWindow = (o: Line) =>
      cat.limit_period === "claim" ? line.claimId != null && o.claimId === line.claimId
      : cat.limit_period === "day" ? o.spentOn === line.spentOn
      : cat.limit_period === "month" ? o.spentOn.slice(0, 7) === line.spentOn.slice(0, 7)
      : o.spentOn.slice(0, 4) === line.spentOn.slice(0, 4);
    const total = line.amountPaise + same.filter(inWindow).reduce((s, o) => s + o.amountPaise, 0);
    if (total > cat.limit_paise) out.push(`over_limit_${cat.limit_period}` as ViolationCode);
  }
  return out;
}

export function violationText(code: string, cat?: Pick<Category, "limit_paise" | "receipt_required_above_paise"> | null, policy?: PolicyRules | null): string {
  const lim = cat?.limit_paise != null ? inr(cat.limit_paise) : "the limit";
  switch (code) {
    case "receipt_missing": return cat?.receipt_required_above_paise ? `Attach a receipt: it's needed above ${inr(cat.receipt_required_above_paise)}.` : "Attach a receipt.";
    case "future_dated": return "The date is in the future.";
    case "late": return policy?.submissionDeadlineDays != null ? `Older than ${policy.submissionDeadlineDays} days, so it's past the claim deadline.` : "Past the claim deadline.";
    case "duplicate": return "Looks like a duplicate: same date, amount and merchant as another expense.";
    case "over_limit_claim": return `Over ${lim} for this category in one claim.`;
    case "over_limit_day": return `Over ${lim} for this category on this day.`;
    case "over_limit_month": return `Over ${lim} for this category this month.`;
    case "over_limit_year": return `Over ${lim} for this category this year.`;
    default: return code;
  }
}
export const isBlocking = (code: string) => BLOCKING.has(code as ViolationCode);

// ---------- claims ----------
export type ClaimStatus = "draft" | "submitted" | "approved" | "rejected" | "paid";
const NEXT: Record<ClaimStatus, ClaimStatus[]> = {
  draft: ["submitted"],
  submitted: ["approved", "rejected", "draft"],   // draft = withdrawn by the employee
  approved: ["paid"],
  rejected: ["draft"],                            // reopened to fix and resubmit
  paid: [],
};
export const canMove = (from: ClaimStatus, to: ClaimStatus) => NEXT[from]?.includes(to) ?? false;
export const isEditable = (s: ClaimStatus) => s === "draft";

/**
 * Settling an approved claim against an advance the person already received: the advance covers as much of the claim
 * as it still can; the rest is paid out. Never negative, never more than either side.
 */
export function settleAgainstAdvance(claimTotalPaise: number, advance: { amount_paise: number; settled_paise: number } | null) {
  if (!advance) return { applied: 0, payable: claimTotalPaise, settledAfter: 0, fullySettled: false };
  const outstanding = Math.max(0, advance.amount_paise - advance.settled_paise);
  const applied = Math.min(outstanding, claimTotalPaise);
  const settledAfter = advance.settled_paise + applied;
  return { applied, payable: claimTotalPaise - applied, settledAfter, fullySettled: settledAfter >= advance.amount_paise };
}

// ---------- payroll months ----------
export const monthOf = (iso: string) => iso.slice(0, 7) + "-01";
export const isMonthStart = (s: string) => /^\d{4}-(0[1-9]|1[0-2])-01$/.test(s);
/** Expense payouts can go into this month's payroll or a later one, at most a year ahead. */
export function schedulableMonth(month: string, today: string): string | null {
  if (!isMonthStart(month)) return "Pick a month.";
  const cur = monthOf(today);
  if (month < cur) return "That payroll month has passed. Pick this month or a later one.";
  const [y, m] = cur.split("-").map(Number);
  const max = `${y + 1}-${String(m).padStart(2, "0")}-01`;
  if (month > max) return "Pick a month within the next year.";
  return null;
}
export const monthLabel = (month: string) => new Date(month.slice(0, 7) + "-01T00:00:00Z").toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
/** The current month and the next few, for the schedule picker. */
export function upcomingMonths(today: string, n = 4) {
  const [y, m] = today.split("-").map(Number);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
  });
}

// ---------- reports ----------
export type ReportRow = { category: string; department: string | null; spentOn: string; amountPaise: number };
export type Group = { key: string; totalPaise: number; count: number };

/** Totals by category, department and month (largest first; months in date order). */
export function summarize(rows: ReportRow[]) {
  const by = (k: (r: ReportRow) => string) => {
    const m = new Map<string, Group>();
    for (const r of rows) {
      const key = k(r);
      const g = m.get(key) ?? { key, totalPaise: 0, count: 0 };
      g.totalPaise += r.amountPaise; g.count += 1;
      m.set(key, g);
    }
    return [...m.values()];
  };
  const big = (a: Group, b: Group) => b.totalPaise - a.totalPaise || a.key.localeCompare(b.key);
  return {
    totalPaise: rows.reduce((s, r) => s + r.amountPaise, 0),
    count: rows.length,
    byCategory: by((r) => r.category).sort(big),
    byDepartment: by((r) => r.department ?? "No department").sort(big),
    byMonth: by((r) => r.spentOn.slice(0, 7)).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

const isDate = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
/** Report period from the URL: defaults to the start of the month two months back until today; swapped if reversed; at most ~2 years. */
export function reportRange(from: string | null, to: string | null, today: string) {
  const [y, m] = today.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 3, 1));
  let f = isDate(from) ? from : d.toISOString().slice(0, 10);
  let t = isDate(to) ? to : today;
  if (f > t) [f, t] = [t, f];
  const minFrom = `${Number(t.slice(0, 4)) - 2}${t.slice(4)}`;
  if (f < minFrom) f = minFrom;
  return { from: f, to: t };
}

/** RFC 4180 CSV. Cells that a spreadsheet would run as a formula (=, +, -, @, tab, CR) are prefixed with a quote. */
export function toCsv(rows: (string | number | null | undefined)[][]) {
  const cell = (v: string | number | null | undefined) => {
    if (v == null) return "";
    if (typeof v === "number") return String(v);
    const s = /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
/** Paise → "1234.50" for CSV (exact, no float maths). */
export const csvAmount = (paise: number) => (paise < 0 ? "-" : "") + rupeesText(Math.abs(paise));

// ---------- receipts ----------
export const RECEIPT_EXTS = new Set(["pdf", "png", "jpg", "jpeg"]);
export const RECEIPT_ACCEPT = ".pdf,.png,.jpg,.jpeg";
export const RECEIPT_LABEL = "PDF, PNG or JPG, up to 5 MB each";
export const MAX_RECEIPTS = 5;
export const extOf = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");
