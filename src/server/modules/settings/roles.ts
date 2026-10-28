import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { assertCan } from "@/server/auth/permissions";
import { ALL_PERMISSION_KEYS, type Scope } from "@/server/auth/catalog";

export type RoleRow = { id: string; key: string; name: string; is_system: boolean; permissions: string[]; members: number };
export type Member = { assignment_id: string; employee_id: string; name: string; title: string | null; scopes: Scope[] };

export async function listRoles(tx: Tx) {
  return tx<RoleRow[]>`select r.id, r.key, r.name, r.is_system, r.permissions, (select count(*)::int from role_assignments a where a.role_id = r.id) as members from roles r order by r.is_system desc, r.name`;
}

export async function roleMembers(tx: Tx, roleId: string) {
  return tx<Member[]>`
    select a.id as assignment_id, e.id as employee_id, e.display_name as name, d.title, a.scopes
    from role_assignments a join employees e on e.id = a.employee_id left join designations d on d.id = e.designation_id
    where a.role_id = ${roleId} order by e.display_name`;
}

export async function saveRole(tx: Tx, actor: Actor, id: string | null, input: { name: string; permissions: string[] }) {
  assertCan(actor, "settings.roles");
  const name = input.name.trim();
  if (!name) throw new AppError("invalid", "Give the role a name.", "name");
  const perms = [...new Set(input.permissions.filter((p) => ALL_PERMISSION_KEYS.includes(p)))];
  if (id) {
    const [r] = await tx<{ is_system: boolean; key: string }[]>`select is_system, key from roles where id = ${id}`;
    if (!r) throw new AppError("not_found", "Role not found.");
    if (r.key === "global_admin") throw new AppError("invalid", "The Global admin role always has every permission.");
    await tx`update roles set name = ${name}, permissions = ${perms} where id = ${id}`;
  } else {
    const key = "custom_" + name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
    try {
      const [r] = await tx<{ id: string }[]>`insert into roles (tenant_id, key, name, is_system, permissions) values (${actor.tenant.id}, ${key}, ${name}, false, ${perms}) returning id`;
      id = r.id;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new AppError("conflict", "A role with this name already exists.", "name");
      throw e;
    }
  }
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${actor.tenant.id}, ${actor.userId}, 'role', ${id}, 'save', ${tx.json({ name, permissions: perms })})`;
  return { id };
}

export async function deleteRole(tx: Tx, actor: Actor, id: string) {
  assertCan(actor, "settings.roles");
  const [r] = await tx<{ is_system: boolean }[]>`select is_system from roles where id = ${id}`;
  if (!r) throw new AppError("not_found", "Role not found.");
  if (r.is_system) throw new AppError("invalid", "Built-in roles can't be deleted.");
  await tx`delete from roles where id = ${id}`;
}

export async function assign(tx: Tx, actor: Actor, roleId: string, employeeId: string, scopes: Scope[]) {
  assertCan(actor, "settings.roles");
  const clean = scopes.filter((s) => s.ids.length > 0);
  await tx`insert into role_assignments (tenant_id, role_id, employee_id, scopes) values (${actor.tenant.id}, ${roleId}, ${employeeId}, ${tx.json(clean as never)})
           on conflict (role_id, employee_id) do update set scopes = excluded.scopes`;
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${actor.tenant.id}, ${actor.userId}, 'role', ${roleId}, 'assign', ${tx.json({ employeeId, scopes: clean } as never)})`;
}

export async function unassign(tx: Tx, actor: Actor, assignmentId: string) {
  assertCan(actor, "settings.roles");
  const [a] = await tx<{ key: string; employee_id: string; role_id: string }[]>`select r.key, a.employee_id, a.role_id from role_assignments a join roles r on r.id = a.role_id where a.id = ${assignmentId}`;
  if (!a) return;
  if (a.key === "global_admin") {
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from role_assignments where role_id = ${a.role_id}`;
    if (n <= 1) throw new AppError("invalid", "There must always be at least one Global admin.");
  }
  await tx`delete from role_assignments where id = ${assignmentId}`;
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${actor.tenant.id}, ${actor.userId}, 'role', ${a.role_id}, 'unassign', ${tx.json({ employeeId: a.employee_id })})`;
}
