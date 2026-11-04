import "server-only";
import type { Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { addDaysISO } from "@/lib/dates";
import { resolveOwner, type TaskOwner } from "./rules";
import { inviteToExitSurvey } from "./survey";

/** In-app notification (kept local so the approvals engine can import this file without a cycle). */
async function notify(tx: Tx, tenantId: string, employeeId: string, kind: string, title: string, body: string, link: string) {
  await tx`insert into notifications (tenant_id, user_id, kind, title, body, link)
           select ${tenantId}, user_id, ${kind}, ${title}, ${body}, ${link} from employees where id = ${employeeId} and user_id is not null`;
}

async function roleHolders(tx: Tx, employeeId: string) {
  const rows = await tx<{ key: string; id: string }[]>`
    select distinct on (ro.key) ro.key, ra.employee_id as id from role_assignments ra join roles ro on ro.id = ra.role_id
    join employees e on e.id = ra.employee_id and e.status <> 'relieved'
    where ra.employee_id <> ${employeeId} order by ro.key, ra.created_at`;
  const m = new Map(rows.map((r) => [r.key, r.id]));
  return (role: string) => m.get(role) ?? null;
}

/**
 * Exit accepted (or started by HR): status in progress, person serving notice, checklist created from the exit template.
 * Guarded on status, so running it twice does nothing the second time.
 */
export async function startExitProcess(tx: Tx, exitId: string, actorUserId: string | null) {
  const [x] = await tx<{ tenant_id: string; employee_id: string; last_working_date: string }[]>`
    update exit_requests set status = 'in_progress' where id = ${exitId} and status = 'under_review' and process_id is null
    returning tenant_id, employee_id, last_working_date::text`;
  if (!x) return false;
  const [emp] = await tx<{ manager_id: string | null; display_name: string }[]>`
    update employees set status = 'notice', exit_date = ${x.last_working_date} where id = ${x.employee_id} returning manager_id, display_name`;
  // an older checklist left open (e.g. a cancelled exit) would block the new one
  await tx`update lifecycle_processes set status = 'cancelled' where employee_id = ${x.employee_id} and kind = 'exit' and status = 'in_progress'`;
  const [tpl] = await tx<{ id: string }[]>`select id from task_templates where kind = 'exit' order by created_at limit 1`;
  const [proc] = await tx<{ id: string }[]>`
    insert into lifecycle_processes (tenant_id, kind, employee_id, template_id) values (${x.tenant_id}, 'exit', ${x.employee_id}, ${tpl?.id ?? null}) returning id`;
  await tx`update exit_requests set process_id = ${proc.id} where id = ${exitId}`;
  if (tpl) {
    const items = await tx<{ id: string; title: string; description: string | null; type: string; owner: TaskOwner; due_offset_days: number }[]>`
      select id, title, description, type, owner, due_offset_days from task_template_items where template_id = ${tpl.id} order by position, created_at`;
    const holder = await roleHolders(tx, x.employee_id);
    for (const it of items) {
      const assignee = resolveOwner(it.owner, { employeeId: x.employee_id, managerId: emp.manager_id, roleHolder: holder });
      await tx`insert into tasks (tenant_id, process_id, subject_employee_id, assignee_employee_id, template_item_id, title, type, config, due_date)
               values (${x.tenant_id}, ${proc.id}, ${x.employee_id}, ${assignee}, ${it.id}, ${it.title}, ${it.type},
                       ${tx.json({ description: it.description, owner: it.owner })}, ${addDaysISO(x.last_working_date, it.due_offset_days)})`;
      if (assignee && assignee !== x.employee_id) await notify(tx, x.tenant_id, assignee, "exit.task", "New exit task", `${it.title} · ${emp.display_name}`, "/org/exits");
    }
  }
  await tx`insert into timeline_events (tenant_id, employee_id, kind, effective_date, data, actor_user_id)
           values (${x.tenant_id}, ${x.employee_id}, 'exit_started', current_date, ${tx.json({ exit_id: exitId, last_working_date: x.last_working_date })}, ${actorUserId})`;
  await inviteToExitSurvey(tx, x.tenant_id, exitId);   // the leaver is asked for feedback while they're still around to answer
  return true;
}

/** Final decision from the approvals engine on a resignation. */
export async function onExitDecided(tx: Tx, actor: Actor | null, exitId: string, final: "approved" | "rejected") {
  if (final === "approved") { await startExitProcess(tx, exitId, actor?.userId ?? null); return; }
  await tx`update exit_requests set status = 'rejected' where id = ${exitId} and status = 'under_review'`;
}
