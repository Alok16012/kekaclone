import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { addDaysISO, eachDay, todayIn, type ISODate } from "@/lib/dates";
import { cancelApproval, startApproval, timeline } from "@/server/modules/approvals/service";
import { fmtRange } from "@/server/modules/leave/service";
import { REQUEST_LABELS, dayWindow, fmtHours, isOvernight, toMin, validatePartial, validateRegularization, validateRemote, zonedToUtc, type RequestKind } from "./rules";
import { normalizeRules, validateOvertimeRequest } from "./overtime-rules";
import { validateShiftChange, validateWeeklyOffChange, type ShiftRule } from "./roster-rules";
import { calendarFor, capturePolicyFor, personFor, reprocessFrom, shiftsFor } from "./process";

export type RequestInput =
  | { kind: "regularization"; date: ISODate; inTime: string; outTime: string; reason: string }
  | { kind: "wfh" | "on_duty"; from: ISODate; to: ISODate; half: "first" | "second" | null; reason: string }
  | { kind: "partial_day"; date: ISODate; type: "late_arrival" | "early_leave"; minutes: number; reason: string }
  | { kind: "overtime"; date: ISODate; minutes: number; reason: string }
  | { kind: "shift_change"; from: ISODate; to: ISODate; shiftId: string; reason: string }
  | { kind: "weekly_off_change"; offDate: ISODate; workDate: ISODate; reason: string };

export type Payload = {
  inTime?: string; outTime?: string; half?: "first" | "second" | null; type?: "late_arrival" | "early_leave"; minutes?: number;
  shiftId?: string; shiftName?: string; offDate?: ISODate; workDate?: ISODate;
};

const monthBounds = (d: ISODate) => {
  const first = d.slice(0, 8) + "01";
  return { first, next: addDaysISO(first, 32).slice(0, 8) + "01" };
};

export function describe(kind: string, from: ISODate, to: ISODate, p: Payload) {
  const label = REQUEST_LABELS[kind as RequestKind] ?? kind;
  const when = fmtRange(from, to);
  if (kind === "regularization") return `${label} · ${when} · ${p.inTime}–${p.outTime}`;
  if (kind === "partial_day") return `${label} · ${when} · ${p.type === "late_arrival" ? "late arrival" : "early leave"} ${fmtHours(p.minutes ?? 0)}`;
  if (kind === "overtime") return `${label} · ${when} · ${fmtHours(p.minutes ?? 0)}`;
  if (kind === "shift_change") return `${label} · ${when} · to ${p.shiftName ?? "another shift"}`;
  if (kind === "weekly_off_change") return `${label} · off ${fmtRange(p.offDate ?? from, p.offDate ?? from)}, work ${fmtRange(p.workDate ?? to, p.workDate ?? to)}`;
  return `${label} · ${when}${p.half ? ` · ${p.half} half` : ""}`;
}

/** The company's shift / weekly-off change rule (the oldest one is the default), or null when none is set up. */
export async function shiftRuleFor(tx: Tx): Promise<(ShiftRule & { id: string; name: string }) | null> {
  const [r] = await tx<(ShiftRule & { id: string; name: string })[]>`
    select id, name, allowed_shift_ids, request_window_days, max_requests_per_month, allow_on_off_days from shift_rules order by created_at, id limit 1`;
  return r ?? null;
}

