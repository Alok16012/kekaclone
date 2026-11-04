import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { todayIn, type ISODate } from "@/lib/dates";
import { countLeaveDays, validateRequest, type ApplicationRules, type Calendar, type DayPart, type WeeklyOffPattern } from "./rules";
import { cycleStartFor, onLeaveDecided } from "./effects";
import { pickGrant } from "./accrual-rules";
import { activeGrants } from "./grants";
import { canAdminLeaveFor } from "./access";
import { cancelApproval, decide, inbox, notifyEmployee, startApproval, type Level } from "@/server/modules/approvals/service";

export type LeaveTypeBalance = {
  id: string; name: string; code: string; color: string; kind: string; quota: number | null;
  credited: number; used: number; pending: number; available: number; rules: ApplicationRules;
  /** no yearly quota and not comp-off or event-based (those have no quota but are limited to what was earned or granted) */
  unlimited: boolean;
};

/**
 * The holiday list that applies to a person: their own, else their location's default, else the company's first list.
 * Lists are per year; lists that share a name (e.g. "Head office" 2026 and 2027) are one calendar across years.
 */
export async function holidayListNameFor(tx: Tx, employeeId: string): Promise<string | null> {
  const [r] = await tx<{ name: string | null }[]>`
    select (select name from holiday_lists where id = coalesce(
      (select holiday_list_id from employees where id = ${employeeId}),
      (select l.default_holiday_list_id from employees e join locations l on l.id = e.location_id where e.id = ${employeeId}),
      (select id from holiday_lists order by created_at limit 1))) as name`;
  return r?.name ?? null;
}

export async function calendarFor(tx: Tx, employeeId: string): Promise<Calendar> {
  const list = await holidayListNameFor(tx, employeeId);
  const holidays = await tx<{ date: string }[]>`
    select h.date::text from holidays h join holiday_lists hl on hl.id = h.holiday_list_id
    where hl.name = ${list} and (not h.is_floater or exists (select 1 from floater_choices f where f.holiday_id = h.id and f.employee_id = ${employeeId}))`;
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
    const unlimited = r.quota == null && r.kind !== "comp_off" && r.kind !== "incident";
    return { id: r.id, name: r.name, code: r.code, color: r.color, kind: r.kind, quota: r.quota == null ? null : Number(r.quota), rules: r.application,
      credited, used, pending, unlimited, available: unlimited ? Infinity : Math.round((credited - used - pending) * 100) / 100 };
  });
}

export type LeaveInput = { leaveTypeId: string; from: ISODate; to: ISODate; fromPart: DayPart; toPart: DayPart; note?: string; notify?: string[]; attachments?: string[] };

export async function preview(tx: Tx, employeeId: string, input: LeaveInput) {
  const types = await balances(tx, employeeId, input.from);
  const type = types.find((t) => t.id === input.leaveTypeId);
  if (!type) throw new AppError("invalid", "This leave type isn't part of your leave plan.", "leaveTypeId");
  const cal = await calendarFor(tx, employeeId);
  const { days, breakdown } = countLeaveDays(input.from, input.to, input.fromPart, input.toPart, cal, type.rules);
  let violations = validateRequest({ ...input, days, today: todayIn(), available: type.available, rules: type.rules, hasAttachment: !!input.attachments?.length });
  // event-based leave without an upfront quota draws on a grant from HR: the grant's window and remainder decide, not the yearly balance
  let grantId: string | null = null;
  if (type.kind === "incident" && type.quota == null) {
    const pick = pickGrant(await activeGrants(tx, employeeId, type.id), { from: input.from, to: input.to, days });
    violations = violations.filter((v) => v.code !== "balance" && v.code !== "negative");
    if (pick.problem) violations.push({ code: "grant", message: pick.problem, blocking: true });
    grantId = pick.grant?.id ?? null;
  }
  return { days, breakdown, violations, grantId, type: { ...type, available: Number.isFinite(type.available) ? type.available : null } };
}

/**
 * Applies for the person (`onBehalfOf` = HR or a manager applying for someone; see applyOnBehalf for the checks).
 * The approval chain runs as usual; when the applier is the approver of a step, that step is approved by them as they apply.
 */
