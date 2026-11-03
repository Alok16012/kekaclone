import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";

export const PERF = "performance.admin";
export const COMP = "compensation.admin";
export const EVERYWHERE: Placement = { department_id: null, location_id: null, legal_entity_id: null, business_unit_id: null };

/** Company-wide performance setup (settings, skills library, cycles, publishing) needs performance.admin with no scope. */
export const isPerfAdmin = (actor: Actor) => canFor(actor, PERF, EVERYWHERE);
export function assertPerfAdmin(actor: Actor) {
  if (!isPerfAdmin(actor)) throw new AppError("forbidden", "Only performance admins for the whole company can do this.");
}
/** performance.admin covering this person (scoped grants count). */
export const perfAdminFor = (actor: Actor, p: Placement) => canFor(actor, PERF, p);
export const hasAnywhere = (actor: Actor, permission: string) => (actor.grants ?? []).some((g) => g.permissions.includes("*") || g.permissions.includes(permission));
export const hasAnyPerf = (actor: Actor) => hasAnywhere(actor, PERF);

export const isCompAdmin = (actor: Actor) => canFor(actor, COMP, EVERYWHERE);
export function assertCompAdmin(actor: Actor) {
  if (!isCompAdmin(actor)) throw new AppError("forbidden", "Only compensation admins for the whole company can do this.");
}

export type PersonRow = Placement & { id: string; display_name: string; first_name: string; manager_id: string | null; l2_manager_id: string | null; status: string; joining_date: string; probation_end_date: string | null; user_id: string | null };

export async function personRow(tx: Tx, id: string): Promise<PersonRow> {
  const [p] = await tx<PersonRow[]>`
    select id, display_name, first_name, manager_id, l2_manager_id, status, joining_date::text, probation_end_date::text, user_id,
      department_id, location_id, legal_entity_id, business_unit_id
    from employees where id = ${id}`;
  if (!p) throw new AppError("not_found", "Person not found.");
  return p;
}

/** Everyone who reports to `managerId`, directly or through others. */
export async function reportIds(tx: Tx, managerId: string): Promise<string[]> {
  const rows = await tx<{ id: string }[]>`
    with recursive r as (
      select id from employees where manager_id = ${managerId} and status <> 'relieved'
      union select e.id from employees e join r on e.manager_id = r.id where e.status <> 'relieved'
    ) select id from r`;
  return rows.map((r) => r.id);
}
export async function directReportIds(tx: Tx, managerId: string): Promise<string[]> {
  return (await tx<{ id: string }[]>`select id from employees where manager_id = ${managerId} and status <> 'relieved'`).map((r) => r.id);
}

/** True when `managerId` sits anywhere above `employeeId` in the reporting line. */
export async function isAbove(tx: Tx, managerId: string, employeeId: string) {
  if (managerId === employeeId) return false;
  const [r] = await tx<{ ok: boolean }[]>`
    with recursive up as (
      select manager_id as id, 1 as depth from employees where id = ${employeeId}
      union all select e.manager_id, up.depth + 1 from employees e join up on e.id = up.id where up.depth < 50
    ) select exists (select 1 from up where id = ${managerId}) as ok`;
  return !!r?.ok;
}

/**
 * Who may look after this person's goals, 1:1 notes and reviews: their managers (any level up) or a performance admin covering them.
 * Never grants rights over yourself (callers decide what self may do).
 */
export async function oversees(tx: Tx, actor: Actor, employeeId: string) {
  if (employeeId === actor.employeeId) return false;
  const p = await personRow(tx, employeeId);
  if (perfAdminFor(actor, p)) return true;
  return isAbove(tx, actor.employeeId, employeeId);
}

/** Everyone working here, for people pickers. */
export async function peopleOptions(tx: Tx) {
  return tx<{ id: string; name: string; title: string | null; department: string | null }[]>`
    select e.id, e.display_name as name, g.title, d.name as department from employees e
    left join designations g on g.id = e.designation_id left join departments d on d.id = e.department_id
    where e.status in ('active','notice') order by e.display_name`;
}
