/**
 * Leave rules: pure functions, no I/O. Everything that decides "how many days is this request"
 * and "is it allowed" lives here so it can be unit-tested exhaustively.
 */
import { addDaysISO, eachDay, weekday, weekOfMonth, type ISODate } from "@/lib/dates";

export type DayPart = "full" | "first" | "second";
/** weekly-off pattern: per weekday either one value for every week, or 5 values (1st..5th occurrence in the month) */
export type WeeklyOffPattern = Partial<Record<"sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat", "off" | "half" | "work" | ("off" | "half" | "work")[]>>;

export type ApplicationRules = {
  allowHalfDay?: boolean;
  noticeDays?: number;          // apply at least N days before the start
  backdateDays?: number | null; // how far in the past you may apply (null = not allowed)
  maxConsecutiveDays?: number;
  negativeLimit?: number;       // days the balance may go below zero
  attachmentAfterDays?: number; // attachment required when days > N
  sandwich?: { enabled: boolean; ignoreHalfDays?: boolean };
};

export type Calendar = { holidays: Set<ISODate>; weeklyOff: WeeklyOffPattern };

export function dayType(date: ISODate, cal: Calendar): "holiday" | "weekly_off" | "half_weekly_off" | "working" {
  if (cal.holidays.has(date)) return "holiday";
  const p = cal.weeklyOff[weekday(date)];
  const v = Array.isArray(p) ? p[weekOfMonth(date) - 1] ?? "work" : p ?? "work";
  return v === "off" ? "weekly_off" : v === "half" ? "half_weekly_off" : "working";
}

export type DayCount = { date: ISODate; type: ReturnType<typeof dayType>; counted: number; why: "leave" | "half" | "off" | "sandwich" };

/**
 * Days a request costs. Off days inside the range cost nothing, unless the sandwich rule is on and the
 * off day sits between two leave days of this request (optionally only when both neighbours are full days).
 */
export function countLeaveDays(
  from: ISODate, to: ISODate, fromPart: DayPart, toPart: DayPart, cal: Calendar, rules: Pick<ApplicationRules, "sandwich"> = {},
): { days: number; breakdown: DayCount[] } {
  if (to < from) return { days: 0, breakdown: [] };
  const dates = eachDay(from, to);
  const base: DayCount[] = dates.map((date, i) => {
    const type = dayType(date, cal);
    if (type === "holiday" || type === "weekly_off") return { date, type, counted: 0, why: "off" };
    let counted = type === "half_weekly_off" ? 0.5 : 1;
    if (i === 0 && fromPart === "second") counted = Math.min(counted, 0.5);
    if (i === dates.length - 1 && toPart === "first") counted = Math.min(counted, 0.5);
    if (dates.length === 1 && fromPart !== "full") counted = 0.5;
    return { date, type, counted, why: counted < 1 ? "half" : "leave" };
  });

  if (rules.sandwich?.enabled) {
    const isLeave = (d: DayCount) => d.counted > 0 && (!rules.sandwich!.ignoreHalfDays || d.counted === 1);
    for (let i = 0; i < base.length; i++) {
      if (base[i].why !== "off") continue;
      let l = i - 1; while (l >= 0 && base[l].why === "off") l--;
      let r = i + 1; while (r < base.length && base[r].why === "off") r++;
      if (l >= 0 && r < base.length && isLeave(base[l]) && isLeave(base[r])) base[i] = { ...base[i], counted: 1, why: "sandwich" };
    }
  }
  return { days: base.reduce((s, d) => s + d.counted, 0), breakdown: base };
}

export type Violation = { code: string; message: string; blocking: boolean };

export function validateRequest(input: {
  from: ISODate; to: ISODate; fromPart: DayPart; toPart: DayPart; days: number; today: ISODate;
  available: number; rules: ApplicationRules; hasAttachment: boolean;
}): Violation[] {
  const v: Violation[] = [];
  const { from, to, fromPart, toPart, days, today, available, rules } = input;
  if (to < from) v.push({ code: "range", message: "The end date is before the start date.", blocking: true });
  if (from === to && fromPart === "second" && toPart === "first") v.push({ code: "range", message: "Pick either the first half or the second half for a single day.", blocking: true });
  if (days <= 0) v.push({ code: "zero", message: "The selected dates are all holidays or weekly offs, so there is nothing to apply for.", blocking: true });
  if (!rules.allowHalfDay && (fromPart !== "full" || toPart !== "full")) v.push({ code: "half", message: "Half days aren't allowed for this leave type.", blocking: true });
  if (rules.noticeDays && from > today && from < addDaysISO(today, rules.noticeDays)) v.push({ code: "notice", message: `Apply at least ${rules.noticeDays} days in advance for this leave type.`, blocking: true });
  if (from < today) {
    if (rules.backdateDays == null) v.push({ code: "backdate", message: "This leave type can't be applied for past dates.", blocking: true });
    else if (from < addDaysISO(today, -rules.backdateDays)) v.push({ code: "backdate", message: `You can apply for up to ${rules.backdateDays} days in the past.`, blocking: true });
  }
  if (rules.maxConsecutiveDays && days > rules.maxConsecutiveDays) v.push({ code: "max", message: `At most ${rules.maxConsecutiveDays} days in one request.`, blocking: true });
  const floor = -(rules.negativeLimit ?? 0);
  if (available - days < floor) v.push({ code: "balance", message: `Not enough balance: you have ${fmt(available)} available and this needs ${fmt(days)}.`, blocking: true });
  else if (available - days < 0) v.push({ code: "negative", message: `This takes your balance to ${fmt(available - days)}.`, blocking: false });
  if (rules.attachmentAfterDays != null && days > rules.attachmentAfterDays && !input.hasAttachment) v.push({ code: "attachment", message: `Attach a document for requests longer than ${rules.attachmentAfterDays} days.`, blocking: true });
  return v;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1)) + (Math.abs(n) === 1 ? " day" : " days");

/** Opening credit when someone joins mid-year: quota for the remaining months of the leave year, rounded down to half days. */
export function proratedOpening(yearlyQuota: number, joining: ISODate, yearStartMonth: number /* 1 = Jan, 4 = Apr */): number {
  const m = Number(joining.slice(5, 7));
  const monthsLeft = ((yearStartMonth - 1 - (m - 1) + 12) % 12) || 12;   // incl. joining month
  return Math.floor(((yearlyQuota * monthsLeft) / 12) * 2) / 2;
}
