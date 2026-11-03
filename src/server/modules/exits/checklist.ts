import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canEditExitSettings } from "./service";
import { AUTO_KINDS, type AutoKind, type TaskOwner } from "./rules";

/**
 * The exit checklist template (Settings → Exits): add, edit, reorder and remove tasks. Exits already started keep
 * the tasks they were given. Tasks can be auto-ticked where the system can tell (assets returned, access revoked,
 * final settlement finalised); see autoTickExitTasks.
 */
async function exitTemplate(tx: Tx, tenantId: string) {
  const [t] = await tx<{ id: string }[]>`select id from task_templates where kind = 'exit' order by created_at limit 1`;
  if (t) return t.id;
  const [n] = await tx<{ id: string }[]>`insert into task_templates (tenant_id, kind, name) values (${tenantId}, 'exit', 'Standard exit checklist') returning id`;
  return n.id;
}

export type ChecklistInput = { title: string; description?: string | null; owner: TaskOwner; dueOffsetDays: number; auto?: AutoKind | null };

function cleanInput(i: ChecklistInput) {
  const title = (i.title ?? "").trim().slice(0, 160);
  if (!title) throw new AppError("invalid", "Give the task a title.", "title");
  const o = i.owner as TaskOwner | undefined;
  const okOwner = o && (o.type === "self" || o.type === "manager" || (o.type === "role" && typeof o.role === "string" && /^[a-z_]{2,40}$/.test(o.role)) || (o.type === "employee" && /^[0-9a-f-]{36}$/i.test(o.id)));
  if (!okOwner) throw new AppError("invalid", "Pick who owns this task.", "owner");
  if (!Number.isInteger(i.dueOffsetDays) || i.dueOffsetDays < -365 || i.dueOffsetDays > 365) throw new AppError("invalid", "Due within a year of the last working day.", "dueOffsetDays");
  const auto = i.auto && (AUTO_KINDS as readonly string[]).includes(i.auto) ? i.auto : null;
  return { title, description: i.description?.trim().slice(0, 1000) || null, owner: o!, dueOffsetDays: i.dueOffsetDays, auto };
}

export async function saveChecklistItem(tx: Tx, actor: Actor, id: string | null, input: ChecklistInput) {
  if (!canEditExitSettings(actor)) throw new AppError("forbidden", "You don't have access to do this.");
  const v = cleanInput(input);
  if (v.owner.type === "employee") { const [e] = await tx`select 1 from employees where id = ${v.owner.id} and status <> 'relieved'`; if (!e) throw new AppError("invalid", "That person isn't here any more.", "owner"); }
  const templateId = await exitTemplate(tx, actor.tenant.id);
  const config = v.auto ? { auto: v.auto } : {};
  const action = id ? "update" : "create";
  if (id) {
    const [r] = await tx<{ id: string }[]>`update task_template_items set title = ${v.title}, description = ${v.description}, owner = ${tx.json(v.owner)}, due_offset_days = ${v.dueOffsetDays},
      config = (config - 'auto') || ${tx.json(config)} where id = ${id} and template_id = ${templateId} returning id`;
    if (!r) throw new AppError("not_found", "Task not found.");
  } else {
    const [{ n }] = await tx<{ n: number }[]>`select coalesce(max(position), -1) + 1 as n from task_template_items where template_id = ${templateId}`;
    const [r] = await tx<{ id: string }[]>`insert into task_template_items (tenant_id, template_id, title, description, owner, due_offset_days, config, position)
      values (${actor.tenant.id}, ${templateId}, ${v.title}, ${v.description}, ${tx.json(v.owner)}, ${v.dueOffsetDays}, ${tx.json(config)}, ${n}) returning id`;
    id = r.id;
  }
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${actor.tenant.id}, ${actor.userId}, 'exit_checklist_item', ${id}, ${action}, ${tx.json({ name: v.title, auto: v.auto, due_offset_days: v.dueOffsetDays })})`;
  return { id };
}

export async function deleteChecklistItem(tx: Tx, actor: Actor, id: string) {
  if (!canEditExitSettings(actor)) throw new AppError("forbidden", "You don't have access to do this.");
  const [r] = await tx<{ title: string }[]>`delete from task_template_items i using task_templates t where i.id = ${id} and t.id = i.template_id and t.kind = 'exit' returning i.title`;
  if (!r) throw new AppError("not_found", "Task not found.");
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${actor.tenant.id}, ${actor.userId}, 'exit_checklist_item', ${id}, 'delete', ${tx.json({ name: r.title })})`;
}

export async function moveChecklistItem(tx: Tx, actor: Actor, id: string, dir: "up" | "down") {
  if (!canEditExitSettings(actor)) throw new AppError("forbidden", "You don't have access to do this.");
  const templateId = await exitTemplate(tx, actor.tenant.id);
  const items = await tx<{ id: string }[]>`select id from task_template_items where template_id = ${templateId} order by position, created_at`;
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) throw new AppError("not_found", "Task not found.");
  const j = dir === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= items.length) return;
  [items[i], items[j]] = [items[j], items[i]];
  for (const [pos, it] of items.entries()) await tx`update task_template_items set position = ${pos} where id = ${it.id}`;
}

/**
 * Tick tasks the system can prove are done, for every exit in progress (or one person). Idempotent: a task is only
 * moved from open to done, never back, and a task HR already ticked or skipped is left alone.
 *   assets_returned  no asset assignment still open for the person
 *   access_revoked   the person's sign-in is disabled (relieved)
 *   fnf_finalized    the final settlement for the exit is finalised
 */
export async function autoTickExitTasks(tx: Tx, opts: { employeeId?: string | null } = {}) {
  const rows = await tx<{ task_id: string; employee_id: string; exit_id: string; auto: AutoKind }[]>`
    select t.id as task_id, t.subject_employee_id as employee_id, x.id as exit_id, i.config->>'auto' as auto
    from tasks t join lifecycle_processes p on p.id = t.process_id and p.kind = 'exit'
    join exit_requests x on x.process_id = p.id and x.status in ('in_progress','exited')
    join task_template_items i on i.id = t.template_item_id
    where t.status = 'open' and i.config ? 'auto' and (${opts.employeeId ?? null}::uuid is null or t.subject_employee_id = ${opts.employeeId ?? null}::uuid)`;
  let ticked = 0;
  for (const r of rows) {
    let done = false;
    if (r.auto === "assets_returned") {
      const [{ open }] = await tx<{ open: number }[]>`select count(*)::int as open from asset_assignments where employee_id = ${r.employee_id} and returned_at is null`;
      done = open === 0;
    } else if (r.auto === "access_revoked") {
      const [u] = await tx<{ status: string | null }[]>`select u.status from employees e left join users u on u.id = e.user_id where e.id = ${r.employee_id}`;
      done = u?.status === "disabled" || u?.status === null;
    } else if (r.auto === "fnf_finalized") {
      const [s] = await tx<{ status: string }[]>`select status from fnf_settlements where exit_request_id = ${r.exit_id}`;
      done = s?.status === "finalized";
    }
    if (!done) continue;
    const u = await tx`update tasks set status = 'done', completed_at = now(), config = config || '{"auto_done": true}'::jsonb where id = ${r.task_id} and status = 'open'`;
    ticked += u.count;
  }
  return { checked: rows.length, ticked };
}