/** Employee asks to regularize a day, work from home / be on duty, come late / leave early, claim overtime or change shift / weekly off. Goes to their manager. */
export async function createRequest(tx: Tx, actor: Actor, input: RequestInput) {
  const employeeId = actor.employeeId;
  await tx`select pg_advisory_xact_lock(hashtext(${"attendance-request:" + employeeId}))`;   // limits are counted, so serialise
  const person = await personFor(tx, employeeId);
  if (!person) throw new AppError("not_found", "We couldn't find your employee record.");
  const today = todayIn(person.tz);
  const { policy } = await capturePolicyFor(tx, employeeId);
  const reason = input.reason.trim().slice(0, 1000);
  let from: ISODate, to: ISODate, payload: Payload, error: string | null;

  if (input.kind === "regularization") {
    const { first, next } = monthBounds(input.date);
    const [{ used, same }] = await tx<{ used: number; same: number }[]>`
      select count(*) filter (where status in ('pending','approved'))::int as used,
             count(*) filter (where status = 'pending' and from_date = ${input.date})::int as same
      from attendance_requests where employee_id = ${employeeId} and kind = 'regularization' and from_date >= ${first} and from_date < ${next}`;
    error = validateRegularization({ date: input.date, today, joining: person.joining_date, inTime: input.inTime, outTime: input.outTime, reason, limits: policy.limits, usedThisMonth: used, pendingSameDay: same > 0 });
    from = to = input.date; payload = { inTime: input.inTime, outTime: input.outTime };
  } else if (input.kind === "partial_day") {
    const { first, next } = monthBounds(input.date);
    const [{ used, same }] = await tx<{ used: number; same: number }[]>`
      select coalesce(sum((payload->>'minutes')::int), 0)::int as used,
             count(*) filter (where from_date = ${input.date} and payload->>'type' = ${input.type})::int as same
      from attendance_requests where employee_id = ${employeeId} and kind = 'partial_day' and status in ('pending','approved') and from_date >= ${first} and from_date < ${next}`;
    error = validatePartial({ date: input.date, type: input.type, minutes: input.minutes, today, joining: person.joining_date, pastDays: policy.limits.regularization_past_days,
      usedMinutes: used, monthlyMinutes: policy.limits.partial_day_minutes_per_month, reason, sameDayType: same > 0 });
    from = to = input.date; payload = { type: input.type, minutes: input.minutes };
  } else if (input.kind === "overtime") {
    if (!person.overtime_policy_id) throw new AppError("invalid", "You're not on an overtime policy. Ask HR if you think you should be.");
    const [pol] = await tx<{ rules: Record<string, unknown> }[]>`select rules from overtime_policies where id = ${person.overtime_policy_id}`;
    if (!pol) throw new AppError("invalid", "Your overtime policy no longer exists. Ask HR.");
    if (normalizeRules(pol.rules).approval === "none") throw new AppError("invalid", "Your overtime is counted automatically; there's nothing to request.");
    const [{ same }] = await tx<{ same: number }[]>`
      select count(*)::int as same from attendance_requests where employee_id = ${employeeId} and kind = 'overtime' and status in ('pending','approved') and from_date = ${input.date}`;
    const [day] = await tx<{ overtime_minutes: number; effective_minutes: number }[]>`select overtime_minutes, effective_minutes from attendance_days where employee_id = ${employeeId} and date = ${input.date}`;
    error = validateOvertimeRequest({ date: input.date, today, joining: person.joining_date, minutes: input.minutes, reason, pastDays: Math.max(policy.limits.regularization_past_days, 7), pendingSameDay: same > 0, computed: day?.overtime_minutes ?? null });
    from = to = input.date; payload = { minutes: input.minutes };
  } else if (input.kind === "shift_change") {
    const [shift] = await tx<{ id: string; name: string; code: string }[]>`select id, name, code from shifts where id = ${input.shiftId}`;
    if (!shift) throw new AppError("not_found", "That shift doesn't exist.");
    const rule = await shiftRuleFor(tx);
    const { first, next } = monthBounds(input.from);
    const [{ used, overlaps }] = await tx<{ used: number; overlaps: number }[]>`
      select count(*) filter (where from_date >= ${first} and from_date < ${next})::int as used,
             count(*) filter (where kind = 'shift_change' and from_date <= ${input.to} and to_date >= ${input.from})::int as overlaps
      from attendance_requests where employee_id = ${employeeId} and kind in ('shift_change','weekly_off_change') and status in ('pending','approved')`;
    const shiftOn = await shiftsFor(tx, employeeId, input.from, input.to);
    const typeOn = await calendarFor(tx, employeeId, input.from, input.to);
    const offDays = input.to >= input.from && addDaysISO(input.from, 31) > input.to ? eachDay(input.from, input.to).filter((d) => typeOn(d) !== "working").length : 0;
    error = validateShiftChange({ from: input.from, to: input.to, today, joining: person.joining_date, shiftId: shift.id, currentShiftId: shiftOn(input.from)?.id ?? null, reason, rule, usedThisMonth: used, overlaps: overlaps > 0, offDaysInRange: offDays });
    from = input.from; to = input.to; payload = { shiftId: shift.id, shiftName: `${shift.name} (${shift.code})` };
  } else if (input.kind === "weekly_off_change") {
    const rule = await shiftRuleFor(tx);
    const lo = input.offDate < input.workDate ? input.offDate : input.workDate, hi = input.offDate < input.workDate ? input.workDate : input.offDate;
    const { first, next } = monthBounds(lo);
    const [{ used, overlaps }] = await tx<{ used: number; overlaps: number }[]>`
      select count(*) filter (where from_date >= ${first} and from_date < ${next})::int as used,
             count(*) filter (where kind = 'weekly_off_change' and from_date <= ${hi} and to_date >= ${lo})::int as overlaps
      from attendance_requests where employee_id = ${employeeId} and kind in ('shift_change','weekly_off_change') and status in ('pending','approved')`;
    const typeOn = await calendarFor(tx, employeeId, lo, hi);
    error = validateWeeklyOffChange({ offDate: input.offDate, workDate: input.workDate, today, joining: person.joining_date, reason, offDateType: typeOn(input.offDate), workDateType: typeOn(input.workDate), rule, usedThisMonth: used, overlaps: overlaps > 0 });
    from = lo; to = hi; payload = { offDate: input.offDate, workDate: input.workDate };
  } else {
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from attendance_requests where employee_id = ${employeeId} and kind in ('wfh','on_duty') and status in ('pending','approved')
        and from_date <= ${input.to} and to_date >= ${input.from}`;
    error = validateRemote({ kind: input.kind, from: input.from, to: input.to, half: input.half, today, joining: person.joining_date,
      allowed: input.kind === "wfh" ? policy.remote.wfh : policy.remote.od, pastDays: policy.limits.regularization_past_days, overlaps: n > 0, reason });
    from = input.from; to = input.to; payload = { half: input.half };
  }
  if (error) throw new AppError("invalid", error);

  const [{ id }] = await tx<{ id: string }[]>`
    insert into attendance_requests (tenant_id, employee_id, kind, from_date, to_date, payload, reason)
    values (${actor.tenant.id}, ${employeeId}, ${input.kind}, ${from}, ${to}, ${tx.json(payload)}, ${reason}) returning id`;
  const { status } = await startApproval(tx, { tenantId: actor.tenant.id, entityType: "attendance_request", entityId: id, requesterId: employeeId, summary: `${actor.name} · ${describe(input.kind, from, to, payload)}` });
  if (status === "approved") await onAttendanceRequestDecided(tx, actor, id, "approved");   // nobody to ask (e.g. the founder)
  return { id, status };
}

/** The requester withdraws a request that hasn't been decided yet. */
export async function cancelRequest(tx: Tx, actor: Actor, id: string) {
  const [r] = await tx<{ id: string }[]>`
    update attendance_requests set status = 'cancelled' where id = ${id} and employee_id = ${actor.employeeId} and status = 'pending' returning id`;
  if (!r) throw new AppError("conflict", "Only requests still waiting for approval can be withdrawn.");
  await cancelApproval(tx, "attendance_request", id);
}

/**
 * Final decision from the approvals engine. Approving a regularization replaces that day's punches with the
 * corrected pair (the originals are kept, just not counted); a shift change or weekly-off swap goes on the roster;
 * every approval re-processes the affected days.
 */
export async function onAttendanceRequestDecided(tx: Tx, actor: Actor | null, id: string, final: "approved" | "rejected") {
  const [r] = await tx<{ tenant_id: string; employee_id: string; kind: string; from_date: string; to_date: string; payload: Payload; reason: string | null }[]>`
    update attendance_requests set status = ${final} where id = ${id} and status = 'pending'
    returning tenant_id, employee_id, kind, from_date::text, to_date::text, payload, reason`;
  if (!r || final !== "approved") return;
  if (r.kind === "regularization" && r.payload.inTime && r.payload.outTime) {
    const person = await personFor(tx, r.employee_id);
    const tz = person?.tz ?? "Asia/Kolkata";
    const timing = { start: r.payload.inTime, end: r.payload.outTime };
    const inAt = zonedToUtc(r.from_date, toMin(timing.start), tz);
    const outAt = zonedToUtc(r.from_date, toMin(timing.end) + (isOvernight(timing) ? 1440 : 0), tz);
    // an earlier regularization of the same day stops counting
    const shiftOn = await shiftsFor(tx, r.employee_id, r.from_date, addDaysISO(r.from_date, 1));
    const w = dayWindow(r.from_date, shiftOn(r.from_date), shiftOn(addDaysISO(r.from_date, 1)), tz);
    await tx`
      update punches set status = 'rejected' where employee_id = ${r.employee_id} and source = 'regularization' and status = 'valid'
        and at >= ${w.start} and at < ${w.end}`;
    await tx`
      insert into punches (tenant_id, employee_id, at, direction, source, comment) values
        (${r.tenant_id}, ${r.employee_id}, ${inAt}, 'in', 'regularization', ${r.reason}),
        (${r.tenant_id}, ${r.employee_id}, ${outAt}, 'out', 'regularization', ${r.reason})`;
  }
  if (r.kind === "shift_change" && r.payload.shiftId) {
    const [shift] = await tx<{ id: string }[]>`select id from shifts where id = ${r.payload.shiftId}`;
    if (shift) {
      for (const d of eachDay(r.from_date, r.to_date)) {
        await tx`insert into roster_entries (tenant_id, employee_id, date, shift_id) values (${r.tenant_id}, ${r.employee_id}, ${d}, ${shift.id})
                 on conflict (employee_id, date) do update set shift_id = excluded.shift_id`;
      }
    }
  }
  if (r.kind === "weekly_off_change" && r.payload.offDate && r.payload.workDate) {
    // the person's regular shift on the day they now work; the roster entry marks that day as working
    const base = await shiftsFor(tx, r.employee_id, r.payload.workDate, r.payload.workDate);
    const shift = base(r.payload.workDate);
    await tx`insert into roster_entries (tenant_id, employee_id, date, shift_id) values (${r.tenant_id}, ${r.employee_id}, ${r.payload.offDate}, null)
             on conflict (employee_id, date) do update set shift_id = null`;
    if (shift) await tx`insert into roster_entries (tenant_id, employee_id, date, shift_id) values (${r.tenant_id}, ${r.employee_id}, ${r.payload.workDate}, ${shift.id})
                        on conflict (employee_id, date) do update set shift_id = excluded.shift_id`;
  }
  await reprocessFrom(tx, r.tenant_id, r.employee_id, r.from_date, r.to_date);
}

export type MyRequest = { id: string; kind: string; from_date: string; to_date: string; payload: Payload; reason: string | null; status: "pending" | "approved" | "rejected" | "cancelled"; created_at: Date };

export async function myRequests(tx: Tx, employeeId: string) {
  return tx<MyRequest[]>`
    select id, kind, from_date::text, to_date::text, payload, reason, status, created_at from attendance_requests
    where employee_id = ${employeeId} and kind in ('regularization','partial_day','wfh','on_duty','overtime','shift_change','weekly_off_change') order by created_at desc limit 200`;
}

/** Monthly usage so the request forms can show what's left, plus what the person may ask for (overtime, shift changes). */
export async function requestAllowance(tx: Tx, employeeId: string, date: ISODate) {
  const { first, next } = monthBounds(date);
  const { policy } = await capturePolicyFor(tx, employeeId);
  const [u] = await tx<{ regs: number; minutes: number; shift_changes: number }[]>`
    select count(*) filter (where kind = 'regularization')::int as regs,
           coalesce(sum((payload->>'minutes')::int) filter (where kind = 'partial_day'), 0)::int as minutes,
           count(*) filter (where kind in ('shift_change','weekly_off_change'))::int as shift_changes
    from attendance_requests where employee_id = ${employeeId} and status in ('pending','approved') and from_date >= ${first} and from_date < ${next}`;
  const person = await personFor(tx, employeeId);
  const [pol] = person?.overtime_policy_id ? await tx<{ rules: Record<string, unknown> }[]>`select rules from overtime_policies where id = ${person.overtime_policy_id}` : [];
  const rule = await shiftRuleFor(tx);
  const shifts = await tx<{ id: string; name: string; code: string }[]>`select id, name, code from shifts order by created_at, id`;
  const allowedShifts = rule?.allowed_shift_ids.length ? shifts.filter((s) => rule.allowed_shift_ids.includes(s.id)) : shifts;
  return {
    limits: policy.limits, remote: policy.remote, usedRegularizations: u.regs, usedPartialMinutes: u.minutes,
    overtime: pol ? (normalizeRules(pol.rules).approval === "required" ? "request" : "auto") : "none" as "request" | "auto" | "none",
    shiftChange: { allowed: allowedShifts.map((s) => ({ id: s.id, name: `${s.name} (${s.code})` })), windowDays: rule?.request_window_days ?? null, maxPerMonth: rule?.max_requests_per_month ?? null, used: u.shift_changes, offDaysOk: rule?.allow_on_off_days ?? false },
  };
}

/** Detail for the approver's drawer: the request, the day as recorded now, and the approval chain. */
export async function requestDetail(tx: Tx, actor: Actor, id: string) {
  const [row] = await tx<({ id: string; employee_id: string; name: string; kind: string; from_date: string; to_date: string; payload: Payload; reason: string | null; status: MyRequest["status"]; created_at: Date } & Placement)[]>`
    select r.id, r.employee_id, e.display_name as name, r.kind, r.from_date::text, r.to_date::text, r.payload, r.reason, r.status, r.created_at,
      e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id
    from attendance_requests r join employees e on e.id = r.employee_id where r.id = ${id}`;
  if (!row) return null;
  const { department_id, location_id, legal_entity_id, business_unit_id, ...r } = row;
  const placement: Placement = { department_id, location_id, legal_entity_id, business_unit_id };
  const [approver] = await tx<{ ok: boolean }[]>`
    select true as ok from approval_requests q join approval_steps s on s.request_id = q.id
    where q.entity_type = 'attendance_request' and q.entity_id = ${id} and s.approver_employee_id = ${actor.employeeId} limit 1`;
  if (r.employee_id !== actor.employeeId && !approver && !canFor(actor, "attendance.admin", placement)) return null;   // scoped admins: their people only
  const [day] = await tx<{ first_in: Date | null; last_out: Date | null; status: string; late_minutes: number; effective_minutes: number; gross_minutes: number; overtime_minutes: number; shift: string | null }[]>`
    select a.first_in, a.last_out, a.status, a.late_minutes, a.effective_minutes, a.gross_minutes, a.overtime_minutes, s.name as shift
    from attendance_days a left join shifts s on s.id = a.shift_id where a.employee_id = ${r.employee_id} and a.date = ${r.from_date}`;
  const [usage] = await tx<{ regs: number; minutes: number }[]>`
    select count(*) filter (where kind = 'regularization')::int as regs, coalesce(sum((payload->>'minutes')::int) filter (where kind = 'partial_day'), 0)::int as minutes
    from attendance_requests where employee_id = ${r.employee_id} and status = 'approved' and date_trunc('month', from_date) = date_trunc('month', ${r.from_date}::date)`;
  const steps = await timeline(tx, "attendance_request", id);
  return {
    ...r, created_at: r.created_at.toISOString(), label: REQUEST_LABELS[r.kind as RequestKind] ?? r.kind, summary: describe(r.kind, r.from_date, r.to_date, r.payload),
    day: day ? { firstIn: day.first_in?.toISOString() ?? null, lastOut: day.last_out?.toISOString() ?? null, status: day.status, late: day.late_minutes, effective: day.effective_minutes, gross: day.gross_minutes, overtime: day.overtime_minutes, shift: day.shift } : null,
    approvedThisMonth: usage,
    steps: steps.map((s) => ({ ...s, acted_at: s.acted_at?.toISOString() ?? null })),
  };
}
