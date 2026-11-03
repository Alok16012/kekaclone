import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { newToken, sha256 } from "@/server/auth/password";
import { notifyEmployee } from "@/server/modules/approvals/service";
import { audit } from "@/server/modules/audit/service";
import { updateSection } from "@/server/modules/employees/profile";
import { uploadPersonDocument } from "@/server/modules/documents/service";
import { appUrl, queueEmail } from "@/server/email";
import { resolveOwner } from "@/server/modules/exits/rules";
import { addDaysISO, todayIn, type ISODate } from "@/lib/dates";
import {
  DEFAULT_ONBOARDING_TASKS, PROFILE_FIELDS, allClosed, cleanCriteria, completionAllowed, dueDate, isOverdue, itemConfig, ownerLabel, pickTemplate, progress, validateItem,
  type CompleteInput, type Criteria, type ItemInput, type JoinerPlacement, type TaskConfig, type TaskOwner, type TaskStatus, type TaskType,
} from "./rules";

export const ONBOARDING_PERMISSION = "onboarding.manage";
const EVERYWHERE: Placement = { department_id: null, location_id: null, legal_entity_id: null, business_unit_id: null };
const PORTAL_DAYS = 14;

/** Templates are company-wide: editing them needs onboarding.manage with no department / location scope. */
export const canEditOnboardingTemplates = (actor: Actor) => canFor(actor, ONBOARDING_PERMISSION, EVERYWHERE);
/** Running one person's onboarding: onboarding.manage covering that person, never on your own onboarding. */
export const canRunOnboardingOf = (actor: Actor, p: Placement & { id: string }) => p.id !== actor.employeeId && canFor(actor, ONBOARDING_PERMISSION, p);
/** Anyone with the permission somewhere: sees the joiners page (rows are still filtered per person). */
export const hasOnboardingAccess = (actor: Actor) => (actor.grants ?? []).some((g) => g.permissions.includes("*") || g.permissions.includes(ONBOARDING_PERMISSION));

const assertTemplates = (actor: Actor) => { if (!canEditOnboardingTemplates(actor)) throw new AppError("forbidden", "You don't have access to do this."); };

type Joiner = Placement & JoinerPlacement & { id: string; tenant_id: string; display_name: string; first_name: string; joining_date: string; status: string; manager_id: string | null; personal_email: string | null; work_email: string; user_id: string | null };
async function joiner(tx: Tx, employeeId: string): Promise<Joiner | null> {
  const [e] = await tx<Joiner[]>`
    select id, tenant_id, display_name, first_name, joining_date::text, status, manager_id, department_id, location_id, legal_entity_id, business_unit_id, designation_id,
      personal_email, work_email, user_id
    from employees where id = ${employeeId}`;
  return e ?? null;
}

async function roleHolders(tx: Tx, employeeId: string) {
  const rows = await tx<{ key: string; id: string }[]>`
    select distinct on (ro.key) ro.key, ra.employee_id as id from role_assignments ra join roles ro on ro.id = ra.role_id
    join employees e on e.id = ra.employee_id and e.status <> 'relieved'
    where ra.employee_id <> ${employeeId} order by ro.key, ra.created_at`;
  const m = new Map(rows.map((r) => [r.key, r.id]));
  return (role: string) => m.get(role) ?? null;
}

// ---------------------------------------------------------------- defaults + templates

/** A standard onboarding checklist for a company that has none. Safe to run any number of times. */
export async function ensureOnboardingDefaults(tx: Tx, tenantId: string) {
  const [tpl] = await tx<{ id: string }[]>`select id from task_templates where kind = 'onboarding' limit 1`;
  if (tpl) return tpl.id;
  const [t] = await tx<{ id: string }[]>`insert into task_templates (tenant_id, kind, name) values (${tenantId}, 'onboarding', 'Standard onboarding') returning id`;
  for (const [i, it] of DEFAULT_ONBOARDING_TASKS.entries()) {
    await tx`insert into task_template_items (tenant_id, template_id, title, description, type, owner, due_offset_days, config, position)
             values (${tenantId}, ${t.id}, ${it.title}, ${it.description}, ${it.type}, ${tx.json(it.owner)}, ${it.dueOffsetDays}, ${tx.json(itemConfig(it) as never)}, ${i})`;
  }
  return t.id;
}

export type TemplateItemRow = { id: string; title: string; description: string | null; type: TaskType; owner: TaskOwner; due_offset_days: number; config: TaskConfig; position: number; owner_name: string | null };
export type TemplateRow = { id: string; name: string; criteria: Criteria; created_at: Date; items: TemplateItemRow[]; in_use: number };

export async function listTemplates(tx: Tx): Promise<TemplateRow[]> {
  const tpls = await tx<Omit<TemplateRow, "items">[]>`
    select t.id, t.name, t.criteria, t.created_at,
      (select count(*)::int from lifecycle_processes p where p.template_id = t.id and p.status = 'in_progress') as in_use
    from task_templates t where t.kind = 'onboarding' order by t.created_at`;
  const items = await tx<(TemplateItemRow & { template_id: string })[]>`
    select i.id, i.template_id, i.title, i.description, i.type, i.owner, i.due_offset_days, i.config, i.position,
      (select e.display_name from employees e where i.owner->>'type' = 'employee' and e.id::text = i.owner->>'id') as owner_name
    from task_template_items i join task_templates t on t.id = i.template_id and t.kind = 'onboarding' order by i.position, i.created_at`;
  return tpls.map((t) => ({ ...t, criteria: cleanCriteria(t.criteria), items: items.filter((i) => i.template_id === t.id) }));
}

