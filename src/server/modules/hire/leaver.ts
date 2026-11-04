import "server-only";
import type { Tx } from "@/server/db";
import { cancelApproval, notifyEmployee } from "@/server/modules/approvals/service";

/**
 * Exit hook: when someone starts their exit, requisitions they raised that haven't been decided yet (draft, waiting for
 * approval, or sent back) are closed, their approvals are cancelled, and recruiters are told so they can raise a new
 * one if the role is still needed. Approved requisitions stay: someone already agreed the position is needed.
 * Guarded on status, so running it again does nothing.
 */
export async function closeLeaverRequisitions(tx: Tx, tenantId: string, employeeId: string, actorUserId: string | null) {
  const rows = await tx<{ id: string; title: string; status: string }[]>`
    select id, title, status from requisitions where raised_by_employee_id = ${employeeId} and status in ('draft','pending','sent_back') for update`;
  if (!rows.length) return 0;
  const [who] = await tx<{ name: string }[]>`select display_name as name from employees where id = ${employeeId}`;
  for (const r of rows) {
    if (r.status === "pending") await cancelApproval(tx, "requisition", r.id);
    await tx`update requisitions set status = 'closed' where id = ${r.id} and status = ${r.status}`;
    await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff)
             values (${tenantId}, ${actorUserId}, 'requisition', ${r.id}, 'requisition.closed_on_exit', ${tx.json({ employee_id: employeeId, was: r.status })})`;
  }
  const recruiters = await tx<{ id: string }[]>`
    select distinct ra.employee_id as id from role_assignments ra join roles ro on ro.id = ra.role_id join employees e on e.id = ra.employee_id and e.status <> 'relieved'
    where ('hire.recruit' = any(ro.permissions) or 'hire.admin' = any(ro.permissions)) and ra.employee_id <> ${employeeId}`;
  const titles = rows.map((r) => r.title);
  for (const x of recruiters) {
    await notifyEmployee(tx, tenantId, x.id, "hire.requisition_closed", `${titles.length === 1 ? "A requisition was" : `${titles.length} requisitions were`} closed`,
      `${who?.name ?? "The person who raised it"} is leaving: ${titles.slice(0, 3).join(", ")}${titles.length > 3 ? "…" : ""}. Raise it again if the role is still needed.`, "/hire/requisitions");
  }
  return rows.length;
}
