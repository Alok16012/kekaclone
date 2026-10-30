import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { can } from "@/server/auth/permissions";
import { addDaysISO, todayIn, type ISODate } from "@/lib/dates";
import { cancelApproval, startApproval, timeline } from "@/server/modules/approvals/service";
import { fmtRange } from "@/server/modules/leave/service";
import { REQUEST_LABELS, dayWindow, fmtHours, isOvernight, toMin, validatePartial, validateRegularization, validateRemote, zonedToUtc, type RequestKind } from "./rules";
import { capturePolicyFor, personFor, reprocessFrom, shiftsFor } from "./process";

export type RequestInput =
  | { kind: "regularization"; date: ISODate; inTime: string; outTime: string; reason: string }
  | { kind: "wfh" | "on_duty"; from: ISODate; to: ISODate; half: "first" | "second" | null; reason: string }
  | { kind: "partial_day"; date: ISODate; type: "late_arrival" | "early_leave"; minutes: number; reason: string };

export type Payload = { inTime?: string; outTime?: string; half?: "first" | "second" | null; type?: "late_arrival" | "early_leave"; minutes?: number };

const monthBounds = (d: ISODate) => {
  const first = d.slice(0, 8) + "01";
  return { first, next: addDaysISO(first, 32).slice(0, 8) + "01" };
};

export function describe(kind: string, from: ISODate, to: ISODate, p: Payload) {
  const label = REQUEST_LABELS[kind as RequestKind] ?? kind;
  const when = fmtRange(from, to);
  if (kind === "regularization") return `${label} · ${when} · ${p.inTime}–${p.outTime}`;
  if (kind === "partial_day") return `${label} · ${when} · ${p.type === "late_arrival" ? "late arrival" : "early leave"} ${fmtHours(p.minutes ?? 0)}`;
  return `${label} · ${when}${p.half ? ` · ${p.half} half` : ""}`;
}

/** Employee asks to regularize a day, work from home / be on duty, or come late / leave early. Goes to their manager. */
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
 * corrected pair (the originals are kept, just not counted); every approval re-processes the affected days.
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
  await reprocessFrom(tx, r.tenant_id, r.employee_id, r.from_date, r.to_date);
}

export type MyRequest = { id: string; kind: string; from_date: string; to_date: string; payload: Payload; reason: string | null; status: "pending" | "approved" | "rejected" | "cancelled"; created_at: Date };

export async function myRequests(tx: Tx, employeeId: string) {
  return tx<MyRequest[]>`
    select id, kind, from_date::text, to_date::text, payload, reason, status, created_at from attendance_requests
    where employee_id = ${employeeId} and kind in ('regularization','partial_day','wfh','on_duty') order by created_at desc limit 200`;
}

/** Monthly usage so the request forms can show what's left. */
export async function requestAllowance(tx: Tx, employeeId: string, date: ISODate) {
  const { first, next } = monthBounds(date);
  const { policy } = await capturePolicyFor(tx, employeeId);
  const [u] = await tx<{ regs: number; minutes: number }[]>`
    select count(*) filter (where kind = 'regularization')::int as regs,
           coalesce(sum((payload->>'minutes')::int) filter (where kind = 'partial_day'), 0)::int as minutes
    from attendance_requests where employee_id = ${employeeId} and status in ('pending','approved') and from_date >= ${first} and from_date < ${next}`;
  return { limits: policy.limits, remote: policy.remote, usedRegularizations: u.regs, usedPartialMinutes: u.minutes };
}

/** Detail for the approver's drawer: the request, the day as recorded now, and the approval chain. */
export async function requestDetail(tx: Tx, actor: Actor, id: string) {
  const [r] = await tx<{ id: string; employee_id: string; name: string; kind: string; from_date: string; to_date: string; payload: Payload; reason: string | null; status: MyRequest["status"]; created_at: Date }[]>`
    select r.id, r.employee_id, e.display_name as name, r.kind, r.from_date::text, r.to_date::text, r.payload, r.reason, r.status, r.created_at
    from attendance_requests r join employees e on e.id = r.employee_id where r.id = ${id}`;
  if (!r) return null;
  const [approver] = await tx<{ ok: boolean }[]>`
    select true as ok from approval_requests q join approval_steps s on s.request_id = q.id
    where q.entity_type = 'attendance_request' and q.entity_id = ${id} and s.approver_employee_id = ${actor.employeeId} limit 1`;
  if (r.employee_id !== actor.employeeId && !approver && !can(actor, "attendance.admin")) return null;
  const [day] = await tx<{ first_in: Date | null; last_out: Date | null; status: string; late_minutes: number }[]>`
    select first_in, last_out, status, late_minutes from attendance_days where employee_id = ${r.employee_id} and date = ${r.from_date}`;
  const [usage] = await tx<{ regs: number; minutes: number }[]>`
    select count(*) filter (where kind = 'regularization')::int as regs, coalesce(sum((payload->>'minutes')::int) filter (where kind = 'partial_day'), 0)::int as minutes
    from attendance_requests where employee_id = ${r.employee_id} and status = 'approved' and date_trunc('month', from_date) = date_trunc('month', ${r.from_date}::date)`;
  const steps = await timeline(tx, "attendance_request", id);
  return {
    ...r, created_at: r.created_at.toISOString(), label: REQUEST_LABELS[r.kind as RequestKind] ?? r.kind, summary: describe(r.kind, r.from_date, r.to_date, r.payload),
    day: day ? { firstIn: day.first_in?.toISOString() ?? null, lastOut: day.last_out?.toISOString() ?? null, status: day.status, late: day.late_minutes } : null,
    approvedThisMonth: usage,
    steps: steps.map((s) => ({ ...s, acted_at: s.acted_at?.toISOString() ?? null })),
  };
}