/** Every id in the criteria must be a row of this company (FK-free jsonb, so checked here). */
async function checkCriteria(tx: Tx, c: Criteria) {
  const clean = cleanCriteria(c);
  const tables = { department_ids: "departments", location_ids: "locations", designation_ids: "designations", legal_entity_ids: "legal_entities" } as const;
  for (const [k, table] of Object.entries(tables) as [keyof Criteria, string][]) {
    const ids = clean[k] ?? [];
    if (!ids.length) continue;
    if (ids.some((x) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x))) throw new AppError("invalid", "Pick from the lists.", "criteria");
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from ${tx(table)} where id = any(${ids}::uuid[])`;
    if (n !== ids.length) throw new AppError("invalid", "Some of the picked departments, locations, designations or entities no longer exist.", "criteria");
  }
  return clean;
}

export async function saveTemplate(tx: Tx, actor: Actor, id: string | null, input: { name: string; criteria: Criteria }) {
  assertTemplates(actor);
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new AppError("invalid", "Give the template a name.", "name");
  const criteria = await checkCriteria(tx, input.criteria);
  if (id) {
    const [r] = await tx<{ id: string }[]>`update task_templates set name = ${name}, criteria = ${tx.json(criteria as never)} where id = ${id} and kind = 'onboarding' returning id`;
    if (!r) throw new AppError("not_found", "Template not found.");
    await audit(tx, actor, { entityType: "task_template", entityId: id, action: "update", diff: { name, criteria } });
    return r;
  }
  const [r] = await tx<{ id: string }[]>`insert into task_templates (tenant_id, kind, name, criteria) values (${actor.tenant.id}, 'onboarding', ${name}, ${tx.json(criteria as never)}) returning id`;
  await audit(tx, actor, { entityType: "task_template", entityId: r.id, action: "create", diff: { name, criteria } });
  return r;
}

/** Running processes keep their tasks (the link to the template is just cleared). */
export async function deleteTemplate(tx: Tx, actor: Actor, id: string) {
  assertTemplates(actor);
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from task_templates where kind = 'onboarding'`;
  const r = await tx`delete from task_templates where id = ${id} and kind = 'onboarding' and ${n > 1}`;
  if (!r.count) throw new AppError(n > 1 ? "not_found" : "invalid", n > 1 ? "Template not found." : "Keep at least one onboarding template.");
  await audit(tx, actor, { entityType: "task_template", entityId: id, action: "delete" });
}

export async function saveItem(tx: Tx, actor: Actor, templateId: string, itemId: string | null, input: ItemInput) {
  assertTemplates(actor);
  const bad = validateItem(input);
  if (bad) throw new AppError("invalid", bad.error, bad.field);
  const [tpl] = await tx<{ id: string }[]>`select id from task_templates where id = ${templateId} and kind = 'onboarding'`;
  if (!tpl) throw new AppError("not_found", "Template not found.");
  let owner: TaskOwner = input.owner;
  if (owner.type === "employee") {
    const [e] = await tx<{ id: string }[]>`select id from employees where id = ${owner.id} and status <> 'relieved'`;
    if (!e) throw new AppError("invalid", "Pick someone who works here.", "owner");
    owner = { type: "employee", id: e.id };
  } else if (owner.type === "role") {
    const [r] = await tx<{ key: string }[]>`select key from roles where key = ${owner.role}`;
    if (!r) throw new AppError("invalid", "Pick a role.", "owner");
    owner = { type: "role", role: r.key };
  } else owner = { type: owner.type };
  const cfg = itemConfig(input);
  const title = input.title.trim(), desc = input.description?.trim().slice(0, 2000) || null;
  if (itemId) {
    const [r] = await tx<{ id: string }[]>`
      update task_template_items set title = ${title}, description = ${desc}, type = ${input.type}, owner = ${tx.json(owner)}, due_offset_days = ${input.dueOffsetDays}, config = ${tx.json(cfg as never)}
      where id = ${itemId} and template_id = ${templateId} returning id`;
    if (!r) throw new AppError("not_found", "Task not found.");
    await audit(tx, actor, { entityType: "task_template", entityId: templateId, action: "item.update", diff: { itemId, title, type: input.type } });
    return r;
  }
  const [r] = await tx<{ id: string }[]>`
    insert into task_template_items (tenant_id, template_id, title, description, type, owner, due_offset_days, config, position)
    values (${actor.tenant.id}, ${templateId}, ${title}, ${desc}, ${input.type}, ${tx.json(owner)}, ${input.dueOffsetDays}, ${tx.json(cfg as never)},
      (select coalesce(max(position) + 1, 0) from task_template_items where template_id = ${templateId})) returning id`;
  await audit(tx, actor, { entityType: "task_template", entityId: templateId, action: "item.create", diff: { itemId: r.id, title, type: input.type } });
  return r;
}

export async function deleteItem(tx: Tx, actor: Actor, itemId: string) {
  assertTemplates(actor);
  const [r] = await tx<{ template_id: string }[]>`
    delete from task_template_items i using task_templates t where i.id = ${itemId} and t.id = i.template_id and t.kind = 'onboarding' returning i.template_id`;
  if (!r) throw new AppError("not_found", "Task not found.");
  await audit(tx, actor, { entityType: "task_template", entityId: r.template_id, action: "item.delete", diff: { itemId } });
}

