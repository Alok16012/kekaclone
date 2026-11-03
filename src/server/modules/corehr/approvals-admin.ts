import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { audit } from "@/server/modules/audit/service";
import { DEFAULT_LEVELS, decide, effectiveApprover, notifyEmployee, type EntityType, type Level } from "@/server/modules/approvals/service";
import { queueEmail, appUrl } from "@/server/email";
import { todayIn } from "@/lib/dates";
import { CONDITION_FIELDS, daysWaiting, validateLevels, type Condition } from "./rules";

export const EVERYWHERE: Placement = { department_id: null, location_id: null, legal_entity_id: null, business_unit_id: null };
/** Company-wide settings need an unscoped grant: a department-scoped admin can't change everyone's approval chains. */
export const canManageApprovals = (actor: Actor) => canFor(actor, "settings.approvals", EVERYWHERE);
function assertManage(actor: Actor) {
  if (!canManageApprovals(actor)) throw new AppError("forbidden", "You don't have access to approval settings.");
}

export const ENTITY_LABELS: Record<string, string> = {
  leave: "Leave", attendance_request: "Attendance requests", profile_change: "Profile changes", comp_off: "Comp-off",
  exit: "Resignations", expense_claim: "Expense claims", expense_advance: "Expense advances", asset_request: "Asset requests", loan: "Loans", requisition: "Requisitions", offer: "Offers", comp_proposal: "Increment proposals",
};
export const entityTypes = () => Object.keys(DEFAULT_LEVELS) as EntityType[];
const isEntity = (s: string): s is EntityType => (entityTypes() as string[]).includes(s);

export type WorkflowRow = {
  id: string; entity_type: EntityType; name: string; conditions: Condition[]; levels: Level[]; auto_approve_after_days: number | null;
  escalation: { afterDays: number; to: Level } | null; priority: number; is_active: boolean; pending: number;
};

export async function listWorkflows(tx: Tx, actor: Actor) {
  assertManage(actor);
  const rows = await tx<WorkflowRow[]>`
    select w.id, w.entity_type, w.name, w.conditions, w.levels, w.auto_approve_after_days, w.escalation, w.priority, w.is_active,
      (select count(*)::int from approval_requests r where r.workflow_id = w.id and r.status = 'pending') as pending
    from approval_workflows w order by w.entity_type, w.priority desc, w.created_at`;
  const [options] = await Promise.all([workflowOptions(tx)]);
  return { rows, options, defaults: DEFAULT_LEVELS, entities: entityTypes().map((e) => ({ value: e, label: ENTITY_LABELS[e] ?? e })) };
}

export async function workflowOptions(tx: Tx) {
  const [department, location, designation, legal_entity, business_unit, roles, people] = await Promise.all([
    tx<{ id: string; name: string }[]>`select id, name from departments order by name`,
    tx<{ id: string; name: string }[]>`select id, name from locations order by name`,
    tx<{ id: string; name: string }[]>`select id, title as name from designations order by title`,
    tx<{ id: string; name: string }[]>`select id, name from legal_entities order by name`,
    tx<{ id: string; name: string }[]>`select id, name from business_units order by name`,
    tx<{ key: string; name: string }[]>`select key, name from roles order by name`,
    tx<{ id: string; name: string; title: string | null; department: string | null }[]>`
      select e.id, e.display_name as name, d.title, dp.name as department from employees e left join designations d on d.id = e.designation_id
      left join departments dp on dp.id = e.department_id where e.status <> 'relieved' order by e.display_name`,
  ]);
  const worker_type = ["permanent", "contract", "intern", "consultant"].map((v) => ({ id: v, name: v[0].toUpperCase() + v.slice(1) }));
  return { values: { department, location, designation, legal_entity, business_unit, worker_type }, roles, people };
}

export type WorkflowInput = {
  entityType: string; name: string; conditions: Condition[]; levels: Level[]; autoApproveAfterDays: number | null;
  escalation: { afterDays: number; to: Level } | null; priority: number; isActive: boolean;
};

