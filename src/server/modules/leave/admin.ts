import "server-only";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { z } from "zod";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { notifyEmployee, type Level } from "@/server/modules/approvals/service";
import { todayIn, type ISODate } from "@/lib/dates";
import { cycleStart, parseBalance, round2 } from "./accrual-rules";
import { assertLeaveAdmin, canAdminLeaveFor, hasAnyLeaveAdmin } from "./access";
import { runAccrual } from "./accrual";
import { cycleStartFor } from "./effects";

const audit = (tx: Tx, actor: Actor, entity: string, id: string | null, action: string, diff?: unknown) =>
  tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff)
     values (${actor.tenant.id}, ${actor.userId}, ${entity}, ${id}, ${action}, ${diff === undefined ? null : tx.json(diff as never)})`;

/** Runs one statement in a savepoint so an expected unique violation becomes a friendly error without aborting the transaction. */
const unique = async <T>(tx: Tx, fn: (sp: Tx) => PromiseLike<T>, message: string, field?: string): Promise<T> => {
  try { return (await tx.savepoint((sp) => fn(sp as unknown as Tx) as Promise<T>)) as T; } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new AppError("conflict", message, field);
    throw e;
  }
};

// ---------------------------------------------------------------- leave types

export const KINDS = ["regular", "incident", "comp_off", "unpaid"] as const;
const colour = z.string().regex(/^(#[0-9a-fA-F]{6}|var\(--chart-[1-8]\))$/, "Pick a colour");
export const leaveTypeInput = z.object({
  name: z.string().trim().min(1, "Enter a name").max(60),
  code: z.string().trim().min(1, "Enter a short code").max(8).regex(/^[A-Za-z0-9_-]+$/, "Letters and numbers only").transform((s) => s.toUpperCase()),
  kind: z.enum(KINDS),
  paid: z.boolean(),
  color: colour,
});

export type LeaveTypeRow = { id: string; name: string; code: string; kind: (typeof KINDS)[number]; is_paid: boolean; color: string; plans: number; used: boolean };

export async function listTypes(tx: Tx) {
  return tx<LeaveTypeRow[]>`
    select t.id, t.name, t.code, t.kind, t.is_paid, t.color,
      (select count(*)::int from leave_plan_rules r where r.leave_type_id = t.id) as plans,
      (exists (select 1 from leave_requests q where q.leave_type_id = t.id) or exists (select 1 from leave_ledger l where l.leave_type_id = t.id)) as used
    from leave_types t order by t.kind = 'unpaid', t.name`;
}

export async function saveType(tx: Tx, actor: Actor, id: string | null, raw: unknown) {
  assertLeaveAdmin(actor);
  const p = leaveTypeInput.safeParse(raw);
  if (!p.success) throw new AppError("invalid", p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
  const v = p.data;
  if (v.kind === "unpaid" && v.paid) throw new AppError("invalid", "Unpaid leave can't be marked as paid.", "paid");
  if (!id) {
    const [r] = await unique(tx, (sp) => sp<{ id: string }[]>`
      insert into leave_types (tenant_id, name, code, kind, is_paid, color) values (${actor.tenant.id}, ${v.name}, ${v.code}, ${v.kind}, ${v.paid}, ${v.color}) returning id`,
    "Another leave type already uses this code.", "code");
    await audit(tx, actor, "leave_type", r.id, "create", v);
    return { id: r.id };
  }
  const [cur] = await tx<{ kind: string }[]>`select kind from leave_types where id = ${id}`;
  if (!cur) throw new AppError("not_found", "Leave type not found.");
  if (cur.kind !== v.kind) {
    const [used] = await tx`select 1 from leave_ledger where leave_type_id = ${id} union all select 1 from leave_requests where leave_type_id = ${id} limit 1`;
    if (used) throw new AppError("invalid", "This leave type has been used, so its kind can't change. Create a new type instead.", "kind");
  }
  await unique(tx, (sp) => sp`update leave_types set name = ${v.name}, code = ${v.code}, kind = ${v.kind}, is_paid = ${v.paid}, color = ${v.color}, updated_at = now() where id = ${id}`,
    "Another leave type already uses this code.", "code");
  await audit(tx, actor, "leave_type", id, "update", v);
  return { id };
}

export async function deleteType(tx: Tx, actor: Actor, id: string) {
  assertLeaveAdmin(actor);
  const [t] = await tx<{ plans: number; used: boolean }[]>`
    select (select count(*)::int from leave_plan_rules where leave_type_id = ${id}) as plans,
           (exists (select 1 from leave_requests where leave_type_id = ${id}) or exists (select 1 from leave_ledger where leave_type_id = ${id})) as used
    from leave_types where id = ${id}`;
  if (!t) throw new AppError("not_found", "Leave type not found.");
  if (t.plans) throw new AppError("invalid", "Remove this leave type from every leave plan first.");
  if (t.used) throw new AppError("invalid", "This leave type has requests or balances, so it can't be deleted.");
  await tx`delete from leave_types where id = ${id}`;
  await audit(tx, actor, "leave_type", id, "delete");
}

// ---------------------------------------------------------------- leave plans

export type PlanRow = { id: string; name: string; description: string | null; year_start: "jan" | "apr" | "joining_date"; is_default: boolean; people: number; types: number };

export async function listPlans(tx: Tx) {
  return tx<PlanRow[]>`
    select p.id, p.name, p.description, p.year_start, p.is_default,
      (select count(*)::int from employees e where e.leave_plan_id = p.id and e.status <> 'relieved') as people,
      (select count(*)::int from leave_plan_rules r where r.leave_plan_id = p.id) as types
    from leave_plans p order by p.is_default desc, p.name`;
}

const planInput = z.object({
  name: z.string().trim().min(1, "Enter a name").max(80),
  description: z.string().trim().max(500).optional().nullable(),
  yearStart: z.enum(["jan", "apr", "joining_date"]).optional(),
  isDefault: z.boolean().optional(),
});

export async function savePlan(tx: Tx, actor: Actor, id: string | null, raw: unknown) {
  assertLeaveAdmin(actor);
  const p = planInput.safeParse(raw);
  if (!p.success) throw new AppError("invalid", p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
  const v = p.data;
  if (v.isDefault) await tx`update leave_plans set is_default = false where is_default and id is distinct from ${id}`;
  if (!id) {
    if (!v.yearStart) throw new AppError("invalid", "Choose when the leave year starts.", "yearStart");
    const yearStart = v.yearStart;
    const [r] = await unique(tx, (sp) => sp<{ id: string }[]>`
      insert into leave_plans (tenant_id, name, description, year_start, is_default) values (${actor.tenant.id}, ${v.name}, ${v.description || null}, ${yearStart}, ${!!v.isDefault}) returning id`,
    "A leave plan with this name already exists.", "name");
    await audit(tx, actor, "leave_plan", r.id, "create", v);
    return { id: r.id };
  }
  const [cur] = await tx<{ year_start: string; is_default: boolean }[]>`select year_start, is_default from leave_plans where id = ${id}`;
  if (!cur) throw new AppError("not_found", "Leave plan not found.");
  if (v.yearStart && v.yearStart !== cur.year_start) throw new AppError("invalid", "The leave year can't change after a plan is created. Create a new plan instead.", "yearStart");
  if (cur.is_default && v.isDefault === false) throw new AppError("invalid", "Make another plan the default first; new joiners need one.", "isDefault");
  await unique(tx, (sp) => sp`update leave_plans set name = ${v.name}, description = ${v.description || null}, is_default = ${v.isDefault ?? cur.is_default}, updated_at = now() where id = ${id}`,
    "A leave plan with this name already exists.", "name");
  await audit(tx, actor, "leave_plan", id, "update", v);
  return { id };
}

export async function deletePlan(tx: Tx, actor: Actor, id: string) {
  assertLeaveAdmin(actor);
  const [p] = await tx<{ is_default: boolean; people: number }[]>`
    select is_default, (select count(*)::int from employees where leave_plan_id = ${id}) as people from leave_plans where id = ${id}`;
  if (!p) throw new AppError("not_found", "Leave plan not found.");
  if (p.is_default) throw new AppError("invalid", "The default plan can't be deleted. Make another plan the default first.");
  if (p.people) throw new AppError("invalid", `${p.people} ${p.people === 1 ? "person is" : "people are"} on this plan. Move them to another plan first.`);
  await tx`delete from leave_plans where id = ${id}`;
  await audit(tx, actor, "leave_plan", id, "delete");
}

// ---------------------------------------------------------------- plan rules

const num = (max: number) => z.number().min(0).max(max);
const levelSchema = z.object({ approver: z.enum(["manager", "l2_manager", "role", "employee"]), role: z.string().max(40).optional(), id: z.uuid().optional() });
export const ruleInput = z.object({
  quota: z.number().min(0).max(365).nullable(),
  accrual: z.object({
    frequency: z.enum(["monthly", "quarterly", "half_yearly", "yearly", "upfront"]),
    day: z.number().int().min(1).max(28),
    prorate_joining: z.boolean(),
    stop_in_probation: z.boolean(),
  }),
  application: z.object({
    allowHalfDay: z.boolean(),
    noticeDays: num(365).optional(),
    backdateDays: num(365).nullable(),
    maxConsecutiveDays: num(365).optional(),
    negativeLimit: num(365).optional(),
    attachmentAfterDays: num(365).optional(),
    sandwich: z.object({ enabled: z.boolean(), ignoreHalfDays: z.boolean().optional() }),
    compOffExpiryDays: num(730).optional(),
    compOffWindowDays: num(365).optional(),
  }),
  year_end: z.object({ carry: z.enum(["none", "all", "upto"]), carry_max: num(365).optional(), encash_max: num(365).optional() }),
  approval: z.object({ auto: z.boolean().optional(), levels: z.array(levelSchema).max(5).optional() }),
});
export type RuleInput = z.infer<typeof ruleInput>;

export type PlanRule = {
  id: string; leave_type_id: string; name: string; code: string; kind: string; color: string; is_paid: boolean;
  yearly_quota: string | null; accrual: Record<string, unknown>; application: Record<string, unknown>; year_end: Record<string, unknown>; approval: { auto?: boolean; levels?: Level[] };
};

export async function planDetail(tx: Tx, planId: string) {
  const [plan] = await tx<PlanRow[]>`
    select p.id, p.name, p.description, p.year_start, p.is_default,
      (select count(*)::int from employees e where e.leave_plan_id = p.id and e.status <> 'relieved') as people,
      (select count(*)::int from leave_plan_rules r where r.leave_plan_id = p.id) as types
    from leave_plans p where p.id = ${planId}`;
  if (!plan) return null;
  const [rules, members] = await Promise.all([
    tx<PlanRule[]>`
      select r.id, r.leave_type_id, t.name, t.code, t.kind, t.color, t.is_paid, r.yearly_quota, r.accrual, r.application, r.year_end, r.approval
      from leave_plan_rules r join leave_types t on t.id = r.leave_type_id where r.leave_plan_id = ${planId} order by t.kind = 'unpaid', t.name`,
    tx<{ id: string; name: string; title: string | null; department: string | null }[]>`
      select e.id, e.display_name as name, d.title, dp.name as department from employees e
      left join designations d on d.id = e.designation_id left join departments dp on dp.id = e.department_id
      where e.leave_plan_id = ${planId} and e.status <> 'relieved' order by e.display_name`,
  ]);
  return { plan, rules, members };
}

/** Sensible starting rules for a type added to a plan. */
function defaultRule(kind: string): RuleInput {
  return {
    quota: kind === "unpaid" || kind === "comp_off" ? null : kind === "incident" ? 3 : 12,
    accrual: { frequency: kind === "incident" ? "upfront" : "monthly", day: 1, prorate_joining: true, stop_in_probation: false },
    application: { allowHalfDay: kind !== "incident", backdateDays: 7, sandwich: { enabled: false }, ...(kind === "comp_off" ? { compOffExpiryDays: 60, compOffWindowDays: 30 } : {}) },
    year_end: { carry: "none" },
    approval: {},
  };
}

export async function addTypeToPlan(tx: Tx, actor: Actor, planId: string, typeId: string) {
  assertLeaveAdmin(actor);
  const [t] = await tx<{ kind: string }[]>`select kind from leave_types where id = ${typeId}`;
  if (!t) throw new AppError("not_found", "Leave type not found.");
  const r = defaultRule(t.kind);
  const [row] = await unique(tx, (sp) => sp<{ id: string }[]>`
    insert into leave_plan_rules (tenant_id, leave_plan_id, leave_type_id, yearly_quota, accrual, application, year_end, approval)
    values (${actor.tenant.id}, ${planId}, ${typeId}, ${r.quota}, ${tx.json(r.accrual)}, ${tx.json(r.application as never)}, ${tx.json(r.year_end)}, ${tx.json(r.approval)}) returning id`,
  "This leave type is already in the plan.");
  await audit(tx, actor, "leave_plan", planId, "rule.add", { typeId });
  return { id: row.id };
}

export async function saveRule(tx: Tx, actor: Actor, ruleId: string, raw: unknown) {
  assertLeaveAdmin(actor);
  const p = ruleInput.safeParse(raw);
  if (!p.success) throw new AppError("invalid", `Check “${p.error.issues[0].path.join(" ")}”: ${p.error.issues[0].message}`);
  const v = p.data;
  const [cur] = await tx<{ leave_plan_id: string; kind: string }[]>`
    select r.leave_plan_id, t.kind from leave_plan_rules r join leave_types t on t.id = r.leave_type_id where r.id = ${ruleId}`;
  if (!cur) throw new AppError("not_found", "Rule not found.");
  if (cur.kind === "comp_off" && v.quota != null) throw new AppError("invalid", "Comp-off is earned by working off days, so it has no yearly quota.", "quota");
  if (v.year_end.carry === "upto" && v.year_end.carry_max == null) throw new AppError("invalid", "Enter how many days can carry forward.", "carry_max");
  const levels = v.approval.levels?.filter((l) => l.approver !== "employee" || l.id);
  for (const l of levels ?? []) if (l.approver === "role" && !l.role) throw new AppError("invalid", "Choose a role for each role approval level.");
  await tx`update leave_plan_rules set yearly_quota = ${v.quota}, accrual = ${tx.json(v.accrual)}, application = ${tx.json(v.application as never)},
             year_end = ${tx.json(v.year_end)}, approval = ${tx.json({ auto: !!v.approval.auto, levels: levels ?? [] } as never)}, updated_at = now()
           where id = ${ruleId}`;
  await audit(tx, actor, "leave_plan", cur.leave_plan_id, "rule.update", { ruleId, ...v });
  return { planId: cur.leave_plan_id };
}

export async function removeRule(tx: Tx, actor: Actor, ruleId: string) {
  assertLeaveAdmin(actor);
  const [r] = await tx<{ leave_plan_id: string; leave_type_id: string }[]>`delete from leave_plan_rules where id = ${ruleId} returning leave_plan_id, leave_type_id`;
  if (!r) throw new AppError("not_found", "Rule not found.");
  await audit(tx, actor, "leave_plan", r.leave_plan_id, "rule.remove", { typeId: r.leave_type_id });
}

type PlacedPerson = { id: string; name: string; department_id: string | null; location_id: string | null; legal_entity_id: string | null; business_unit_id: string | null };

async function placed(tx: Tx, ids: string[]) {
  return tx<PlacedPerson[]>`select id, display_name as name, department_id, location_id, legal_entity_id, business_unit_id from employees where id = any(${ids}::uuid[]) and status <> 'relieved'`;
}

/** Moves people onto a plan (bulk) and credits whatever the new plan has due for them today. Scoped admins: their people only. */
export async function assignPlan(tx: Tx, actor: Actor, planId: string, employeeIds: string[]) {
  const [plan] = await tx<{ id: string; name: string }[]>`select id, name from leave_plans where id = ${planId}`;
  if (!plan) throw new AppError("not_found", "Leave plan not found.");
  const people = await placed(tx, [...new Set(employeeIds)]);
  if (!people.length) throw new AppError("invalid", "Choose who to move to this plan.");
  const outside = people.filter((p) => !canAdminLeaveFor(actor, p));
  if (outside.length) throw new AppError("forbidden", `You can't change the leave plan for ${outside.map((p) => p.name).join(", ")}.`);
  await tx`update employees set leave_plan_id = ${planId}, updated_at = now() where id = any(${people.map((p) => p.id)}::uuid[])`;
  await audit(tx, actor, "leave_plan", planId, "assign", { employeeIds: people.map((p) => p.id) });
  await runAccrual(tx, actor.tenant.id, todayIn(), { employeeIds: people.map((p) => p.id), actorUserId: actor.userId });
  return { moved: people.length };
}

