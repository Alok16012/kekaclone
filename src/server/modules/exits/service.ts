import "server-only";
import { emitEvent } from "@/server/modules/automations/service";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { todayIn, type ISODate } from "@/lib/dates";
import { cancelApproval, notifyEmployee, startApproval, timeline } from "@/server/modules/approvals/service";
import { fmtRange } from "@/server/modules/leave/service";
import { cycleStartFor } from "@/server/modules/leave/effects";
import { emitWebhook } from "@/server/modules/integrations/service";
import {
  DEFAULT_EXIT_REASONS, DEFAULT_EXIT_TASKS, DEFAULT_NOTICE_POLICIES, canCompleteNow, dueForRelieving, lastWorkingDay, nextStatus, noticeDays,
  stageOf, validateExitDates, waivedDays, OWNER_LABEL, type AutoKind, type ExitAction, type ExitKind, type ExitStatus, type TaskOwner,
} from "./rules";
import { onExitDecided, startExitProcess } from "./effects";
import { ensureExitSurveyDefaults } from "./survey";
import { autoTickExitTasks } from "./checklist";

const PERM = "exits.manage";
const EVERYWHERE: Placement = { department_id: null, location_id: null, legal_entity_id: null, business_unit_id: null };
/** Notice periods and exit reasons are company-wide settings: settings.org or exits.manage, without a scope. */
export const canEditExitSettings = (actor: Actor) => canFor(actor, "settings.org", EVERYWHERE) || canFor(actor, PERM, EVERYWHERE);
const assertExitSettings = (actor: Actor) => { if (!canEditExitSettings(actor)) throw new AppError("forbidden", "You don't have access to do this."); };