/** Levels and conditions reference roles, people and masters: every id is resolved inside the tenant before it's stored. */
async function checkLevels(tx: Tx, levels: Level[], field = "levels") {
  const err = validateLevels(levels);
  if (err) throw new AppError("invalid", err, field);
  for (const l of levels) {
    if (l.approver === "role") {
      const [r] = await tx`select 1 from roles where key = ${l.role!}`;
      if (!r) throw new AppError("invalid", "That role doesn't exist any more.", field);
    }
    if (l.approver === "employee") {
      const [r] = await tx`select 1 from employees where id = ${l.id!} and status <> 'relieved'`;
      if (!r) throw new AppError("invalid", "Pick someone who works here as the approver.", field);
    }
  }
  return levels.map((l) => (l.approver === "role" ? { approver: "role" as const, role: l.role } : l.approver === "employee" ? { approver: "employee" as const, id: l.id } : { approver: l.approver }));
}

const TABLE: Record<string, string> = { department: "departments", location: "locations", designation: "designations", legal_entity: "legal_entities", business_unit: "business_units" };

export async function saveWorkflow(tx: Tx, actor: Actor, id: string | null, input: WorkflowInput) {
  assertManage(actor);
  if (!isEntity(input.entityType)) throw new AppError("invalid", "Pick what this workflow approves.", "entityType");
  const name = input.name.trim();
  if (!name || name.length > 120) throw new AppError("invalid", "Give the workflow a name (up to 120 characters).", "name");
  const levels = await checkLevels(tx, input.levels);
  const conditions: Condition[] = [];
  for (const c of input.conditions ?? []) {
    if (!(CONDITION_FIELDS as readonly string[]).includes(c.field)) throw new AppError("invalid", "Unknown condition.", "conditions");
    const values = [...new Set(c.values)].slice(0, 200);
    if (!values.length) continue;
    if (c.field === "worker_type") {
      if (values.some((v) => !["permanent", "contract", "intern", "consultant"].includes(v))) throw new AppError("invalid", "Unknown worker type.", "conditions");
    } else {
      const found = await tx<{ id: string }[]>`select id from ${tx(TABLE[c.field])} where id = any(${values}::uuid[])`;
      if (found.length !== values.length) throw new AppError("invalid", "Some of the chosen values no longer exist.", "conditions");
    }
    conditions.push({ field: c.field, values });
  }
  const auto = input.autoApproveAfterDays;
  if (auto != null && (!Number.isInteger(auto) || auto < 1 || auto > 90)) throw new AppError("invalid", "Auto-approve after 1 to 90 days, or leave it off.", "autoApproveAfterDays");
  let escalation: WorkflowInput["escalation"] = null;
  if (input.escalation) {
    const d = input.escalation.afterDays;
    if (!Number.isInteger(d) || d < 1 || d > 30) throw new AppError("invalid", "Escalate after 1 to 30 days.", "escalation");
    if (auto != null && d >= auto) throw new AppError("invalid", "Escalation has to happen before auto-approval.", "escalation");
    escalation = { afterDays: d, to: (await checkLevels(tx, [input.escalation.to], "escalation"))[0] };
  }
  if (!levels.length && auto != null) throw new AppError("invalid", "With no approval levels requests are approved at once; auto-approval doesn't apply.", "autoApproveAfterDays");
  const priority = Math.max(0, Math.min(1000, Math.trunc(input.priority || 0)));
  const row = { name, conditions: tx.json(conditions as never), levels: tx.json(levels as never), auto_approve_after_days: auto, escalation: escalation ? tx.json(escalation as never) : null, priority, is_active: !!input.isActive };
  if (id) {
    const [before] = await tx<WorkflowRow[]>`select * from approval_workflows where id = ${id}`;
    if (!before) throw new AppError("not_found", "That workflow was deleted.");
    if (before.entity_type !== input.entityType) throw new AppError("invalid", "A workflow can't change what it approves. Create a new one instead.", "entityType");
    await tx`update approval_workflows set ${tx(row as never)} where id = ${id}`;
    await audit(tx, actor, { entityType: "approval_workflow", entityId: id, action: "update", diff: { before: { name: before.name, levels: before.levels, conditions: before.conditions, auto: before.auto_approve_after_days, escalation: before.escalation, active: before.is_active }, after: { name, levels, conditions, auto, escalation, active: !!input.isActive } } });
    return { id };
  }
  const [r] = await tx<{ id: string }[]>`insert into approval_workflows ${tx({ tenant_id: actor.tenant.id, entity_type: input.entityType, ...row } as never)} returning id`;
  await audit(tx, actor, { entityType: "approval_workflow", entityId: r.id, action: "create", diff: { entityType: input.entityType, name, levels, conditions, auto, escalation } });
  return { id: r.id };
}

