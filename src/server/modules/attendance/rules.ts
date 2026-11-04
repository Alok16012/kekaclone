/**
 * Attendance rules: pure functions, no I/O (Intl is used for time-zone maths, which is deterministic).
 * Shifts and day windows, evaluating one attendance day, penalization, deductions, capture checks
 * (IP allowlist, geofence) and request validation all live here so they can be unit-tested.
 */
import { addDaysISO, weekday, type ISODate } from "@/lib/dates";

export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
export const WEEK: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
/** Local wall-clock times "HH:MM". An end at or before the start means the shift runs past midnight. */
export type DayTiming = { start: string; end: string };
export type ShiftDef = {
  id?: string; name?: string; kind: "fixed" | "flexible";
  timings: Partial<Record<Weekday, DayTiming>>; break_minutes: number; grace_minutes: number; half_day_minutes: number | null;
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isHHMM = (s: unknown): s is string => typeof s === "string" && HHMM.test(s);
export const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
export const fmtMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export const isOvernight = (t: DayTiming) => toMin(t.end) <= toMin(t.start);
/** Length of a timing in minutes (overnight aware). */
export const timingMinutes = (t: DayTiming) => (isOvernight(t) ? toMin(t.end) + 1440 : toMin(t.end)) - toMin(t.start);
/** Minutes someone must work on a timing: its length minus the break. */
export const requiredMinutes = (s: ShiftDef, t: DayTiming) => Math.max(0, timingMinutes(t) - s.break_minutes);

export function validateShift(s: { name: string; code: string; kind: string; timings: Record<string, DayTiming | null | undefined>; break_minutes: number; grace_minutes: number; half_day_minutes: number | null; auto_assign?: DayTiming | null }): string | null {
  if (!s.name.trim()) return "Give the shift a name.";
  if (s.auto_assign) {
    if (!isHHMM(s.auto_assign.start) || !isHHMM(s.auto_assign.end)) return "Auto-assign times must look like 05:00.";
    if (s.auto_assign.start === s.auto_assign.end) return "The auto-assign window can't start and end at the same time.";
  }
  if (!/^[A-Za-z0-9_-]{1,12}$/.test(s.code)) return "Use a short code of letters and numbers (up to 12), e.g. GEN or NIGHT.";
  if (s.kind !== "fixed" && s.kind !== "flexible") return "Choose fixed or flexible.";
  const days = Object.entries(s.timings).filter(([, t]) => t);
  if (!days.length) return "Add timings for at least one day.";
  for (const [d, t] of days) {
    if (!WEEK.includes(d as Weekday)) return "Unknown weekday.";
    if (!isHHMM(t!.start) || !isHHMM(t!.end)) return "Times must look like 09:30.";
    if (t!.start === t!.end) return "A shift can't start and end at the same time.";
    if (timingMinutes(t!) > 16 * 60) return "A shift can be at most 16 hours long.";
    if (s.break_minutes >= timingMinutes(t!)) return "The break is longer than the shift.";
  }
  if (!Number.isInteger(s.break_minutes) || s.break_minutes < 0 || s.break_minutes > 240) return "The break must be between 0 and 240 minutes.";
  if (!Number.isInteger(s.grace_minutes) || s.grace_minutes < 0 || s.grace_minutes > 180) return "Grace must be between 0 and 180 minutes.";
  if (s.half_day_minutes != null && (!Number.isInteger(s.half_day_minutes) || s.half_day_minutes < 30 || s.half_day_minutes > 720)) return "Half-day minimum must be between 30 and 720 minutes.";
  return null;
}

// ---------------------------------------------------------------- time zones

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(instant: Date, tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(instant).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second) };
}

