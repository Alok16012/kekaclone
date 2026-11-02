/**
 * Loans: EMI schedules (interest-free, flat and reducing balance), broken-period ("pre-EMI") interest, skipping an EMI,
 * rescheduling after a prepayment, and what is still owed. Pure: no I/O, no clock. Money is integer paise; interest maths
 * is exact (BigInt) and rounded once where stated:
 *   - the EMI (and, for flat loans, each month's principal and interest share) to the nearest rupee, the last EMI taking the remainder;
 *   - reducing-balance interest each month to the nearest paisa on the opening balance;
 *   - pre-EMI interest to the nearest paisa (simple interest, actual days / 365).
 * These are company-policy choices, not statutory rules.
 */

export const RATE_TYPES = ["zero", "flat", "reducing"] as const;
export type RateType = (typeof RATE_TYPES)[number];
export const RATE_TYPE_LABEL: Record<RateType, string> = { zero: "Interest-free", flat: "Flat rate", reducing: "Reducing balance" };
export const MAX_TENURE_MONTHS = 360;
export const MAX_LOAN_PAISE = 1_00_00_000_00; // ₹1 crore

const B2 = BigInt(2), B100 = BigInt(100);
const RUPEE = B100;

function divRound(n: bigint, d: bigint): bigint {
  // half-up for non-negative numbers
  return (B2 * n + d) / (B2 * d);
}
const roundToRupee = (n: bigint, d: bigint) => divRound(n, d * RUPEE) * RUPEE;

