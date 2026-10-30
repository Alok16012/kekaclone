import "server-only";
import type { Tx } from "@/server/db";
import { addDaysISO, eachDay, todayIn, type ISODate } from "@/lib/dates";
import { dayType as calendarDayType, type WeeklyOffPattern } from "@/server/modules/leave/rules";
import { balances, holidayListNameFor } from "@/server/modules/leave/service";
import { cycleStartFor } from "@/server/modules/leave/effects";
import {
  allocateDeductions, dayWindow, evaluateDay, leavePortion, ledgerDelta, penaltiesFor,
  type CapturePolicy, type DayType, type PenaltyPolicy, type ShiftDef,
} from "./rules";

/**
 * Attendance processing: rebuilds attendance_days from punches, shift, calendar, approved leave and
 * attendance requests, then applies the person's penalization policy. Safe to run any number of times:
 * the day row is upserted and leave deductions are posted as idempotent ledger deltas.
 */

export type Person = { id: string; joining_date: ISODate; exit_date: ISODate | null; tz: string; penalization_policy_id: string | null; capture_policy_id: string | null };

export async function personFor(tx: Tx, employeeId: string): Promise<Person | null> {
  const [p] = await tx<Person[]>`
    select e.id, e.joining_date::text, e.exit_date::text, coalesce(l.timezone, t.timezone, 'Asia/Kolkata') as tz,
           e.penalization_policy_id, e.capture_policy_id
    from employees e join tenants t on t.id = e.tenant_id left join locations l on l.id = e.location_id where e.id = ${employeeId}`;
  return p ?? null;
}

type ShiftRow = ShiftDef & { id: string; name: string; code: string };
const SHIFT_COLS = (tx: Tx) => tx`s.id, s.name, s.code, s.kind, s.timings, s.break_minutes, s.grace_minutes, s.half_day_minutes`;

/** The person's shift on each date of a range: their assignment, else the company's default (oldest) shift. */
export async function shiftsFor(tx: Tx, employeeId: string, from: ISODate, to: ISODate): Promise<(d: ISODate) => ShiftRow | null> {
  const rows = await tx<(ShiftRow & { lo: string | null; hi: string | null })[]>`
    select ${SHIFT_COLS(tx)}, lower(a.period)::text as lo, upper(a.period)::text as hi
    from shift_assignments a join shifts s on s.id = a.shift_id
    where a.employee_id = ${employeeId} and a.period && daterange(${from}::date, ${addDaysISO(to, 1)}::date)`;
  const [fallback] = await tx<ShiftRow[]>`select ${SHIFT_COLS(tx)} from shifts s order by s.created_at, s.id limit 1`;
  return (d) => rows.find((r) => (!r.lo || r.lo <= d) && (!r.hi || d < r.hi)) ?? fallback ?? null;
}

const DEFAULT_WEEKLY_OFF: WeeklyOffPattern = { sat: "off", sun: "off" };

/** Holiday / weekly off / working for each date of a range, using the weekly-off policy in force on that date. */
export async function calendarFor(tx: Tx, employeeId: string, from: ISODate, to: ISODate): Promise<(d: ISODate) => DayType> {
  // Same holiday calendar as leave: lists sharing a name are one calendar across years; floaters only for people who picked them.
  const list = await holidayListNameFor(tx, employeeId);
  const holidays = await tx<{ date: string }[]>`
    select h.date::text from holidays h join holiday_lists hl on hl.id = h.holiday_list_id
    where hl.name = ${list} and h.date between ${from} and ${to}
      and (not h.is_floater or exists (select 1 from floater_choices f where f.holiday_id = h.id and f.employee_id = ${employeeId}))`;
  const wo = await tx<{ pattern: WeeklyOffPattern; lo: string | null; hi: string | null }[]>`
    select p.pattern, lower(a.period)::text as lo, upper(a.period)::text as hi
    from weekly_off_assignments a join weekly_off_policies p on p.id = a.policy_id
    where a.employee_id = ${employeeId} and a.period && daterange(${from}::date, ${addDaysISO(to, 1)}::date)`;
  const [dflt] = await tx<{ pattern: WeeklyOffPattern }[]>`select pattern from weekly_off_policies order by created_at, id limit 1`;
  const hol = new Set(holidays.map((h) => h.date));
  return (d) => {
    const pattern = wo.find((r) => (!r.lo || r.lo <= d) && (!r.hi || d < r.hi))?.pattern ?? dflt?.pattern ?? DEFAULT_WEEKLY_OFF;
    return calendarDayType(d, { holidays: hol, weeklyOff: pattern });
  };
}