/** Notice policies, exit reasons and the exit checklist for a company. Safe to run any number of times. */
export async function ensureExitDefaults(tx: Tx, tenantId: string) {
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from notice_period_policies`;
  if (n === 0) for (const p of DEFAULT_NOTICE_POLICIES) {
    await tx`insert into notice_period_policies (tenant_id, name, days, probation_days, is_default) values (${tenantId}, ${p.name}, ${p.days}, ${p.probation_days}, ${!!p.is_default}) on conflict do nothing`;
  }
  const [{ r }] = await tx<{ r: number }[]>`select count(*)::int as r from exit_reasons`;
  if (r === 0) for (const x of DEFAULT_EXIT_REASONS) await tx`insert into exit_reasons (tenant_id, kind, name) values (${tenantId}, ${x.kind}, ${x.name}) on conflict do nothing`;
  const [tpl] = await tx<{ id: string }[]>`select id from task_templates where kind = 'exit' limit 1`;
  if (!tpl) {
    const [t] = await tx<{ id: string }[]>`insert into task_templates (tenant_id, kind, name) values (${tenantId}, 'exit', 'Standard exit checklist') returning id`;
    for (const [i, it] of DEFAULT_EXIT_TASKS.entries()) {
      await tx`insert into task_template_items (tenant_id, template_id, title, description, owner, due_offset_days, config, position)
               values (${tenantId}, ${t.id}, ${it.title}, ${it.description}, ${tx.json(it.owner)}, ${it.due_offset_days}, ${tx.json(it.auto ? { auto: it.auto } : {})}, ${i})`;
    }
  }
  await ensureExitSurveyDefaults(tx, tenantId);
}

// ---------- notice periods ----------
export type NoticePolicyRow = { id: string; name: string; days: number; probation_days: number | null; is_default: boolean; people: number };

export async function listNoticePolicies(tx: Tx) {
  return tx<NoticePolicyRow[]>`
    select p.id, p.name, p.days, p.probation_days, p.is_default,
      (select count(*)::int from employees e where e.notice_period_policy_id = p.id and e.status <> 'relieved') as people
    from notice_period_policies p order by p.days, p.name`;
}

export async function saveNoticePolicy(tx: Tx, actor: Actor, id: string | null, input: { name: string; days: number; probationDays: number | null; isDefault: boolean }) {
  assertExitSettings(actor);
  const name = input.name.trim();
  if (!name) throw new AppError("invalid", "Give the policy a name.", "name");
  if (!Number.isInteger(input.days) || input.days < 0 || input.days > 365) throw new AppError("invalid", "Notice must be between 0 and 365 days.", "days");
  if (input.probationDays != null && (!Number.isInteger(input.probationDays) || input.probationDays < 0 || input.probationDays > 365)) throw new AppError("invalid", "Probation notice must be between 0 and 365 days.", "probationDays");
  if (input.isDefault) await tx`update notice_period_policies set is_default = false where is_default and id is distinct from ${id}`;
  try {
    return await tx.savepoint(async (sp) => {
      if (id) {
        const [r] = await sp<{ id: string }[]>`update notice_period_policies set name = ${name}, days = ${input.days}, probation_days = ${input.probationDays}, is_default = ${input.isDefault} where id = ${id} returning id`;
        if (!r) throw new AppError("not_found", "Notice period not found.");
        return r;
      }
      const [r] = await sp<{ id: string }[]>`insert into notice_period_policies (tenant_id, name, days, probation_days, is_default) values (${actor.tenant.id}, ${name}, ${input.days}, ${input.probationDays}, ${input.isDefault}) returning id`;
      return r;
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new AppError("conflict", "A notice period with this name already exists.", "name");
    throw e;
  }
}

export async function deleteNoticePolicy(tx: Tx, actor: Actor, id: string) {
  assertExitSettings(actor);
  const [p] = await tx<{ is_default: boolean; people: number }[]>`select is_default, (select count(*)::int from employees where notice_period_policy_id = ${id}) as people from notice_period_policies where id = ${id}`;
  if (!p) throw new AppError("not_found", "Notice period not found.");
  if (p.is_default) throw new AppError("invalid", "This is the default notice period. Make another one the default first.");
  if (p.people) throw new AppError("invalid", "People are still on this notice period. Move them to another one first.");
  await tx`delete from notice_period_policies where id = ${id}`;
}

/** Put people on a notice period (HR). */
export async function assignNoticePolicy(tx: Tx, actor: Actor, policyId: string, employeeIds: string[]) {
  assertExitSettings(actor);
  const [p] = await tx<{ id: string }[]>`select id from notice_period_policies where id = ${policyId}`;
  if (!p) throw new AppError("not_found", "Notice period not found.");
  const r = await tx`update employees set notice_period_policy_id = ${policyId} where id = any(${employeeIds}::uuid[]) and status <> 'relieved'`;
  return { updated: r.count };
}

/** The policy that applies to someone: theirs, or the company default. */
export async function noticeFor(tx: Tx, employeeId: string, resignationDate: ISODate) {
  const [r] = await tx<{ name: string | null; days: number | null; probation_days: number | null; probation_status: string; probation_end_date: string | null }[]>`
    select p.name, p.days, p.probation_days, e.probation_status, e.probation_end_date::text
    from employees e left join notice_period_policies p on p.id = coalesce(e.notice_period_policy_id, (select id from notice_period_policies where is_default limit 1))
    where e.id = ${employeeId}`;
  if (!r) throw new AppError("not_found", "Employee not found.");
  const inProbation = (r.probation_status === "in_probation" || r.probation_status === "extended") && (!r.probation_end_date || r.probation_end_date >= resignationDate);
  const days = noticeDays(r.days == null ? null : { days: r.days, probation_days: r.probation_days }, inProbation);
  return { policy: r.name, days, inProbation, lastWorkingDate: lastWorkingDay(resignationDate, days) };
}

/** Notice preview for the exit forms: your own, or someone you manage exits for. */
export async function noticePreview(tx: Tx, actor: Actor, employeeId: string, resignationDate: ISODate) {
  if (employeeId !== actor.employeeId && !canManageExitOf(actor, await placement(tx, employeeId))) throw new AppError("forbidden", "You can't manage exits for this person.");
  return noticeFor(tx, employeeId, resignationDate);
}

// ---------- access ----------
async function placement(tx: Tx, employeeId: string) {
  const [p] = await tx<(Placement & { manager_id: string | null; status: string; display_name: string })[]>`
    select department_id, location_id, legal_entity_id, business_unit_id, manager_id, status, display_name from employees where id = ${employeeId}`;
  if (!p) throw new AppError("not_found", "Employee not found.");
  return p;
}
export const canManageExitOf = (actor: Actor, p: Placement) => canFor(actor, PERM, p);

/** HR actions on an exit: in scope, and never on your own exit (your resignation goes through your manager and HR). */
async function assertManagesExit(tx: Tx, actor: Actor, employeeId: string) {
  if (employeeId === actor.employeeId) throw new AppError("forbidden", "Someone else in HR has to handle your own exit.");
  if (!canManageExitOf(actor, await placement(tx, employeeId))) throw new AppError("forbidden", "You can't manage exits for this person.");
}

type ExitRow = { id: string; employee_id: string; status: ExitStatus; kind: ExitKind; resignation_date: string; last_working_date: string; process_id: string | null };
async function loadExit(tx: Tx, exitId: string, lock = false) {
  const [x] = lock
    ? await tx<ExitRow[]>`select id, employee_id, status, kind, resignation_date::text, last_working_date::text, process_id from exit_requests where id = ${exitId} for update`
    : await tx<ExitRow[]>`select id, employee_id, status, kind, resignation_date::text, last_working_date::text, process_id from exit_requests where id = ${exitId}`;
  if (!x) throw new AppError("not_found", "Exit not found.");
  return x;
}
function move(x: ExitRow, action: ExitAction) {
  const to = nextStatus(x.status, action);
  if (!to) throw new AppError("conflict", x.status === "exited" ? "This person has already exited." : x.status === "withdrawn" || x.status === "rejected" ? "This exit is closed." : "That can't be done at this stage.");
  return to;
}

async function reasonOk(tx: Tx, reasonId: string | null | undefined) {
  if (!reasonId) return null;
  const [r] = await tx<{ id: string }[]>`select id from exit_reasons where id = ${reasonId}`;
  if (!r) throw new AppError("invalid", "Pick a reason from the list.", "reasonId");
  return r.id;
}

async function insertExit(tx: Tx, actor: Actor, a: { employeeId: string; kind: ExitKind; reasonId: string | null; resignationDate: string; requestedLwd: string | null; lastWorkingDate: string; computedLwd: string; okToRehire: boolean | null; comments: string | null }) {
  try {
    const [x] = await tx.savepoint((sp) => sp<{ id: string }[]>`
      insert into exit_requests (tenant_id, employee_id, kind, reason_id, comments, resignation_date, requested_lwd, last_working_date, notice_waived_days, ok_to_rehire, initiated_by)
      values (${actor.tenant.id}, ${a.employeeId}, ${a.kind}, ${a.reasonId}, ${a.comments}, ${a.resignationDate}, ${a.requestedLwd}, ${a.lastWorkingDate},
              ${waivedDays(a.computedLwd, a.lastWorkingDate)}, ${a.okToRehire}, ${actor.userId}) returning id`);
    return x.id;
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new AppError("conflict", "There's already an exit in progress for this person.");
    throw e;
  }
}

export type InitiateInput = { employeeId: string; kind: ExitKind; reasonId?: string | null; resignationDate: string; lastWorkingDate?: string | null; okToRehire?: boolean | null; comments?: string | null };

/** HR starts an exit (resignation received by HR, or company action). It goes straight to In progress. */
export async function initiateExit(tx: Tx, actor: Actor, input: InitiateInput) {
  const p = await placement(tx, input.employeeId);
  if (!canManageExitOf(actor, p)) throw new AppError("forbidden", "You can't manage exits for this person.");
  if (input.employeeId === actor.employeeId) throw new AppError("invalid", "To leave yourself, resign from your profile.");
  if (p.status === "relieved") throw new AppError("invalid", "This person has already left.");
  const n = await noticeFor(tx, input.employeeId, input.resignationDate);
  const lwd = input.lastWorkingDate || n.lastWorkingDate;
  const problems = validateExitDates({ resignationDate: input.resignationDate, lastWorkingDate: lwd, today: todayIn(), by: "hr" });
  if (problems.length) throw new AppError("invalid", problems[0].message, problems[0].field);
  await tx`select pg_advisory_xact_lock(hashtext(${"exit:" + input.employeeId}))`;
  const id = await insertExit(tx, actor, { employeeId: input.employeeId, kind: input.kind, reasonId: await reasonOk(tx, input.reasonId), resignationDate: input.resignationDate, requestedLwd: null, lastWorkingDate: lwd, computedLwd: n.lastWorkingDate, okToRehire: input.okToRehire ?? null, comments: input.comments?.trim() || null });
  await startExitProcess(tx, id, actor.userId);
  await notifyEmployee(tx, actor.tenant.id, input.employeeId, "exit.started", input.kind === "resignation" ? "Your resignation was recorded" : "Your exit has been started", `Last working day: ${fmtRange(lwd, lwd)}`, "/me");
  await audit(tx, actor, id, "exit.initiate", { kind: input.kind, last_working_date: lwd });
  return { id, lastWorkingDate: lwd };
}

/** The employee resigns. Goes to their manager, then HR, through the approvals engine. */
export async function resign(tx: Tx, actor: Actor, input: { reasonId?: string | null; lastWorkingDate?: string | null; comments?: string | null }) {
  const today = todayIn();
  const p = await placement(tx, actor.employeeId);
  if (p.status === "relieved") throw new AppError("invalid", "You've already left.");
  const n = await noticeFor(tx, actor.employeeId, today);
  const lwd = input.lastWorkingDate || n.lastWorkingDate;
  const problems = validateExitDates({ resignationDate: today, lastWorkingDate: lwd, today, by: "self" });
  if (problems.length) throw new AppError("invalid", problems[0].message, problems[0].field);
  if (!input.comments?.trim() && !input.reasonId) throw new AppError("invalid", "Tell us why you're leaving: pick a reason or add a note.", "reasonId");
  await tx`select pg_advisory_xact_lock(hashtext(${"exit:" + actor.employeeId}))`;
  const id = await insertExit(tx, actor, { employeeId: actor.employeeId, kind: "resignation", reasonId: await reasonOk(tx, input.reasonId), resignationDate: today, requestedLwd: lwd, lastWorkingDate: lwd, computedLwd: n.lastWorkingDate, okToRehire: null, comments: input.comments?.trim() || null });
  const summary = `${p.display_name} · Resignation · last day ${fmtRange(lwd, lwd)}`;
  const { status } = await startApproval(tx, { tenantId: actor.tenant.id, entityType: "exit", entityId: id, requesterId: actor.employeeId, summary });
  if (status === "approved") await onExitDecided(tx, actor, id, "approved");
  await audit(tx, actor, id, "exit.resign", { last_working_date: lwd });
  return { id, status: status === "approved" ? "in_progress" as const : "under_review" as const, lastWorkingDate: lwd };
}

/** The employee takes back a resignation that hasn't been accepted yet. */
export async function withdraw(tx: Tx, actor: Actor, exitId: string) {
  const x = await loadExit(tx, exitId, true);
  if (x.employee_id !== actor.employeeId) throw new AppError("not_found", "Exit not found.");
  if (x.status !== "under_review") throw new AppError("conflict", x.status === "in_progress" ? "Your resignation was already accepted. Talk to HR to take it back." : "This resignation is closed.");
  await tx`update exit_requests set status = ${move(x, "withdraw")} where id = ${exitId}`;
  await cancelApproval(tx, "exit", exitId);
  await audit(tx, actor, exitId, "exit.withdraw", {});
}

/**
 * HR accepts or declines a resignation directly from the exits board, closing whatever approval steps are left.
 * (Approvers can also decide from their Inbox; both paths end in onExitDecided.)
 */
export async function hrDecide(tx: Tx, actor: Actor, exitId: string, decision: "approved" | "rejected", comment?: string) {
  const x = await loadExit(tx, exitId, true);
  await assertManagesExit(tx, actor, x.employee_id);
  move(x, decision === "approved" ? "approve" : "reject");
  const [req] = await tx<{ id: string; requester_employee_id: string; summary: string }[]>`
    update approval_requests set status = ${decision} where entity_type = 'exit' and entity_id = ${exitId} and status = 'pending' returning id, requester_employee_id, summary`;
  if (req) await tx`update approval_steps set status = 'skipped', comment = coalesce(comment, ${comment || null}) where request_id = ${req.id} and status in ('pending','waiting')`;
  await onExitDecided(tx, actor, exitId, decision);
  await notifyEmployee(tx, actor.tenant.id, x.employee_id, `request.${decision}`, decision === "approved" ? "Your resignation was accepted" : "Your resignation was declined", req?.summary ?? "Resignation", "/me");
  await audit(tx, actor, exitId, `exit.${decision}`, { comment: comment ?? null, by: "hr" });
}

/** HR edits an open exit: last working day, reason, rehire flag, comments. */
export async function updateExit(tx: Tx, actor: Actor, exitId: string, input: { lastWorkingDate?: string; reasonId?: string | null; okToRehire?: boolean | null; comments?: string | null }) {
  const x = await loadExit(tx, exitId, true);
  await assertManagesExit(tx, actor, x.employee_id);
  if (x.status !== "under_review" && x.status !== "in_progress") throw new AppError("conflict", "Closed exits can't be changed.");
  const lwd = input.lastWorkingDate ?? x.last_working_date;
  const problems = validateExitDates({ resignationDate: x.resignation_date, lastWorkingDate: lwd, today: todayIn(), by: "hr" }).filter((p) => p.field === "lastWorkingDate");
  if (problems.length) throw new AppError("invalid", problems[0].message, problems[0].field);
  const n = await noticeFor(tx, x.employee_id, x.resignation_date);
  await tx`update exit_requests set last_working_date = ${lwd}, notice_waived_days = ${waivedDays(n.lastWorkingDate, lwd)},
           reason_id = ${input.reasonId === undefined ? tx`reason_id` : await reasonOk(tx, input.reasonId)},
           ok_to_rehire = ${input.okToRehire === undefined ? tx`ok_to_rehire` : input.okToRehire},
           comments = ${input.comments === undefined ? tx`comments` : input.comments?.trim() || null}
           where id = ${exitId}`;
  if (x.status === "in_progress" && lwd !== x.last_working_date) {
    await tx`update employees set exit_date = ${lwd} where id = ${x.employee_id}`;
    await notifyEmployee(tx, actor.tenant.id, x.employee_id, "exit.updated", "Your last working day changed", fmtRange(lwd, lwd), "/me");
  }
  await audit(tx, actor, exitId, "exit.update", { last_working_date: lwd });
}

/** HR cancels an exit (the person stays). Checklist closed, person back to active. */
export async function cancelExit(tx: Tx, actor: Actor, exitId: string) {
  const x = await loadExit(tx, exitId, true);
  await assertManagesExit(tx, actor, x.employee_id);
  await tx`update exit_requests set status = ${move(x, "cancel")} where id = ${exitId}`;
  await cancelApproval(tx, "exit", exitId);
  if (x.process_id) {
    await tx`update lifecycle_processes set status = 'cancelled' where id = ${x.process_id} and status = 'in_progress'`;
    await tx`update tasks set status = 'skipped' where process_id = ${x.process_id} and status = 'open'`;
  }
  await tx`update employees set status = 'active', exit_date = null where id = ${x.employee_id} and status = 'notice'`;
  await notifyEmployee(tx, actor.tenant.id, x.employee_id, "exit.cancelled", "Your exit was cancelled", "You're staying with us. Nothing changes.", "/me");
  await audit(tx, actor, exitId, "exit.cancel", {});
}

/**
 * Relieve someone: exit marked Exited, employee Relieved, sign-in disabled, every session ended.
 * Guarded on status, so a re-run (job twice, or HR + job) is a no-op.
 */
export async function relieve(tx: Tx, exitId: string, actorUserId: string | null) {
  const [x] = await tx<{ tenant_id: string; employee_id: string; process_id: string | null; last_working_date: string }[]>`
    update exit_requests set status = 'exited' where id = ${exitId} and status = 'in_progress' returning tenant_id, employee_id, process_id, last_working_date::text`;
  if (!x) return false;
  const [e] = await tx<{ user_id: string | null }[]>`update employees set status = 'relieved', exit_date = ${x.last_working_date} where id = ${x.employee_id} returning user_id`;
  if (e?.user_id) {
    await tx`update users set status = 'disabled' where id = ${e.user_id}`;
    await tx`delete from sessions where user_id = ${e.user_id}`;
  }
  await autoTickExitTasks(tx, { employeeId: x.employee_id });   // "revoke access" (and anything else provable) ticks itself
  if (x.process_id) await tx`update lifecycle_processes set status = 'completed' where id = ${x.process_id} and status = 'in_progress'`;
  await withdrawOpenRequests(tx, x.employee_id, x.last_working_date);
  await emitWebhook(tx, x.tenant_id, "employee.exited", { employee_id: x.employee_id, exit_id: exitId, last_working_date: x.last_working_date });
  await emitEvent(tx, x.tenant_id, "employee.exited", { employeeId: x.employee_id, occurrence: exitId, vars: { "exit.last_working_date": x.last_working_date } });
  await tx`insert into timeline_events (tenant_id, employee_id, kind, effective_date, data, actor_user_id)
           values (${x.tenant_id}, ${x.employee_id}, 'exited', ${x.last_working_date}, ${tx.json({ exit_id: exitId })}, ${actorUserId})`;
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff)
           values (${x.tenant_id}, ${actorUserId}, 'exit', ${exitId}, 'exit.relieved', ${tx.json({ last_working_date: x.last_working_date })})`;
  return true;
}

