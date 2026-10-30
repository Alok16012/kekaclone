import "server-only";
import { z } from "zod";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { audit } from "@/server/modules/audit/service";
import { assertPayrollAdmin } from "./access";
import { analyseStructure, CALCS, COMPONENT_KINDS, computeBreakup, FREQUENCIES, PAYABLE_BASES, RESERVED_CODES, STRUCTURE_KINDS, type ComponentKind, type StructureDef } from "./rules";
import { parseDecimal } from "./formula";

const invalid = (e: z.ZodError) => new AppError("invalid", e.issues[0].message, String(e.issues[0].path[0] ?? ""));
const unique = async <T>(tx: Tx, fn: (sp: Tx) => PromiseLike<T>, message: string, field?: string): Promise<T> => {
  try { return (await tx.savepoint((sp) => fn(sp as unknown as Tx) as Promise<T>)) as T; } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new AppError("conflict", message, field);
    throw e;
  }
};

// ---------------------------------------------------------------- components

export type ComponentRow = {
  id: string; code: string; name: string; kind: ComponentKind; is_taxable: boolean; tax_section: string | null; lop_prorated: boolean;
  frequency: (typeof FREQUENCIES)[number]; on_payslip: boolean; in_arrears: boolean; pf_wage: boolean; esi_wage: boolean; structures: number; used: boolean;
};

export async function listComponents(tx: Tx) {
  return tx<ComponentRow[]>`
    select c.id, c.code, c.name, c.kind, c.is_taxable, c.tax_section, c.lop_prorated, c.frequency, c.on_payslip, c.in_arrears, c.pf_wage, c.esi_wage,
      (select count(*)::int from salary_structure_lines l where l.component_id = c.id) as structures,
      exists (select 1 from employee_salaries s where s.breakup ? c.code) as used
    from salary_components c
    order by array_position(${[...COMPONENT_KINDS]}::text[], c.kind), c.code`;
}

export const componentInput = z.object({
  name: z.string().trim().min(1, "Enter a name").max(80),
  code: z.string().trim().transform((s) => s.toUpperCase()).pipe(z.string().regex(/^[A-Z][A-Z0-9_]{1,30}$/, "Codes are 2–31 capital letters, digits or _, starting with a letter, like BASIC")),
  kind: z.enum(COMPONENT_KINDS),
  taxable: z.boolean(),
  taxSection: z.string().trim().max(40).nullable().optional(),
  lopProrated: z.boolean(),
  frequency: z.enum(FREQUENCIES),
  onPayslip: z.boolean(),
  inArrears: z.boolean(),
  pfWage: z.boolean(),
  esiWage: z.boolean(),
});

export async function saveComponent(tx: Tx, actor: Actor, id: string | null, raw: unknown) {
  assertPayrollAdmin(actor);
  const p = componentInput.safeParse(raw);
  if (!p.success) throw invalid(p.error);
  const v = p.data;
  if ((RESERVED_CODES as readonly string[]).includes(v.code)) throw new AppError("invalid", `${v.code} is reserved for formulas. Pick another code.`, "code");
  const taxSection = v.taxable ? null : v.taxSection || null;   // a section only explains why something is exempt
  if (!id) {
    const [r] = await unique(tx, (sp) => sp<{ id: string }[]>`
      insert into salary_components (tenant_id, code, name, kind, is_taxable, tax_section, lop_prorated, frequency, on_payslip, in_arrears, pf_wage, esi_wage)
      values (${actor.tenant.id}, ${v.code}, ${v.name}, ${v.kind}, ${v.taxable}, ${taxSection}, ${v.lopProrated}, ${v.frequency}, ${v.onPayslip}, ${v.inArrears}, ${v.pfWage}, ${v.esiWage})
      returning id`, "Another component already uses this code.", "code");
    await audit(tx, actor, { entityType: "salary_component", entityId: r.id, action: "create", diff: v });
    return { id: r.id };
  }
  const [cur] = await tx<{ code: string; kind: ComponentKind; structures: number; used: boolean }[]>`
    select code, kind, (select count(*)::int from salary_structure_lines where component_id = c.id) as structures,
      exists (select 1 from employee_salaries s where s.breakup ? c.code) as used
    from salary_components c where id = ${id}`;
  if (!cur) throw new AppError("not_found", "Component not found.");
  const inUse = cur.structures > 0 || cur.used;
  if (inUse && cur.code !== v.code) throw new AppError("invalid", "This component is on a structure or someone's salary, so its code can't change (formulas and salary history use it).", "code");
  if (inUse && cur.kind !== v.kind) throw new AppError("invalid", "This component is already in use, so its type can't change. Create a new component instead.", "kind");
  await unique(tx, (sp) => sp`
    update salary_components set code = ${v.code}, name = ${v.name}, kind = ${v.kind}, is_taxable = ${v.taxable}, tax_section = ${taxSection},
      lop_prorated = ${v.lopProrated}, frequency = ${v.frequency}, on_payslip = ${v.onPayslip}, in_arrears = ${v.inArrears},
      pf_wage = ${v.pfWage}, esi_wage = ${v.esiWage}, updated_at = now()
    where id = ${id}`, "Another component already uses this code.", "code");
  await audit(tx, actor, { entityType: "salary_component", entityId: id, action: "update", diff: v });
  return { id };
}