export async function apply(tx: Tx, actor: Actor, input: LeaveInput, onBehalfOf?: string) {
  const employeeId = onBehalfOf ?? actor.employeeId;
  await tx`select pg_advisory_xact_lock(hashtext(${employeeId + ":" + input.leaveTypeId}))`;   // serialise balance checks per employee+type
  const p = await preview(tx, employeeId, input);
  const blocking = p.violations.filter((v) => v.blocking);
  if (blocking.length) throw new AppError("invalid", blocking[0].message);

  let id: string;
  try {
    [{ id }] = await tx<{ id: string }[]>`
      insert into leave_requests (tenant_id, employee_id, leave_type_id, from_date, to_date, from_half, to_half, days, note, notify_employee_ids, attachment_file_ids, applied_by, grant_id)
      values (${actor.tenant.id}, ${employeeId}, ${input.leaveTypeId}, ${input.from}, ${input.to},
              ${input.fromPart === "second" ? "second" : "full"}, ${input.toPart === "first" || (input.from === input.to && input.fromPart === "first") ? "first" : "full"},
              ${p.days}, ${input.note || null}, ${input.notify ?? []}, ${input.attachments ?? []}, ${actor.userId}, ${p.grantId})
      returning id`;
  } catch (e) {
    if ((e as { code?: string }).code === "23P01") throw new AppError("conflict", onBehalfOf ? "They already have leave on some of these dates." : "You already have leave on some of these dates.");
    throw e;
  }
  const [who] = await tx<{ display_name: string }[]>`select display_name from employees where id = ${employeeId}`;
  const summary = `${who.display_name} · ${p.type.name} · ${fmtRange(input.from, input.to)} · ${p.days} ${p.days === 1 ? "day" : "days"}`;
  const [chain] = await tx<{ approval: { auto?: boolean; levels?: Level[] } }[]>`
    select r.approval from employees e join leave_plan_rules r on r.leave_plan_id = e.leave_plan_id and r.leave_type_id = ${input.leaveTypeId} where e.id = ${employeeId}`;
  const levels = chain?.approval?.auto ? [] : chain?.approval?.levels?.length ? chain.approval.levels : undefined;   // undefined = company workflow
  let { status } = await startApproval(tx, { tenantId: actor.tenant.id, entityType: "leave", entityId: id, requesterId: employeeId, summary, levels });
  // people the requester chose to keep in the loop (FYI, not approvers)
  for (const other of new Set(input.notify ?? [])) {
    if (other === employeeId) continue;
    await notifyEmployee(tx, actor.tenant.id, other, "leave.fyi", `${who.display_name} will be on leave`, `${p.type.name} · ${fmtRange(input.from, input.to)} · ${p.days} ${p.days === 1 ? "day" : "days"}`, "/home");
  }
  if (status === "approved") await onLeaveDecided(tx, actor, id, "approved");
  else if (onBehalfOf) {
    // the applier approves their own step(s) as they apply; anyone further up the chain still reviews it
    for (let guard = 0; guard < 5 && status === "pending"; guard++) {
      const mine = (await inbox(tx, actor)).find((i) => i.entity_type === "leave" && i.entity_id === id);
      if (!mine) break;
      const r = await decide(tx, actor, mine.step_id, "approved", "Applied on their behalf");
      if (r.final === "approved") status = "approved";
    }
  }
  return { id, status, days: p.days };
}

export type OnBehalfCandidate = { id: string; name: string; title: string | null; department: string | null; why: "report" | "admin" };