function money(name: string, v: number) {
  if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${name} must be a whole, non-negative number of paise (got ${v})`);
  return v;
}

/** "9.5" / "9.50" / 9.5 → 950 basis points (two decimals at most, like numeric(5,2)). null when it isn't a valid rate. */
export function rateToBp(rate: string | number): number | null {
  const s = String(rate).trim();
  const m = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}
export const bpToRate = (bp: number) => (bp / 100).toFixed(2);

// ---------------------------------------------------------------- months
export const isMonth = (s: string) => /^\d{4}-(0[1-9]|1[0-2])-01$/.test(s);
export function addMonths(month: string, n: number) {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}-01`;
}
export const monthOf = (date: string) => `${date.slice(0, 7)}-01`;
const dayNumber = (d: string) => Math.round(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86_400_000);
export const monthLabel = (month: string) => new Date(`${month.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });

// ---------------------------------------------------------------- EMI
export type Terms = { principalPaise: number; rateBp: number; rateType: RateType; months: number };

function checkTerms(t: Terms) {
  money("principalPaise", t.principalPaise);
  if (t.principalPaise <= 0) throw new RangeError("principal must be positive");
  if (!Number.isInteger(t.months) || t.months < 1 || t.months > MAX_TENURE_MONTHS) throw new RangeError(`months must be 1–${MAX_TENURE_MONTHS}`);
  if (!Number.isInteger(t.rateBp) || t.rateBp < 0 || t.rateBp > 9999) throw new RangeError("rate must be 0–99.99%");
  if (t.rateType !== "zero" && t.rateBp === 0) return { ...t, rateType: "zero" as const };
  if (t.rateType === "zero") return { ...t, rateBp: 0 };
  return t;
}

/** Total flat interest: principal × rate × months / 12, to the nearest rupee. */
export function flatInterest(principalPaise: number, rateBp: number, months: number) {
  return Number(roundToRupee(BigInt(principalPaise) * BigInt(rateBp) * BigInt(months), BigInt(10_000 * 12)));
}

/** Equal share of `total` over `n` months, rounded to the rupee (rounded down instead if rounding up would overshoot). */
function share(total: number, n: number) {
  if (n === 1) return total;
  let s = Number(roundToRupee(BigInt(total), BigInt(n)));
  if (s * (n - 1) > total) s = Math.floor(total / n / 100) * 100;
  return s;
}

/**
 * The monthly instalment. Reducing balance: P·r·(1+r)^n / ((1+r)^n − 1) with r = rate/12, computed exactly and rounded to the rupee.
 * Flat: (principal + flat interest) / months. Interest-free: principal / months. The last EMI of a schedule may differ.
 */
export function emiFor(terms: Terms): number {
  const t = checkTerms(terms);
  if (t.rateType === "zero") return share(t.principalPaise, t.months);
  if (t.rateType === "flat") return share(t.principalPaise, t.months) + share(flatInterest(t.principalPaise, t.rateBp, t.months), t.months);
  const B = BigInt(120_000), A = B + BigInt(t.rateBp), n = BigInt(t.months);
  const An = A ** n, Bn = B ** n;
  return Number(roundToRupee(BigInt(t.principalPaise) * BigInt(t.rateBp) * An, B * (An - Bn)));
}

export type ScheduleRow = { n: number; dueMonth: string; openingPaise: number; principalPaise: number; interestPaise: number; emiPaise: number; closingPaise: number };

/**
 * The full schedule from `firstMonth`. `extraFirstInterestPaise` (pre-EMI interest) is added to the first row's interest.
 * Principal always sums to exactly the loan amount.
 */
export function buildSchedule(terms: Terms & { firstMonth: string; extraFirstInterestPaise?: number }): ScheduleRow[] {
  const t = checkTerms(terms);
  if (!isMonth(terms.firstMonth)) throw new RangeError("firstMonth must be YYYY-MM-01");
  const extra = money("extraFirstInterestPaise", terms.extraFirstInterestPaise ?? 0);
  const rows: ScheduleRow[] = [];
  let balance = t.principalPaise;
  if (t.rateType === "reducing") {
    const emi = emiFor(t);
    for (let k = 1; k <= t.months; k++) {
      const interest = Number(divRound(BigInt(balance) * BigInt(t.rateBp), BigInt(120_000)));
      let principal = emi - interest;
      if (k === t.months || principal >= balance) principal = balance;
      if (principal < 0) principal = 0;
      rows.push({ n: k, dueMonth: addMonths(terms.firstMonth, k - 1), openingPaise: balance, principalPaise: principal, interestPaise: interest, emiPaise: principal + interest, closingPaise: balance - principal });
      balance -= principal;
      if (balance === 0) break;
    }
  } else {
    const pShare = share(t.principalPaise, t.months);
    const totalInterest = t.rateType === "flat" ? flatInterest(t.principalPaise, t.rateBp, t.months) : 0;
    const iShare = share(totalInterest, t.months);
    let interestLeft = totalInterest;
    for (let k = 1; k <= t.months; k++) {
      const last = k === t.months;
      const principal = last ? balance : Math.min(pShare, balance);
      const interest = last ? interestLeft : Math.min(iShare, interestLeft);
      rows.push({ n: k, dueMonth: addMonths(terms.firstMonth, k - 1), openingPaise: balance, principalPaise: principal, interestPaise: interest, emiPaise: principal + interest, closingPaise: balance - principal });
      balance -= principal; interestLeft -= interest;
    }
  }
  if (extra && rows[0]) { rows[0].interestPaise += extra; rows[0].emiPaise += extra; }
  return rows;
}

export const scheduleTotals = (rows: Pick<ScheduleRow, "principalPaise" | "interestPaise">[]) => ({
  principalPaise: rows.reduce((s, r) => s + r.principalPaise, 0),
  interestPaise: rows.reduce((s, r) => s + r.interestPaise, 0),
  totalPaise: rows.reduce((s, r) => s + r.principalPaise + r.interestPaise, 0),
});

/**
 * Broken-period interest: the regular schedule charges interest from the first day of the month before the first EMI.
 * Money paid out earlier than that earns simple interest for the extra days (actual / 365). Interest-free loans: none.
 */
export function preEmiInterest(a: { principalPaise: number; rateBp: number; rateType: RateType; disbursedOn: string; firstEmiMonth: string }) {
  money("principalPaise", a.principalPaise);
  if (!isMonth(a.firstEmiMonth)) throw new RangeError("firstEmiMonth must be YYYY-MM-01");
  const accrualStart = addMonths(a.firstEmiMonth, -1);
  const days = Math.max(0, dayNumber(accrualStart) - dayNumber(a.disbursedOn));
  if (a.rateType === "zero" || a.rateBp === 0 || days === 0) return { days, interestPaise: 0 };
  return { days, interestPaise: Number(divRound(BigInt(a.principalPaise) * BigInt(a.rateBp) * BigInt(days), BigInt(10_000 * 365))) };
}

/** The first EMI month by default: the month after the money is paid out. It can't be before that month. */
export const defaultFirstEmiMonth = (disbursedOn: string) => addMonths(monthOf(disbursedOn), 1);
export function checkFirstEmiMonth(disbursedOn: string, firstEmiMonth: string): string | null {
  if (!isMonth(firstEmiMonth)) return "Pick the month the first EMI is taken.";
  if (firstEmiMonth < monthOf(disbursedOn)) return "The first EMI can't be before the month the loan is paid out.";
  if (firstEmiMonth > addMonths(monthOf(disbursedOn), 6)) return "Start EMIs within 6 months of paying out the loan.";
  return null;
}

// ---------------------------------------------------------------- policy checks
export type CategoryLimits = { name: string; maxAmountPaise: number | null; maxTenureMonths: number | null };
const inr = (p: number) => "₹" + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(p / 100);
export const formatPaise = inr;

/** A request against a category's limits. Returns the problem in plain words, or null. */
export function checkRequest(c: CategoryLimits, r: { amountPaise: number; months: number }): { message: string; field: "amount" | "months" } | null {
  if (!Number.isSafeInteger(r.amountPaise) || r.amountPaise <= 0) return { message: "Enter the amount you need.", field: "amount" };
  if (r.amountPaise < 100_00) return { message: "Loans start at ₹100.", field: "amount" };
  if (r.amountPaise > MAX_LOAN_PAISE) return { message: `Loans can be at most ${inr(MAX_LOAN_PAISE)}.`, field: "amount" };
  if (c.maxAmountPaise != null && r.amountPaise > c.maxAmountPaise) return { message: `${c.name} loans go up to ${inr(c.maxAmountPaise)}.`, field: "amount" };
  if (!Number.isInteger(r.months) || r.months < 1) return { message: "Pick how many months you'll repay over.", field: "months" };
  const max = Math.min(c.maxTenureMonths ?? MAX_TENURE_MONTHS, MAX_TENURE_MONTHS);
  if (r.months > max) return { message: `${c.name} loans are repaid over at most ${max} months.`, field: "months" };
  return null;
}

// ---------------------------------------------------------------- after disbursal
export type Installment = { id?: string; dueMonth: string; principalPaise: number; interestPaise: number; status: "scheduled" | "deducted" | "skipped" | "prepaid" };

/**
 * Skipping an EMI: that month is marked skipped and the same principal and interest move to a new instalment after the
 * last one, so the tenure grows by a month and no extra interest is charged. Returns the month the moved EMI lands in.
 */
export function skipTarget(rows: Pick<Installment, "dueMonth" | "status">[], month: string): { ok: true; newMonth: string } | { ok: false; error: string } {
  const row = rows.find((r) => r.dueMonth === month);
  if (!row) return { ok: false, error: "There's no EMI due that month." };
  if (row.status !== "scheduled") return { ok: false, error: "Only an EMI that hasn't been taken yet can be skipped." };
  const last = rows.reduce((m, r) => (r.dueMonth > m ? r.dueMonth : m), rows[0].dueMonth);
  return { ok: true, newMonth: addMonths(last, 1) };
}

/** Principal still owed: the loan, less principal taken through payroll, less money paid back outside it. */
export function outstandingPrincipal(principalPaise: number, rows: Pick<Installment, "principalPaise" | "status">[], prepaidPaise: number) {
  const repaid = rows.filter((r) => r.status === "deducted").reduce((s, r) => s + r.principalPaise, 0);
  return Math.max(0, principalPaise - repaid - prepaidPaise);
}

/**
 * A prepayment against the open schedule. `lockedPrincipalPaise` is principal in EMIs already locked into a finalised payroll
 * month (they will still be taken). Pays off principal only; interest that isn't due yet is not charged.
 *  - the whole remainder: every open EMI becomes "prepaid" and the loan closes once locked EMIs are taken;
 *  - part of it: the open EMIs are rebuilt on the lower balance over the same number of months (flat loans: flat interest on the new balance).
 */
export function planPrepayment(a: {
  terms: Omit<Terms, "principalPaise" | "months">; outstandingPaise: number; lockedPrincipalPaise: number; amountPaise: number;
  openMonths: string[];
}): { ok: false; error: string } | { ok: true; closes: true } | { ok: true; closes: false; rows: ScheduleRow[] } {
  money("amountPaise", a.amountPaise);
  const payable = a.outstandingPaise - a.lockedPrincipalPaise;
  if (a.amountPaise <= 0) return { ok: false, error: "Enter the amount paid back." };
  if (payable <= 0) return { ok: false, error: "Nothing is left to prepay on this loan." };
  if (a.amountPaise > payable) return { ok: false, error: `At most ${inr(payable)} can be prepaid (EMIs already in a finalised payroll still run).` };
  if (a.amountPaise === payable) return { ok: true, closes: true };
  if (!a.openMonths.length) return { ok: false, error: "This loan has no open EMIs to reschedule." };
  const months = [...a.openMonths].sort();
  const rows = buildSchedule({ ...a.terms, principalPaise: payable - a.amountPaise, months: months.length, firstMonth: months[0] });
  return { ok: true, closes: false, rows };
}

export const LOAN_STATUS_LABEL: Record<string, string> = {
  requested: "Waiting for approval", approved: "Approved, not paid out", rejected: "Declined", cancelled: "Withdrawn",
  disbursed: "Paid out", active: "Repaying", closed: "Closed", written_off: "Written off",
};