/**
 * Once someone has left, nothing of theirs should sit in an approver's inbox: pending leave, comp-off and attendance
 * requests are withdrawn (their approvals cancelled), and approved leave starting after the last working day is
 * cancelled with its days returned. Accruals and attendance stop on their own at employees.exit_date.
 */
async function withdrawOpenRequests(tx: Tx, employeeId: string, lastWorkingDate: ISODate) {
  const pending = await tx<{ entity_type: "leave" | "comp_off" | "attendance_request" | "requisition"; id: string }[]>`
    select 'leave' as entity_type, id from leave_requests where employee_id = ${employeeId} and status = 'pending'
    union all select 'comp_off', id from comp_off_requests where employee_id = ${employeeId} and status = 'pending'
    union all select 'attendance_request', id from attendance_requests where employee_id = ${employeeId} and status = 'pending'
    union all select 'requisition', id from requisitions where raised_by_employee_id = ${employeeId} and status = 'pending'`;
  for (const p of pending) await cancelApproval(tx, p.entity_type, p.id);
  await tx`update requisitions set status = 'rejected', updated_at = now() where raised_by_employee_id = ${employeeId} and status = 'pending'`;
  await tx`update leave_requests set status = 'cancelled' where employee_id = ${employeeId} and status = 'pending'`;
  await tx`update comp_off_requests set status = 'cancelled', updated_at = now() where employee_id = ${employeeId} and status = 'pending'`;
  await tx`update attendance_requests set status = 'cancelled' where employee_id = ${employeeId} and status = 'pending'`;
  const later = await tx<{ id: string; tenant_id: string; leave_type_id: string; from_date: string; days: string }[]>`
    update leave_requests set status = 'cancelled' where employee_id = ${employeeId} and status = 'approved' and from_date > ${lastWorkingDate}
    returning id, tenant_id, leave_type_id, from_date::text, days`;
  for (const r of later) {
    const cycle = await cycleStartFor(tx, employeeId, r.from_date);
    await tx`insert into leave_ledger (tenant_id, employee_id, leave_type_id, cycle_start, entry_date, kind, amount, ref_type, ref_id, idempotency_key)
             values (${r.tenant_id}, ${employeeId}, ${r.leave_type_id}, ${cycle}, ${lastWorkingDate}, 'use_reversal', ${Number(r.days)}, 'leave_request', ${r.id}, ${`rev:${r.id}`})
             on conflict (tenant_id, idempotency_key) do nothing`;
  }
}

