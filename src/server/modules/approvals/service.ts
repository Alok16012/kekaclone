import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { onCompOffDecided, onLeaveDecided } from "@/server/modules/leave/effects";
import { onProfileChangeDecided } from "@/server/modules/employees/effects";
import { onAttendanceRequestDecided } from "@/server/modules/attendance/requests";
import { onExitDecided } from "@/server/modules/exits/effects";
import { onExpenseAdvanceDecided, onExpenseClaimDecided } from "@/server/modules/expenses/effects";
import { onAssetRequestDecided } from "@/server/modules/assets/effects";
import { onLoanDecided } from "@/server/modules/loans/effects";
import { notify } from "@/server/modules/notifications/service";

export type Level = { approver: "manager" | "l2_manager" | "role" | "employee"; role?: string; id?: string };
export type EntityType = "leave" | "attendance_request" | "profile_change" | "comp_off" | "exit" | "expense_claim" | "expense_advance" | "asset_request" | "loan";

/** Used when a tenant has no workflow configured for the entity type. */
const DEFAULT_LEVELS: Record<EntityType, Level[]> = {
  leave: [{ approver: "manager" }],
  attendance_request: [{ approver: "manager" }],
  profile_change: [{ approver: "role", role: "hr_admin" }],
  comp_off: [{ approver: "manager" }],
  exit: [{ approver: "manager" }, { approver: "role", role: "hr_admin" }],
  expense_claim: [{ approver: "manager" }, { approver: "role", role: "finance" }],
  expense_advance: [{ approver: "manager" }, { approver: "role", role: "finance" }],
  asset_request: [{ approver: "manager" }],
  loan: [{ approver: "manager" }, { approver: "role", role: "payroll_admin" }],
};

async function resolveApprover(tx: Tx, level: Level, requesterId: string): Promise<string | null> {
  if (level.approver === "manager" || level.approver === "l2_manager") {
    const col = level.approver === "manager" ? "manager_id" : "l2_manager_id";
    const [r] = await tx<{ id: string | null }[]>`select ${tx(col)} as id from employees where id = ${requesterId}`;
    if (r?.id) return r.id;
  }
  if (level.approver === "employee" && level.id) return level.id;
  // fallback: someone holding the named role (or any global admin) who isn't the requester
  const [r] = await tx<{ id: string }[]>`
    select ra.employee_id as id from role_assignments ra join roles ro on ro.id = ra.role_id
    join employees e on e.id = ra.employee_id and e.status <> 'relieved'
    where ro.key = ${level.role ?? "global_admin"} and ra.employee_id <> ${requesterId}
    order by ra.created_at limit 1`;
  return r?.id ?? null;
}

/**
 * Starts approval for an entity. Returns 'approved' when there is nobody to ask (e.g. the founder's own leave).
 * `levels` overrides the workflow (a leave type's own chain; [] = auto-approve).
 */
export async function startApproval(tx: Tx, a: { tenantId: string; entityType: EntityType; entityId: string; requesterId: string; summary: string; levels?: Level[] }) {
  const [wf] = await tx<{ id: string; levels: Level[] }[]>`
    select id, levels from approval_workflows where entity_type = ${a.entityType} and is_active order by priority desc limit 1`;
  const levels = a.levels ?? wf?.levels ?? DEFAULT_LEVELS[a.entityType];
  const approvers: string[] = [];
  for (const l of levels) {
    const id = await resolveApprover(tx, l, a.requesterId);
    if (id && id !== a.requesterId && !approvers.includes(id)) approvers.push(id);
  }
  const status = approvers.length ? "pending" : "approved";
  const [req] = await tx<{ id: string }[]>`
    insert into approval_requests (tenant_id, workflow_id, entity_type, entity_id, requester_employee_id, summary, status)
    values (${a.tenantId}, ${wf?.id ?? null}, ${a.entityType}, ${a.entityId}, ${a.requesterId}, ${a.summary}, ${status}) returning id`;
  for (const [i, approver] of approvers.entries()) {
    await tx`insert into approval_steps (tenant_id, request_id, level, approver_employee_id, status)
             values (${a.tenantId}, ${req.id}, ${i + 1}, ${approver}, ${i === 0 ? "pending" : "waiting"})`;
  }
  if (approvers[0]) await notifyEmployee(tx, a.tenantId, approvers[0], "approval.pending", "New request to review", a.summary, "/inbox");
  return { requestId: req.id, status };
}