export async function deleteComponent(tx: Tx, actor: Actor, id: string) {
  assertPayrollAdmin(actor);
  const [c] = await tx<{ code: string; structures: number; used: boolean }[]>`
    select code, (select count(*)::int from salary_structure_lines where component_id = c.id) as structures,
      exists (select 1 from employee_salaries s where s.breakup ? c.code) or exists (select 1 from payroll_inputs i where i.component_id = c.id) as used
    from salary_components c where id = ${id}`;
  if (!c) throw new AppError("not_found", "Component not found.");
  if (c.structures) throw new AppError("invalid", "Remove this component from every salary structure first.");
  if (c.used) throw new AppError("invalid", "People's salaries or payroll use this component, so it can't be deleted.");
  await tx`delete from salary_components where id = ${id}`;
  await audit(tx, actor, { entityType: "salary_component", entityId: id, action: "delete", diff: { code: c.code } });
}

// ---------------------------------------------------------------- pay groups

export type PayGroupRow = {
  id: string; name: string; legal_entity_id: string; legal_entity: string; cycle: "monthly"; attendance_cutoff_day: number;
  payable_days_basis: (typeof PAYABLE_BASES)[number]; people: number; structures: number;
};

export async function listPayGroups(tx: Tx) {
  return tx<PayGroupRow[]>`
    select g.id, g.name, g.legal_entity_id, le.name as legal_entity, g.cycle, g.attendance_cutoff_day, g.payable_days_basis,
      (select count(*)::int from employees e where e.pay_group_id = g.id and e.status <> 'relieved') as people,
      (select count(*)::int from salary_structures s where s.pay_group_id = g.id) as structures
    from pay_groups g join legal_entities le on le.id = g.legal_entity_id order by g.name`;
}

const payGroupInput = z.object({
  name: z.string().trim().min(1, "Enter a name").max(80),
  legalEntityId: z.uuid("Pick a legal entity"),
  cutoffDay: z.number().int("Pick a day from 1 to 31").min(1, "Pick a day from 1 to 31").max(31, "Pick a day from 1 to 31"),
  payableDaysBasis: z.enum(PAYABLE_BASES),
});

