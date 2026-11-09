import "server-only";
import type { Tx } from "@/server/db";
import type { Actor, Tenant } from "./session";
import type { Scope } from "./catalog";

/**
 * An Actor for a person without a browser session: approving from Slack / Teams, writes through the public API on
 * someone's behalf. Same roles and grants as a signed-in session, built inside the tenant (RLS), so a stale or
 * foreign id finds nobody. Relieved people and disabled accounts get null.
 */
export async function actorForEmployee(tx: Tx, tenant: Tenant, employeeId: string): Promise<Actor | null> {
  const [row] = await tx<{ user_id: string; email: string; display_name: string; title: string | null }[]>`
    select u.id as user_id, u.email::text as email, e.display_name, d.title
    from employees e join users u on u.id = e.user_id and u.status = 'active' left join designations d on d.id = e.designation_id
    where e.id = ${employeeId} and e.status <> 'relieved'`;
  if (!row) return null;
  const roles = await tx<{ key: string; permissions: string[]; scopes: Scope[] }[]>`
    select r.key, r.permissions, ra.scopes from role_assignments ra join roles r on r.id = ra.role_id where ra.employee_id = ${employeeId}`;
  return {
    tenant, userId: row.user_id, employeeId, name: row.display_name, email: row.email, title: row.title,
    roles: roles.map((r) => r.key), permissions: new Set(roles.flatMap((r) => r.permissions)), grants: roles.map((r) => ({ permissions: r.permissions, scopes: r.scopes ?? [] })),
  };
}