export async function moveItem(tx: Tx, actor: Actor, itemId: string, dir: "up" | "down") {
  assertTemplates(actor);
  const [it] = await tx<{ template_id: string }[]>`select i.template_id from task_template_items i join task_templates t on t.id = i.template_id and t.kind = 'onboarding' where i.id = ${itemId}`;
  if (!it) throw new AppError("not_found", "Task not found.");
  const rows = await tx<{ id: string }[]>`select id from task_template_items where template_id = ${it.template_id} order by position, created_at`;
  const i = rows.findIndex((r) => r.id === itemId), j = dir === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= rows.length) return;
  [rows[i], rows[j]] = [rows[j], rows[i]];
  for (const [pos, r] of rows.entries()) await tx`update task_template_items set position = ${pos} where id = ${r.id}`;
}

// ---------------------------------------------------------------- starting a process

/**
 * Start onboarding for a person (called by HR from the joiners page, and by the hire package when an offer is
 * accepted). Picks the most specific matching template unless one is given, creates the tasks with owners and due
 * dates counted from the joining date, and tells each owner. Idempotent: an onboarding already in progress is returned.
 */
export async function startOnboarding(tx: Tx, employeeId: string, opts: { actorUserId?: string | null; templateId?: string | null } = {}) {
  const e = await joiner(tx, employeeId);
  if (!e) throw new AppError("not_found", "Person not found.");
  if (e.status === "relieved") throw new AppError("invalid", "This person has left the company.");
  const [open] = await tx<{ id: string }[]>`select id from lifecycle_processes where employee_id = ${employeeId} and kind = 'onboarding' and status = 'in_progress'`;
  if (open) return { processId: open.id, created: false, tasks: 0 };
  await ensureOnboardingDefaults(tx, e.tenant_id);
  const templates = await tx<{ id: string; name: string; criteria: Criteria; created_at: Date }[]>`select id, name, criteria, created_at from task_templates where kind = 'onboarding'`;
  const tpl = opts.templateId ? templates.find((t) => t.id === opts.templateId) : pickTemplate(templates, e);
  if (opts.templateId && !tpl) throw new AppError("invalid", "Pick a template.", "templateId");
  const proc = await tx.savepoint(async (sp) => {
    const [p] = await sp<{ id: string }[]>`
      insert into lifecycle_processes (tenant_id, kind, employee_id, template_id) values (${e.tenant_id}, 'onboarding', ${employeeId}, ${tpl?.id ?? null})
      on conflict (employee_id, kind) where status = 'in_progress' do nothing returning id`;
    return p;
  });
  if (!proc) {   // someone else started it a moment ago
    const [p] = await tx<{ id: string }[]>`select id from lifecycle_processes where employee_id = ${employeeId} and kind = 'onboarding' and status = 'in_progress'`;
    return { processId: p.id, created: false, tasks: 0 };
  }
  const items = tpl ? await tx<{ id: string; title: string; description: string | null; type: TaskType; owner: TaskOwner; due_offset_days: number; config: TaskConfig }[]>`
    select id, title, description, type, owner, due_offset_days, config from task_template_items where template_id = ${tpl.id} order by position, created_at` : [];
  const holder = await roleHolders(tx, employeeId);
  const notified = new Set<string>();
  for (const it of items) {
    const assignee = resolveOwner(it.owner, { employeeId, managerId: e.manager_id, roleHolder: holder });
    await tx`insert into tasks (tenant_id, process_id, subject_employee_id, assignee_employee_id, template_item_id, title, type, config, due_date)
             values (${e.tenant_id}, ${proc.id}, ${employeeId}, ${assignee}, ${it.id}, ${it.title}, ${it.type},
                     ${tx.json({ ...it.config, description: it.description, owner: it.owner } as never)}, ${dueDate(e.joining_date, it.due_offset_days)})`;
    if (assignee && assignee !== employeeId && !notified.has(assignee)) {
      notified.add(assignee);
      await notifyEmployee(tx, e.tenant_id, assignee, "onboarding.task", "New onboarding tasks", `Help ${e.display_name} get started`, "/me/tasks");
    }
  }
  if (items.some((i) => i.owner.type === "self")) await notifyEmployee(tx, e.tenant_id, employeeId, "onboarding.welcome", "Welcome aboard", "A few things to do before and after your first day", "/home");
  await tx`insert into timeline_events (tenant_id, employee_id, kind, effective_date, data, actor_user_id)
           values (${e.tenant_id}, ${employeeId}, 'onboarding_started', ${todayIn()}, ${tx.json({ process_id: proc.id, template: tpl?.name ?? null })}, ${opts.actorUserId ?? null})`;
  await audit(tx, { tenantId: e.tenant_id, userId: opts.actorUserId ?? null }, { entityType: "onboarding", entityId: proc.id, action: "start", diff: { employeeId, templateId: tpl?.id ?? null, tasks: items.length } });
  return { processId: proc.id, created: true, tasks: items.length };
}

/** HR starts onboarding from the joiners page. */
export async function initiateOnboarding(tx: Tx, actor: Actor, employeeId: string, templateId: string | null) {
  const e = await joiner(tx, employeeId);
  if (!e) throw new AppError("not_found", "Person not found.");
  if (!canRunOnboardingOf(actor, e)) throw new AppError("forbidden", e.id === actor.employeeId ? "Someone else in HR has to run your onboarding." : "You don't have access to do this.");
  const r = await startOnboarding(tx, employeeId, { actorUserId: actor.userId, templateId });
  if (!r.created) throw new AppError("conflict", `${e.first_name}'s onboarding has already started.`);
  return r;
}

