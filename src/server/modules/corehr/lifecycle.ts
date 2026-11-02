import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { audit } from "@/server/modules/audit/service";
import { applyJobChange } from "@/server/modules/employees/profile";
import { notifyEmployee } from "@/server/modules/approvals/service";
import { addDaysISO, todayIn } from "@/lib/dates";
import { EVERYWHERE } from "./approvals-admin";
import { probationBucket } from "./rules";

/** Masters that define company structure: an unscoped settings.org grant. */
export const canEditStructure = (actor: Actor) => canFor(actor, "settings.org", EVERYWHERE);
const assertStructure = (actor: Actor) => { if (!canEditStructure(actor)) throw new AppError("forbidden", "You don't have access to company settings."); };
const unique = (e: unknown, msg: string, field = "name") => { if ((e as { code?: string }).code === "23505") throw new AppError("conflict", msg, field); throw e; };

// ---------------------------------------------------------------- groups

export type GroupTypeRow = { id: string; name: string; groups: { id: string; name: string; people: number }[] };

export async function listGroups(tx: Tx): Promise<GroupTypeRow[]> {
  const [types, groups] = await Promise.all([
    tx<{ id: string; name: string }[]>`select id, name from group_types order by name`,
    tx<{ id: string; name: string; group_type_id: string; people: number }[]>`
      select g.id, g.name, g.group_type_id, (select count(*)::int from employee_groups eg join employees e on e.id = eg.employee_id and e.status <> 'relieved' where eg.group_id = g.id) as people
      from groups g order by g.name`,
  ]);
  return types.map((t) => ({ ...t, groups: groups.filter((g) => g.group_type_id === t.id).map((g) => ({ id: g.id, name: g.name, people: g.people })) }));
}

export async function saveGroupType(tx: Tx, actor: Actor, id: string | null, name: string) {
  assertStructure(actor);
  const n = name.trim();
  if (!n || n.length > 80) throw new AppError("invalid", "Give the group type a name (up to 80 characters).", "name");
  try {
    if (id) {
      const [r] = await tx.savepoint((sp) => sp<{ id: string }[]>`update group_types set name = ${n} where id = ${id} returning id`);
      if (!r) throw new AppError("not_found", "That group type was deleted.");
    } else id = (await tx.savepoint((sp) => sp<{ id: string }[]>`insert into group_types (tenant_id, name) values (${actor.tenant.id}, ${n}) returning id`))[0].id;
  } catch (e) { if (e instanceof AppError) throw e; unique(e, "A group type with this name already exists."); }
  await audit(tx, actor, { entityType: "group_type", entityId: id, action: "save", diff: { name: n } });
  return { id: id! };
}