const CAPTURE_DEFAULTS: CapturePolicy = {
  web: { enabled: true, comment_required: false, ip_ranges: [] },
  mobile: { enabled: true, geofence_ids: [], selfie: false },
  remote: { wfh: true, od: true },
  limits: { regularization_per_month: 3, regularization_past_days: 7, partial_day_minutes_per_month: 240 },
};

/** The person's capture policy (or the company default), with defaults filled in for missing keys. */
export async function capturePolicyFor(tx: Tx, employeeId: string) {
  const [row] = await tx<{ id: string; name: string; web: Partial<CapturePolicy["web"]>; mobile: Partial<CapturePolicy["mobile"]>; remote: Partial<CapturePolicy["remote"]>; limits: Partial<CapturePolicy["limits"]> }[]>`
    select c.id, c.name, c.web, c.mobile, c.remote, c.limits from capture_policies c
    where c.id = coalesce((select capture_policy_id from employees where id = ${employeeId}), (select id from capture_policies order by created_at, id limit 1))`;
  const policy: CapturePolicy = {
    web: { ...CAPTURE_DEFAULTS.web, ...row?.web },
    mobile: { ...CAPTURE_DEFAULTS.mobile, ...row?.mobile },
    remote: { ...CAPTURE_DEFAULTS.remote, ...row?.remote },
    limits: { ...CAPTURE_DEFAULTS.limits, ...row?.limits },
  };
  const fences = policy.mobile.geofence_ids.length
    ? await tx<{ id: string; name: string; lat: number; lng: number; radius_m: number }[]>`select id, name, lat, lng, radius_m from geofences where id = any(${policy.mobile.geofence_ids}::uuid[])`
    : [];
  return { id: row?.id ?? null, name: row?.name ?? "Default", policy, fences };
}

export type StoredPenalty = { rule: string; days: number; detail: string; incident?: number; deductions: { days: number; leaveTypeId: string | null; leaveType?: string }[] };

type ProcessOpts = { now?: Date; person?: Person };