export async function savePayGroup(tx: Tx, actor: Actor, id: string | null, raw: unknown) {
  assertPayrollAdmin(actor);
  const p = payGroupInput.safeParse(raw);
  if (!p.success) throw invalid(p.error);
  const v = p.data;
  const [le] = await tx`select 1 from legal_entities where id = ${v.legalEntityId}`;
  if (!le) throw new AppError("invalid", "Pick a legal entity.", "legalEntityId");
  if (!id) {
    const [r] = await unique(tx, (sp) => sp<{ id: string }[]>`
      insert into pay_groups (tenant_id, legal_entity_id, name, attendance_cutoff_day, payable_days_basis)
      values (${actor.tenant.id}, ${v.legalEntityId}, ${v.name}, ${v.cutoffDay}, ${v.payableDaysBasis}) returning id`,
    "A pay group with this name already exists.", "name");
    await audit(tx, actor, { entityType: "pay_group", entityId: r.id, action: "create", diff: v });
    return { id: r.id };
  }
  const [cur] = await tx<{ legal_entity_id: string; people: number }[]>`
    select legal_entity_id, (select count(*)::int from employees e where e.pay_group_id = g.id and e.status <> 'relieved') as people from pay_groups g where id = ${id}`;
  if (!cur) throw new AppError("not_found", "Pay group not found.");
  if (cur.legal_entity_id !== v.legalEntityId && cur.people) throw new AppError("invalid", "People are in this pay group, so its legal entity can't change. Move them out first.", "legalEntityId");
  await unique(tx, (sp) => sp`update pay_groups set name = ${v.name}, legal_entity_id = ${v.legalEntityId}, attendance_cutoff_day = ${v.cutoffDay},
    payable_days_basis = ${v.payableDaysBasis}, updated_at = now() where id = ${id}`, "A pay group with this name already exists.", "name");
  await audit(tx, actor, { entityType: "pay_group", entityId: id, action: "update", diff: v });
  return { id };
}

export async function deletePayGroup(tx: Tx, actor: Actor, id: string) {
  assertPayrollAdmin(actor);
  const [g] = await tx<{ people: number; salaries: number; runs: number }[]>`
    select (select count(*)::int from employees e where e.pay_group_id = g.id) as people,
      (select count(*)::int from employee_salaries s join salary_structures st on st.id = s.structure_id where st.pay_group_id = g.id) as salaries,
      (select count(*)::int from payroll_runs r where r.pay_group_id = g.id) as runs
    from pay_groups g where id = ${id}`;
  if (!g) throw new AppError("not_found", "Pay group not found.");
  if (g.people) throw new AppError("invalid", "Move everyone out of this pay group first.");
  if (g.salaries || g.runs) throw new AppError("invalid", "Salaries or payroll runs use this pay group, so it can't be deleted.");
  await tx`delete from pay_groups where id = ${id}`;
  await audit(tx, actor, { entityType: "pay_group", entityId: id, action: "delete" });
}

export async function payGroupPeople(tx: Tx, actor: Actor, id: string) {
  assertPayrollAdmin(actor);
  return tx<{ id: string; name: string; number: string; department: string | null; in_group: boolean; other_group: string | null; entity_ok: boolean }[]>`
    select e.id, e.display_name as name, e.employee_number as number, d.name as department, e.pay_group_id = ${id} as in_group,
      case when e.pay_group_id is not null and e.pay_group_id <> ${id} then (select name from pay_groups where id = e.pay_group_id) end as other_group,
      (e.legal_entity_id is null or e.legal_entity_id = (select legal_entity_id from pay_groups where id = ${id})) as entity_ok
    from employees e left join departments d on d.id = e.department_id
    where e.status <> 'relieved' order by e.display_name`;
}

/** Put people in a pay group. Their current salary stays as it is until it's revised on one of this group's structures. */
export async function assignPayGroup(tx: Tx, actor: Actor, id: string, employeeIds: string[]) {
  assertPayrollAdmin(actor);
  const [g] = await tx<{ legal_entity_id: string; name: string }[]>`select legal_entity_id, name from pay_groups where id = ${id}`;
  if (!g) throw new AppError("not_found", "Pay group not found.");
  const people = await tx<{ id: string; display_name: string; legal_entity_id: string | null; status: string }[]>`
    select id, display_name, legal_entity_id, status from employees where id = any(${employeeIds}::uuid[])`;
  if (people.length !== new Set(employeeIds).size) throw new AppError("invalid", "Some of these people weren't found.");
  const wrong = people.find((p) => p.legal_entity_id && p.legal_entity_id !== g.legal_entity_id);
  if (wrong) throw new AppError("invalid", `${wrong.display_name} works for a different legal entity than ${g.name}.`);
  const gone = people.find((p) => p.status === "relieved");
  if (gone) throw new AppError("invalid", `${gone.display_name} has left the company.`);
  const moved = await tx`update employees set pay_group_id = ${id}, updated_at = now() where id = any(${employeeIds}::uuid[]) and pay_group_id is distinct from ${id} returning id`;
  await audit(tx, actor, { entityType: "pay_group", entityId: id, action: "pay_group.assign", diff: { employeeIds, moved: moved.length } });
  return { moved: moved.length };
}