// ---------------------------------------------------------------- balances admin

export type BalanceCell = { typeId: string; available: number | null; credited: number; used: number; pending: number };
export type BalanceRow = { id: string; name: string; number: string; department: string | null; plan: string | null; cycleStart: string | null; cells: BalanceCell[] };

/** Everyone the actor may administer, with this leave year's balance per type in their plan. */
export async function balanceTable(tx: Tx, actor: Actor, q?: string, asOf: ISODate = todayIn()) {
  if (!hasAnyLeaveAdmin(actor)) throw new AppError("forbidden", "You don't have access to leave balances.");
  const term = q?.trim() ? `%${q.trim().replace(/[\\%_]/g, (c) => "\\" + c)}%` : null;
  const people = await tx<(PlacedPerson & { number: string; department: string | null; plan: string | null; plan_id: string | null; year_start: string | null; joining_date: string })[]>`
    select e.id, e.display_name as name, e.employee_number as number, e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id,
           dp.name as department, p.name as plan, p.id as plan_id, p.year_start, e.joining_date::text
    from employees e left join departments dp on dp.id = e.department_id left join leave_plans p on p.id = e.leave_plan_id
    where e.status <> 'relieved' and (${term}::text is null or e.display_name ilike ${term} or e.employee_number ilike ${term} or e.work_email ilike ${term})
    order by e.display_name limit 500`;
  const mine = people.filter((p) => canAdminLeaveFor(actor, p));
  const types = await tx<{ id: string; name: string; code: string; color: string; kind: string }[]>`
    select distinct t.id, t.name, t.code, t.color, t.kind from leave_types t join leave_plan_rules r on r.leave_type_id = t.id order by t.name`;
  if (!mine.length) return { types, rows: [] as BalanceRow[] };
  const ids = mine.map((p) => p.id);
  const [rules, sums, pend] = await Promise.all([
    tx<{ leave_plan_id: string; leave_type_id: string; unlimited: boolean }[]>`
      select r.leave_plan_id, r.leave_type_id, (r.yearly_quota is null and t.kind <> 'comp_off') as unlimited
      from leave_plan_rules r join leave_types t on t.id = r.leave_type_id`,
    tx<{ employee_id: string; leave_type_id: string; cycle_start: string; credited: string; used: string }[]>`
      select employee_id, leave_type_id, cycle_start::text,
        coalesce(sum(amount) filter (where kind not in ('use','use_reversal','penalty')), 0) as credited,
        coalesce(-sum(amount) filter (where kind in ('use','use_reversal','penalty')), 0) as used
      from leave_ledger where employee_id = any(${ids}::uuid[]) group by 1, 2, 3`,
    tx<{ employee_id: string; leave_type_id: string; days: string }[]>`
      select employee_id, leave_type_id, sum(days) as days from leave_requests where employee_id = any(${ids}::uuid[]) and status = 'pending' group by 1, 2`,
  ]);
  const rows: BalanceRow[] = mine.map((p) => {
    const c = p.year_start ? cycleStart(p.year_start, p.joining_date, asOf) : null;
    const cells = rules.filter((r) => r.leave_plan_id === p.plan_id).map((r) => {
      const s = sums.find((x) => x.employee_id === p.id && x.leave_type_id === r.leave_type_id && x.cycle_start === c);
      const credited = Number(s?.credited ?? 0), used = Number(s?.used ?? 0);
      const pending = Number(pend.find((x) => x.employee_id === p.id && x.leave_type_id === r.leave_type_id)?.days ?? 0);
      return { typeId: r.leave_type_id, credited, used, pending, available: r.unlimited ? null : round2(credited - used - pending) };
    });
    return { id: p.id, name: p.name, number: p.number, department: p.department, plan: p.plan, cycleStart: c, cells };
  });
  return { types, rows };
}