/** Recomputes one attendance day for one person. Returns null when the day is locked (payroll finalized). */
export async function processAttendance(tx: Tx, tenantId: string, employeeId: string, date: ISODate, opts: ProcessOpts = {}) {
  const now = opts.now ?? new Date();
  await tx`select pg_advisory_xact_lock(hashtext(${"attendance:" + employeeId}))`;
  const person = opts.person ?? (await personFor(tx, employeeId));
  if (!person) return null;
  const [existing] = await tx<{ is_locked: boolean; late_minutes: number; penalties: StoredPenalty[] }[]>`
    select is_locked, late_minutes, penalties from attendance_days where employee_id = ${employeeId} and date = ${date}`;
  if (existing?.is_locked) return null;

  const shiftOn = await shiftsFor(tx, employeeId, date, addDaysISO(date, 1));
  const typeOn = await calendarFor(tx, employeeId, date, date);
  const shift = shiftOn(date);
  const w = dayWindow(date, shift, shiftOn(addDaysISO(date, 1)), person.tz);

  const all = await tx<{ at: Date; source: string }[]>`
    select at, source from punches where employee_id = ${employeeId} and status = 'valid' and at >= ${w.start} and at < ${w.end} order by at`;
  const regularized = all.some((p) => p.source === "regularization");
  const punches = (regularized ? all.filter((p) => p.source === "regularization") : all).map((p) => p.at);

  const leaves = await tx<{ id: string; from_date: string; to_date: string; from_half: string; to_half: string }[]>`
    select id, from_date::text, to_date::text, from_half, to_half from leave_requests
    where employee_id = ${employeeId} and status = 'approved' and from_date <= ${date} and to_date >= ${date}`;
  const leaveP = Math.min(1, leaves.reduce((s, l) => s + leavePortion(date, l), 0));
  const reqs = await tx<{ kind: string; payload: { half?: "first" | "second" | null; type?: string; minutes?: number } }[]>`
    select kind, payload from attendance_requests
    where employee_id = ${employeeId} and status = 'approved' and kind in ('wfh','on_duty','partial_day') and from_date <= ${date} and to_date >= ${date}`;
  const remoteReq = reqs.find((r) => r.kind === "wfh" || r.kind === "on_duty");
  const remote = remoteReq ? { kind: remoteReq.kind as "wfh" | "on_duty", portion: remoteReq.payload.half ? 0.5 : 1 } : null;
  const partial = {
    lateMinutes: reqs.filter((r) => r.kind === "partial_day" && r.payload.type === "late_arrival").reduce((s, r) => s + (r.payload.minutes ?? 0), 0),
    earlyMinutes: reqs.filter((r) => r.kind === "partial_day" && r.payload.type === "early_leave").reduce((s, r) => s + (r.payload.minutes ?? 0), 0),
  };
  const joined = date >= person.joining_date && (!person.exit_date || date <= person.exit_date);
  const inputs = { date, tz: person.tz, dayType: typeOn(date), joined, shift, punches, final: now >= w.end, leavePortion: leaveP, remote, partial };
  const day = evaluateDay(inputs);

  // penalization
  const [policy] = person.penalization_policy_id
    ? await tx<(PenaltyPolicy & { deduct_from_leave_type_ids: string[] })[]>`
        select late_arrival, hours_shortage, no_attendance, missing_swipe, deduct_from_leave_type_ids from penalization_policies where id = ${person.penalization_policy_id}`
    : [];
  const monthStart = date.slice(0, 8) + "01";
  const [{ prior }] = await tx<{ prior: number }[]>`
    select count(*)::int as prior from attendance_days
    where employee_id = ${employeeId} and date >= ${monthStart} and date < ${date} and exists (select 1 from jsonb_array_elements(penalties) x where x->>'rule' = 'late_arrival')`;
  const pens = penaltiesFor(policy ?? null, day, inputs, prior);

  const posted = await tx<{ leave_type_id: string; days: string }[]>`
    select leave_type_id, -sum(amount) as days from leave_ledger
    where employee_id = ${employeeId} and kind = 'penalty' and ref_type = 'attendance_day' and entry_date = ${date} group by leave_type_id`;
  const postedBy = new Map(posted.map((p) => [p.leave_type_id, Number(p.days)]));
  const order = policy?.deduct_from_leave_type_ids ?? [];
  const bal = order.length && pens.some((p) => p.days > 0 && !p.lopOnly) ? await balances(tx, employeeId, date) : [];
  const ordered = order.map((id) => bal.find((b) => b.id === id)).filter((b) => !!b)
    .map((b) => ({ id: b.id, available: b.available + (postedBy.get(b.id) ?? 0) }));   // this day's own earlier deduction is given back first
  const deductions = allocateDeductions(pens, ordered);
  const names = new Map(bal.map((b) => [b.id, b.name]));
  const stored: StoredPenalty[] = pens.map((p) => ({
    rule: p.rule, days: p.days, detail: p.detail, ...(p.incident ? { incident: p.incident } : {}),
    deductions: deductions.filter((d) => d.rule === p.rule).map((d) => ({ days: d.days, leaveTypeId: d.leaveTypeId, ...(d.leaveTypeId ? { leaveType: names.get(d.leaveTypeId) } : {}) })),
  }));
  const status = day.status;

  const [row] = await tx<{ id: string }[]>`
    insert into attendance_days (tenant_id, employee_id, date, shift_id, day_type, first_in, last_out, gross_minutes, effective_minutes, late_minutes, early_minutes, status, leave_request_id, penalties, computed_at)
    values (${tenantId}, ${employeeId}, ${date}, ${shift?.id ?? null}, ${inputs.dayType}, ${day.firstIn}, ${day.lastOut}, ${day.gross}, ${day.effective},
            ${day.late}, ${day.early}, ${status}, ${leaves[0]?.id ?? null}, ${tx.json(stored)}, now())
    on conflict (employee_id, date) do update set shift_id = excluded.shift_id, day_type = excluded.day_type, first_in = excluded.first_in,
      last_out = excluded.last_out, gross_minutes = excluded.gross_minutes, effective_minutes = excluded.effective_minutes,
      late_minutes = excluded.late_minutes, early_minutes = excluded.early_minutes, status = excluded.status,
      leave_request_id = excluded.leave_request_id, penalties = excluded.penalties, computed_at = now()
    where not attendance_days.is_locked
    returning id`;

  // leave deductions: post only the difference per leave type (idempotent by key)
  const target = new Map<string, number>();
  for (const d of deductions) if (d.leaveTypeId) target.set(d.leaveTypeId, (target.get(d.leaveTypeId) ?? 0) + d.days);
  const typeIds = new Set([...target.keys(), ...postedBy.keys()]);
  if (typeIds.size) {
    const cycle = await cycleStartFor(tx, employeeId, date);
    for (const typeId of typeIds) {
      const delta = ledgerDelta(employeeId, date, typeId, postedBy.get(typeId) ?? 0, target.get(typeId) ?? 0);
      if (!delta) continue;
      await tx`
        insert into leave_ledger (tenant_id, employee_id, leave_type_id, cycle_start, entry_date, kind, amount, ref_type, ref_id, note, idempotency_key)
        values (${tenantId}, ${employeeId}, ${typeId}, ${cycle}, ${date}, 'penalty', ${delta.amount}, 'attendance_day', ${row?.id ?? null},
                ${delta.amount < 0 ? "Attendance penalty" : "Attendance penalty reversed"}, ${delta.key})
        on conflict (tenant_id, idempotency_key) do nothing`;
    }
  }
  const lop = deductions.filter((d) => !d.leaveTypeId).reduce((s, d) => s + d.days, 0);
  const lateChanged = (existing?.penalties ?? []).some((p) => p.rule === "late_arrival") !== pens.some((p) => p.rule === "late_arrival");
  return { status, day, penalties: stored, lop, final: inputs.final, lateChanged };
}

/** Old name kept for callers that only need the day rebuilt. */
export const recomputeDay = (tx: Tx, tenantId: string, employeeId: string, date: ISODate) => processAttendance(tx, tenantId, employeeId, date);

/**
 * Re-runs a range of days (e.g. after an approval or an assignment change), and then the rest of that month,
 * because late-arrival counts carry forward within a month. Never goes past today.
 */
export async function reprocessFrom(tx: Tx, tenantId: string, employeeId: string, from: ISODate, to: ISODate = from, now = new Date()) {
  const person = await personFor(tx, employeeId);
  if (!person) return 0;
  const today = todayIn(person.tz, now);
  const monthEnd = addDaysISO(addDaysISO(to.slice(0, 8) + "01", 32).slice(0, 8) + "01", -1);
  const last = monthEnd < today ? monthEnd : today;
  const start = from < addDaysISO(today, -62) ? addDaysISO(today, -62) : from;
  let n = 0;
  for (const d of eachDay(start, last)) {
    if (d < person.joining_date) continue;
    await processAttendance(tx, tenantId, employeeId, d, { now, person });
    n++;
  }
  return n;
}
