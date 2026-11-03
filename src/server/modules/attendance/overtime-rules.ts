/**
 * Overtime rules: pure functions, no I/O. How many minutes of a day count as overtime (per day type, coverage,
 * threshold, cap, rounding), what they are worth (pay code × hourly wage, tiers) or how many comp-off days they earn.
 */
import type { DayType } from "./rules";

export type OtRounding = { to: 1 | 15 | 30 | 60; mode: "down" | "nearest" };
export type OtDayRule = {
  enabled: boolean;
  mode: "pay" | "comp_off";
  /** working days only: count time before the shift starts / after it ends. Off days and holidays count everything worked. */
  coverage: { pre: boolean; post: boolean };
  /** below this many minutes a day, nothing counts */
  min_minutes: number;
  /** at most this many minutes a day (null = no cap) */
  max_minutes: number | null;
  rounding: OtRounding;
  pay_code_id: string | null;
  /** minutes beyond `after_minutes` in a day are paid at this multiplier instead of the pay code's */
  tiers: { after_minutes: number; multiplier: number }[];
};
export type OvertimeRules = {
  basis: "effective" | "gross";
  /** required: only minutes approved through an overtime request count (capped by what was actually worked) */
  approval: "none" | "required";
  /** hourly wage = monthly wage on this basis ÷ hours_per_month */
  wage_basis: "basic" | "gross";
  hours_per_month: number;
  comp_off: { full_day_minutes: number; half_day_minutes: number };
  working: OtDayRule;
  weekly_off: OtDayRule;
  holiday: OtDayRule;
};
export type PayCode = { kind: "multiplier" | "fixed_per_hour" | "lump_sum"; value: number | null };

export const OT_DAY_KEYS = ["working", "weekly_off", "holiday"] as const;
export type OtDayKey = (typeof OT_DAY_KEYS)[number];

export const DEFAULT_DAY_RULE: OtDayRule = {
  enabled: false, mode: "pay", coverage: { pre: false, post: true }, min_minutes: 30, max_minutes: 240,
  rounding: { to: 15, mode: "down" }, pay_code_id: null, tiers: [],
};
export const DEFAULT_OVERTIME_RULES: OvertimeRules = {
  basis: "effective", approval: "required", wage_basis: "basic", hours_per_month: 208,
  comp_off: { full_day_minutes: 480, half_day_minutes: 240 },
  working: { ...DEFAULT_DAY_RULE, enabled: true },
  weekly_off: { ...DEFAULT_DAY_RULE, enabled: true, mode: "comp_off", min_minutes: 240, max_minutes: null },
  holiday: { ...DEFAULT_DAY_RULE, enabled: true, mode: "comp_off", min_minutes: 240, max_minutes: null },
};

export const dayKeyOf = (t: DayType): OtDayKey => (t === "holiday" ? "holiday" : t === "weekly_off" || t === "half_weekly_off" ? "weekly_off" : "working");

/** Fills in anything a stored policy is missing, so older rows keep working after a rule is added. */
export function normalizeRules(r: Partial<OvertimeRules> | null | undefined): OvertimeRules {
  const d = DEFAULT_OVERTIME_RULES;
  const day = (k: OtDayKey): OtDayRule => ({ ...d[k], ...(r?.[k] ?? {}), coverage: { ...d[k].coverage, ...(r?.[k]?.coverage ?? {}) }, rounding: { ...d[k].rounding, ...(r?.[k]?.rounding ?? {}) }, tiers: r?.[k]?.tiers ?? [] });
  return {
    basis: r?.basis === "gross" ? "gross" : "effective",
    approval: r?.approval === "none" ? "none" : "required",
    wage_basis: r?.wage_basis === "gross" ? "gross" : "basic",
    hours_per_month: r?.hours_per_month ?? d.hours_per_month,
    comp_off: { ...d.comp_off, ...(r?.comp_off ?? {}) },
    working: day("working"), weekly_off: day("weekly_off"), holiday: day("holiday"),
  };
}

const int = (n: unknown, lo: number, hi: number) => Number.isInteger(n) && (n as number) >= lo && (n as number) <= hi;