export type LedgerEntry = { id: string; entry_date: string; kind: string; amount: string; note: string | null; type: string; color: string; by: string | null; created_at: Date };

/** Every balance change for one person in a leave year: the audit trail behind the numbers. */
export async function ledgerFor(tx: Tx, actor: Actor, employeeId: string, asOf: ISODate = todayIn()) {
  const [p] = await placed(tx, [employeeId]);
  if (!p) throw new AppError("not_found", "Person not found.");
  if (!canAdminLeaveFor(actor, p) && actor.employeeId !== employeeId) throw new AppError("forbidden", "You don't have access to this person's leave.");
  const [e] = await tx<{ year_start: string | null; joining_date: string }[]>`
    select p.year_start, e.joining_date::text from employees e left join leave_plans p on p.id = e.leave_plan_id where e.id = ${employeeId}`;
  const c = cycleStart(e.year_start ?? "jan", e.joining_date, asOf);
  const entries = await tx<LedgerEntry[]>`
    select l.id, l.entry_date::text, l.kind, l.amount, l.note, t.name as type, t.color, u.email as by, l.created_at
    from leave_ledger l join leave_types t on t.id = l.leave_type_id left join users u on u.id = l.created_by
    where l.employee_id = ${employeeId} and l.cycle_start = ${c} order by l.entry_date desc, l.created_at desc limit 300`;
  return { cycleStart: c, entries };
}