// ---------------------------------------------------------------- structures

export type StructureLineRow = { id: string; component_id: string; code: string; name: string; kind: ComponentKind; calc: (typeof CALCS)[number]; value: string | null; formula: string | null; position: number };
export type StructureRow = { id: string; name: string; pay_group_id: string; pay_group: string; lines: StructureLineRow[]; people: number };

export async function listStructures(tx: Tx, payGroupId?: string) {
  const rows = await tx<Omit<StructureRow, "lines">[]>`
    select s.id, s.name, s.pay_group_id, g.name as pay_group,
      (select count(distinct es.employee_id)::int from employee_salaries es where es.structure_id = s.id and es.status = 'active') as people
    from salary_structures s join pay_groups g on g.id = s.pay_group_id
    where ${payGroupId ?? null}::uuid is null or s.pay_group_id = ${payGroupId ?? null}
    order by g.name, s.name`;
  const lines = rows.length ? await linesFor(tx, rows.map((r) => r.id)) : [];
  return rows.map((r) => ({ ...r, lines: lines.filter((l) => l.structure_id === r.id).map(stripLine) })) as StructureRow[];
}

const stripLine = (l: StructureLineRow & { structure_id: string }): StructureLineRow =>
  ({ id: l.id, component_id: l.component_id, code: l.code, name: l.name, kind: l.kind, calc: l.calc, value: l.value, formula: l.formula, position: l.position });

async function linesFor(tx: Tx, ids: string[]) {
  return tx<(StructureLineRow & { structure_id: string })[]>`
    select l.id, l.structure_id, l.component_id, c.code, c.name, c.kind, l.calc, l.value::text as value, l.formula, l.position
    from salary_structure_lines l join salary_components c on c.id = l.component_id
    where l.structure_id = any(${ids}::uuid[]) order by l.position, c.code`;
}

export async function getStructure(tx: Tx, id: string) {
  const [s] = await tx<Omit<StructureRow, "lines" | "people">[]>`
    select s.id, s.name, s.pay_group_id, g.name as pay_group from salary_structures s join pay_groups g on g.id = s.pay_group_id where s.id = ${id}`;
  if (!s) return null;
  return { ...s, lines: (await linesFor(tx, [id])).map(stripLine) };
}

/** A structure as the formula engine wants it. */
export const toDef = (lines: Pick<StructureLineRow, "code" | "name" | "kind" | "calc" | "value" | "formula">[]): StructureDef =>
  ({ lines: lines.map((l) => ({ code: l.code, name: l.name, kind: l.kind, calc: l.calc, value: l.value, formula: l.formula })) });

const lineInput = z.object({
  componentId: z.uuid("Pick a component"),
  calc: z.enum(CALCS),
  value: z.string().trim().max(24).nullable().optional(),
  formula: z.string().trim().max(500).nullable().optional(),
});
const structureInput = z.object({
  name: z.string().trim().min(1, "Enter a name").max(80),
  payGroupId: z.uuid("Pick a pay group"),
  lines: z.array(lineInput).max(40, "Up to 40 components per structure"),
});