export function validateOvertimeRules(r: OvertimeRules): string | null {
  if (!int(r.hours_per_month, 100, 400)) return "Hours per month must be between 100 and 400 (208 is usual for 26 days of 8 hours).";
  if (!int(r.comp_off.half_day_minutes, 30, 720) || !int(r.comp_off.full_day_minutes, 60, 960)) return "Comp-off thresholds must be between 30 minutes and 16 hours.";
  if (r.comp_off.half_day_minutes >= r.comp_off.full_day_minutes) return "The half-day comp-off threshold must be less than the full-day one.";
  for (const k of OT_DAY_KEYS) {
    const d = r[k];
    if (!d.enabled) continue;
    const label = { working: "working days", weekly_off: "weekly offs", holiday: "holidays" }[k];
    if (d.mode !== "pay" && d.mode !== "comp_off") return `Choose pay or comp-off for ${label}.`;
    if (!int(d.min_minutes, 0, 480)) return `The minimum for ${label} must be between 0 and 8 hours.`;
    if (d.max_minutes != null && (!int(d.max_minutes, 15, 960) || d.max_minutes < d.min_minutes)) return `The daily cap for ${label} must be at least the minimum and at most 16 hours.`;
    if (![1, 15, 30, 60].includes(d.rounding.to) || !["down", "nearest"].includes(d.rounding.mode)) return "Round to the minute, 15, 30 or 60 minutes.";
    if (k === "working" && !d.coverage.pre && !d.coverage.post) return "On working days, count time before the shift, after it, or both.";
    if (d.mode === "pay" && !d.pay_code_id) return `Pick a pay code for ${label}.`;
    if (d.tiers.length > 5) return "Add at most 5 tiers.";
    let last = 0;
    for (const t of d.tiers) {
      if (!int(t.after_minutes, 1, 960) || t.after_minutes <= last) return "Tiers must start after increasing numbers of minutes.";
      if (!(Number.isFinite(t.multiplier) && t.multiplier >= 0.5 && t.multiplier <= 5)) return "Tier multipliers must be between 0.5 and 5.";
      last = t.after_minutes;
    }
  }
  return null;
}

export function validatePayCode(p: { name: string; kind: string; value: number | null }): string | null {
  if (!p.name.trim() || p.name.length > 80) return "Give the pay code a name (up to 80 characters).";
  if (!["multiplier", "fixed_per_hour", "lump_sum"].includes(p.kind)) return "Choose a pay code type.";
  if (p.value == null || !Number.isFinite(p.value) || p.value <= 0) return "Enter a value greater than zero.";
  if (p.kind === "multiplier" && p.value > 5) return "A multiplier can be at most 5× the hourly wage.";
  if (p.kind !== "multiplier" && p.value > 100000) return "That amount looks too large.";
  return null;
}

export function roundMinutes(minutes: number, r: OtRounding) {
  if (minutes <= 0) return 0;
  if (r.to === 1) return Math.round(minutes);
  return r.mode === "nearest" ? Math.round(minutes / r.to) * r.to : Math.floor(minutes / r.to) * r.to;
}

export type OtDayInputs = {
  dayType: DayType;
  shiftKind: "fixed" | "flexible" | null;
  /** shift start / end as UTC instants for the day (null on days without timings) */
  shiftStart: Date | null; shiftEnd: Date | null;
  firstIn: Date | null; lastOut: Date | null;
  gross: number; effective: number;
  /** minutes someone must work on the shift (length minus break); 0 when there's no shift */
  required: number;
  final: boolean;
};

/**
 * Overtime minutes for one finished day under a policy. Working days: time outside the shift (fixed shifts, per
 * coverage) or beyond the required hours (flexible shifts). Off days and holidays: all time worked. Then threshold,
 * cap and rounding. Returns 0 while the day is still open.
 */
export function overtimeMinutes(rules: OvertimeRules | null, i: OtDayInputs): number {
  if (!rules || !i.final) return 0;
  const rule = rules[dayKeyOf(i.dayType)];
  if (!rule.enabled) return 0;
  const worked = rules.basis === "gross" ? i.gross : i.effective;
  if (worked <= 0) return 0;
  let raw = 0;
  if (i.dayType === "working" || i.dayType === "half_weekly_off") {
    if (i.shiftKind === "fixed" && i.shiftStart && i.shiftEnd && i.firstIn && i.lastOut) {
      const pre = Math.max(0, (i.shiftStart.getTime() - i.firstIn.getTime()) / 60000);
      const post = Math.max(0, (i.lastOut.getTime() - i.shiftEnd.getTime()) / 60000);
      raw = (rule.coverage.pre ? pre : 0) + (rule.coverage.post ? post : 0);
      // never more than was actually worked beyond the shift's own requirement (long breaks don't become overtime)
      raw = Math.min(raw, Math.max(0, worked - i.required));
    } else {
      raw = Math.max(0, worked - i.required);
    }
  } else {
    raw = worked;
  }
  raw = Math.round(raw);
  if (raw < rule.min_minutes) return 0;
  if (rule.max_minutes != null) raw = Math.min(raw, rule.max_minutes);
  return roundMinutes(raw, rule.rounding);
}