/** Requests already started keep their steps; only new requests use the change. */
export async function deleteWorkflow(tx: Tx, actor: Actor, id: string) {
  assertManage(actor);
  const [w] = await tx<{ name: string; entity_type: string }[]>`delete from approval_workflows where id = ${id} returning name, entity_type`;
  if (!w) throw new AppError("not_found", "That workflow was already deleted.");
  await audit(tx, actor, { entityType: "approval_workflow", entityId: id, action: "delete", diff: w });
}

// ---------------------------------------------------------------- delegation

export type DelegationRow = { id: string; delegator_id: string; delegator: string; delegate_id: string; delegate: string; from_date: string; to_date: string | null; reason: string | null; active: boolean };

export async function listDelegations(tx: Tx, actor: Actor) {
  const all = canManageApprovals(actor);
  const today = todayIn();
  return tx<DelegationRow[]>`
    select g.id, g.delegator_employee_id as delegator_id, a.display_name as delegator, g.delegate_employee_id as delegate_id, b.display_name as delegate,
      g.from_date::text, g.to_date::text, g.reason, (g.from_date <= ${today} and (g.to_date is null or g.to_date >= ${today})) as active
    from approval_delegations g join employees a on a.id = g.delegator_employee_id join employees b on b.id = g.delegate_employee_id
    where g.cancelled_at is null and (g.to_date is null or g.to_date >= ${today})
      and (${all} or g.delegator_employee_id = ${actor.employeeId} or g.delegate_employee_id = ${actor.employeeId})
    order by g.from_date`;
}

export async function saveDelegation(tx: Tx, actor: Actor, input: { delegatorId: string; delegateId: string; from: string; to: string | null; reason?: string | null }) {
  const self = input.delegatorId === actor.employeeId;
  if (!self && !canManageApprovals(actor)) throw new AppError("forbidden", "You can only hand over your own approvals.");
  if (input.delegatorId === input.delegateId) throw new AppError("invalid", "Pick someone else to approve on your behalf.", "delegateId");
  const today = todayIn();
  if (input.from < today) throw new AppError("invalid", "Start today or later.", "from");
  if (input.to && input.to < input.from) throw new AppError("invalid", "The end date is before the start.", "to");
  const people = await tx<{ id: string; display_name: string }[]>`select id, display_name from employees where id = any(${[input.delegatorId, input.delegateId]}::uuid[]) and status <> 'relieved'`;
  if (people.length !== 2) throw new AppError("invalid", "Pick people who work here.", "delegateId");
  const [overlap] = await tx`select 1 from approval_delegations where delegator_employee_id = ${input.delegatorId} and cancelled_at is null
    and daterange(from_date, to_date, '[]') && daterange(${input.from}::date, ${input.to}::date, '[]')`;
  if (overlap) throw new AppError("conflict", "There's already a hand-over for some of these dates. Cancel it first.", "from");
  const [r] = await tx<{ id: string }[]>`insert into approval_delegations (tenant_id, delegator_employee_id, delegate_employee_id, from_date, to_date, reason, created_by)
    values (${actor.tenant.id}, ${input.delegatorId}, ${input.delegateId}, ${input.from}, ${input.to}, ${input.reason?.trim().slice(0, 300) || null}, ${actor.userId}) returning id`;
  await audit(tx, actor, { entityType: "approval_delegation", entityId: r.id, action: "create", diff: { employeeId: input.delegatorId, delegateId: input.delegateId, from: input.from, to: input.to } });
  const name = people.find((p) => p.id === input.delegatorId)!.display_name;
  await notifyEmployee(tx, actor.tenant.id, input.delegateId, "approval.delegated", "You're covering approvals", `${name}'s approvals come to you from ${input.from}${input.to ? ` to ${input.to}` : ""}.`, "/inbox");
  const moved = input.from <= today ? await reassignPending(tx, actor.tenant.id, { userId: actor.userId, onlyApproverId: input.delegatorId }) : { moved: 0 };
  return { id: r.id, moved: moved.moved };
}