/** HR completes an exit by hand, from the last working day onwards. */
export async function completeExit(tx: Tx, actor: Actor, exitId: string) {
  const x = await loadExit(tx, exitId, true);
  await assertManagesExit(tx, actor, x.employee_id);
  move(x, "complete");
  if (!canCompleteNow(x.last_working_date, todayIn())) throw new AppError("invalid", "You can complete the exit from the last working day. Change the last working day if they're leaving earlier.");
  await relieve(tx, exitId, actor.userId);
}

/** Nightly: relieve everyone whose last working day has passed. Returns how many were relieved. */
export async function processDueExits(tx: Tx, today: ISODate = todayIn()) {
  const due = await tx<{ id: string; last_working_date: string }[]>`
    select id, last_working_date::text from exit_requests where status = 'in_progress' and last_working_date < ${today} order by last_working_date for update skip locked`;
  let n = 0;
  for (const d of due) if (dueForRelieving(d.last_working_date, today) && (await relieve(tx, d.id, null))) n++;
  return n;
}

// ---------- checklist ----------
export async function setTaskStatus(tx: Tx, actor: Actor, taskId: string, status: "open" | "done" | "skipped") {
  const [t] = await tx<{ id: string; assignee_employee_id: string | null; subject_employee_id: string; process_status: string | null }[]>`
    select t.id, t.assignee_employee_id, t.subject_employee_id, p.status as process_status
    from tasks t left join lifecycle_processes p on p.id = t.process_id where t.id = ${taskId} and p.kind = 'exit'`;
  if (!t) throw new AppError("not_found", "Task not found.");
  const hr = t.subject_employee_id !== actor.employeeId && canManageExitOf(actor, await placement(tx, t.subject_employee_id));
  if (!hr && t.assignee_employee_id !== actor.employeeId) throw new AppError("forbidden", "Only the task owner or HR can update this task.");
  if (status === "skipped" && !hr) throw new AppError("forbidden", "Only HR can skip a task.");
  if (t.process_status !== "in_progress") throw new AppError("conflict", "This checklist is closed.");
  await tx`update tasks set status = ${status}, completed_at = ${status === "open" ? null : tx`now()`} where id = ${taskId}`;
}