/** Minutes that count after the approval rule: with approval required only the approved request's minutes, capped by what was worked. */
export function creditableMinutes(rules: OvertimeRules | null, computed: number, approvedMinutes: number | null) {
  if (!rules || computed <= 0) return 0;
  if (rules.approval === "none") return computed;
  if (approvedMinutes == null) return 0;
  return Math.min(computed, Math.max(0, approvedMinutes));
}

/** Monthly wage on the policy's basis, from a salary breakup of monthly paise per component code. */
export function wageOnBasis(breakup: Record<string, number>, basis: "basic" | "gross", earningCodes: Set<string>) {
  if (basis === "basic") return breakup.BASIC ?? 0;
  return Object.entries(breakup).filter(([c]) => earningCodes.has(c)).reduce((s, [, v]) => s + (v || 0), 0);
}

/** Paise for a day's overtime: hourly wage × pay-code multiplier (tiers raise the multiplier beyond a point), fixed per hour, or one lump sum. */
export function overtimePaise(minutes: number, hourlyPaise: number, code: PayCode, tiers: OtDayRule["tiers"]): number {
  if (minutes <= 0) return 0;
  if (code.kind === "lump_sum") return Math.round((code.value ?? 0) * 100);
  if (code.kind === "fixed_per_hour") return Math.round(((code.value ?? 0) * 100 * minutes) / 60);
  const base = code.value ?? 1;
  const sorted = [...tiers].sort((a, b) => a.after_minutes - b.after_minutes);
  let total = 0, from = 0, mult = base;
  for (const t of sorted) {
    const upto = Math.min(minutes, t.after_minutes);
    if (upto > from) total += ((upto - from) / 60) * hourlyPaise * mult;
    from = Math.max(from, upto);
    mult = t.multiplier;
    if (from >= minutes) break;
  }
  if (minutes > from) total += ((minutes - from) / 60) * hourlyPaise * mult;
  return Math.round(total);
}

/** Comp-off earned by one day's overtime: a full day, half a day or nothing. */
export function compOffDaysFor(minutes: number, c: OvertimeRules["comp_off"]) {
  if (minutes >= c.full_day_minutes) return 1;
  if (minutes >= c.half_day_minutes) return 0.5;
  return 0;
}

/** Ledger delta for a month's comp-off credit from overtime: idempotent key encodes before > after (and a sequence for re-applies). */
export function compOffDelta(employeeId: string, month: string, postedDays: number, targetDays: number, seq = 0) {
  const r = (n: number) => Math.round(n * 100);
  if (r(postedDays) === r(targetDays)) return null;
  return { amount: targetDays - postedDays, key: `ot:${employeeId}:${month}:${r(postedDays)}>${r(targetDays)}${seq ? `#${seq}` : ""}` };
}

export function validateOvertimeRequest(r: { date: string; today: string; joining: string; minutes: number; reason: string; pastDays: number; pendingSameDay: boolean; computed: number | null }): string | null {
  if (!Number.isInteger(r.minutes) || r.minutes < 15 || r.minutes > 960) return "Ask for between 15 minutes and 16 hours.";
  if (r.date > r.today) return "Overtime can be claimed for today or earlier days only.";
  if (r.date < r.joining) return "This day is before you joined.";
  if (r.date < addDays(r.today, -r.pastDays)) return `You can claim overtime up to ${r.pastDays} days back.`;
  if (r.pendingSameDay) return "You already have an overtime request waiting for this day.";
  if (!r.reason.trim()) return "Add a note for your manager about what the extra time was for.";
  return null;
}

function addDays(s: string, n: number) {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const fmtMinutes = (m: number) => (m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`);