/** Create or replace a structure (its lines are saved as a whole). Refuses anything the formula engine can't evaluate. */
export async function saveStructure(tx: Tx, actor: Actor, id: string | null, raw: unknown) {
  assertPayrollAdmin(actor);
  const p = structureInput.safeParse(raw);
  if (!p.success) throw invalid(p.error);
  const v = p.data;
  const [g] = await tx`select 1 from pay_groups where id = ${v.payGroupId}`;
  if (!g) throw new AppError("invalid", "Pick a pay group.", "payGroupId");
  const comps = await tx<{ id: string; code: string; name: string; kind: ComponentKind }[]>`select id, code, name, kind from salary_components where id = any(${v.lines.map((l) => l.componentId)}::uuid[])`;
  const lines = v.lines.map((l) => {
    const c = comps.find((x) => x.id === l.componentId);
    if (!c) throw new AppError("invalid", "One of the components no longer exists.", "lines");
    if (!STRUCTURE_KINDS.includes(c.kind)) throw new AppError("invalid", `${c.name} is a ${c.kind.replace(/_/g, " ")}; only earnings, reimbursables and employer contributions belong on a structure.`, "lines");
    const value = l.calc === "flat" || l.calc === "pct_ctc" || l.calc === "pct_gross" ? (l.value ?? "").replace(/,/g, "") : null;
    if (value !== null && !parseDecimal(value)) throw new AppError("invalid", `${c.name}: enter a number.`, "lines");
    return { ...c, calc: l.calc, value, formula: l.calc === "formula" ? l.formula ?? "" : null };
  });
  const { issues } = analyseStructure(toDef(lines));
  if (issues.length) throw new AppError("invalid", issues[0].message, "lines");
  const sample = computeBreakup(toDef(lines), 12_00_000_00);   // sanity check (e.g. division by zero) at ₹12 lakh
  if (!sample.ok && sample.errors.some((e) => /Division by zero/.test(e.message))) throw new AppError("invalid", sample.errors[0].message, "lines");

  let sid = id;
  if (!sid) {
    const [r] = await unique(tx, (sp) => sp<{ id: string }[]>`insert into salary_structures (tenant_id, pay_group_id, name) values (${actor.tenant.id}, ${v.payGroupId}, ${v.name}) returning id`,
      "This pay group already has a structure with this name.", "name");
    sid = r.id;
  } else {
    const [cur] = await tx<{ pay_group_id: string; salaries: number }[]>`select pay_group_id, (select count(*)::int from employee_salaries where structure_id = s.id) as salaries from salary_structures s where id = ${sid}`;
    if (!cur) throw new AppError("not_found", "Structure not found.");
    if (cur.pay_group_id !== v.payGroupId && cur.salaries) throw new AppError("invalid", "Salaries use this structure, so it can't move to another pay group.", "payGroupId");
    await unique(tx, (sp) => sp`update salary_structures set name = ${v.name}, pay_group_id = ${v.payGroupId}, updated_at = now() where id = ${sid}`,
      "This pay group already has a structure with this name.", "name");
    await tx`delete from salary_structure_lines where structure_id = ${sid}`;
  }
  for (const [i, l] of lines.entries()) {
    await tx`insert into salary_structure_lines (tenant_id, structure_id, component_id, calc, value, formula, position)
             values (${actor.tenant.id}, ${sid}, ${l.id}, ${l.calc}, ${l.value}, ${l.formula}, ${i})`;
  }
  await audit(tx, actor, { entityType: "salary_structure", entityId: sid, action: id ? "update" : "create", diff: { name: v.name, lines: lines.map((l) => ({ code: l.code, calc: l.calc, value: l.value, formula: l.formula })) } });
  return { id: sid };
}

export async function deleteStructure(tx: Tx, actor: Actor, id: string) {
  assertPayrollAdmin(actor);
  const [s] = await tx<{ salaries: number }[]>`select (select count(*)::int from employee_salaries where structure_id = s.id) as salaries from salary_structures s where id = ${id}`;
  if (!s) throw new AppError("not_found", "Structure not found.");
  if (s.salaries) throw new AppError("invalid", "People's salaries use this structure, so it can't be deleted.");
  await tx`delete from salary_structures where id = ${id}`;
  await audit(tx, actor, { entityType: "salary_structure", entityId: id, action: "delete" });
}

// ---------------------------------------------------------------- statutory sign-off
// The CA sign-off lives in the statutory module (statutory_verifications, fingerprinted against the whole
// rates table); payroll screens read it through verificationStatus() from "@/server/modules/statutory/service".