export async function deleteGroupType(tx: Tx, actor: Actor, id: string) {
  assertStructure(actor);
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from groups where group_type_id = ${id}`;
  if (n) throw new AppError("conflict", "Delete the groups inside it first.");
  const [r] = await tx<{ name: string }[]>`delete from group_types where id = ${id} returning name`;
  if (!r) throw new AppError("not_found", "That group type was already deleted.");
  await audit(tx, actor, { entityType: "group_type", entityId: id, action: "delete", diff: r });
}

export async function saveGroup(tx: Tx, actor: Actor, id: string | null, input: { typeId: string; name: string }) {
  assertStructure(actor);
  const n = input.name.trim();
  if (!n || n.length > 80) throw new AppError("invalid", "Give the group a name (up to 80 characters).", "name");
  const [t] = await tx`select 1 from group_types where id = ${input.typeId}`;
  if (!t) throw new AppError("invalid", "Pick a group type.", "typeId");
  try {
    if (id) {
      const [r] = await tx.savepoint((sp) => sp<{ id: string }[]>`update groups set name = ${n}, group_type_id = ${input.typeId} where id = ${id} returning id`);
      if (!r) throw new AppError("not_found", "That group was deleted.");
    } else id = (await tx.savepoint((sp) => sp<{ id: string }[]>`insert into groups (tenant_id, group_type_id, name) values (${actor.tenant.id}, ${input.typeId}, ${n}) returning id`))[0].id;
  } catch (e) { if (e instanceof AppError) throw e; unique(e, "This group type already has a group with this name."); }
  await audit(tx, actor, { entityType: "group", entityId: id, action: "save", diff: { name: n, typeId: input.typeId } });
  return { id: id! };
}

export async function deleteGroup(tx: Tx, actor: Actor, id: string) {
  assertStructure(actor);
  const [r] = await tx<{ name: string }[]>`delete from groups where id = ${id} returning name`;
  if (!r) throw new AppError("not_found", "That group was already deleted.");
  await audit(tx, actor, { entityType: "group", entityId: id, action: "delete", diff: r });
}

export async function groupMembers(tx: Tx, groupId: string) {
  return tx<{ id: string; name: string; title: string | null }[]>`
    select e.id, e.display_name as name, d.title from employee_groups eg join employees e on e.id = eg.employee_id left join designations d on d.id = e.designation_id
    where eg.group_id = ${groupId} and e.status <> 'relieved' order by e.display_name`;
}

/** Replace a group's members. People outside the actor's scope can't be added or removed. */
export async function setGroupMembers(tx: Tx, actor: Actor, groupId: string, employeeIds: string[]) {
  assertStructure(actor);
  const [g] = await tx`select 1 from groups where id = ${groupId}`;
  if (!g) throw new AppError("not_found", "That group was deleted.");
  const ids = [...new Set(employeeIds)].slice(0, 5000);
  const found = await tx<{ id: string }[]>`select id from employees where id = any(${ids}::uuid[]) and status <> 'relieved'`;
  if (found.length !== ids.length) throw new AppError("invalid", "Some of these people aren't in your company.");
  await tx`delete from employee_groups where group_id = ${groupId} and employee_id <> all(${ids}::uuid[])`;
  for (const id of ids) await tx`insert into employee_groups (tenant_id, employee_id, group_id) values (${actor.tenant.id}, ${id}, ${groupId}) on conflict do nothing`;
  await audit(tx, actor, { entityType: "group", entityId: groupId, action: "members", diff: { count: ids.length } });
  return { count: ids.length };
}

// ---------------------------------------------------------------- probation policies

export type ProbationPolicyRow = { id: string; name: string; duration_days: number; auto_confirm: boolean; people: number };
export async function listProbationPolicies(tx: Tx) {
  return tx<ProbationPolicyRow[]>`select p.id, p.name, p.duration_days, p.auto_confirm,
    (select count(*)::int from employees e where e.probation_policy_id = p.id and e.status <> 'relieved') as people from probation_policies p order by p.duration_days, p.name`;
}

export async function saveProbationPolicy(tx: Tx, actor: Actor, id: string | null, input: { name: string; durationDays: number; autoConfirm: boolean }) {
  assertStructure(actor);
  const name = input.name.trim();
  if (!name || name.length > 80) throw new AppError("invalid", "Give the policy a name.", "name");
  if (!Number.isInteger(input.durationDays) || input.durationDays < 0 || input.durationDays > 730) throw new AppError("invalid", "Probation can last 0 to 730 days.", "durationDays");
  const [dupe] = await tx`select 1 from probation_policies where lower(name) = lower(${name}) and id <> ${id ?? "00000000-0000-0000-0000-000000000000"}`;
  if (dupe) throw new AppError("conflict", "A probation policy with this name already exists.", "name");
  const row = { name, duration_days: input.durationDays, auto_confirm: !!input.autoConfirm };
  if (id) {
    const [r] = await tx<{ id: string }[]>`update probation_policies set ${tx(row)} where id = ${id} returning id`;
    if (!r) throw new AppError("not_found", "That policy was deleted.");
  } else id = (await tx<{ id: string }[]>`insert into probation_policies ${tx({ tenant_id: actor.tenant.id, ...row })} returning id`)[0].id;
  await audit(tx, actor, { entityType: "probation_policy", entityId: id, action: "save", diff: row });
  return { id };
}

export async function deleteProbationPolicy(tx: Tx, actor: Actor, id: string) {
  assertStructure(actor);
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from employees where probation_policy_id = ${id} and status <> 'relieved'`;
  if (n) throw new AppError("conflict", `${n} ${n === 1 ? "person uses" : "people use"} this policy.`);
  const [r] = await tx<{ name: string }[]>`delete from probation_policies where id = ${id} returning name`;
  if (!r) throw new AppError("not_found", "That policy was already deleted.");
  await audit(tx, actor, { entityType: "probation_policy", entityId: id, action: "delete", diff: r });
}