/** Approve or reject the actor's pending step. Guarded update, so double clicks and races can't decide twice. */
export async function decide(tx: Tx, actor: Actor, stepId: string, decision: "approved" | "rejected", comment?: string) {
  const [step] = await tx<{ id: string; request_id: string; level: number }[]>`
    update approval_steps set status = ${decision}, comment = ${comment || null}, acted_at = now()
    where id = ${stepId} and approver_employee_id = ${actor.employeeId} and status = 'pending'
    returning id, request_id, level`;
  if (!step) throw new AppError("conflict", "This request was already handled or isn't waiting for you.");
  const [req] = await tx<{ entity_type: EntityType; entity_id: string; requester_employee_id: string; summary: string }[]>`
    select entity_type, entity_id, requester_employee_id, summary from approval_requests where id = ${step.request_id}`;

  let final: "approved" | "rejected" | null = decision === "rejected" ? "rejected" : null;
  if (decision === "approved") {
    const [next] = await tx<{ id: string; approver_employee_id: string }[]>`
      update approval_steps set status = 'pending' where id = (
        select id from approval_steps where request_id = ${step.request_id} and status = 'waiting' order by level limit 1)
      returning id, approver_employee_id`;
    if (next) {
      await tx`update approval_requests set current_level = ${step.level + 1} where id = ${step.request_id}`;
      await notifyEmployee(tx, actor.tenant.id, next.approver_employee_id, "approval.pending", "New request to review", req.summary, "/inbox");
    } else final = "approved";
  }
  if (final) {
    await tx`update approval_steps set status = 'skipped' where request_id = ${step.request_id} and status = 'waiting'`;
    await tx`update approval_requests set status = ${final} where id = ${step.request_id}`;
    if (req.entity_type === "leave") await onLeaveDecided(tx, actor, req.entity_id, final);
    if (req.entity_type === "profile_change") await onProfileChangeDecided(tx, actor, req.entity_id, final);
    if (req.entity_type === "comp_off") await onCompOffDecided(tx, actor, req.entity_id, final);
    if (req.entity_type === "attendance_request") await onAttendanceRequestDecided(tx, actor, req.entity_id, final);
    if (req.entity_type === "exit") await onExitDecided(tx, actor, req.entity_id, final);
    if (req.entity_type === "expense_claim") await onExpenseClaimDecided(tx, actor, req.entity_id, final);
    if (req.entity_type === "asset_request") await onAssetRequestDecided(tx, actor, req.entity_id, final);
    if (req.entity_type === "expense_advance") await onExpenseAdvanceDecided(tx, actor, req.entity_id, final);
    if (req.entity_type === "loan") await onLoanDecided(tx, actor, req.entity_id, final);
    await notifyEmployee(tx, actor.tenant.id, req.requester_employee_id, `request.${final}`,
      final === "approved" ? "Your request was approved" : "Your request was declined", req.summary,
      req.entity_type === "leave" || req.entity_type === "comp_off" ? "/me/leave" : req.entity_type === "profile_change" || req.entity_type === "exit" ? "/me"
        : req.entity_type === "expense_claim" ? "/me/expenses" : req.entity_type === "expense_advance" ? "/me/expenses/advances" : req.entity_type === "asset_request" ? "/me/assets" : req.entity_type === "loan" ? "/me/loans" : "/me/attendance");
  }
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff)
           values (${actor.tenant.id}, ${actor.userId}, ${req.entity_type}, ${req.entity_id}, ${"approval." + decision}, ${tx.json({ comment: comment ?? null })})`;
  return { final };
}

export async function cancelApproval(tx: Tx, entityType: EntityType, entityId: string) {
  const [r] = await tx<{ id: string }[]>`update approval_requests set status = 'cancelled' where entity_type = ${entityType} and entity_id = ${entityId} and status = 'pending' returning id`;
  if (r) await tx`update approval_steps set status = 'skipped' where request_id = ${r.id} and status in ('pending','waiting')`;
}

export type InboxItem = {
  step_id: string; request_id: string; entity_type: EntityType; entity_id: string; summary: string; created_at: Date;
  requester_id: string; requester_name: string; requester_title: string | null; level: number;
};

export async function inbox(tx: Tx, actor: Actor) {
  return tx<InboxItem[]>`
    select s.id as step_id, r.id as request_id, r.entity_type, r.entity_id, r.summary, r.created_at, s.level,
           e.id as requester_id, e.display_name as requester_name, d.title as requester_title
    from approval_steps s join approval_requests r on r.id = s.request_id
    join employees e on e.id = r.requester_employee_id left join designations d on d.id = e.designation_id
    where s.approver_employee_id = ${actor.employeeId} and s.status = 'pending'
    order by r.created_at`;
}

export async function timeline(tx: Tx, entityType: EntityType, entityId: string) {
  return tx<{ level: number; status: "approved" | "rejected" | "pending" | "waiting" | "skipped"; comment: string | null; acted_at: Date | null; approver: string; title: string | null }[]>`
    select s.level, s.status, s.comment, s.acted_at, e.display_name as approver, d.title
    from approval_requests r join approval_steps s on s.request_id = r.id
    join employees e on e.id = s.approver_employee_id left join designations d on d.id = e.designation_id
    where r.entity_type = ${entityType} and r.entity_id = ${entityId} order by s.level`;
}

/** In-app and/or email, per the tenant's notification settings (Settings → Notifications). */
export async function notifyEmployee(tx: Tx, tenantId: string, employeeId: string, kind: string, title: string, body: string, link: string) {
  await notify(tx, tenantId, [employeeId], kind, title, body, link);
}