/** People the actor may apply leave for: their direct reports, plus everyone their leave.admin scope covers. Never themselves. */
export async function onBehalfCandidates(tx: Tx, actor: Actor): Promise<OnBehalfCandidate[]> {
  const rows = await tx<(OnBehalfCandidate & { manager_id: string | null; department_id: string | null; location_id: string | null; legal_entity_id: string | null; business_unit_id: string | null })[]>`
    select e.id, e.display_name as name, d.title, dp.name as department, e.manager_id, e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id, 'report' as why
    from employees e left join designations d on d.id = e.designation_id left join departments dp on dp.id = e.department_id
    where e.status <> 'relieved' and e.id <> ${actor.employeeId} and e.leave_plan_id is not null order by e.display_name`;
  return rows.flatMap((r) => {
    const report = r.manager_id === actor.employeeId;
    const admin = canAdminLeaveFor(actor, r);
    if (!report && !admin) return [];
    return [{ id: r.id, name: r.name, title: r.title, department: r.department, why: report ? "report" : "admin" }];
  });
}

/** Must the actor apply for this person at all? Direct manager or a leave admin for them; never for themselves. */
export async function assertCanApplyFor(tx: Tx, actor: Actor, employeeId: string) {
  if (employeeId === actor.employeeId) throw new AppError("invalid", "Use the normal form to apply for your own leave.");
  const [e] = await tx<{ id: string; name: string; manager_id: string | null; department_id: string | null; location_id: string | null; legal_entity_id: string | null; business_unit_id: string | null }[]>`
    select id, display_name as name, manager_id, department_id, location_id, legal_entity_id, business_unit_id from employees where id = ${employeeId} and status <> 'relieved'`;
  if (!e) throw new AppError("not_found", "Person not found.");
  if (e.manager_id !== actor.employeeId && !canAdminLeaveFor(actor, e)) throw new AppError("forbidden", `You can't apply for leave on behalf of ${e.name}.`);
  return e;
}

/** HR or a manager applies for someone, with a note. Audited; the person is told; the chain runs (see apply). */
export async function applyOnBehalf(tx: Tx, actor: Actor, employeeId: string, input: LeaveInput) {
  const e = await assertCanApplyFor(tx, actor, employeeId);
  const note = input.note?.trim();
  if (!note) throw new AppError("invalid", "Add a note saying why you're applying for them.", "note");
  const r = await apply(tx, actor, { ...input, note }, employeeId);
  const [t] = await tx<{ name: string }[]>`select name from leave_types where id = ${input.leaveTypeId}`;
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff)
           values (${actor.tenant.id}, ${actor.userId}, 'leave_request', ${r.id}, 'leave.apply_on_behalf', ${tx.json({ employeeId, type: t?.name, from: input.from, to: input.to, days: r.days, note })})`;
  await notifyEmployee(tx, actor.tenant.id, employeeId, "leave.on_behalf", `${actor.name} applied for leave on your behalf`,
    `${t?.name ?? "Leave"} · ${fmtRange(input.from, input.to)} · ${r.days} ${r.days === 1 ? "day" : "days"} · ${r.status === "approved" ? "approved" : "waiting for approval"} · “${note}”`, "/me/leave");
  return { ...r, employee: e.name };
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

export type MyRequest = {
  id: string; type: string; color: string; from_date: string; to_date: string; from_half: string; to_half: string; days: string;
  status: "pending" | "approved" | "rejected" | "cancelled"; note: string | null; created_at: Date;
  /** who applied, when it wasn't the person themself */
  applied_by_name: string | null; grant_event: string | null;
};

const REQUEST_COLS = (tx: Tx) => tx`
  q.id, t.name as type, t.color, q.from_date::text, q.to_date::text, q.from_half, q.to_half, q.days, q.status, q.note, q.created_at,
  (select a.display_name from employees a where a.user_id = q.applied_by and a.id <> q.employee_id limit 1) as applied_by_name,
  (select g.event from leave_grants g where g.id = q.grant_id) as grant_event`;

export async function myRequests(tx: Tx, employeeId: string) {
  return tx<MyRequest[]>`
    select ${REQUEST_COLS(tx)} from leave_requests q join leave_types t on t.id = q.leave_type_id
    where q.employee_id = ${employeeId} order by q.from_date desc limit 100`;
}

export async function requestDetail(tx: Tx, requestId: string) {
  const [r] = await tx<(MyRequest & { employee: string; employee_id: string })[]>`
    select ${REQUEST_COLS(tx)}, e.display_name as employee, e.id as employee_id
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