// ---------- reading ----------
export type BoardRow = {
  id: string; status: ExitStatus; kind: ExitKind; employee_id: string; name: string; number: string; designation: string | null; department: string | null;
  reason: string | null; resignation_date: string; last_working_date: string; created_at: Date; tasks_total: number; tasks_done: number;
};

/** The HR board: exits of people the actor may manage, by stage. */
export async function board(tx: Tx, actor: Actor) {
  const rows = await tx<(BoardRow & Placement)[]>`
    select x.id, x.status, x.kind, e.id as employee_id, e.display_name as name, e.employee_number as number, d.title as designation, dp.name as department,
      r.name as reason, x.resignation_date::text, x.last_working_date::text, x.created_at,
      e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id,
      (select count(*)::int from tasks t where t.process_id = x.process_id and t.status <> 'skipped') as tasks_total,
      (select count(*)::int from tasks t where t.process_id = x.process_id and t.status = 'done') as tasks_done
    from exit_requests x join employees e on e.id = x.employee_id
    left join designations d on d.id = e.designation_id left join departments dp on dp.id = e.department_id
    left join exit_reasons r on r.id = x.reason_id
    where x.status in ('under_review','in_progress','exited')
    order by case x.status when 'exited' then x.last_working_date end desc nulls last, x.last_working_date, x.created_at`;
  const mine = rows.filter((r) => canManageExitOf(actor, r));
  const out: Record<"review" | "progress" | "exited", BoardRow[]> = { review: [], progress: [], exited: [] };
  for (const r of mine) {
    const s = stageOf(r.status);
    if (s) out[s].push(r);
  }
  return out;
}

