import "server-only";
import type { Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import type { Scope } from "@/server/auth/catalog";

export const ASSETS_ADMIN = "assets.admin";

/** In-app notification (kept local so the approvals engine can import this file without a cycle). */
export async function notify(tx: Tx, tenantId: string, employeeId: string, kind: string, title: string, body: string, link: string) {
  await tx`insert into notifications (tenant_id, user_id, kind, title, body, link)
           select ${tenantId}, user_id, ${kind}, ${title}, ${body}, ${link} from employees where id = ${employeeId} and user_id is not null`;
}

export async function placementOf(tx: Tx, employeeId: string) {
  const [p] = await tx<(Placement & { manager_id: string | null; status: string; display_name: string })[]>`
    select department_id, location_id, legal_entity_id, business_unit_id, manager_id, status, display_name from employees where id = ${employeeId}`;
  return p ?? null;
}

/** Asset admins whose scope covers this person (never the person themselves). */
export async function assetAdminsFor(tx: Tx, employeeId: string, p: Placement) {
  const rows = await tx<{ employee_id: string; permissions: string[]; scopes: Scope[] }[]>`
    select ra.employee_id, r.permissions, ra.scopes from role_assignments ra join roles r on r.id = ra.role_id
    join employees e on e.id = ra.employee_id and e.status <> 'relieved'
    where (${ASSETS_ADMIN} = any(r.permissions) or '*' = any(r.permissions)) and ra.employee_id <> ${employeeId}`;
  const ids = new Set<string>();
  for (const r of rows) {
    const fake = { grants: [{ permissions: r.permissions, scopes: r.scopes ?? [] }] } as unknown as Actor;
    if (canFor(fake, ASSETS_ADMIN, p)) ids.add(r.employee_id);
  }
  return [...ids];
}

/** Approval finished: record it; approved requests go to the asset admins to hand something over. Guarded on 'pending'. */
export async function onAssetRequestDecided(tx: Tx, actor: Actor, requestId: string, final: "approved" | "rejected") {
  const [r] = await tx<{ employee_id: string; type: string }[]>`
    update asset_requests q set status = ${final} from asset_types t where q.id = ${requestId} and q.status = 'pending' and t.id = q.type_id
    returning q.employee_id, t.name as type`;
  if (!r || final !== "approved") return;
  const p = await placementOf(tx, r.employee_id);
  if (!p) return;
  for (const id of await assetAdminsFor(tx, r.employee_id, p)) {
    await notify(tx, actor.tenant.id, id, "assets.request_approved", "Asset request to hand over", `${p.display_name} needs a ${r.type.toLowerCase()}`, "/org/assets?tab=requests");
  }
}