// ---------------------------------------------------------------- reading

export type JoinerRow = {
  id: string; name: string; number: string; designation: string | null; department: string | null; location: string | null; status: string; joining_date: string;
  process_id: string | null; process_status: "in_progress" | "completed" | "cancelled" | null; template: string | null; total: number; done: number; overdue: number; suggested: string | null;
};

/** People who are joining or joined in the last 90 days (and anyone with onboarding still open), that the actor can run. */
export async function newJoiners(tx: Tx, actor: Actor, today: ISODate = todayIn()) {
  const rows = await tx<(Omit<JoinerRow, "total" | "done" | "overdue" | "suggested"> & Placement & JoinerPlacement & { tasks: { status: TaskStatus; due_date: string | null }[] | null })[]>`
    select e.id, e.display_name as name, e.employee_number as number, d.title as designation, dp.name as department, l.name as location, e.status, e.joining_date::text,
      e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id, e.designation_id,
      p.id as process_id, p.status as process_status, t.name as template,
      (select json_agg(json_build_object('status', k.status, 'due_date', k.due_date)) from tasks k where k.process_id = p.id) as tasks
    from employees e
    left join designations d on d.id = e.designation_id left join departments dp on dp.id = e.department_id left join locations l on l.id = e.location_id
    left join lateral (select * from lifecycle_processes x where x.employee_id = e.id and x.kind = 'onboarding' order by (x.status = 'in_progress') desc, x.created_at desc limit 1) p on true
    left join task_templates t on t.id = p.template_id
    where e.status <> 'relieved' and (e.status = 'preboarding' or e.joining_date >= ${addDaysISO(today, -90)}::date or p.status = 'in_progress')
    order by e.joining_date desc, e.display_name`;
  const templates = await tx<{ id: string; name: string; criteria: Criteria; created_at: Date }[]>`select id, name, criteria, created_at from task_templates where kind = 'onboarding'`;
  return rows.filter((r) => canRunOnboardingOf(actor, r)).map((r): JoinerRow => {
    const pr = progress(r.tasks ?? [], today);
    return {
      id: r.id, name: r.name, number: r.number, designation: r.designation, department: r.department, location: r.location, status: r.status, joining_date: r.joining_date,
      process_id: r.process_id, process_status: r.process_status, template: r.template, total: pr.total, done: pr.done, overdue: pr.overdue,
      suggested: r.process_id && r.process_status === "in_progress" ? null : pickTemplate(templates, r)?.name ?? null,
    };
  });
}

export type TaskView = {
  id: string; title: string; description: string | null; type: TaskType; owner: string; assignee: { id: string; name: string } | null; due_date: string | null;
  status: TaskStatus; overdue: boolean; completed_at: string | null; config: Pick<TaskConfig, "field" | "docType" | "category" | "ackText" | "decision" | "decisionNote" | "documentId">;
  fieldLabel: string | null; fieldFilled: boolean;
  can: { complete: boolean; manage: boolean };
};

export type ProcessDetail = {
  id: string; status: "in_progress" | "completed" | "cancelled"; template: string | null; created_at: string;
  employee: { id: string; name: string; first_name: string; number: string; designation: string | null; department: string | null; manager: string | null; joining_date: string; status: string; personal_email: string | null };
  tasks: TaskView[]; progress: { total: number; done: number; overdue: number; pct: number };
  portal: { active: boolean; expires_at: string | null };
  can: { manage: boolean };
};

type TaskRow = { id: string; title: string; type: TaskType; config: TaskConfig; due_date: string | null; status: TaskStatus; completed_at: Date | null; assignee_id: string | null; assignee_name: string | null; subject_employee_id: string };

async function taskViews(tx: Tx, processId: string, viewerEmployeeId: string | null, manage: boolean, today: ISODate): Promise<TaskView[]> {
  const rows = await tx<(TaskRow & { filled: Record<string, unknown> })[]>`
    select t.id, t.title, t.type, t.config, t.due_date::text, t.status, t.completed_at, t.assignee_employee_id as assignee_id, a.display_name as assignee_name, t.subject_employee_id,
      (select json_build_object('personal_email', s.personal_email, 'mobile', s.mobile, 'dob', s.dob, 'gender', s.gender, 'marital_status', s.marital_status, 'blood_group', s.blood_group, 'nationality', s.nationality)
         from employees s where s.id = t.subject_employee_id) as filled
    from tasks t left join employees a on a.id = t.assignee_employee_id left join task_template_items i on i.id = t.template_item_id
    where t.process_id = ${processId} order by t.due_date nulls last, i.position nulls last, t.created_at`;
  return rows.map((t) => ({
    id: t.id, title: t.title, description: t.config?.description ?? null, type: t.type, owner: t.config?.owner ? ownerLabel(t.config.owner) : "—",
    assignee: t.assignee_id ? { id: t.assignee_id, name: t.assignee_name ?? "" } : null, due_date: t.due_date, status: t.status, overdue: isOverdue(t, today),
    completed_at: t.completed_at ? t.completed_at.toISOString() : null,
    config: { field: t.config?.field, docType: t.config?.docType, category: t.config?.category, ackText: t.config?.ackText, decision: t.config?.decision, decisionNote: t.config?.decisionNote, documentId: t.config?.documentId },
    fieldLabel: t.config?.field ? PROFILE_FIELDS[t.config.field]?.label ?? null : null,
    fieldFilled: !!(t.config?.field && t.filled?.[t.config.field] != null && t.filled[t.config.field] !== ""),
    can: { complete: t.status === "open" && !!viewerEmployeeId && t.assignee_id === viewerEmployeeId && !(t.type === "approval" && t.subject_employee_id === viewerEmployeeId), manage },
  }));
}