// ---------------------------------------------------------------- probation list + bulk actions

export type ProbationRow = {
  id: string; name: string; title: string | null; department: string | null; manager: string | null; joining_date: string; probation_end_date: string | null;
  probation_status: string; policy: string | null; auto_confirm: boolean; bucket: "overdue" | "due_soon" | "upcoming";
} & Placement;

/** People in probation that the actor manages (HR in scope, or their own reports). */
export async function probationList(tx: Tx, actor: Actor) {
  const today = todayIn();
  const rows = await tx<(Omit<ProbationRow, "bucket"> & { manager_id: string | null; l2_manager_id: string | null })[]>`
    select e.id, e.display_name as name, d.title, dp.name as department, m.display_name as manager, e.joining_date::text, e.probation_end_date::text, e.probation_status,
      p.name as policy, coalesce(p.auto_confirm, false) as auto_confirm, e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id, e.manager_id, e.l2_manager_id
    from employees e left join designations d on d.id = e.designation_id left join departments dp on dp.id = e.department_id
    left join employees m on m.id = e.manager_id left join probation_policies p on p.id = e.probation_policy_id
    where e.status in ('active','notice') and e.probation_status in ('in_probation','extended')
    order by e.probation_end_date nulls first, e.display_name`;
  return rows
    .filter((r) => r.id !== actor.employeeId && (canFor(actor, "employees.write", r) || r.manager_id === actor.employeeId || r.l2_manager_id === actor.employeeId))
    .map((r) => { const { manager_id, l2_manager_id, ...rest } = r; void manager_id; void l2_manager_id; return { ...rest, bucket: probationBucket(r.probation_end_date, today) }; });
}

/**
 * Confirm or extend several people at once. HR in scope or the person's (L2) manager; never one's own probation.
 * Each person is checked separately; the whole batch fails on the first person the actor can't act on.
 */
export async function bulkProbation(tx: Tx, actor: Actor, input: { employeeIds: string[]; action: "confirm" | "extend"; date?: string; extendDays?: number; note?: string }) {
  const ids = [...new Set(input.employeeIds)].slice(0, 500);
  if (!ids.length) throw new AppError("invalid", "Choose at least one person.");
  const today = todayIn();
  if (input.action === "extend" && !(input.extendDays && input.extendDays >= 1 && input.extendDays <= 365) && !input.date) throw new AppError("invalid", "Extend by 1 to 365 days, or pick a new end date.", "extendDays");
  if (input.action === "extend" && input.date && input.date <= today) throw new AppError("invalid", "The new end date has to be in the future.", "date");
  const confirmOn = input.action === "confirm" ? input.date ?? today : null;
  if (confirmOn && confirmOn > addDaysISO(today, 31)) throw new AppError("invalid", "Confirm today or within the next month.", "date");
  const people = await tx<(Placement & { id: string; display_name: string; probation_status: string; probation_end_date: string | null; manager_id: string | null; l2_manager_id: string | null; joining_date: string })[]>`
    select id, display_name, probation_status, probation_end_date::text, manager_id, l2_manager_id, joining_date::text, department_id, location_id, legal_entity_id, business_unit_id
    from employees where id = any(${ids}::uuid[]) and status in ('active','notice')`;
  if (people.length !== ids.length) throw new AppError("not_found", "Some of these people have left or aren't in your company.");
  for (const p of people) {
    if (p.id === actor.employeeId) throw new AppError("forbidden", "You can't confirm or extend your own probation.");
    if (!(canFor(actor, "employees.write", p) || p.manager_id === actor.employeeId || p.l2_manager_id === actor.employeeId)) throw new AppError("forbidden", `You can't update ${p.display_name}'s probation.`);
    if (p.probation_status !== "in_probation" && p.probation_status !== "extended") throw new AppError("invalid", `${p.display_name} isn't on probation.`);
    if (confirmOn && confirmOn < p.joining_date) throw new AppError("invalid", `${p.display_name} joined after that date.`, "date");
  }
  for (const p of people) {
    const until = input.action === "confirm" ? confirmOn! : input.date ?? addDaysISO(p.probation_end_date && p.probation_end_date > today ? p.probation_end_date : today, input.extendDays!);
    const status = input.action === "confirm" ? "confirmed" : "extended";
    await tx`update employees set probation_status = ${status}, probation_end_date = ${until} where id = ${p.id}`;
    await tx`insert into timeline_events (tenant_id, employee_id, kind, effective_date, data, actor_user_id)
             values (${actor.tenant.id}, ${p.id}, ${"probation_" + status}, ${input.action === "confirm" ? until : today}, ${tx.json({ until, note: input.note ?? null, bulk: true })}, ${actor.userId})`;
    await audit(tx, actor, { entityType: "employee", entityId: p.id, action: "probation", diff: { action: input.action, until, note: input.note ?? null, bulk: true } });
    await notifyEmployee(tx, actor.tenant.id, p.id, `probation.${status}`, input.action === "confirm" ? "Your probation is confirmed" : "Your probation was extended",
      input.action === "confirm" ? `Congratulations! You're confirmed from ${until}.` : `Your probation now ends on ${until}.`, `/people/${p.id}?tab=job`);
  }
  return { updated: people.length };
}

