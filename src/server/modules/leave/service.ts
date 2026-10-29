import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { todayIn, type ISODate } from "@/lib/dates";
import { countLeaveDays, validateRequest, type ApplicationRules, type Calendar, type DayPart, type WeeklyOffPattern } from "./rules";
import { cycleStartFor, onLeaveDecided } from "./effects";
import { cancelApproval, notifyEmployee, startApproval } from "@/server/modules/approvals/service";

export type LeaveTypeBalance = {
  id: string; name: string; code: string; color: string; kind: string; quota: number | null;
  credited: number; used: number; pending: number; available: number; rules: ApplicationRules;
};

export async function calendarFor(tx: Tx, employeeId: string): Promise<Calendar> {
  const holidays = await tx<{ date: string }[]>`
    select h.date::text from holidays h
    where h.holiday_list_id = coalesce(
      (select holiday_list_id from employees where id = ${employeeId}),
      (select l.default_holiday_list_id from employees e join locations l on l.id = e.location_id where e.id = ${employeeId}),
      (select id from holiday_lists order by created_at limit 1)) and not h.is_floater`;
  const [wo] = await tx<{ pattern: WeeklyOffPattern }[]>`
    select p.pattern from weekly_off_assignments a join weekly_off_policies p on p.id = a.policy_id
    where a.employee_id = ${employeeId} order by lower(a.period) desc limit 1`;
  return { holidays: new Set(holidays.map((h) => h.date)), weeklyOff: wo?.pattern ?? { sat: "off", sun: "off" } };
}

/** credited = grants and adjustments; used = leave taken net of cancellations (+ penalties); available = credited − used − pending. */
export async function balances(tx: Tx, employeeId: string, asOf: ISODate = todayIn()): Promise<LeaveTypeBalance[]> {
  const cycle = await cycleStartFor(tx, employeeId, asOf);
  const rows = await tx<{ id: string; name: string; code: string; color: string; kind: string; quota: string | null; application: ApplicationRules; credited: string; used: string; pending: string }[]>`
    select t.id, t.name, t.code, t.color, t.kind, r.yearly_quota as quota, r.application,
      coalesce((select sum(amount) from leave_ledger l where l.employee_id = ${employeeId} and l.leave_type_id = t.id and l.cycle_start = ${cycle} and l.kind not in ('use','use_reversal','penalty')), 0) as credited,
      coalesce((select -sum(amount) from leave_ledger l where l.employee_id = ${employeeId} and l.leave_type_id = t.id and l.cycle_start = ${cycle} and l.kind in ('use','use_reversal','penalty')), 0) as used,
      coalesce((select sum(days) from leave_requests q where q.employee_id = ${employeeId} and q.leave_type_id = t.id and q.status = 'pending'), 0) as pending
    from employees e join leave_plan_rules r on r.leave_plan_id = e.leave_plan_id join leave_types t on t.id = r.leave_type_id
    where e.id = ${employeeId} order by t.kind = 'unpaid', t.name`;
  return rows.map((r) => {
    const credited = Number(r.credited), used = Number(r.used), pending = Number(r.pending);
    return { id: r.id, name: r.name, code: r.code, color: r.color, kind: r.kind, quota: r.quota == null ? null : Number(r.quota), rules: r.application,
      credited, used, pending, available: r.quota == null ? Infinity : credited - used - pending };
  });
}

export type LeaveInput = { leaveTypeId: string; from: ISODate; to: ISODate; fromPart: DayPart; toPart: DayPart; note?: string; notify?: string[]; attachments?: string[] };

export async function preview(tx: Tx, employeeId: string, input: LeaveInput) {
  const types = await balances(tx, employeeId, input.from);
  const type = types.find((t) => t.id === input.leaveTypeId);
  if (!type) throw new AppError("invalid", "This leave type isn't part of your leave plan.", "leaveTypeId");
  const cal = await calendarFor(tx, employeeId);
  const { days, breakdown } = countLeaveDays(input.from, input.to, input.fromPart, input.toPart, cal, type.rules);
  const violations = validateRequest({ ...input, days, today: todayIn(), available: type.available, rules: type.rules, hasAttachment: !!input.attachments?.length });
  return { days, breakdown, violations, type: { ...type, available: Number.isFinite(type.available) ? type.available : null } };
}