/** Offset of a zone from UTC at an instant, in minutes (IST = 330). */
export function tzOffsetMinutes(instant: Date, tz: string) {
  const p = parts(instant, tz);
  const wall = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return Math.round((wall - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

/** The UTC instant of a local wall-clock time: `minutes` after local midnight of `date` (may be negative or past 24h). */
export function zonedToUtc(date: ISODate, minutes: number, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d) + minutes * 60000;
  const off1 = tzOffsetMinutes(new Date(guess), tz);
  let t = guess - off1 * 60000;
  const off2 = tzOffsetMinutes(new Date(t), tz);
  if (off2 !== off1) t = guess - off2 * 60000;   // crossed a DST change
  return new Date(t);
}

export function localDate(instant: Date, tz: string): ISODate {
  const p = parts(instant, tz);
  return `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}
export function localMinutes(instant: Date, tz: string) {
  const p = parts(instant, tz);
  return p.h * 60 + p.mi;
}

// ---------------------------------------------------------------- attendance day windows

/** An attendance day opens this long before its shift starts, so early arrivals still count for that day. */
export const DAY_LEAD_MINUTES = 240;

export function timingFor(shift: ShiftDef | null, date: ISODate): DayTiming | null {
  return shift?.timings[weekday(date) as Weekday] ?? null;
}
const anyTiming = (shift: ShiftDef) => WEEK.map((d) => shift.timings[d]).find(Boolean) ?? null;

/**
 * When the attendance day `date` begins: shift start minus the lead time (on a day without timings, the shift's
 * usual start), or local midnight with no shift. A night shift 22:00–06:00 therefore owns 18:00 → 18:00 next day,
 * and its punches belong to the date it started.
 */
export function dayAnchor(date: ISODate, shift: ShiftDef | null, tz: string): Date {
  const t = shift ? timingFor(shift, date) ?? anyTiming(shift) : null;
  return zonedToUtc(date, t ? toMin(t.start) - DAY_LEAD_MINUTES : 0, tz);
}

/** [start, end) of the attendance day, given the shift on that day and on the next one. */
export function dayWindow(date: ISODate, shift: ShiftDef | null, nextShift: ShiftDef | null, tz: string) {
  return { start: dayAnchor(date, shift, tz), end: dayAnchor(addDaysISO(date, 1), nextShift, tz) };
}

/** Which attendance date an instant belongs to (handles night shifts and early starts). */
export function attendanceDateOf(instant: Date, tz: string, shiftOn: (d: ISODate) => ShiftDef | null): ISODate {
  const local = localDate(instant, tz);
  for (const c of [addDaysISO(local, 1), local, addDaysISO(local, -1)]) {
    const w = dayWindow(c, shiftOn(c), shiftOn(addDaysISO(c, 1)), tz);
    if (instant >= w.start && instant < w.end) return c;
  }
  return local;
}

// ---------------------------------------------------------------- evaluating one day

export type DayType = "working" | "weekly_off" | "half_weekly_off" | "holiday";
export type DayStatus = "present" | "absent" | "half_day" | "leave" | "half_leave" | "wfh" | "on_duty" | "weekly_off" | "holiday" | "not_joined";

export type DayInputs = {
  date: ISODate; tz: string; dayType: DayType; joined: boolean;
  shift: ShiftDef | null;
  /** valid punches inside the day window, sorted */
  punches: Date[];
  /** the day is over (its window has closed), so missing swipes and penalties apply */
  final: boolean;
  leavePortion: number;                                   // 0, 0.5 or 1 from approved leave
  remote: { kind: "wfh" | "on_duty"; portion: number } | null;
  partial: { lateMinutes: number; earlyMinutes: number }; // approved partial-day allowances
};

export type DayResult = {
  status: DayStatus; firstIn: Date | null; lastOut: Date | null;
  gross: number; effective: number;
  /** minutes late beyond shift grace (after partial-day allowance), 0 if within grace */
  late: number;
  /** minutes late after the partial-day allowance, before grace */
  lateRaw: number;
  early: number; missingSwipe: boolean;
  required: number;   // portion of the day someone must attend: 0, 0.5 or 1
  covered: number;    // portion covered by leave / WFH / on duty
};

export function evaluateDay(i: DayInputs): DayResult {
  const p = i.punches;
  const firstIn = p[0] ?? null;
  const lastOut = p.length > 1 ? p[p.length - 1] : null;
  let effective = 0;
  for (let k = 0; k + 1 < p.length; k += 2) effective += (p[k + 1].getTime() - p[k].getTime()) / 60000;
  const gross = firstIn && lastOut ? (lastOut.getTime() - firstIn.getTime()) / 60000 : 0;
  const missingSwipe = i.final && p.length % 2 === 1;

  const working = i.dayType === "working" || i.dayType === "half_weekly_off";
  const t = working ? timingFor(i.shift, i.date) : null;
  let lateRaw = 0, late = 0, early = 0;
  if (t && i.shift?.kind === "fixed") {
    const start = zonedToUtc(i.date, toMin(t.start), i.tz);
    const end = zonedToUtc(i.date, toMin(t.end) + (isOvernight(t) ? 1440 : 0), i.tz);
    if (firstIn) {
      lateRaw = Math.max(0, Math.round((firstIn.getTime() - start.getTime()) / 60000) - i.partial.lateMinutes);
      late = lateRaw > i.shift.grace_minutes ? lateRaw : 0;
    }
    if (lastOut) early = Math.max(0, Math.round((end.getTime() - lastOut.getTime()) / 60000) - i.partial.earlyMinutes);
  }

  const required = !working ? 0 : i.dayType === "half_weekly_off" ? 0.5 : 1;
  const remote = i.remote?.portion ?? 0;
  const covered = Math.min(required, i.leavePortion + remote);
  let status: DayStatus;
  if (!i.joined) status = "not_joined";
  else if (!working) status = p.length ? "present" : (i.dayType as "holiday" | "weekly_off");
  else if (covered >= required) status = i.leavePortion >= required ? "leave" : i.leavePortion > 0 ? "half_leave" : i.remote!.kind;
  else if (p.length) status = i.leavePortion > 0 ? "half_leave" : i.remote ? i.remote.kind : "present";
  else if (covered > 0) status = i.leavePortion > 0 ? "half_leave" : "half_day";
  else status = "absent";

  return { status, firstIn, lastOut, gross: Math.round(gross), effective: Math.round(effective), late, lateRaw, early, missingSwipe, required, covered };
}

// ---------------------------------------------------------------- penalization

export type PenaltyPolicy = {
  late_arrival?: { enabled: boolean; grace_minutes?: number | null; free_per_month: number; deduct_days: number } | null;
  hours_shortage?: { enabled: boolean; basis: "effective" | "gross"; full_day_minutes: number; half_day_minutes: number } | null;
  no_attendance?: { enabled: boolean } | null;
  missing_swipe?: { enabled: boolean; deduct_days: number } | null;
};
export type PenaltyRule = "late_arrival" | "hours_shortage" | "no_attendance" | "missing_swipe";
export type Penalty = { rule: PenaltyRule; days: number; detail: string; incident?: number; lopOnly?: boolean };

export const PENALTY_LABELS: Record<PenaltyRule, string> = {
  late_arrival: "Late arrival", hours_shortage: "Short hours", no_attendance: "No attendance", missing_swipe: "Missing swipe",
};

const halves = (n: number) => Math.round(n * 2) / 2;

export function validatePenaltyPolicy(p: PenaltyPolicy): string | null {
  const d = (x: number) => [0, 0.5, 1, 1.5, 2].includes(x);
  if (p.late_arrival?.enabled) {
    const l = p.late_arrival;
    if (!Number.isInteger(l.free_per_month) || l.free_per_month < 0 || l.free_per_month > 31) return "Free late arrivals must be between 0 and 31.";
    if (!d(l.deduct_days) || l.deduct_days === 0) return "Deduct half a day to two days per late arrival.";
    if (l.grace_minutes != null && (!Number.isInteger(l.grace_minutes) || l.grace_minutes < 0 || l.grace_minutes > 180)) return "Grace must be between 0 and 180 minutes.";
  }
  if (p.hours_shortage?.enabled) {
    const h = p.hours_shortage;
    if (!Number.isInteger(h.half_day_minutes) || !Number.isInteger(h.full_day_minutes) || h.half_day_minutes < 30 || h.full_day_minutes > 960) return "Hours must be between 0:30 and 16:00.";
    if (h.half_day_minutes >= h.full_day_minutes) return "The half-day minimum must be less than the full-day minimum.";
  }
  if (p.missing_swipe?.enabled && (!d(p.missing_swipe.deduct_days) || p.missing_swipe.deduct_days === 0)) return "Deduct half a day to two days for a missing swipe.";
  return null;
}

/**
 * Penalties for one finished day. `priorLateIncidents` = late arrivals already counted earlier in the same month,
 * so the first `free_per_month` are free and later ones cost `deduct_days` each.
 */
export function penaltiesFor(policy: PenaltyPolicy | null, day: DayResult, i: Pick<DayInputs, "final" | "joined" | "shift" | "partial" | "punches">, priorLateIncidents: number): Penalty[] {
  if (!policy || !i.final || !i.joined || day.required === 0) return [];
  const out: Penalty[] = [];
  const uncovered = day.required - day.covered;
  if (!i.punches.length) {
    if (policy.no_attendance?.enabled && uncovered > 0) out.push({ rule: "no_attendance", days: uncovered, detail: "No clock-in and no leave", lopOnly: true });
    return out;
  }
  if (day.covered > 0) return out;   // half leave / remote: arrival and hours aren't judged against the full shift
  const la = policy.late_arrival;
  if (la?.enabled) {
    const grace = la.grace_minutes ?? i.shift?.grace_minutes ?? 0;
    if (day.lateRaw > grace) {
      const n = priorLateIncidents + 1;
      out.push({ rule: "late_arrival", incident: n, days: n > la.free_per_month ? la.deduct_days : 0,
        detail: n > la.free_per_month ? `Late by ${day.lateRaw} min (late arrival ${n} this month)` : `Late by ${day.lateRaw} min (free ${n} of ${la.free_per_month})` });
    }
  }
  if (policy.missing_swipe?.enabled && day.missingSwipe) out.push({ rule: "missing_swipe", days: policy.missing_swipe.deduct_days, detail: "Clocked in but never clocked out" });
  const hs = policy.hours_shortage;
  if (hs?.enabled && !day.missingSwipe) {
    const worked = (hs.basis === "gross" ? day.gross : day.effective) + i.partial.lateMinutes + i.partial.earlyMinutes;
    const scale = day.required;   // half working days need half the hours
    const days = worked < hs.half_day_minutes * scale ? day.required : worked < hs.full_day_minutes * scale ? halves(day.required / 2) : 0;
    if (days > 0) out.push({ rule: "hours_shortage", days, detail: `Worked ${fmtMin(Math.max(0, Math.round(worked)))} of ${fmtMin(Math.round(hs.full_day_minutes * scale))}` });
  }
  return out;
}

export type Deduction = { rule: PenaltyRule; days: number; leaveTypeId: string | null };   // null = loss of pay

/**
 * Takes penalty days from leave types in the configured order (whole half days only, never below zero),
 * falling back to loss of pay. Penalties marked lopOnly always go to loss of pay.
 */
export function allocateDeductions(penalties: Penalty[], balances: { id: string; available: number }[]): Deduction[] {
  const left = balances.map((b) => ({ ...b, available: Number.isFinite(b.available) ? Math.max(0, Math.floor(b.available * 2) / 2) : Infinity }));
  const out: Deduction[] = [];
  for (const p of penalties) {
    let rest = p.days;
    if (rest <= 0) continue;
    if (!p.lopOnly) {
      for (const b of left) {
        if (rest <= 0) break;
        const take = Math.min(rest, b.available);
        if (take > 0) { out.push({ rule: p.rule, days: take, leaveTypeId: b.id }); b.available -= take; rest -= take; }
      }
    }
    if (rest > 0) out.push({ rule: p.rule, days: rest, leaveTypeId: null });
  }
  return out;
}

/**
 * Ledger delta for one (day, leave type): what to post so the day's penalty entries sum to the new target.
 * The key encodes the before and after totals, so re-running with no change posts nothing and a concurrent
 * duplicate collides on the unique key.
 */
export function ledgerDelta(employeeId: string, date: ISODate, leaveTypeId: string, postedDays: number, targetDays: number, seq = 0) {
  const r = (n: number) => Math.round(n * 100);
  if (r(postedDays) === r(targetDays)) return null;
  // `seq` = entries already posted for this person, day and type. Without it a penalty that is reversed and then
  // re-applied (0>50, 50>0, 0>50 again) would reuse the first key and be silently dropped by the idempotency check.
  return { amount: -(targetDays - postedDays), key: `penalty:${employeeId}:${date}:${leaveTypeId}:${r(postedDays)}>${r(targetDays)}${seq ? `#${seq}` : ""}` };
}

// ---------------------------------------------------------------- capture: IP allowlist and geofences

function ipv4ToBig(ip: string): bigint | null {
  const m = ip.split(".");
  if (m.length !== 4 || m.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
  return m.reduce((a, x) => (a << BigInt(8)) + BigInt(Number(x)), BigInt(0));
}
function ipv6ToBig(ip: string): bigint | null {
  let s = ip;
  let tail: number[] = [];
  const v4 = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);   // embedded IPv4, e.g. ::ffff:10.0.0.1
  if (v4) {
    const b = ipv4ToBig(v4[2]);
    if (b == null) return null;
    tail = [Number(b >> BigInt(16)), Number(b & BigInt(0xffff))];
    s = v4[1].endsWith("::") ? v4[1] : v4[1].slice(0, -1);
  }
  const dbl = s.split("::");
  if (dbl.length > 2) return null;
  const h = dbl[0] ? dbl[0].split(":") : [];
  const r = dbl.length === 2 && dbl[1] ? dbl[1].split(":") : [];
  if ([...h, ...r].some((x) => !/^[0-9a-f]{1,4}$/i.test(x))) return null;
  const fill = 8 - h.length - r.length - tail.length;
  if (dbl.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...h.map((x) => parseInt(x, 16)), ...Array<number>(fill).fill(0), ...r.map((x) => parseInt(x, 16)), ...tail];
  return groups.reduce((a, g) => (a << BigInt(16)) + BigInt(g), BigInt(0));
}
function parseIp(ip: string): { v: 4 | 6; n: bigint } | null {
  const s = ip.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const v4 = ipv4ToBig(s);
  if (v4 != null) return { v: 4, n: v4 };
  const v6 = ipv6ToBig(s.toLowerCase());
  if (v6 == null) return null;
  if (v6 >> BigInt(32) === BigInt(0xffff)) return { v: 4, n: v6 & BigInt(0xffffffff) };   // ::ffff:a.b.c.d
  return { v: 6, n: v6 };
}
/** A clean IP string for storage (inet), or null if it isn't one. */
export function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const s = ip.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  return parseIp(s) ? s : null;
}
export function parseCidr(cidr: string): { v: 4 | 6; n: bigint; bits: number } | null {
  const [addr, len, extra] = cidr.trim().split("/");
  if (extra !== undefined) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const max = ip.v === 4 ? 32 : 128;
  const bits = len === undefined ? max : /^\d{1,3}$/.test(len) ? Number(len) : NaN;
  if (!(bits >= 0 && bits <= max)) return null;
  return { ...ip, bits };
}
export const isValidCidr = (c: string) => parseCidr(c) != null;
export function ipInCidr(ip: string, cidr: string): boolean {
  const a = parseIp(ip), c = parseCidr(cidr);
  if (!a || !c || a.v !== c.v) return false;
  const width = BigInt(a.v === 4 ? 32 : 128), shift = width - BigInt(c.bits);
  return a.n >> shift === c.n >> shift;
}
export const ipAllowed = (ip: string | null, ranges: string[]) => !ranges.length || (!!ip && ranges.some((r) => ipInCidr(ip, r)));

/** Great-circle distance in metres. */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
export type Fence = { id: string; name: string; lat: number; lng: number; radius_m: number };
/** Nearest fence that contains the point. GPS accuracy gives up to 50 m of slack, never more. */
export function fenceFor(lat: number, lng: number, accuracy: number | null | undefined, fences: Fence[]) {
  const slack = Math.min(50, Math.max(0, accuracy ?? 0));
  let best: { fence: Fence; distance: number } | null = null;
  for (const f of fences) {
    const distance = haversineMeters(lat, lng, f.lat, f.lng);
    if (distance <= f.radius_m + slack && (!best || distance < best.distance)) best = { fence: f, distance };
  }
  return best;
}
export function nearestFence(lat: number, lng: number, fences: Fence[]) {
  return fences.map((f) => ({ fence: f, distance: haversineMeters(lat, lng, f.lat, f.lng) })).sort((a, b) => a.distance - b.distance)[0] ?? null;
}

export type CapturePolicy = {
  web: { enabled: boolean; comment_required?: boolean; ip_ranges: string[] };
  mobile: {
    enabled: boolean; geofence_ids: string[];
    /** take a selfie with every location clock-in (stored for HR to see; never matched against anything) */
    selfie?: boolean;
    /** the first location clock-in from a browser/device the person hasn't used before waits for the manager */
    first_clock_in_approval?: boolean;
    /** reject location fixes less precise than this many metres (null = no limit beyond the 50 m fence slack) */
    accuracy_m?: number | null;
  };
  remote: { wfh: boolean; od: boolean };
  limits: { regularization_per_month: number; regularization_past_days: number; partial_day_minutes_per_month: number };
};

export type PunchCheck =
  | { ok: true; source: "web" | "mobile"; fence: string | null; fenceId: string | null }
  | { ok: false; code: "web_off" | "ip" | "location_needed" | "outside" | "comment" | "accuracy" | "stale" | "selfie"; message: string };

/** A location fix older than this is a cached position, not where the phone is now. */
export const MAX_FIX_AGE_MS = 60_000;

/**
 * Server-side decision for a browser punch. A punch is accepted from an allowed network (web capture),
 * or from inside a geofence (location capture), or from anywhere on a day with approved WFH / on duty.
 * Location clock-ins also need a fresh fix (no last-known position), one precise enough for the policy, and a selfie when the policy asks for one.
 */
export function checkPunch(p: CapturePolicy, fences: Fence[], m: { ip: string | null; lat?: number | null; lng?: number | null; accuracy?: number | null; fixAgeMs?: number | null; hasSelfie?: boolean; comment?: string | null; remoteToday: boolean }): PunchCheck {
  if (p.web.comment_required && !m.comment?.trim()) return { ok: false, code: "comment", message: "Add a short comment to clock in or out." };
  if (m.remoteToday) return { ok: true, source: "web", fence: null, fenceId: null };
  const webOk = p.web.enabled && ipAllowed(m.ip, p.web.ip_ranges ?? []);
  const geo = p.mobile.enabled && fences.length > 0;
  if (webOk) return { ok: true, source: "web", fence: null, fenceId: null };
  if (geo) {
    if (m.lat == null || m.lng == null) return { ok: false, code: "location_needed", message: "Share your location to clock in from here." };
    if (m.fixAgeMs != null && m.fixAgeMs > MAX_FIX_AGE_MS) return { ok: false, code: "stale", message: "That location is an old reading. Let the phone find where you are now and try again." };
    const limit = p.mobile.accuracy_m ?? null;
    if (limit != null && limit > 0 && m.accuracy != null && m.accuracy > limit) return { ok: false, code: "accuracy", message: `Your location is only accurate to about ${Math.round(m.accuracy)} m; this needs ${limit} m or better. Step outside or turn on GPS and try again.` };
    if (p.mobile.selfie && !m.hasSelfie) return { ok: false, code: "selfie", message: "Take a selfie to clock in from here." };
    const hit = fenceFor(m.lat, m.lng, m.accuracy, fences);
    if (hit) return { ok: true, source: "mobile", fence: hit.fence.name, fenceId: hit.fence.id };
    const near = nearestFence(m.lat, m.lng, fences)!;
    const km = near.distance >= 1000 ? `${(near.distance / 1000).toFixed(1)} km` : `${Math.round(near.distance)} m`;
    return { ok: false, code: "outside", message: `You're ${km} from ${near.fence.name}. Move within ${near.fence.radius_m} m to clock in.` };
  }
  if (!p.web.enabled) return { ok: false, code: "web_off", message: "Clocking in from the browser is turned off for you. Use your office's attendance device." };
  return { ok: false, code: "ip", message: "You can only clock in from your office network. If you're working remotely, ask for work from home." };
}

// ---------------------------------------------------------------- employee requests

export type RequestKind = "regularization" | "partial_day" | "wfh" | "on_duty" | "overtime" | "shift_change" | "weekly_off_change" | "remote_clock_in";
export const REQUEST_LABELS: Record<RequestKind, string> = {
  regularization: "Regularize", partial_day: "Partial day", wfh: "Work from home", on_duty: "On duty",
  overtime: "Overtime", shift_change: "Shift change", weekly_off_change: "Weekly off swap", remote_clock_in: "New device clock-in",
};

export function validateRegularization(r: {
  date: ISODate; today: ISODate; joining: ISODate; inTime: string; outTime: string; reason: string;
  limits: CapturePolicy["limits"]; usedThisMonth: number; pendingSameDay: boolean;
}): string | null {
  if (!isHHMM(r.inTime) || !isHHMM(r.outTime)) return "Enter clock-in and clock-out times like 09:30.";
  if (r.inTime === r.outTime) return "Clock-in and clock-out can't be the same time.";
  if (r.date >= r.today) return "You can regularize past days only.";
  if (r.date < r.joining) return "This day is before you joined.";
  if (r.date < addDaysISO(r.today, -r.limits.regularization_past_days)) return `You can regularize up to ${r.limits.regularization_past_days} days back.`;
  if (r.pendingSameDay) return "You already have a regularization waiting for this day.";
  if (r.usedThisMonth >= r.limits.regularization_per_month) return `You've used all ${r.limits.regularization_per_month} regularizations for this month.`;
  if (!r.reason.trim()) return "Add a reason for your manager.";
  return null;
}

export function validateRemote(r: {
  kind: "wfh" | "on_duty"; from: ISODate; to: ISODate; half: "first" | "second" | null; today: ISODate; joining: ISODate;
  allowed: boolean; pastDays: number; overlaps: boolean; reason: string;
}): string | null {
  const label = r.kind === "wfh" ? "Work from home" : "On duty";
  if (!r.allowed) return `${label} requests are turned off for you.`;
  if (r.to < r.from) return "The end date is before the start date.";
  if (r.half && r.from !== r.to) return "Half days work for a single date only.";
  if (addDaysISO(r.from, 31) <= r.to) return "Ask for at most 31 days at a time.";
  if (r.from < r.joining) return "These dates are before you joined.";
  if (r.from < addDaysISO(r.today, -r.pastDays)) return `You can ask for up to ${r.pastDays} days back.`;
  if (r.from > addDaysISO(r.today, 90)) return "Ask at most 90 days ahead.";
  if (r.overlaps) return `You already have work from home or on duty on some of these dates.`;
  if (!r.reason.trim()) return "Add a reason for your manager.";
  return null;
}

export function validatePartial(r: {
  date: ISODate; type: "late_arrival" | "early_leave"; minutes: number; today: ISODate; joining: ISODate; pastDays: number;
  usedMinutes: number; monthlyMinutes: number; reason: string; sameDayType: boolean;
}): string | null {
  if (!Number.isInteger(r.minutes) || r.minutes < 15 || r.minutes > 240) return "Choose between 15 minutes and 4 hours.";
  if (r.date < r.joining) return "This day is before you joined.";
  if (r.date < addDaysISO(r.today, -r.pastDays)) return `You can ask for up to ${r.pastDays} days back.`;
  if (r.date > addDaysISO(r.today, 30)) return "Ask at most 30 days ahead.";
  if (r.sameDayType) return r.type === "late_arrival" ? "You already asked to come in late on this day." : "You already asked to leave early on this day.";
  if (r.usedMinutes + r.minutes > r.monthlyMinutes) return `That's over your ${fmtHours(r.monthlyMinutes)} partial-day allowance this month (${fmtHours(Math.max(0, r.monthlyMinutes - r.usedMinutes))} left).`;
  if (!r.reason.trim()) return "Add a reason for your manager.";
  return null;
}

export const fmtHours = (m: number) => (m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`);

/** Portion of `date` a range with an optional half covers (0.5 for a half day). */
export function rangePortion(date: ISODate, from: ISODate, to: ISODate, half: "first" | "second" | null) {
  if (date < from || date > to) return 0;
  return half ? 0.5 : 1;
}

/** Portion of `date` an approved leave request covers. */
export function leavePortion(date: ISODate, l: { from_date: ISODate; to_date: ISODate; from_half: string; to_half: string }) {
  if (date < l.from_date || date > l.to_date) return 0;
  if (date === l.from_date && l.from_half === "second") return 0.5;
  if (date === l.to_date && l.to_half === "first") return 0.5;
  return 1;
}

// ---------------------------------------------------------------- weekly-off patterns

export type OffValue = "off" | "half" | "work";
export type OffGrid = Record<Weekday, OffValue[]>;   // 5 values per weekday: 1st..5th occurrence in the month
const OFF_VALUES: OffValue[] = ["off", "half", "work"];

/** Grid for the editor from a stored pattern (a single value means every week). */
export function gridFromPattern(p: Partial<Record<Weekday, OffValue | OffValue[]>>): OffGrid {
  return Object.fromEntries(WEEK.map((d) => {
    const v = p[d];
    return [d, Array.isArray(v) ? [0, 1, 2, 3, 4].map((i) => v[i] ?? "work") : Array(5).fill(v ?? "work")];
  })) as OffGrid;
}

/** Stored pattern from the editor grid: uniform weekdays collapse to one value, working-every-week weekdays are dropped. */
export function patternFromGrid(g: Partial<Record<string, unknown>>): { pattern: Partial<Record<Weekday, OffValue | OffValue[]>>; error: string | null } {
  const pattern: Partial<Record<Weekday, OffValue | OffValue[]>> = {};
  let workingSlots = 0;
  for (const d of WEEK) {
    const v = g[d];
    if (v === undefined) { workingSlots += 5; continue; }
    if (!Array.isArray(v) || v.length !== 5 || v.some((x) => !OFF_VALUES.includes(x as OffValue))) return { pattern: {}, error: "Each weekday needs a value for weeks 1 to 5." };
    const vals = v as OffValue[];
    workingSlots += vals.filter((x) => x !== "off").length;
    if (vals.every((x) => x === "work")) continue;
    pattern[d] = vals.every((x) => x === vals[0]) ? vals[0] : vals;
  }
  if (workingSlots === 0) return { pattern: {}, error: "At least one day has to be a working day." };
  return { pattern, error: null };
}
