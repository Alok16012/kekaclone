/**
 * Leave administration rules: pure functions, no I/O. Leave years, accrual schedules (with joining proration and the
 * probation stop), year-end splits (carry / encash / lapse) and comp-off expiry. Services load inputs and save outputs.
 */
import { addDaysISO, type ISODate } from "@/lib/dates";

export type YearStart = "jan" | "apr" | "joining_date";
export type Frequency = "monthly" | "quarterly" | "half_yearly" | "yearly" | "upfront";

/** Stored in leave_plan_rules.accrual. `upfront: true` is the older spelling of frequency 'upfront'. */
export type AccrualRule = {
  frequency?: Frequency; day?: number; prorate_joining?: boolean; stop_in_probation?: boolean; upfront?: boolean;
  /** stop rules: no credit while the balance is at or above this many days … */
  cap_balance?: number | null;
  /** … and none for the rest of the leave year once this many days have been taken in it */
  stop_after_days_taken?: number | null;
};
/** Stored in leave_plan_rules.year_end. `action: 'reset'` (the column default) means nothing carries. */
export type YearEndRule = { carry?: "none" | "all" | "upto"; carry_max?: number; encash_max?: number; action?: string };

export const FREQUENCIES: Frequency[] = ["monthly", "quarterly", "half_yearly", "yearly", "upfront"];
export const PERIODS: Record<Frequency, number> = { monthly: 12, quarterly: 4, half_yearly: 2, yearly: 1, upfront: 1 };
const PERIOD_CODE: Record<Frequency, string> = { monthly: "", quarterly: "-Q", half_yearly: "-H", yearly: "-Y", upfront: "-Y" };

export const round2 = (n: number) => Math.round(n * 100) / 100;
const floorHalf = (n: number) => Math.floor(n * 2 + 1e-9) / 2;
const nearestHalf = (n: number) => Math.round(n * 2) / 2;