/**
 * Daily: people whose probation ended (end date before today) under a policy with auto-confirm are confirmed on their
 * end date. Idempotent (only rows still in probation change).
 */
export async function autoConfirmProbation(tx: Tx, tenantId: string, today = todayIn()) {
  const due = await tx<{ id: string; probation_end_date: string }[]>`
    update employees e set probation_status = 'confirmed' from probation_policies p
    where p.id = e.probation_policy_id and p.auto_confirm and e.status in ('active','notice')
      and e.probation_status in ('in_probation','extended') and e.probation_end_date < ${today}
    returning e.id, e.probation_end_date::text`;
  for (const d of due) {
    await tx`insert into timeline_events (tenant_id, employee_id, kind, effective_date, data) values (${tenantId}, ${d.id}, 'probation_confirmed', ${d.probation_end_date}, ${tx.json({ auto: true })})`;
    await audit(tx, { tenantId, userId: null }, { entityType: "employee", entityId: d.id, action: "probation.auto_confirm", diff: { on: d.probation_end_date } });
    await notifyEmployee(tx, tenantId, d.id, "probation.confirmed", "Your probation is confirmed", `You're confirmed from ${d.probation_end_date}.`, `/people/${d.id}?tab=job`);
  }
  // reminders for managers: probation ending in 7 days and nobody has decided yet (once: exactly 7 days ahead)
  const soon = await tx<{ id: string; name: string; manager_id: string | null }[]>`
    select e.id, e.display_name as name, e.manager_id from employees e left join probation_policies p on p.id = e.probation_policy_id
    where e.status = 'active' and e.probation_status in ('in_probation','extended') and not coalesce(p.auto_confirm, false) and e.probation_end_date = ${addDaysISO(today, 7)}`;
  for (const s of soon) if (s.manager_id) await notifyEmployee(tx, tenantId, s.manager_id, "probation.due", "Probation ending soon", `${s.name}'s probation ends in 7 days. Confirm or extend it.`, "/org/probation");
  return { confirmed: due.length, reminded: soon.length };
}

/**
 * Daily: applies job changes whose effective date has arrived (oldest first). Changes for someone who has since left
 * are cancelled instead. Idempotent: only rows still 'scheduled' are touched.
 */
export async function applyDueJobChanges(tx: Tx, tenantId: string, today = todayIn()) {
  const due = await tx<{ id: string; employee_status: string }[]>`
    select j.id, e.status as employee_status from job_changes j join employees e on e.id = j.employee_id
    where j.status = 'scheduled' and j.effective_date <= ${today} order by j.effective_date, j.created_at`;
  let applied = 0, cancelled = 0;
  for (const d of due) {
    if (d.employee_status === "relieved") {
      const r = await tx`update job_changes set status = 'cancelled' where id = ${d.id} and status = 'scheduled' returning id`;
      if (r.length) { cancelled++; await audit(tx, { tenantId, userId: null }, { entityType: "job_change", entityId: d.id, action: "job_change_cancelled", diff: { reason: "relieved" } }); }
      continue;
    }
    await applyJobChange(tx, d.id, null);
    applied++;
  }
  return { applied, cancelled };
}