export type ExitDetail = {
  exit: { id: string; status: ExitStatus; kind: ExitKind; reason: string | null; reason_id: string | null; comments: string | null; resignation_date: string; requested_lwd: string | null; last_working_date: string; notice_waived_days: number; ok_to_rehire: boolean | null; created_at: string; initiated_by: string | null };
  employee: { id: string; name: string; number: string; designation: string | null; department: string | null; manager: string | null; joining_date: string };
  notice: { policy: string | null; days: number; lastWorkingDate: string };
  tasks: { id: string; title: string; description: string | null; owner: string; assignee: string | null; assignee_id: string | null; due_date: string | null; status: "open" | "done" | "skipped"; mine: boolean; auto: boolean; autoDone: boolean }[];
  survey: { sent: boolean; submitted_at: string | null } | null;
  approvals: { level: number; status: "approved" | "rejected" | "pending" | "waiting" | "skipped"; comment: string | null; acted_at: string | null; approver: string; title: string | null }[];
  letters: { id: string; title: string; created_at: string; file_id: string }[];
  can: { manage: boolean; withdraw: boolean; complete: boolean; decide: boolean; pendingForMe: boolean };
};

/** One exit, for HR, the person themselves, their manager, or an approver on it. */
export async function exitDetail(tx: Tx, actor: Actor, exitId: string): Promise<ExitDetail | null> {
  const [x] = await tx<(ExitDetail["exit"] & { employee_id: string; process_id: string | null; created_at_ts: Date })[]>`
    select x.id, x.status, x.kind, r.name as reason, x.reason_id, x.comments, x.resignation_date::text, x.requested_lwd::text, x.last_working_date::text,
      x.notice_waived_days, x.ok_to_rehire, x.created_at as created_at_ts, ie.display_name as initiated_by, x.employee_id, x.process_id
    from exit_requests x left join exit_reasons r on r.id = x.reason_id
    left join employees ie on ie.user_id = x.initiated_by
    where x.id = ${exitId}`;
  if (!x) return null;
  const p = await placement(tx, x.employee_id);
  const self = x.employee_id === actor.employeeId;
  const manage = !self && canManageExitOf(actor, p);   // HR can't act on their own exit
  const [{ approver }] = await tx<{ approver: boolean }[]>`
    select exists(select 1 from approval_requests r join approval_steps s on s.request_id = r.id where r.entity_type = 'exit' and r.entity_id = ${exitId} and s.approver_employee_id = ${actor.employeeId}) as approver`;
  if (!manage && !self && !approver && p.manager_id !== actor.employeeId) return null;
  const [emp] = await tx<ExitDetail["employee"][]>`
    select e.id, e.display_name as name, e.employee_number as number, d.title as designation, dp.name as department, m.display_name as manager, e.joining_date::text
    from employees e left join designations d on d.id = e.designation_id left join departments dp on dp.id = e.department_id left join employees m on m.id = e.manager_id
    where e.id = ${x.employee_id}`;
  const tasks = x.process_id ? await tx<{ id: string; title: string; config: { description?: string; owner?: TaskOwner; auto_done?: boolean }; auto: string | null; assignee: string | null; assignee_id: string | null; due_date: string | null; status: "open" | "done" | "skipped" }[]>`
    select t.id, t.title, t.config, i.config->>'auto' as auto, a.display_name as assignee, t.assignee_employee_id as assignee_id, t.due_date::text, t.status
    from tasks t left join employees a on a.id = t.assignee_employee_id left join task_template_items i on i.id = t.template_item_id
    where t.process_id = ${x.process_id} order by i.position nulls last, t.created_at` : [];
  const steps = await timeline(tx, "exit", exitId);
  const letters = manage || self ? await tx<{ id: string; title: string; created_at: Date; file_id: string }[]>`
    select d.id, d.doc_type as title, d.created_at, d.file_id from employee_documents d where d.employee_id = ${x.employee_id} and d.category = 'letter' order by d.created_at desc limit 20` : [];
  const notice = await noticeFor(tx, x.employee_id, x.resignation_date);
  const [{ pendingMine }] = await tx<{ pendingMine: boolean }[]>`
    select exists(select 1 from approval_requests r join approval_steps s on s.request_id = r.id where r.entity_type = 'exit' and r.entity_id = ${exitId} and s.approver_employee_id = ${actor.employeeId} and s.status = 'pending') as "pendingMine"`;
  return {
    exit: { id: x.id, status: x.status, kind: x.kind, reason: x.reason, reason_id: x.reason_id, comments: x.comments, resignation_date: x.resignation_date, requested_lwd: x.requested_lwd,
      last_working_date: x.last_working_date, notice_waived_days: x.notice_waived_days, ok_to_rehire: x.ok_to_rehire, initiated_by: x.initiated_by, created_at: x.created_at_ts.toISOString() },
    employee: emp,
    notice: { policy: notice.policy, days: notice.days, lastWorkingDate: notice.lastWorkingDate },
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, description: t.config?.description ?? null, owner: t.config?.owner ? OWNER_LABEL(t.config.owner) : "—", assignee: t.assignee, assignee_id: t.assignee_id, due_date: t.due_date, status: t.status, mine: t.assignee_id === actor.employeeId, auto: !!t.auto, autoDone: !!t.config?.auto_done })),
    survey: manage || self ? await (async () => { const [r] = await tx<{ submitted_at: Date | null }[]>`select submitted_at from exit_survey_responses where exit_request_id = ${exitId}`; return r ? { sent: true, submitted_at: r.submitted_at?.toISOString() ?? null } : { sent: false, submitted_at: null }; })() : null,
    approvals: steps.map((s) => ({ ...s, acted_at: s.acted_at ? s.acted_at.toISOString() : null })),
    letters: letters.map((l) => ({ ...l, created_at: l.created_at.toISOString() })),
    can: {
      manage,
      withdraw: self && x.status === "under_review",
      complete: manage && x.status === "in_progress" && canCompleteNow(x.last_working_date, todayIn()),
      decide: manage && x.status === "under_review",     // approvers who aren't HR decide from their Inbox
      pendingForMe: pendingMine,
    },
  };
}