export async function apply(tx: Tx, actor: Actor, input: LeaveInput, onBehalfOf?: string) {
  const employeeId = onBehalfOf ?? actor.employeeId;
  await tx`select pg_advisory_xact_lock(hashtext(${employeeId + ":" + input.leaveTypeId}))`;   // serialise balance checks per employee+type
  const p = await preview(tx, employeeId, input);
  const blocking = p.violations.filter((v) => v.blocking);
  if (blocking.length) throw new AppError("invalid", blocking[0].message);

  let id: string;
  try {
    [{ id }] = await tx<{ id: string }[]>`
      insert into leave_requests (tenant_id, employee_id, leave_type_id, from_date, to_date, from_half, to_half, days, note, notify_employee_ids, attachment_file_ids, applied_by)
      values (${actor.tenant.id}, ${employeeId}, ${input.leaveTypeId}, ${input.from}, ${input.to},
              ${input.fromPart === "second" ? "second" : "full"}, ${input.toPart === "first" || (input.from === input.to && input.fromPart === "first") ? "first" : "full"},
              ${p.days}, ${input.note || null}, ${input.notify ?? []}, ${input.attachments ?? []}, ${actor.userId})
      returning id`;
  } catch (e) {
    if ((e as { code?: string }).code === "23P01") throw new AppError("conflict", "You already have leave on some of these dates.");
    throw e;
  }
  const [who] = await tx<{ display_name: string }[]>`select display_name from employees where id = ${employeeId}`;
  const summary = `${who.display_name} · ${p.type.name} · ${fmtRange(input.from, input.to)} · ${p.days} ${p.days === 1 ? "day" : "days"}`;
  const { status } = await startApproval(tx, { tenantId: actor.tenant.id, entityType: "leave", entityId: id, requesterId: employeeId, summary });
  // people the requester chose to keep in the loop (FYI, not approvers)
  for (const other of new Set(input.notify ?? [])) {
    if (other === employeeId) continue;
    await notifyEmployee(tx, actor.tenant.id, other, "leave.fyi", `${who.display_name} will be on leave`, `${p.type.name} · ${fmtRange(input.from, input.to)} · ${p.days} ${p.days === 1 ? "day" : "days"}`, "/home");
  }
  if (status === "approved") await onLeaveDecided(tx, actor, id, "approved");
  return { id, status, days: p.days };
}

export async function cancel(tx: Tx, actor: Actor, requestId: string) {
  const [r] = await tx<{ employee_id: string; status: string; from_date: string; leave_type_id: string; days: string }[]>`
    select employee_id, status, from_date::text, leave_type_id, days from leave_requests where id = ${requestId} for update`;
  if (!r || r.employee_id !== actor.employeeId) throw new AppError("not_found", "Leave request not found.");
  if (r.status === "pending") await cancelApproval(tx, "leave", requestId);
  else if (r.status === "approved") {
    if (r.from_date < todayIn()) throw new AppError("invalid", "Leave that has already started can't be cancelled here. Ask HR to adjust it.");
    const cycle = await cycleStartFor(tx, r.employee_id, r.from_date);
    await tx`insert into leave_ledger (tenant_id, employee_id, leave_type_id, cycle_start, entry_date, kind, amount, ref_type, ref_id, idempotency_key, created_by)
             values (${actor.tenant.id}, ${r.employee_id}, ${r.leave_type_id}, ${cycle}, ${todayIn()}, 'use_reversal', ${Number(r.days)}, 'leave_request', ${requestId}, ${`rev:${requestId}`}, ${actor.userId})
             on conflict (tenant_id, idempotency_key) do nothing`;
  } else throw new AppError("invalid", "Only pending or upcoming approved leave can be cancelled.");
  await tx`update leave_requests set status = 'cancelled' where id = ${requestId}`;
}

export type MyRequest = { id: string; type: string; color: string; from_date: string; to_date: string; from_half: string; to_half: string; days: string; status: "pending" | "approved" | "rejected" | "cancelled"; note: string | null; created_at: Date };

export async function myRequests(tx: Tx, employeeId: string) {
  return tx<MyRequest[]>`
    select q.id, t.name as type, t.color, q.from_date::text, q.to_date::text, q.from_half, q.to_half, q.days, q.status, q.note, q.created_at
    from leave_requests q join leave_types t on t.id = q.leave_type_id
    where q.employee_id = ${employeeId} order by q.from_date desc limit 100`;
}

export async function requestDetail(tx: Tx, requestId: string) {
  const [r] = await tx<(MyRequest & { employee: string; employee_id: string })[]>`
    select q.id, t.name as type, t.color, q.from_date::text, q.to_date::text, q.from_half, q.to_half, q.days, q.status, q.note, q.created_at,
           e.display_name as employee, e.id as employee_id
    from leave_requests q join leave_types t on t.id = q.leave_type_id join employees e on e.id = q.employee_id where q.id = ${requestId}`;
  return r ?? null;
}

export async function offToday(tx: Tx, date: ISODate = todayIn()) {
  return tx<{ id: string; name: string; type: string; half: boolean }[]>`
    select e.id, e.display_name as name, t.name as type, (q.days < 1) as half
    from leave_requests q join employees e on e.id = q.employee_id join leave_types t on t.id = q.leave_type_id
    where q.status = 'approved' and ${date}::date between q.from_date and q.to_date order by e.display_name`;
}

export function fmtRange(from: ISODate, to: ISODate) {
  const f = (s: string) => new Date(s + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
  return from === to ? f(from) : `${f(from)} – ${f(to)}`;
}