export async function cancelDelegation(tx: Tx, actor: Actor, id: string) {
  const [g] = await tx<{ delegator_employee_id: string }[]>`select delegator_employee_id from approval_delegations where id = ${id} and cancelled_at is null`;
  if (!g) throw new AppError("not_found", "That hand-over was already cancelled.");
  if (g.delegator_employee_id !== actor.employeeId && !canManageApprovals(actor)) throw new AppError("forbidden", "You can only cancel your own hand-overs.");
  await tx`update approval_delegations set cancelled_at = now() where id = ${id}`;
  await audit(tx, actor, { entityType: "approval_delegation", entityId: id, action: "cancel", diff: { employeeId: g.delegator_employee_id } });
}

/**
 * Moves pending steps away from approvers who can't act: relieved, handed over (active delegation), or on approved
 * full-day leave today (to their own manager). Never to the requester or to someone already on the request.
 * Idempotent: a step that already sits with the right person is left alone.
 */
export async function reassignPending(tx: Tx, tenantId: string, opts: { userId?: string | null; date?: string; onlyApproverId?: string } = {}) {
  const date = opts.date ?? todayIn();
  const steps = await tx<{ id: string; request_id: string; approver: string; requester: string; summary: string }[]>`
    select s.id, s.request_id, s.approver_employee_id as approver, r.requester_employee_id as requester, r.summary
    from approval_steps s join approval_requests r on r.id = s.request_id
    where s.status = 'pending' and r.status = 'pending' and (${opts.onlyApproverId ?? null}::uuid is null or s.approver_employee_id = ${opts.onlyApproverId ?? null})
    order by r.created_at`;
  const onLeave = async (employeeId: string) => (await tx<{ ok: boolean }[]>`select exists(select 1 from leave_requests l where l.employee_id = ${employeeId} and l.status = 'approved'
    and l.from_date <= ${date} and l.to_date >= ${date} and not (l.from_date = l.to_date and l.days < 1)) as ok`)[0].ok;
  /** Follow hand-overs, leavers and people on leave to the first person who can act (a chain, so one pass is final). */
  const resolve = async (approver: string, requester: string): Promise<{ to: string | null; reason: string }> => {
    let to: string | null = approver, reason = "delegation";
    for (let hop = 0; hop < 6 && to; hop++) {
      const [st] = await tx<{ status: string }[]>`select status from employees where id = ${to}`;
      const next: string | null = await effectiveApprover(tx, to, requester, date);
      if (next !== to) { reason = st?.status === "relieved" ? "relieved" : "delegation"; to = next; continue; }
      if (await onLeave(to)) {
        const mgr: { id: string }[] = await tx<{ id: string }[]>`select m.id from employees e join employees m on m.id = e.manager_id and m.status <> 'relieved' where e.id = ${to} and m.id <> ${requester}`;
        if (mgr[0] && mgr[0].id !== approver) { reason = "on_leave"; to = mgr[0].id; continue; }
      }
      break;
    }
    return { to, reason };
  };
  let moved = 0;
  for (const s of steps) {
    let { to, reason } = await resolve(s.approver, s.requester);
    if (!to) {
      // nobody suitable in the chain: an admin who isn't the requester
      const [g] = await tx<{ id: string }[]>`select ra.employee_id as id from role_assignments ra join roles ro on ro.id = ra.role_id join employees e on e.id = ra.employee_id and e.status <> 'relieved'
        where ro.key in ('hr_admin','global_admin') and ra.employee_id <> ${s.requester} order by ro.key = 'hr_admin' desc, ra.created_at limit 1`;
      to = g?.id ?? null;
      reason = "relieved";
    }
    if (!to || to === s.approver) continue;
    const [dupe] = await tx`select 1 from approval_steps where request_id = ${s.request_id} and approver_employee_id = ${to} and status in ('pending','waiting')`;
    if (dupe) continue;
    await tx`update approval_steps set approver_employee_id = ${to}, delegated_from = coalesce(delegated_from, ${s.approver}) where id = ${s.id} and status = 'pending'`;
    await notifyEmployee(tx, tenantId, to, "approval.pending", "New request to review", s.summary, "/inbox");
    await audit(tx, { tenantId, userId: opts.userId ?? null }, { entityType: "approval_step", entityId: s.id, action: "approval.reassigned", diff: { from: s.approver, to, reason } });
    moved++;
  }
  return { moved };
}

