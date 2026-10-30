import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { assertCan } from "@/server/auth/permissions";

/** Company structure masters. One config per kind keeps the CRUD generic and the column names whitelisted. */
export const MASTERS = {
  departments: { table: "departments", nameCol: "name", label: "Department", employeeCol: "department_id" },
  designations: { table: "designations", nameCol: "title", label: "Designation", employeeCol: "designation_id" },
  locations: { table: "locations", nameCol: "name", label: "Location", employeeCol: "location_id" },
  legal_entities: { table: "legal_entities", nameCol: "name", label: "Legal entity", employeeCol: "legal_entity_id" },
  business_units: { table: "business_units", nameCol: "name", label: "Business unit", employeeCol: "business_unit_id" },
  bands: { table: "bands", nameCol: "name", label: "Band", employeeCol: "band_id" },
} as const;
export type MasterKind = keyof typeof MASTERS;
export const isMaster = (k: string): k is MasterKind => k in MASTERS;

export type MasterRow = { id: string; name: string; people: number; parent_id?: string | null; head?: string | null; head_id?: string | null; state_code?: string | null };

export async function listMaster(tx: Tx, kind: MasterKind): Promise<MasterRow[]> {
  const m = MASTERS[kind];
  if (kind === "departments") {
    return tx<MasterRow[]>`
      select d.id, d.name, d.parent_id, d.head_employee_id as head_id, h.display_name as head,
        (select count(*)::int from employees e where e.department_id = d.id and e.status <> 'relieved') as people
      from departments d left join employees h on h.id = d.head_employee_id order by d.name`;
  }
  if (kind === "locations") {
    return tx<MasterRow[]>`select l.id, l.name, l.state_code, (select count(*)::int from employees e where e.location_id = l.id and e.status <> 'relieved') as people from locations l order by l.name`;
  }
  return tx<MasterRow[]>`
    select t.id, t.${tx(m.nameCol)} as name, (select count(*)::int from employees e where e.${tx(m.employeeCol)} = t.id and e.status <> 'relieved') as people
    from ${tx(m.table)} t order by 2`;
}

export type MasterInput = { name: string; parentId?: string | null; headId?: string | null; stateCode?: string | null };

export async function saveMaster(tx: Tx, actor: Actor, kind: MasterKind, id: string | null, input: MasterInput) {
  assertCan(actor, "settings.org");
  const m = MASTERS[kind];
  const name = input.name.trim();
  if (!name) throw new AppError("invalid", `Enter a ${m.label.toLowerCase()} name.`, "name");
  if (name.length > 120) throw new AppError("invalid", "Keep the name under 120 characters.", "name");
  const extra: Record<string, unknown> = {};
  if (kind === "departments") {
    if (input.parentId && input.parentId === id) throw new AppError("invalid", "A department can't sit under itself.", "parentId");
    if (input.parentId && id) {
      const [loop] = await tx<{ loop: boolean }[]>`with recursive up as (select id, parent_id, 1 d from departments where id = ${input.parentId}
        union all select x.id, x.parent_id, up.d + 1 from departments x join up on x.id = up.parent_id where up.d < 50) select exists(select 1 from up where id = ${id}) as loop`;
      if (loop.loop) throw new AppError("invalid", "That parent is inside this department already.", "parentId");
    }
    extra.parent_id = input.parentId ?? null;
    extra.head_employee_id = input.headId ?? null;
  }
  if (kind === "locations") extra.state_code = input.stateCode?.trim().toUpperCase() || null;
  const row = { [m.nameCol]: name, ...extra } as Record<string, never>;
  try {
    if (id) {
      const cols = Object.keys(row);
      const [before] = await tx<Record<string, unknown>[]>`select ${tx(cols)} from ${tx(m.table)} where id = ${id}`;
      if (!before) throw new AppError("not_found", `${m.label} not found.`);
      await tx`update ${tx(m.table)} set ${tx(row)} where id = ${id}`;
      const diff = Object.fromEntries(cols.filter((c) => (before[c] ?? null) !== ((row as Record<string, unknown>)[c] ?? null))
        .map((c) => [c === m.nameCol ? "name" : c, { old: before[c] ?? null, new: (row as Record<string, unknown>)[c] ?? null }]));
      if (Object.keys(diff).length) await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${actor.tenant.id}, ${actor.userId}, ${kind}, ${id}, 'update', ${tx.json(diff as never)})`;
      return { id };
    }
    const [r] = await tx<{ id: string }[]>`insert into ${tx(m.table)} ${tx({ tenant_id: actor.tenant.id, ...row } as unknown as Record<string, never>)} returning id`;
    await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${actor.tenant.id}, ${actor.userId}, ${kind}, ${r.id}, 'create', ${tx.json({ name })})`;
    return { id: r.id };
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new AppError("conflict", `A ${m.label.toLowerCase()} with this name already exists.`, "name");
    throw e;
  }
}

export async function deleteMaster(tx: Tx, actor: Actor, kind: MasterKind, id: string) {
  assertCan(actor, "settings.org");
  const m = MASTERS[kind];
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from employees where ${tx(m.employeeCol)} = ${id}`;
  const [cur] = await tx<{ name: string }[]>`select ${tx(m.nameCol)} as name from ${tx(m.table)} where id = ${id}`;
  if (n > 0) throw new AppError("conflict", `${n} ${n === 1 ? "person is" : "people are"} still assigned here. Move them first.`);
  try {
    await tx`delete from ${tx(m.table)} where id = ${id}`;
  } catch (e) {
    if ((e as { code?: string }).code === "23503") throw new AppError("conflict", `This ${m.label.toLowerCase()} is still used elsewhere (e.g. as a parent or in a policy).`);
    throw e;
  }
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${actor.tenant.id}, ${actor.userId}, ${kind}, ${id}, 'delete', ${cur ? tx.json({ name: cur.name }) : null})`;
}