/** The person's own exit, newest first: the open one if any, otherwise the last closed one from the past 30 days. */
export async function myExit(tx: Tx, employeeId: string) {
  const [x] = await tx<{ id: string; status: ExitStatus; resignation_date: string; last_working_date: string; reason: string | null; comments: string | null }[]>`
    select x.id, x.status, x.resignation_date::text, x.last_working_date::text, r.name as reason, x.comments
    from exit_requests x left join exit_reasons r on r.id = x.reason_id
    where x.employee_id = ${employeeId} and (x.status in ('under_review','in_progress') or x.updated_at > now() - interval '30 days')
    order by (x.status in ('under_review','in_progress')) desc, x.created_at desc limit 1`;
  return x ?? null;
}

export async function addReason(tx: Tx, actor: Actor, input: { kind: string; name: string }) {
  assertExitSettings(actor);
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new AppError("invalid", "Write the reason.", "name");
  if (!["resignation", "termination", "other"].includes(input.kind)) throw new AppError("invalid", "Pick a type.", "kind");
  const [r] = await tx<{ id: string }[]>`insert into exit_reasons (tenant_id, kind, name) values (${actor.tenant.id}, ${input.kind}, ${name}) on conflict (tenant_id, kind, name) do nothing returning id`;
  if (!r) throw new AppError("conflict", "This reason is already in the list.", "name");
  return r;
}