// ---------------------------------------------------------------- timers: escalation + auto-approval

/** System actor for decisions the scheduler makes on an approver's step (the audit row marks it as automatic). */
async function approverActor(tx: Tx, tenantId: string, employeeId: string): Promise<Actor> {
  const [e] = await tx<{ user_id: string | null; display_name: string; subdomain: string; name: string; status: string }[]>`
    select e.user_id, e.display_name, t.subdomain::text, t.name, t.status from employees e join tenants t on t.id = e.tenant_id where e.id = ${employeeId}`;
  return { tenant: { id: tenantId, name: e.name, status: e.status, subdomain: e.subdomain }, userId: e.user_id as string /* may be null: audit rows then show no actor */, employeeId, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(), grants: [] };
}

/**
 * For pending steps under a workflow with timers: escalate once after `escalation.afterDays` (the step moves to the
 * escalation approver, who isn't the requester), and approve automatically after `auto_approve_after_days`.
 * The waiting clock starts when the step became pending (previous level's decision, or the request).
 */
export async function runApprovalTimers(tx: Tx, tenantId: string, now = new Date()) {
  const steps = await tx<{ id: string; request_id: string; approver: string; requester: string; summary: string; since: Date; auto: number | null; escalation: { afterDays: number; to: Level } | null; escalated_at: Date | null; level: number }[]>`
    select s.id, s.request_id, s.approver_employee_id as approver, r.requester_employee_id as requester, r.summary, s.level, s.escalated_at,
      coalesce((select max(p.acted_at) from approval_steps p where p.request_id = s.request_id and p.level < s.level), r.created_at) as since,
      w.auto_approve_after_days as auto, w.escalation
    from approval_steps s join approval_requests r on r.id = s.request_id join approval_workflows w on w.id = r.workflow_id
    where s.status = 'pending' and r.status = 'pending' and (w.auto_approve_after_days is not null or w.escalation is not null)
    order by r.created_at`;
  let escalated = 0, approved = 0;
  for (const s of steps) {
    const waited = daysWaiting(s.since, now);
    if (s.auto != null && waited >= s.auto) {
      const a = await approverActor(tx, tenantId, s.approver);
      await decide(tx, a, s.id, "approved", `Approved automatically: no decision in ${s.auto} ${s.auto === 1 ? "day" : "days"}.`);
      await tx`update approval_steps set auto_decided = true where id = ${s.id}`;
      await audit(tx, { tenantId, userId: null }, { entityType: "approval_step", entityId: s.id, action: "approval.auto_approved", diff: { days: s.auto, approver: s.approver } });
      approved++;
      continue;
    }
    if (s.escalation && !s.escalated_at && waited >= s.escalation.afterDays) {
      const to = await escalationTarget(tx, s.escalation.to, s.approver, s.requester);
      await tx`update approval_steps set escalated_at = now() where id = ${s.id}`;   // once, even when nobody suitable is found
      if (to && to !== s.approver) {
        const [dupe] = await tx`select 1 from approval_steps where request_id = ${s.request_id} and approver_employee_id = ${to} and status in ('pending','waiting')`;
        if (!dupe) {
          await tx`update approval_steps set approver_employee_id = ${to}, delegated_from = coalesce(delegated_from, ${s.approver}) where id = ${s.id}`;
          await notifyEmployee(tx, tenantId, to, "approval.escalated", "Escalated to you", `${s.summary} has waited ${waited} days.`, "/inbox");
        }
      }
      await notifyEmployee(tx, tenantId, s.approver, "approval.escalated", "A request was escalated", `${s.summary} waited ${waited} days${to && to !== s.approver ? " and moved on" : ""}.`, "/inbox");
      await audit(tx, { tenantId, userId: null }, { entityType: "approval_step", entityId: s.id, action: "approval.escalated", diff: { from: s.approver, to, days: waited } });
      escalated++;
    }
  }
  return { escalated, approved };
}