const adjustInput = z.object({
  employeeId: z.uuid(), leaveTypeId: z.uuid(),
  amount: z.number().refine((n) => n !== 0 && Math.abs(n) <= 365 && Math.abs(Math.round(n * 100) - n * 100) < 1e-6, "Enter days to add or remove, like 2 or -1.5"),
  reason: z.string().trim().min(3, "Say why, so the change is traceable").max(300),
});

/** Manual credit (+) or debit (−) with a reason: ledger 'adjust', audit log, and a heads-up to the person. */
export async function adjustBalance(tx: Tx, actor: Actor, raw: unknown) {
  const parsed = adjustInput.safeParse(raw);
  if (!parsed.success) throw new AppError("invalid", parsed.error.issues[0].message, String(parsed.error.issues[0].path[0] ?? ""));
  const v = parsed.data;
  const [p] = await placed(tx, [v.employeeId]);
  if (!p) throw new AppError("not_found", "Person not found.");
  if (!canAdminLeaveFor(actor, p)) throw new AppError("forbidden", "You can't adjust leave for this person.");
  const [t] = await tx<{ name: string }[]>`
    select t.name from employees e join leave_plan_rules r on r.leave_plan_id = e.leave_plan_id join leave_types t on t.id = r.leave_type_id
    where e.id = ${v.employeeId} and t.id = ${v.leaveTypeId}`;
  if (!t) throw new AppError("invalid", "This leave type isn't in the person's leave plan.", "leaveTypeId");
  const today = todayIn();
  const cycle = await cycleStartFor(tx, v.employeeId, today);
  const [row] = await tx<{ id: string }[]>`
    insert into leave_ledger (tenant_id, employee_id, leave_type_id, cycle_start, entry_date, kind, amount, ref_type, note, idempotency_key, created_by)
    values (${actor.tenant.id}, ${v.employeeId}, ${v.leaveTypeId}, ${cycle}, ${today}, 'adjust', ${v.amount}, 'manual', ${v.reason}, ${`adjust:${randomUUID()}`}, ${actor.userId})
    returning id`;
  await audit(tx, actor, "employee", v.employeeId, "leave.adjust", { leaveTypeId: v.leaveTypeId, type: t.name, amount: v.amount, reason: v.reason, ledgerId: row.id });
  const days = `${Math.abs(v.amount)} ${Math.abs(v.amount) === 1 ? "day" : "days"}`;
  await notifyEmployee(tx, actor.tenant.id, v.employeeId, "leave.adjusted", "Your leave balance changed",
    `${v.amount > 0 ? "Added" : "Removed"} ${days} of ${t.name}: ${v.reason}`, "/me/leave");
  return { id: row.id };
}