/** Past exits keep their history; the reason is just cleared on them. */
export async function deleteReason(tx: Tx, actor: Actor, id: string) {
  assertExitSettings(actor);
  const r = await tx`delete from exit_reasons where id = ${id}`;
  if (!r.count) throw new AppError("not_found", "Reason not found.");
}

export async function exitChecklist(tx: Tx) {
  return tx<{ id: string; title: string; description: string | null; owner: TaskOwner; due_offset_days: number; auto: AutoKind | null }[]>`
    select i.id, i.title, i.description, i.owner, i.due_offset_days, i.config->>'auto' as auto from task_template_items i
    where i.template_id = (select id from task_templates where kind = 'exit' order by created_at limit 1) order by i.position, i.created_at`;
}

export async function listReasons(tx: Tx) {
  return tx<{ id: string; kind: "resignation" | "termination" | "other"; name: string }[]>`select id, kind, name from exit_reasons order by kind, name`;
}

/** Tasks assigned to someone on other people's exits (for "My tasks" on the board). */
export async function myExitTasks(tx: Tx, employeeId: string) {
  return tx<{ id: string; title: string; due_date: string | null; subject: string; exit_id: string }[]>`
    select t.id, t.title, t.due_date::text, e.display_name as subject, x.id as exit_id
    from tasks t join lifecycle_processes p on p.id = t.process_id and p.kind = 'exit' and p.status = 'in_progress'
    join employees e on e.id = t.subject_employee_id join exit_requests x on x.process_id = p.id
    where t.assignee_employee_id = ${employeeId} and t.status = 'open' and t.subject_employee_id <> ${employeeId} order by t.due_date nulls last`;
}

async function audit(tx: Tx, actor: Actor, exitId: string, action: string, diff: Record<string, unknown>) {
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${actor.tenant.id}, ${actor.userId}, 'exit', ${exitId}, ${action}, ${tx.json(diff as never)})`;
}

export { onExitDecided };