async function escalationTarget(tx: Tx, level: Level, approverId: string, requesterId: string): Promise<string | null> {
  if (level.approver === "manager" || level.approver === "l2_manager") {
    // relative to the approver who sat on it: their manager (or second-level manager)
    const col = level.approver === "manager" ? "manager_id" : "l2_manager_id";
    const [r] = await tx<{ id: string | null }[]>`select m.id from employees e join employees m on m.id = e.${tx(col)} and m.status <> 'relieved' where e.id = ${approverId}`;
    return r?.id && r.id !== requesterId ? r.id : null;
  }
  if (level.approver === "employee") {
    const [r] = await tx<{ id: string }[]>`select id from employees where id = ${level.id ?? null} and status <> 'relieved'`;
    return r && r.id !== requesterId ? r.id : null;
  }
  const [r] = await tx<{ id: string }[]>`select ra.employee_id as id from role_assignments ra join roles ro on ro.id = ra.role_id join employees e on e.id = ra.employee_id and e.status <> 'relieved'
    where ro.key = ${level.role ?? "hr_admin"} and ra.employee_id <> ${requesterId} and ra.employee_id <> ${approverId} order by ra.created_at limit 1`;
  return r?.id ?? null;
}

// ---------------------------------------------------------------- bulk decisions + digest

/** Decides several of the actor's own pending steps. Each one is independent: a failure doesn't undo the others. */
export async function bulkDecide(tx: Tx, actor: Actor, stepIds: string[], decision: "approved" | "rejected", comment?: string) {
  const ids = [...new Set(stepIds)].slice(0, 100);
  if (!ids.length) throw new AppError("invalid", "Pick at least one request.");
  if (decision === "rejected" && !comment?.trim()) throw new AppError("invalid", "Add a comment so people know why they were declined.", "comment");
  let done = 0;
  const failed: { stepId: string; error: string }[] = [];
  for (const id of ids) {
    try {
      await tx.savepoint((sp) => decide(sp as unknown as Tx, actor, id, decision, comment?.trim() || undefined));
      done++;
    } catch (e) {
      failed.push({ stepId: id, error: e instanceof AppError ? e.message : "Couldn't be decided." });
    }
  }
  await audit(tx, actor, { entityType: "approval_step", action: `approval.bulk_${decision}`, diff: { count: done, failed: failed.length } });
  return { done, failed };
}

/** One email per approver with something waiting (run once a day by the scheduler). */
export async function approverDigest(tx: Tx, tenantId: string) {
  const rows = await tx<{ employee_id: string; email: string; name: string; n: number; oldest: Date; subdomain: string; company: string; summaries: string[] }[]>`
    select s.approver_employee_id as employee_id, u.email::text, e.first_name as name, count(*)::int as n, min(r.created_at) as oldest, t.subdomain::text, t.name as company,
      (array_agg(r.summary order by r.created_at))[1:5] as summaries
    from approval_steps s join approval_requests r on r.id = s.request_id and r.status = 'pending'
    join employees e on e.id = s.approver_employee_id and e.status <> 'relieved' join users u on u.id = e.user_id and u.status = 'active'
    join tenants t on t.id = s.tenant_id
    where s.status = 'pending' group by s.approver_employee_id, u.email, e.first_name, t.subdomain, t.name`;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  for (const r of rows) {
    const url = appUrl(r.subdomain, "/inbox");
    const list = r.summaries.map((x) => `<li>${esc(x)}</li>`).join("");
    await queueEmail(tx, tenantId, {
      kind: "approval_digest", to: r.email, subject: `${r.n} ${r.n === 1 ? "request is" : "requests are"} waiting for you`,
      html: `<p>Hi ${esc(r.name)},</p><p>You have ${r.n} ${r.n === 1 ? "request" : "requests"} to review at ${esc(r.company)}:</p><ul>${list}</ul>${r.n > 5 ? `<p>…and ${r.n - 5} more.</p>` : ""}<p><a href="${url}">Open your inbox</a></p>`,
      text: `Hi ${r.name},\n\nYou have ${r.n} ${r.n === 1 ? "request" : "requests"} to review at ${r.company}:\n${r.summaries.map((x) => `- ${x}`).join("\n")}\n\nOpen your inbox: ${url}\n`,
    });
  }
  return { sent: rows.length };
}