/** One onboarding, for HR covering the person, their manager, or the joiner themselves. */
export async function processDetail(tx: Tx, actor: Actor, processId: string, today: ISODate = todayIn()): Promise<ProcessDetail | null> {
  const [p] = await tx<{ id: string; status: ProcessDetail["status"]; template: string | null; created_at: Date; employee_id: string; portal_expires_at: Date | null; portal_token_hash: string | null }[]>`
    select p.id, p.status, t.name as template, p.created_at, p.employee_id, p.portal_expires_at, p.portal_token_hash
    from lifecycle_processes p left join task_templates t on t.id = p.template_id where p.id = ${processId} and p.kind = 'onboarding'`;
  if (!p) return null;
  const e = await joiner(tx, p.employee_id);
  if (!e) return null;
  const manage = canRunOnboardingOf(actor, e) && p.status === "in_progress";
  const viewer = canRunOnboardingOf(actor, e) || e.manager_id === actor.employeeId || e.id === actor.employeeId;
  const [{ assigned }] = await tx<{ assigned: boolean }[]>`select exists(select 1 from tasks where process_id = ${processId} and assignee_employee_id = ${actor.employeeId}) as assigned`;
  if (!viewer && !assigned) return null;
  const [emp] = await tx<ProcessDetail["employee"][]>`
    select e.id, e.display_name as name, e.first_name, e.employee_number as number, d.title as designation, dp.name as department, m.display_name as manager, e.joining_date::text, e.status,
      case when ${canRunOnboardingOf(actor, e)} then e.personal_email end as personal_email
    from employees e left join designations d on d.id = e.designation_id left join departments dp on dp.id = e.department_id left join employees m on m.id = e.manager_id
    where e.id = ${e.id}`;
  let tasks = await taskViews(tx, processId, actor.employeeId, manage, today);
  if (!viewer) tasks = tasks.filter((t) => t.assignee?.id === actor.employeeId);   // owners of a task only see their own
  return {
    id: p.id, status: p.status, template: p.template, created_at: p.created_at.toISOString(), employee: emp, tasks, progress: progress(tasks, today),
    portal: { active: !!p.portal_token_hash && !!p.portal_expires_at && p.portal_expires_at > new Date() && p.status === "in_progress", expires_at: p.portal_expires_at?.toISOString() ?? null },
    can: { manage },
  };
}

export type MyTaskRow = { id: string; title: string; type: TaskType; due_date: string | null; overdue: boolean; status: TaskStatus; process_id: string; subject: { id: string; name: string; joining_date: string }; completed_at: string | null };

/** Onboarding tasks the person owns for other people's onboarding: open ones, plus what they finished in the last 30 days. */
export async function myTasks(tx: Tx, actor: Actor, today: ISODate = todayIn()) {
  const rows = await tx<{ id: string; title: string; type: TaskType; due_date: string | null; status: TaskStatus; process_id: string; subject_id: string; subject_name: string; joining_date: string; completed_at: Date | null }[]>`
    select t.id, t.title, t.type, t.due_date::text, t.status, t.process_id, s.id as subject_id, s.display_name as subject_name, s.joining_date::text, t.completed_at
    from tasks t join lifecycle_processes p on p.id = t.process_id and p.kind = 'onboarding' join employees s on s.id = t.subject_employee_id
    where t.assignee_employee_id = ${actor.employeeId} and t.subject_employee_id <> ${actor.employeeId}
      and ((t.status = 'open' and p.status = 'in_progress') or (t.status <> 'open' and t.completed_at > now() - interval '30 days'))
    order by t.status = 'open' desc, t.due_date nulls last, t.created_at`;
  const out: MyTaskRow[] = rows.map((r) => ({ id: r.id, title: r.title, type: r.type, due_date: r.due_date, status: r.status, overdue: isOverdue(r, today), process_id: r.process_id,
    subject: { id: r.subject_id, name: r.subject_name, joining_date: r.joining_date }, completed_at: r.completed_at?.toISOString() ?? null }));
  return { open: out.filter((t) => t.status === "open"), done: out.filter((t) => t.status !== "open") };
}

/** The joiner's own checklist (only tasks they do themselves), for Home and their profile. */
export async function myOnboarding(tx: Tx, actor: Actor, employeeId: string = actor.employeeId, today: ISODate = todayIn()) {
  const [p] = await tx<{ id: string }[]>`
    select id from lifecycle_processes where employee_id = ${employeeId} and kind = 'onboarding' and (status = 'in_progress' or updated_at > now() - interval '7 days')
    order by (status = 'in_progress') desc, created_at desc limit 1`;
  if (!p) return null;
  const d = await processDetail(tx, actor, p.id, today);
  if (!d) return null;
  const mine = d.tasks.filter((t) => t.assignee?.id === employeeId);
  return { processId: d.id, status: d.status, joining_date: d.employee.joining_date, tasks: mine, progress: progress(mine, today), overall: d.progress };
}

// ---------------------------------------------------------------- doing tasks