/** Adds calendar months; the day is clamped to the target month's last day (31 Jan + 1 month = 28/29 Feb). */
export function addMonthsISO(d: ISODate, n: number): ISODate {
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)) - 1, day = Number(d.slice(8, 10));
  const t = y * 12 + m + n;
  const ty = Math.floor(t / 12), tm = t - ty * 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${ty}-${String(tm + 1).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

const dayDiff = (a: ISODate, b: ISODate) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
const monthIndex = (d: ISODate) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;

/** First day of the leave year that contains `date`. Joining-date plans run from each person's work anniversary. */
export function cycleStart(yearStart: string, joining: ISODate, date: ISODate): ISODate {
  if (yearStart === "joining_date") {
    const years = Number(date.slice(0, 4)) - Number(joining.slice(0, 4));
    let c = addMonthsISO(joining, years * 12);
    if (c > date) c = addMonthsISO(joining, (years - 1) * 12);
    return c;
  }
  const sm = yearStart === "apr" ? 4 : 1;
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  return `${m >= sm ? y : y - 1}-${String(sm).padStart(2, "0")}-01`;
}
export const cycleEnd = (start: ISODate) => addDaysISO(addMonthsISO(start, 12), -1);
export const previousCycle = (start: ISODate) => addMonthsISO(start, -12);

export function frequencyOf(rule: AccrualRule | null | undefined): Frequency {
  if (rule?.upfront) return "upfront";
  return rule?.frequency && FREQUENCIES.includes(rule.frequency) ? rule.frequency : "monthly";
}

export type AccrualPerson = { joining: ISODate; exit?: ISODate | null; probationEnd?: ISODate | null; probationStatus?: string | null };

/** Was the person on probation on this day? Confirmed people were, up to their probation end date. */
export function inProbation(p: AccrualPerson, d: ISODate) {
  if (p.probationStatus === "in_probation" || p.probationStatus === "extended") return !p.probationEnd || d < p.probationEnd;
  if (p.probationStatus === "confirmed") return !!p.probationEnd && d < p.probationEnd;
  return false;
}

export type AccrualPeriod = {
  periodId: string; start: ISODate; end: ISODate; creditDate: ISODate; amount: number;
  status: "due" | "future" | "probation" | "not_employed";
  /** running total of credits up to and including this period (credited periods only) */
  cumulative: number;
};

/**
 * Every accrual period of one leave year for one person and one leave type. Amounts add up exactly to the quota
 * (cumulative rounding), the joining period is prorated when the rule says so, periods credited while on probation
 * are dropped when the rule stops accrual in probation, and nothing is credited before joining or after exit.
 * A period is 'due' once its credit date is on or before asOf.
 */
export function accrualSchedule(input: { quota: number; rule: AccrualRule | null | undefined; cycleStart: ISODate; person: AccrualPerson; asOf: ISODate }): AccrualPeriod[] {
  const { quota, rule, person, asOf } = input;
  const c0 = input.cycleStart;
  const freq = frequencyOf(rule);
  const n = PERIODS[freq], step = 12 / n;
  const prorate = rule?.prorate_joining !== false;
  const day = Math.min(28, Math.max(1, Math.trunc(rule?.day ?? 1)));
  const out: AccrualPeriod[] = [];
  let cumulative = 0;
  for (let k = 0; k < n; k++) {
    const start = addMonthsISO(c0, k * step);
    const end = addDaysISO(addMonthsISO(c0, (k + 1) * step), -1);
    const periodId = start.slice(0, 7) + PERIOD_CODE[freq];
    let base = start;
    if (freq !== "upfront" && c0.endsWith("-01")) base = start.slice(0, 8) + String(day).padStart(2, "0");
    const creditDate = person.joining > base ? person.joining : base;
    let amount = round2((quota * (k + 1)) / n) - round2((quota * k) / n);
    let status: AccrualPeriod["status"] = creditDate <= asOf ? "due" : "future";
    if (end < person.joining || (person.exit && creditDate > person.exit)) { status = "not_employed"; amount = 0; }
    else if (person.joining > start) {   // joined during this period
      if (prorate) {
        if (n === 1) amount = floorHalf((quota * (12 - (monthIndex(person.joining) - monthIndex(c0)))) / 12);
        else amount = nearestHalf((amount * (dayDiff(person.joining, end) + 1)) / (dayDiff(start, end) + 1));
      }
    }
    if (status !== "not_employed" && rule?.stop_in_probation && inProbation(person, creditDate)) { status = "probation"; amount = 0; }
    amount = round2(amount);
    cumulative = round2(cumulative + amount);
    out.push({ periodId, start, end, creditDate, amount, status, cumulative });
  }
  return out;
}

/**
 * What to post now: for every due period, the increment that brings what's already been accrued in this leave year
 * up to the schedule's running total. Never negative, so a lowered quota or a changed frequency never double credits.
 */
export function accrualPostings(schedule: AccrualPeriod[], alreadyAccrued: number): { periodId: string; creditDate: ISODate; amount: number }[] {
  let have = alreadyAccrued;
  const out: { periodId: string; creditDate: ISODate; amount: number }[] = [];
  for (const p of schedule) {
    if (p.status !== "due") continue;
    const add = round2(p.cumulative - have);
    if (add > 0) { out.push({ periodId: p.periodId, creditDate: p.creditDate, amount: add }); have = round2(have + add); }
  }
  return out;
}

export type StoppedPosting = { periodId: string; creditDate: ISODate; amount: number; credited: number; withheld: number; reason: "cap" | "taken" | null };

/**
 * Accrual stop rules applied to what's due. The whole period amount still counts as accrued (so a later run never
 * re-credits it); the part the rule withholds lapses the same day. `balance` = the person's balance of the type right
 * now (credits − leave taken), `taken` = days of the type taken in this leave year.
 */
export function applyAccrualStops(postings: { periodId: string; creditDate: ISODate; amount: number }[], s: { balance: number; taken: number; cap?: number | null; stopAfterTaken?: number | null }): StoppedPosting[] {
  const cap = s.cap != null && s.cap >= 0 ? s.cap : null;
  const stopAt = s.stopAfterTaken != null && s.stopAfterTaken >= 0 ? s.stopAfterTaken : null;
  let balance = s.balance;
  return postings.map((p) => {
    let credited = p.amount;
    let reason: StoppedPosting["reason"] = null;
    if (stopAt != null && s.taken >= stopAt) { credited = 0; reason = "taken"; }
    else if (cap != null) {
      const room = round2(Math.max(0, cap - balance));
      if (room < p.amount) { credited = room; reason = "cap"; }
    }
    credited = round2(credited);
    balance = round2(balance + credited);
    return { ...p, credited, withheld: round2(p.amount - credited), reason };
  });
}

export type GrantLike = { id: string; days: number; used: number; validFrom: ISODate; validTo: ISODate };

/**
 * Event-based leave: the grant a request should draw on, or why none fits. The request must lie inside the grant's
 * validity window and fit what's left of it; when several fit, the one that ends first is used.
 */
export function pickGrant(grants: GrantLike[], r: { from: ISODate; to: ISODate; days: number }): { grant: GrantLike | null; problem: string | null } {
  if (!grants.length) return { grant: null, problem: "This leave is granted for a specific event. Ask HR to grant it before you apply." };
  const inWindow = grants.filter((g) => g.validFrom <= r.from && g.validTo >= r.to);
  if (!inWindow.length) {
    const soonest = [...grants].sort((a, b) => (a.validTo < b.validTo ? -1 : 1))[0];
    return { grant: null, problem: `Your grant for ${soonest.validFrom === soonest.validTo ? soonest.validFrom : `${soonest.validFrom} to ${soonest.validTo}`} doesn't cover these dates.` };
  }
  const fits = inWindow.filter((g) => round2(g.days - g.used) >= r.days).sort((a, b) => (a.validTo < b.validTo ? -1 : 1));
  if (!fits.length) {
    const best = Math.max(...inWindow.map((g) => round2(g.days - g.used)));
    return { grant: null, problem: `Only ${best} ${best === 1 ? "day is" : "days are"} left of this grant and this request needs ${r.days}.` };
  }
  return { grant: fits[0], problem: null };
}

export function carryModeOf(rule: YearEndRule | null | undefined): "none" | "all" | "upto" {
  if (rule?.carry) return rule.carry;
  return rule?.action === "carry" ? "all" : "none";
}

/**
 * Year-end split of a closing balance. Carry first (all / up to N), then encash up to N of the rest, the remainder lapses.
 * A negative closing balance is carried into the new year as it is, so borrowed days are recovered from next year's credit.
 */
export function yearEndSplit(closing: number, rule: YearEndRule | null | undefined): { carry: number; encash: number; lapse: number } {
  const c = round2(closing);
  if (c <= 0) return { carry: c, encash: 0, lapse: 0 };
  const mode = carryModeOf(rule);
  const carry = mode === "all" ? c : mode === "upto" ? Math.min(c, Math.max(0, rule?.carry_max ?? 0)) : 0;
  const rest = round2(c - carry);
  const encash = Math.min(rest, Math.max(0, rule?.encash_max ?? 0));
  return { carry: round2(carry), encash: round2(encash), lapse: round2(rest - encash) };
}

/**
 * Comp-off expiry, first in first out: days taken use up the oldest credits first, so when a credit expires only
 * the part not covered by newer credits is still unused. `outstanding` = days currently held of the comp-off type,
 * `neverExpiring` = other credits of that type with no expiry (manual adjustments). Credits already expired are left out.
 */
export function compOffExpiries(input: { outstanding: number; neverExpiring?: number; credits: { id: string; amount: number; expiresOn: ISODate | null }[]; asOf: ISODate }) {
  const credits = [...input.credits].sort((a, b) => (a.expiresOn ?? "9999") < (b.expiresOn ?? "9999") ? -1 : (a.expiresOn ?? "9999") > (b.expiresOn ?? "9999") ? 1 : 0);
  let outstanding = input.outstanding;
  const out: { id: string; amount: number }[] = [];
  for (let i = 0; i < credits.length; i++) {
    const c = credits[i];
    if (!c.expiresOn || c.expiresOn >= input.asOf) break;   // sorted: nothing later has expired either
    const later = credits.slice(i + 1).reduce((s, x) => s + x.amount, 0) + (input.neverExpiring ?? 0);
    const unused = round2(Math.min(c.amount, Math.max(0, outstanding - later)));
    out.push({ id: c.id, amount: unused });
    outstanding = round2(outstanding - unused);
  }
  return out;
}

export type CompOffViolation = { code: string; message: string };

/** A comp-off claim: worked days must be past (or today), inside the claim window, off days for the person, and not claimed already. */
export function validateCompOff(input: { dates: ISODate[]; today: ISODate; windowDays: number; dayTypes: Record<ISODate, string>; claimed: Set<ISODate> }): CompOffViolation[] {
  const v: CompOffViolation[] = [];
  if (input.dates.length === 0) v.push({ code: "empty", message: "Pick at least one day you worked." });
  if (new Set(input.dates).size !== input.dates.length) v.push({ code: "dupe", message: "The same day is listed twice." });
  for (const d of input.dates) {
    if (d > input.today) v.push({ code: "future", message: `${d} is in the future. Claim comp-off after you've worked the day.` });
    else if (d < addDaysISO(input.today, -input.windowDays)) v.push({ code: "window", message: `${d} is more than ${input.windowDays} days ago, which is outside the claim window.` });
    const t = input.dayTypes[d];
    if (t !== "holiday" && t !== "weekly_off" && t !== "half_weekly_off") v.push({ code: "working", message: `${d} is a working day for you. Comp-off is for weekly offs and holidays.` });
    if (input.claimed.has(d)) v.push({ code: "claimed", message: `You've already claimed comp-off for ${d}.` });
  }
  return v;
}

/** Leave balances import: one row = employee + leave type + balance. Values arrive as typed in Excel. */
export type BalanceRow = { rowNumber: number; employee: string; type: string; balance: unknown };
export function parseBalance(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n) || Math.abs(n) > 999 || Math.abs(Math.round(n * 100) - n * 100) > 1e-6) return null;
  return n;
}