// ---------------------------------------------------------------- opening balances import

const IMPORT_HEADERS = ["Employee number", "Name", "Leave type code", "Balance"] as const;
const MAX_BYTES = 5 * 1024 * 1024, MAX_ROWS = 5000;

export async function buildBalanceTemplate(tx: Tx, actor: Actor) {
  const t = await balanceTable(tx, actor);
  const wb = new ExcelJS.Workbook();
  wb.creator = "erp";
  const ws = wb.addWorksheet("Balances", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [{ header: "Employee number *", width: 18 }, { header: "Name", width: 28 }, { header: "Leave type code *", width: 18 }, { header: "Balance *", width: 12 }];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAF0FE" } };
  for (const r of t.rows) for (const c of r.cells) {
    if (c.available == null) continue;
    const type = t.types.find((x) => x.id === c.typeId)!;
    ws.addRow([r.number, r.name, type.code, round2(c.available + c.pending)]);
  }
  const help = wb.addWorksheet("How to fill");
  help.getColumn(1).width = 110;
  [
    "One row per person and leave type. The file comes pre-filled with today's balances (pending requests not deducted).",
    "Change the Balance column to the number of days the person should have right now in this leave year, e.g. 7 or 4.5.",
    "erp records the difference as an opening balance entry, so importing the same file twice changes nothing.",
    "Leave type codes: " + t.types.map((x) => `${x.code} = ${x.name}`).join(", ") + ".",
    "The Name column is only there to help you; erp matches people by employee number.",
  ].forEach((s, i) => (help.getCell(i + 1, 1).value = s));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export type BalanceImportResult = { rowNumber: number; employee: string; name: string | null; type: string; balance: number | null; current: number | null; change: number | null; errors: string[] };

async function checkBalanceImport(tx: Tx, actor: Actor, bytes: ArrayBuffer) {
  if (!hasAnyLeaveAdmin(actor)) throw new AppError("forbidden", "You don't have access to leave balances.");
  if (bytes.byteLength > MAX_BYTES) throw new AppError("invalid", "The file is larger than 5 MB.");
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(bytes); } catch { throw new AppError("invalid", "This isn't an Excel (.xlsx) file erp can read. Download the template and fill that in."); }
  const ws = wb.getWorksheet("Balances") ?? wb.worksheets[0];
  if (!ws) throw new AppError("invalid", "The file has no sheets.");
  const norm = (s: unknown) => String((s as { text?: string })?.text ?? s ?? "").replace(/\*/g, "").trim().toLowerCase();
  const col = new Map<string, number>();
  ws.getRow(1).eachCell((c, i) => { const h = IMPORT_HEADERS.find((x) => x.toLowerCase() === norm(c.value)); if (h) col.set(h, i); });
  const missing = IMPORT_HEADERS.filter((h) => h !== "Name" && !col.has(h));
  if (missing.length) throw new AppError("invalid", `Missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Use the erp template.`);
  const raw: { rowNumber: number; employee: string; type: string; balance: unknown }[] = [];
  ws.eachRow({ includeEmpty: false }, (r, n) => {
    if (n === 1) return;
    const cell = (h: string) => { const v = r.getCell(col.get(h)!).value; return (v as { result?: unknown })?.result ?? v; };
    raw.push({ rowNumber: n, employee: String(cell("Employee number") ?? "").trim(), type: String(cell("Leave type code") ?? "").trim().toUpperCase(), balance: cell("Balance") });
  });
  if (!raw.length) throw new AppError("invalid", "The file has no rows to import.");
  if (raw.length > MAX_ROWS) throw new AppError("invalid", `Up to ${MAX_ROWS} rows per file.`);
  const table = await balanceTable(tx, actor);
  const [all] = await Promise.all([tx<{ id: string; number: string; name: string }[]>`select id, employee_number as number, display_name as name from employees where status <> 'relieved'`]);
  const seen = new Set<string>();
  const results: (BalanceImportResult & { employeeId?: string; typeId?: string })[] = raw.map((r) => {
    const errors: string[] = [];
    const emp = all.find((e) => e.number.toLowerCase() === r.employee.toLowerCase());
    const row = emp && table.rows.find((x) => x.id === emp.id);
    const type = table.types.find((t) => t.code.toUpperCase() === r.type);
    const cell = row && type ? row.cells.find((c) => c.typeId === type.id) : undefined;
    const balance = parseBalance(r.balance);
    if (!r.employee) errors.push("Employee number is empty.");
    else if (!emp) errors.push(`No one has employee number ${r.employee}.`);
    else if (!row) errors.push(`You can't change leave for ${emp.name}.`);
    if (!r.type) errors.push("Leave type code is empty.");
    else if (!type) errors.push(`Unknown leave type code ${r.type}.`);
    else if (row && !cell) errors.push(`${r.type} isn't in ${emp!.name}'s leave plan.`);
    else if (cell && cell.available == null) errors.push(`${type.name} has no limit, so there's no balance to set.`);
    if (balance == null) errors.push("Balance must be a number of days, like 7 or 4.5.");
    const k = `${emp?.id}|${type?.id}`;
    if (emp && type && seen.has(k)) errors.push("This person and leave type appear on an earlier row too.");
    seen.add(k);
    const current = cell && cell.available != null ? round2(cell.credited - cell.used) : null;
    return { rowNumber: r.rowNumber, employee: r.employee, name: emp?.name ?? null, type: r.type, balance, current,
      change: balance != null && current != null ? round2(balance - current) : null, errors, employeeId: emp?.id, typeId: type?.id };
  });
  return { results, valid: results.every((r) => !r.errors.length) };
}

export async function previewBalanceImport(tx: Tx, actor: Actor, bytes: ArrayBuffer) {
  const { results, valid } = await checkBalanceImport(tx, actor, bytes);
  return { valid, total: results.length, ok: results.filter((r) => !r.errors.length).length, changes: results.filter((r) => !r.errors.length && r.change).length,
    results: results.map((r) => ({ rowNumber: r.rowNumber, employee: r.employee, name: r.name, type: r.type, balance: r.balance, current: r.current, change: r.change, errors: r.errors })) };
}

/** All or nothing. Each changed row posts the difference as an 'opening' entry for this leave year. */
export async function commitBalanceImport(tx: Tx, actor: Actor, bytes: ArrayBuffer) {
  const { results, valid } = await checkBalanceImport(tx, actor, bytes);
  if (!valid) throw new AppError("invalid", "Some rows have problems. Fix them and upload the file again.");
  const today = todayIn();
  const batch = randomUUID();
  let changed = 0;
  for (const r of results) {
    if (!r.change) continue;
    const cycle = await cycleStartFor(tx, r.employeeId!, today);
    await tx`insert into leave_ledger (tenant_id, employee_id, leave_type_id, cycle_start, entry_date, kind, amount, ref_type, note, idempotency_key, created_by)
             values (${actor.tenant.id}, ${r.employeeId!}, ${r.typeId!}, ${cycle}, ${today}, 'opening', ${r.change}, 'import', ${`Opening balance import: set to ${r.balance}`},
                     ${`import:${batch}:${r.rowNumber}`}, ${actor.userId})`;
    changed++;
  }
  await audit(tx, actor, "leave_ledger", null, "leave.import", { batch, rows: results.length, changed });
  return { changed, rows: results.length };
}