type LoadedTask = TaskRow & { process_id: string; process_status: string; tenant_id: string };
async function loadTask(tx: Tx, taskId: string, lock = false): Promise<LoadedTask> {
  const [t] = await tx<LoadedTask[]>`
    select t.id, t.title, t.type, t.config, t.due_date::text, t.status, t.completed_at, t.assignee_employee_id as assignee_id, null::text as assignee_name, t.subject_employee_id,
      t.process_id, p.status as process_status, t.tenant_id
    from tasks t join lifecycle_processes p on p.id = t.process_id and p.kind = 'onboarding' where t.id = ${taskId} ${lock ? tx`for update of t` : tx``}`;
  if (!t) throw new AppError("not_found", "Task not found.");
  return t;
}

/** Close the process once nothing is left open; tells the joiner's HR contact. Returns true when it closed. */
async function maybeComplete(tx: Tx, processId: string, actorUserId: string | null) {
  const tasks = await tx<{ status: TaskStatus }[]>`select status from tasks where process_id = ${processId}`;
  if (!allClosed(tasks)) return false;
  const [p] = await tx<{ employee_id: string; tenant_id: string }[]>`update lifecycle_processes set status = 'completed' where id = ${processId} and status = 'in_progress' returning employee_id, tenant_id`;
  if (!p) return false;
  await tx`insert into timeline_events (tenant_id, employee_id, kind, effective_date, data, actor_user_id) values (${p.tenant_id}, ${p.employee_id}, 'onboarding_completed', ${todayIn()}, ${tx.json({ process_id: processId })}, ${actorUserId})`;
  await audit(tx, { tenantId: p.tenant_id, userId: actorUserId }, { entityType: "onboarding", entityId: processId, action: "complete" });
  return true;
}

/**
 * The task's owner finishes it, in the way its type needs: a to-do is ticked, an acknowledgement recorded, an approval
 * decided (never on your own onboarding), a profile detail submitted (through the usual profile change flow) or a
 * document uploaded. Guarded on status, so a double click does nothing the second time.
 */
export async function completeTask(tx: Tx, actor: Actor, taskId: string, input: CompleteInput) {
  const t = await loadTask(tx, taskId, true);
  if (t.process_status !== "in_progress") throw new AppError("conflict", "This onboarding is closed.");
  if (t.status !== "open") throw new AppError("conflict", "This task is already closed.");
  if (t.assignee_id !== actor.employeeId) throw new AppError("forbidden", "Only the task's owner can complete it.");
  if (t.type === "approval" && t.subject_employee_id === actor.employeeId) throw new AppError("forbidden", "You can't approve your own onboarding.");
  if (!completionAllowed(t.type, input.kind)) throw new AppError("invalid", "This task is finished a different way.");
  const cfg: TaskConfig = { ...t.config, completedBy: actor.userId };
  if (input.kind === "acknowledge") cfg.acknowledgedAt = new Date().toISOString();
  if (input.kind === "decide") {
    if (!["approved", "declined"].includes(input.decision)) throw new AppError("invalid", "Approve or decline.");
    if (input.decision === "declined" && !input.note?.trim()) throw new AppError("invalid", "Say why, so HR can follow up.", "note");
    cfg.decision = input.decision; cfg.decisionNote = input.note?.trim().slice(0, 1000) || null;
  }
  if (input.kind === "field" || input.kind === "done") {
    if (t.type === "profile_field") {
      const field = t.config.field;
      if (!field || !PROFILE_FIELDS[field]) throw new AppError("invalid", "This task has no profile detail set.");
      if (input.kind === "field") {
        const value = input.value.trim();
        if (!value) throw new AppError("invalid", `Enter your ${PROFILE_FIELDS[field].label.toLowerCase()}.`, "value");
        await updateSection(tx, actor, t.subject_employee_id, PROFILE_FIELDS[field].section, { [field]: field === "nationality" ? value.toUpperCase() : value });
      } else {
        const [row] = await tx<Record<string, unknown>[]>`select ${tx(field)} as v from employees where id = ${t.subject_employee_id}`;
        if (row?.v == null || row.v === "") throw new AppError("invalid", "Fill in the detail first.", "value");
      }
    }
  }
  if (input.kind === "document") {
    const [d] = await tx<{ id: string }[]>`select id from employee_documents where id = ${input.documentId} and employee_id = ${t.subject_employee_id}`;
    if (!d) throw new AppError("invalid", "Upload the document first.", "file");
    cfg.documentId = d.id;
  }
  const [u] = await tx<{ id: string }[]>`update tasks set status = 'done', completed_at = now(), config = ${tx.json(cfg as never)} where id = ${taskId} and status = 'open' returning id`;
  if (!u) throw new AppError("conflict", "This task is already closed.");
  await audit(tx, actor, { entityType: "onboarding_task", entityId: taskId, action: input.kind === "decide" ? `task.${input.decision}` : "task.done", diff: { processId: t.process_id } });
  if (input.kind === "decide" && input.decision === "declined") {
    const hr = (await roleHolders(tx, t.subject_employee_id))("hr_admin");
    if (hr && hr !== actor.employeeId) await notifyEmployee(tx, t.tenant_id, hr, "onboarding.declined", "Onboarding step declined", `${t.title}: ${cfg.decisionNote}`, `/org/onboarding/${t.process_id}`);
  }
  return { completed: await maybeComplete(tx, t.process_id, actor.userId) };
}

