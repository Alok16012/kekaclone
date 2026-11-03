/**
 * Roster and shift-change rules: pure functions. Expanding a rotation into dated entries, the week a date belongs to,
 * and validating shift / weekly-off change requests against the company's shift rules.
 */
import { addDaysISO, eachDay, weekday, type ISODate } from "@/lib/dates";

/** A roster cell: a shift id, "off" (a weekly off that day), or null (= clear, back to the regular assignment). */
export type RosterValue = string | "off" | null;
export type RosterEntryInput = { employeeId: string; date: ISODate; value: RosterValue };

export type Rotation =
  | { kind: "weekly"; /** Monday..Sunday */ week: RosterValue[] }
  | { kind: "cycle"; /** repeats from the start date */ sequence: RosterValue[] };

export const WEEK_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** Monday of the week containing `date`. */
export function weekStartOf(date: ISODate): ISODate {
  const idx = WEEK_ORDER.indexOf(weekday(date) as (typeof WEEK_ORDER)[number]);
  return addDaysISO(date, -idx);
}
export const weekDays = (weekStart: ISODate) => eachDay(weekStart, addDaysISO(weekStart, 6));

export function validateRotation(r: Rotation, days: number): string | null {
  if (!Number.isInteger(days) || days < 1 || days > 366) return "Apply the rotation for between 1 and 366 days.";
  const seq = r.kind === "weekly" ? r.week : r.sequence;
  if (r.kind === "weekly" && seq.length !== 7) return "A weekly pattern needs all seven days.";
  if (r.kind === "cycle" && (seq.length < 2 || seq.length > 60)) return "A cycle needs between 2 and 60 days.";
  if (seq.every((v) => v === null)) return "Choose at least one shift or off day in the pattern.";
  return null;
}

/** Entries for one person from `start` for `days` days. Cells left as null are skipped (the regular assignment applies). */
export function expandRotation(r: Rotation, employeeId: string, start: ISODate, days: number): RosterEntryInput[] {
  const out: RosterEntryInput[] = [];
  const dates = eachDay(start, addDaysISO(start, days - 1));
  dates.forEach((date, i) => {
    const value = r.kind === "weekly" ? r.week[WEEK_ORDER.indexOf(weekday(date) as (typeof WEEK_ORDER)[number])] : r.sequence[i % r.sequence.length];
    if (value !== null && value !== undefined) out.push({ employeeId, date, value });
  });
  return out;
}

export type ShiftRule = { allowed_shift_ids: string[]; request_window_days: number | null; max_requests_per_month: number | null; allow_on_off_days: boolean };

export function validateShiftChange(r: {
  from: ISODate; to: ISODate; today: ISODate; joining: ISODate; shiftId: string; currentShiftId: string | null; reason: string;
  rule: ShiftRule | null; usedThisMonth: number; overlaps: boolean; offDaysInRange: number;
}): string | null {
  if (r.to < r.from) return "The end date is before the start date.";
  if (addDaysISO(r.from, 31) <= r.to) return "Ask for at most 31 days at a time.";
  if (r.from < r.joining) return "These dates are before you joined.";
  if (r.from < r.today) return "Shift changes start today or later.";
  if (r.shiftId === r.currentShiftId) return "That's already your shift on these dates.";
  const rule = r.rule;
  if (rule) {
    if (rule.allowed_shift_ids.length && !rule.allowed_shift_ids.includes(r.shiftId)) return "That shift can't be requested. Ask HR if you need it.";
    if (rule.request_window_days != null && r.from > addDaysISO(r.today, rule.request_window_days)) return `Ask at most ${rule.request_window_days} days ahead.`;
    if (rule.max_requests_per_month != null && r.usedThisMonth >= rule.max_requests_per_month) return `You've used all ${rule.max_requests_per_month} shift changes for this month.`;
    if (!rule.allow_on_off_days && r.offDaysInRange > 0) return "These dates include a weekly off or holiday. Pick working days only.";
  } else if (r.from > addDaysISO(r.today, 60)) return "Ask at most 60 days ahead.";
  if (r.overlaps) return "You already have a shift change on some of these dates.";
  if (!r.reason.trim()) return "Add a reason for your manager.";
  return null;
}

/** Swap a weekly off: take `offDate` off and work `workDate` (which must be a weekly off) instead. */
export function validateWeeklyOffChange(r: {
  offDate: ISODate; workDate: ISODate; today: ISODate; joining: ISODate; reason: string; offDateType: string; workDateType: string;
  rule: ShiftRule | null; usedThisMonth: number; overlaps: boolean;
}): string | null {
  if (r.offDate === r.workDate) return "Pick two different days.";
  if (r.offDate < r.today || r.workDate < r.today) return "Weekly-off swaps are for today or later days.";
  if (r.offDate < r.joining || r.workDate < r.joining) return "These dates are before you joined.";
  if (r.offDate.slice(0, 7) !== r.workDate.slice(0, 7)) return "Swap a weekly off within the same month.";
  if (r.workDateType !== "weekly_off") return "The day you give up has to be one of your weekly offs.";
  if (r.offDateType !== "working") return "The day you take off has to be a working day.";
  const rule = r.rule;
  if (rule) {
    const horizon = rule.request_window_days ?? 60;
    if (r.offDate > addDaysISO(r.today, horizon) || r.workDate > addDaysISO(r.today, horizon)) return `Ask at most ${horizon} days ahead.`;
    if (rule.max_requests_per_month != null && r.usedThisMonth >= rule.max_requests_per_month) return `You've used all ${rule.max_requests_per_month} changes for this month.`;
  }
  if (r.overlaps) return "You already have a change waiting for one of these days.";
  if (!r.reason.trim()) return "Add a reason for your manager.";
  return null;
}

export function validateShiftRule(r: { name: string; request_window_days: number | null; max_requests_per_month: number | null }): string | null {
  if (!r.name.trim() || r.name.length > 80) return "Give the rule a name (up to 80 characters).";
  if (r.request_window_days != null && (!Number.isInteger(r.request_window_days) || r.request_window_days < 0 || r.request_window_days > 365)) return "The request window must be between 0 and 365 days.";
  if (r.max_requests_per_month != null && (!Number.isInteger(r.max_requests_per_month) || r.max_requests_per_month < 0 || r.max_requests_per_month > 31)) return "Allow between 0 and 31 requests a month.";
  return null;
}

/** First clock-in local time → the shift whose auto-assign window contains it (the earliest-created wins on ties). */
export function autoAssignedShift<T extends { id: string; auto_assign: { from: string; to: string } | null }>(firstInLocalMinutes: number, shifts: T[]): T | null {
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  for (const s of shifts) {
    const a = s.auto_assign;
    if (!a?.from || !a?.to) continue;
    const from = toMin(a.from), to = toMin(a.to);
    const inside = from <= to ? firstInLocalMinutes >= from && firstInLocalMinutes < to : firstInLocalMinutes >= from || firstInLocalMinutes < to;
    if (inside) return s;
  }
  return null;
}