/** A document-upload task: store the file as the joiner's document (pending HR verification) and close the task. */
export async function uploadForTask(tx: Tx, actor: Actor, taskId: string, file: { name: string; bytes: Uint8Array }) {
  const t = await loadTask(tx, taskId, true);
  if (t.type !== "document_upload") throw new AppError("invalid", "This task doesn't take a document.");
  if (t.status !== "open" || t.process_status !== "in_progress") throw new AppError("conflict", "This task is already closed.");
  if (t.assignee_id !== actor.employeeId) throw new AppError("forbidden", "Only the task's owner can complete it.");
  const doc = await uploadPersonDocument(tx, actor, t.subject_employee_id, { category: t.config.category ?? "other", docType: t.config.docType ?? t.title, file });
  return completeTask(tx, actor, taskId, { kind: "document", documentId: doc.id });
}

async function assertManagesTask(tx: Tx, actor: Actor, t: LoadedTask) {
  const e = await joiner(tx, t.subject_employee_id);
  if (!e || !canRunOnboardingOf(actor, e)) throw new AppError("forbidden", e?.id === actor.employeeId ? "Someone else in HR has to change your onboarding." : "You don't have access to do this.");
  if (t.process_status !== "in_progress") throw new AppError("conflict", "This onboarding is closed.");
  return e;
}

/** HR: skip a task that doesn't apply, or reopen a closed one. */
export async function setTaskState(tx: Tx, actor: Actor, taskId: string, state: "skipped" | "open") {
  const t = await loadTask(tx, taskId, true);
  await assertManagesTask(tx, actor, t);
  if (state === "skipped" && t.status !== "open") throw new AppError("conflict", "Only open tasks can be skipped.");
  if (state === "open" && t.status === "open") throw new AppError("conflict", "This task is already open.");
  await tx`update tasks set status = ${state}, completed_at = ${state === "open" ? null : tx`now()`} where id = ${taskId}`;
  await audit(tx, actor, { entityType: "onboarding_task", entityId: taskId, action: `task.${state === "open" ? "reopen" : "skip"}`, diff: { processId: t.process_id } });
  return { completed: state === "skipped" ? await maybeComplete(tx, t.process_id, actor.userId) : false };
}

/** HR: hand an open task to someone else (not the joiner for an approval). */
export async function reassignTask(tx: Tx, actor: Actor, taskId: string, employeeId: string) {
  const t = await loadTask(tx, taskId, true);
  const e = await assertManagesTask(tx, actor, t);
  if (t.status !== "open") throw new AppError("conflict", "Only open tasks can be handed over.");
  const [to] = await tx<{ id: string; display_name: string }[]>`select id, display_name from employees where id = ${employeeId} and status <> 'relieved'`;
  if (!to) throw new AppError("invalid", "Pick someone who works here.", "employeeId");
  if (t.type === "approval" && to.id === t.subject_employee_id) throw new AppError("invalid", "The joiner can't approve their own onboarding.", "employeeId");
  if ((t.type === "profile_field" || t.type === "document_upload") && to.id !== t.subject_employee_id) throw new AppError("invalid", "Only the joiner can fill in their details or upload their documents.", "employeeId");
  await tx`update tasks set assignee_employee_id = ${to.id} where id = ${taskId}`;
  if (to.id !== t.subject_employee_id) await notifyEmployee(tx, t.tenant_id, to.id, "onboarding.task", "New onboarding task", `${t.title} · ${e.display_name}`, "/me/tasks");
  await audit(tx, actor, { entityType: "onboarding_task", entityId: taskId, action: "task.reassign", diff: { from: t.assignee_id, to: to.id } });
}

export async function cancelOnboarding(tx: Tx, actor: Actor, processId: string) {
  const [p] = await tx<{ employee_id: string; status: string }[]>`select employee_id, status from lifecycle_processes where id = ${processId} and kind = 'onboarding' for update`;
  if (!p) throw new AppError("not_found", "Onboarding not found.");
  const e = await joiner(tx, p.employee_id);
  if (!e || !canRunOnboardingOf(actor, e)) throw new AppError("forbidden", "You don't have access to do this.");
  if (p.status !== "in_progress") throw new AppError("conflict", "This onboarding is already closed.");
  await tx`update lifecycle_processes set status = 'cancelled', portal_token_hash = null, portal_expires_at = null where id = ${processId}`;
  await audit(tx, actor, { entityType: "onboarding", entityId: processId, action: "cancel" });
}

// ---------------------------------------------------------------- joiner portal

function portalEmail(p: { company: string; name: string; url: string; days: number }) {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const first = p.name.split(" ")[0];
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:Inter,Segoe UI,Roboto,Arial,sans-serif;color:#14171c">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e2e5ea;border-radius:12px">
<tr><td style="padding:28px 28px 8px;font-size:13px;color:#535c68">${esc(p.company)} · erp</td></tr>
<tr><td style="padding:0 28px;font-size:22px;font-weight:600;line-height:28px">We're glad you're joining, ${esc(first)}</td></tr>
<tr><td style="padding:12px 28px 0;font-size:15px;line-height:22px">There are a few things to finish before your first day: share some details, upload documents and read our policies.</td></tr>
<tr><td style="padding:24px 28px 8px"><a href="${esc(p.url)}" style="display:inline-block;background:#2f5bea;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:8px">Open my checklist</a></td></tr>
<tr><td style="padding:8px 28px 0;font-size:12px;color:#535c68;word-break:break-all">Or open this link: ${esc(p.url)}</td></tr>
<tr><td style="padding:24px 28px 28px;font-size:12px;line-height:18px;color:#535c68">This link is just for you and works for ${p.days} days. Don't forward it.</td></tr>
</table></td></tr></table></body></html>`;
  const text = `${p.company} · erp\n\nWe're glad you're joining, ${first}\n\nThere are a few things to finish before your first day.\n\nOpen my checklist: ${p.url}\n\nThis link is just for you and works for ${p.days} days.`;
  return { subject: `Your first steps at ${p.company}`, html, text };
}

/**
 * HR creates a fresh joiner-portal link (any older link stops working) and, if the joiner has a personal email,
 * emails it there. The raw token is returned once; only its hash is kept.
 */
export async function sendPortalLink(tx: Tx, actor: Actor, processId: string, opts: { email: boolean }) {
  const [p] = await tx<{ employee_id: string; status: string }[]>`select employee_id, status from lifecycle_processes where id = ${processId} and kind = 'onboarding' for update`;
  if (!p) throw new AppError("not_found", "Onboarding not found.");
  const e = await joiner(tx, p.employee_id);
  if (!e || !canRunOnboardingOf(actor, e)) throw new AppError("forbidden", "You don't have access to do this.");
  if (p.status !== "in_progress") throw new AppError("conflict", "This onboarding is closed.");
  const token = newToken();
  const expires = new Date(Date.now() + PORTAL_DAYS * 864e5);
  await tx`update lifecycle_processes set portal_token_hash = ${sha256(token)}, portal_expires_at = ${expires} where id = ${processId}`;
  const url = appUrl(actor.tenant.subdomain, `/join/${token}`);
  const to = e.personal_email ?? null;
  if (opts.email) {
    if (!to) throw new AppError("invalid", `Add ${e.first_name}'s personal email first, or copy the link instead.`);
    await queueEmail(tx, actor.tenant.id, { kind: "onboarding.portal", to, ...portalEmail({ company: actor.tenant.name, name: e.display_name, url, days: PORTAL_DAYS }) });
  }
  await audit(tx, actor, { entityType: "onboarding", entityId: processId, action: opts.email ? "portal.email" : "portal.link", diff: { expires: expires.toISOString() } });
  return { url, emailedTo: opts.email ? to : null, expiresAt: expires.toISOString() };
}

export type PortalView = {
  company: string; name: string; joining_date: string; tasks: TaskView[]; progress: { total: number; done: number; overdue: number; pct: number }; expires_at: string;
};

/** Resolve a portal token inside the tenant (RLS already limits it to the subdomain's company). */
async function portalProcess(tx: Tx, token: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const [p] = await tx<{ id: string; employee_id: string; portal_expires_at: Date }[]>`
    select id, employee_id, portal_expires_at from lifecycle_processes
    where portal_token_hash = ${sha256(token)} and kind = 'onboarding' and status = 'in_progress' and portal_expires_at > now()`;
  return p ?? null;
}

/** A stand-in actor for the joiner using their portal link: no roles, just themselves. */
function joinerActor(tenant: Actor["tenant"], e: Joiner): Actor {
  return { tenant, userId: e.user_id as string, employeeId: e.id, name: e.display_name, email: e.work_email, title: null, roles: [], permissions: new Set(), grants: [] };
}

export async function portalView(tx: Tx, tenant: Actor["tenant"], token: string, today: ISODate = todayIn()): Promise<PortalView | null> {
  const p = await portalProcess(tx, token);
  if (!p) return null;
  const e = await joiner(tx, p.employee_id);
  if (!e) return null;
  const tasks = (await taskViews(tx, p.id, e.id, false, today)).filter((t) => t.assignee?.id === e.id);
  return { company: tenant.name, name: e.display_name, joining_date: e.joining_date, tasks, progress: progress(tasks, today), expires_at: p.portal_expires_at.toISOString() };
}

/** The joiner finishes one of their own tasks from the portal. Only tasks they own, on this link's onboarding. */
export async function portalComplete(tx: Tx, tenant: Actor["tenant"], token: string, taskId: string, input: CompleteInput | { kind: "upload"; file: { name: string; bytes: Uint8Array } }) {
  const p = await portalProcess(tx, token);
  if (!p) throw new AppError("forbidden", "This link has expired. Ask HR for a new one.");
  const e = await joiner(tx, p.employee_id);
  if (!e || !e.user_id) throw new AppError("forbidden", "This link has expired. Ask HR for a new one.");
  const [t] = await tx<{ id: string }[]>`select id from tasks where id = ${taskId} and process_id = ${p.id} and assignee_employee_id = ${e.id}`;
  if (!t) throw new AppError("not_found", "Task not found.");
  const a = joinerActor(tenant, e);
  if (input.kind === "upload") return uploadForTask(tx, a, taskId, input.file);
  if (input.kind === "decide") throw new AppError("forbidden", "You can't approve your own onboarding.");
  return completeTask(tx, a, taskId, input);
}

/** The person's latest onboarding for their profile tab: HR covering them and their manager see every task, the person sees theirs. */
export async function onboardingForProfile(tx: Tx, actor: Actor, employeeId: string, today: ISODate = todayIn()) {
  const [p] = await tx<{ id: string }[]>`
    select id from lifecycle_processes where employee_id = ${employeeId} and kind = 'onboarding' and status <> 'cancelled' order by created_at desc limit 1`;
  if (!p) return null;
  const d = await processDetail(tx, actor, p.id, today);
  if (!d) return null;
  const e = await joiner(tx, employeeId);
  const full = !!e && (canRunOnboardingOf(actor, e) || e.manager_id === actor.employeeId);
  if (full) return d;
  if (actor.employeeId !== employeeId) return null;
  const tasks = d.tasks.filter((t) => t.assignee?.id === employeeId);
  return { ...d, tasks, progress: progress(tasks, today) };
}
