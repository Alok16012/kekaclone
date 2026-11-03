import "server-only";
import { z } from "zod";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { audit } from "@/server/modules/audit/service";
import { notifyEmployee } from "@/server/modules/approvals/service";
import { emitWebhook } from "@/server/modules/integrations/service";
import { verificationStatus } from "@/server/modules/statutory/service";
import { todayIn } from "@/lib/dates";
import { assertNotSelf, assertRollback, assertRunPayroll } from "./access";
import { bumpVersion, computeRun, getRun, type RunRow, type StepState } from "./engine";
import {
  addMonths, attendanceWindows, isLockedStatus, isMonth, LINE_ACTIONS, monthLabel, monthStart, slipped, STEPS, variancePct,
  type LineAction, type PayItem, type StatutoryDetail, type StepKey,
} from "./rules";

const N = (v: bigint | number | string | null | undefined) => (v == null ? 0 : Number(v));
const OPEN = ["draft", "in_progress"];

async function unique<T>(tx: Tx, fn: (sp: Tx) => PromiseLike<T>, message: string): Promise<T> {
  try { return (await tx.savepoint((sp) => fn(sp as unknown as Tx) as Promise<T>)) as T; } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new AppError("conflict", message);
    throw e;
  }
}

// ---------------------------------------------------------------- home

export type GroupCard = {
  id: string; name: string; legalEntity: string; people: number; cutoff: number;
  openMonth: string; run: { id: string; status: string; month: string; net: number; headcount: number } | null;
  canStart: boolean; lastLocked: string | null;
  trend: { month: string; cost: number; net: number }[];
};

/** Which month a pay group works on next: the open run's, else the month after the last finalised one, else this month. */
function nextMonthFor(runs: { period_month: string; status: string }[], today: string) {
  const live = runs.filter((r) => r.status !== "rolled_back");
  const open = live.find((r) => OPEN.includes(r.status));
  if (open) return open.period_month;
  const locked = live.filter((r) => isLockedStatus(r.status)).map((r) => r.period_month).sort().reverse()[0];
  return locked ? addMonths(locked, 1) : monthStart(today);
}

export async function payrollHome(tx: Tx, actor: Actor, today = todayIn()) {
  assertRunPayroll(actor);
  const groups = await tx<{ id: string; name: string; legal_entity: string; people: number; cutoff: number }[]>`
    select g.id, g.name, le.name as legal_entity, g.attendance_cutoff_day as cutoff,
      (select count(*)::int from employees e where e.pay_group_id = g.id and e.status <> 'relieved') as people
    from pay_groups g join legal_entities le on le.id = g.legal_entity_id order by g.name`;
  const runs = await tx<{ id: string; pay_group_id: string; period_month: string; status: string; totals: { net?: number; cost?: number; headcount?: number } }[]>`
    select id, pay_group_id, period_month::text, status, totals from payroll_runs order by period_month desc, created_at desc`;
  const cards: GroupCard[] = groups.map((g) => {
    const mine = runs.filter((r) => r.pay_group_id === g.id);
    const openMonth = nextMonthFor(mine, today);
    const run = mine.find((r) => r.period_month === openMonth && r.status !== "rolled_back") ?? null;
    const locked = mine.filter((r) => isLockedStatus(r.status));
    return {
      id: g.id, name: g.name, legalEntity: g.legal_entity, people: g.people, cutoff: g.cutoff, openMonth,
      run: run ? { id: run.id, status: run.status, month: run.period_month, net: N(run.totals?.net), headcount: N(run.totals?.headcount) } : null,
      canStart: !run && openMonth <= addMonths(monthStart(today), 1),
      lastLocked: locked[0]?.period_month ?? null,
      trend: locked.slice(0, 6).reverse().map((r) => ({ month: r.period_month, cost: N(r.totals?.cost), net: N(r.totals?.net) })),
    };
  });
  const recent = await tx<{ id: string; pay_group: string; period_month: string; status: string; totals: { net?: number; headcount?: number }; updated_at: Date }[]>`
    select r.id, g.name as pay_group, r.period_month::text, r.status, r.totals, r.updated_at from payroll_runs r join pay_groups g on g.id = r.pay_group_id
    order by r.period_month desc, r.updated_at desc limit 12`;
  const [{ fnf }] = await tx<{ fnf: number }[]>`
    select count(*)::int as fnf from exit_requests x where x.status in ('in_progress','exited')
      and not exists (select 1 from fnf_settlements s where s.exit_request_id = x.id and s.status = 'finalized')`;
  return { cards, recent: recent.map((r) => ({ ...r, net: N(r.totals?.net), headcount: N(r.totals?.headcount), updated_at: r.updated_at.toISOString() })), fnfPending: fnf, verification: await verificationStatus(tx) };
}

// ---------------------------------------------------------------- create

/** Start a run for a pay group and month. One live run per pay group and month (enforced by a unique index). */
export async function createRun(tx: Tx, actor: Actor, payGroupId: string, month: string, today = todayIn()) {
  assertRunPayroll(actor);
  if (!isMonth(month)) throw new AppError("invalid", "Pick a month.", "month");
  const [g] = await tx<{ id: string; name: string }[]>`select id, name from pay_groups where id = ${payGroupId}`;
  if (!g) throw new AppError("not_found", "Pay group not found.");
  await tx`select pg_advisory_xact_lock(hashtext(${"payrun:" + payGroupId}))`;
  const runs = await tx<{ id: string; period_month: string; status: string }[]>`select id, period_month::text, status from payroll_runs where pay_group_id = ${payGroupId}`;
  const live = runs.filter((r) => r.status !== "rolled_back");
  const same = live.find((r) => r.period_month === month);
  if (same) throw new AppError("conflict", `${g.name} already has a run for ${monthLabel(month)}.`);
  const open = live.find((r) => OPEN.includes(r.status));
  if (open) throw new AppError("conflict", `Finish or roll back the ${monthLabel(open.period_month)} run for ${g.name} first.`);
  const lastLocked = live.filter((r) => isLockedStatus(r.status)).map((r) => r.period_month).sort().reverse()[0];
  if (lastLocked && month !== addMonths(lastLocked, 1)) throw new AppError("invalid", `The next run for ${g.name} is ${monthLabel(addMonths(lastLocked, 1))}: months are run in order.`, "month");
  if (month > addMonths(monthStart(today), 1)) throw new AppError("invalid", "You can run payroll up to one month ahead.", "month");
  const [r] = await unique(tx, (sp) => sp<{ id: string }[]>`
    insert into payroll_runs (tenant_id, pay_group_id, period_month, status) values (${actor.tenant.id}, ${payGroupId}, ${month}, 'draft') returning id`,
  `${g.name} already has a run for ${monthLabel(month)}.`);
  await audit(tx, actor, { entityType: "payroll_run", entityId: r.id, action: "payroll.run_created", diff: { payGroupId, month } });
  return { id: r.id };
}

// ---------------------------------------------------------------- reading a run

export type LineRow = {
  id: string; employee_id: string; name: string; number: string; department: string | null; designation: string | null;
  period_days: number; payable_days: number; lop_days: number; gross: number; deductions: number; net: number; employer: number;
  action: LineAction; warnings: string[]; earnings: PayItem[]; deduction_items: PayItem[]; employer_items: PayItem[];
  statutory: StatutoryDetail & { context?: Record<string, unknown> }; prevNet: number | null; variance: number | null; has_bank: boolean; self: boolean;
};
export type InputView = {
  id: string; employee_id: string; name: string; kind: string; amount: number | null; days: number | null; source_month: string | null; action: string; note: string | null;
  component: string | null; source_ref: Record<string, unknown> | null; created_at: string; self: boolean;
};
export type StepView = { key: StepKey; title: string; exceptions: number; done: boolean; reviewed: { by: string; at: string } | null };

const INPUT_KINDS = ["lop_adjust", "lop_reversal", "bonus", "adhoc_earning", "adhoc_deduction", "arrear", "overtime", "shift_allowance", "component_claim", "expense", "loan_emi", "leave_encashment"] as const;

export async function runView(tx: Tx, actor: Actor, runId: string) {
  assertRunPayroll(actor);
  const run = await getRun(tx, runId);
  const lines = await tx<(Omit<LineRow, "gross" | "deductions" | "net" | "employer" | "deduction_items" | "employer_items" | "prevNet" | "variance" | "self" | "period_days" | "payable_days" | "lop_days"> & {
    gross_paise: bigint; total_deductions_paise: bigint; net_paise: bigint; deductions: PayItem[]; employer: PayItem[]; period_days: string; payable_days: string; lop_days: string })[]>`
    select l.id, l.employee_id, e.display_name as name, e.employee_number as number, dp.name as department, d.title as designation,
      l.period_days::text, l.payable_days::text, l.lop_days::text, l.gross_paise, l.total_deductions_paise, l.net_paise, l.action, l.warnings, l.earnings, l.deductions, l.employer, l.statutory,
      exists (select 1 from employee_bank_accounts b where b.employee_id = l.employee_id and b.is_primary) as has_bank
    from payroll_lines l join employees e on e.id = l.employee_id left join departments dp on dp.id = e.department_id left join designations d on d.id = e.designation_id
    where l.run_id = ${runId} order by e.employee_number`;
  const [prevRun] = await tx<{ id: string; totals: Record<string, number> }[]>`
    select id, totals from payroll_runs where pay_group_id = ${run.pay_group_id} and period_month = ${addMonths(run.period_month, -1)} and status in ('finalized','payslips_released','paid')`;
  const prevNets = prevRun ? await tx<{ employee_id: string; net_paise: bigint }[]>`select employee_id, net_paise from payroll_lines where run_id = ${prevRun.id}` : [];
  const rows: LineRow[] = lines.map((l) => {
    const prev = prevNets.find((p) => p.employee_id === l.employee_id);
    const net = N(l.net_paise);
    return {
      id: l.id, employee_id: l.employee_id, name: l.name, number: l.number, department: l.department, designation: l.designation,
      period_days: Number(l.period_days), payable_days: Number(l.payable_days), lop_days: Number(l.lop_days),
      gross: N(l.gross_paise), deductions: N(l.total_deductions_paise), net, employer: (l.employer ?? []).reduce((t, x) => t + x.paise, 0),
      action: l.action, warnings: l.warnings, earnings: l.earnings ?? [], deduction_items: l.deductions ?? [], employer_items: l.employer ?? [], statutory: l.statutory,
      prevNet: prev ? N(prev.net_paise) : null, variance: prev ? variancePct(net, N(prev.net_paise)) : null, has_bank: l.has_bank, self: l.employee_id === actor.employeeId,
    };
  });
  const inputs = (await tx<{ id: string; employee_id: string; name: string; kind: string; amount_paise: bigint | null; days: string | null; source_month: string | null; action: string; note: string | null; component: string | null; source_ref: Record<string, unknown> | null; created_at: Date }[]>`
    select i.id, i.employee_id, e.display_name as name, i.kind, i.amount_paise, i.days::text, i.source_month::text, i.action, i.note, c.name as component, i.source_ref, i.created_at
    from payroll_inputs i join employees e on e.id = i.employee_id left join salary_components c on c.id = i.component_id
    where i.pay_group_id = ${run.pay_group_id} and i.period_month = ${run.period_month} order by i.created_at, i.id`).map((i): InputView => ({
    id: i.id, employee_id: i.employee_id, name: i.name, kind: i.kind, amount: i.amount_paise == null ? null : N(i.amount_paise), days: i.days == null ? null : Number(i.days),
    source_month: i.source_month, action: i.action, note: i.note, component: i.component, source_ref: i.source_ref, created_at: i.created_at.toISOString(), self: i.employee_id === actor.employeeId,
  }));
  const people = await tx<{ id: string; name: string; number: string }[]>`
    select id, display_name as name, employee_number as number from employees where pay_group_id = ${run.pay_group_id} and status <> 'preboarding' order by display_name`;
  const batches = await tx<{ id: string; bank_format: string; total_paise: bigint; status: string; file_id: string | null; created_at: Date; paid_at: Date | null; count: number }[]>`
    select id, bank_format, total_paise, status, file_id, created_at, paid_at, coalesce(array_length(line_ids, 1), 0) as count from payment_batches where run_id = ${runId} order by created_at`;
  const [slips] = await tx<{ total: number; released: number }[]>`
    select count(*)::int as total, count(*) filter (where p.released_at is not null)::int as released from payslips p join payroll_lines l on l.id = p.line_id where l.run_id = ${runId}`;
  const steps = stepViews(run, rows, inputs);
  const fresh = run.step_state.computedVersion === run.lock_version;
  return {
    run: { ...run, created_at: run.created_at.toISOString(), finalized_at: run.finalized_at?.toISOString() ?? null, label: monthLabel(run.period_month) },
    fresh, lines: rows, inputs, people, steps, prevTotals: prevRun?.totals ?? null,
    batches: batches.map((b) => ({ ...b, total_paise: N(b.total_paise), created_at: b.created_at.toISOString(), paid_at: b.paid_at?.toISOString() ?? null })),
    payslips: slips, windows: attendanceWindows(run.period_month, run.cutoff), verification: await verificationStatus(tx),
    canRollback: isLockedStatus(run.status) && run.status !== "paid", today: todayIn(),
  };
}

const ctx = (l: LineRow) => (l.statutory?.context ?? {}) as { joining?: string; lastDay?: string | null; exitStatus?: string | null; absentNoLop?: number; overtimeMinutes?: number };

/** Exceptions per step. A step is done when it has none, or someone has reviewed it. */
export function stepViews(run: Pick<RunRow, "step_state" | "period_month" | "totals">, lines: LineRow[], inputs: InputView[]): StepView[] {
  const count: Record<StepKey, number> = {
    attendance: lines.filter((l) => (ctx(l).absentNoLop ?? 0) > 0).length,
    people: (run.totals?.noSalary?.length ?? 0) + lines.filter((l) => l.action === "process" && l.net > 0 && !l.has_bank).length,
    variable: lines.filter((l) => (ctx(l).overtimeMinutes ?? 0) > 0 && !inputs.some((i) => i.employee_id === l.employee_id && i.kind === "overtime")).length,
    claims: inputs.filter((i) => ["expense", "component_claim", "adhoc_earning", "adhoc_deduction", "loan_emi", "leave_encashment"].includes(i.kind) && i.action === "hold").length,
    holds: lines.filter((l) => l.action === "hold_processing" || l.action === "hold_payout").length,
    review: lines.filter((l) => l.net < 0 || (l.variance != null && Math.abs(l.variance) > 25) || l.warnings.some((w) => /PAN/.test(w))).length,
  };
  return STEPS.map((s) => {
    const reviewed = run.step_state.reviewed?.[s.key] ?? null;
    return { key: s.key, title: s.title, exceptions: count[s.key], reviewed, done: count[s.key] === 0 || !!reviewed };
  });
}

// ---------------------------------------------------------------- inputs

async function openRun(tx: Tx, actor: Actor, runId: string, expected: number | null | undefined) {
  assertRunPayroll(actor);
  const run = await getRun(tx, runId, true);
  if (!OPEN.includes(run.status)) throw new AppError("conflict", "This run is finalised, so it can't change. Roll it back first, or make the change next month.");
  if (expected != null && expected !== run.lock_version) throw new AppError("conflict", "Someone else changed this run since you opened it. Reload the page to see their changes.");
  return run;
}
async function personInGroup(tx: Tx, run: RunRow, employeeId: string) {
  const [e] = await tx<{ id: string; display_name: string; pay_group_id: string | null }[]>`select id, display_name, pay_group_id from employees where id = ${employeeId}`;
  if (!e) throw new AppError("not_found", "Person not found.");
  if (e.pay_group_id !== run.pay_group_id) throw new AppError("invalid", `${e.display_name} isn't in ${run.pay_group}.`, "employeeId");
  return e;
}

export const inputSchema = z.object({
  employeeId: z.uuid("Pick a person"),
  kind: z.enum(INPUT_KINDS),
  amountPaise: z.number().int("Amounts are in whole paise").positive("Enter an amount more than zero").max(1_00_00_000_00, "That amount is too large").nullable().optional(),
  days: z.number().positive("Enter the number of days").max(31, "That's more days than a month has").multipleOf(0.5, "Use whole or half days").nullable().optional(),
  sourceMonth: z.string().refine(isMonth, "Pick a month").nullable().optional(),
  componentId: z.uuid().nullable().optional(),
  note: z.string().trim().max(200, "Keep the note under 200 characters").nullable().optional(),
});
export type InputInput = z.input<typeof inputSchema>;

/** Add or change a payroll input for the run's month (LOP changes, bonus, one-time payments and deductions, …). */
export async function saveInput(tx: Tx, actor: Actor, runId: string, inputId: string | null, raw: unknown, expected?: number | null) {
  const p = inputSchema.safeParse(raw);
  if (!p.success) throw new AppError("invalid", p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
  const v = p.data;
  const run = await openRun(tx, actor, runId, expected);
  assertNotSelf(actor, v.employeeId, "add or change payroll inputs for yourself");
  await personInGroup(tx, run, v.employeeId);
  const byDays = v.kind === "lop_adjust" || v.kind === "lop_reversal";
  if (byDays && !v.days) throw new AppError("invalid", "Enter the number of days.", "days");
  if (!byDays && v.kind !== "leave_encashment" && !v.amountPaise) throw new AppError("invalid", "Enter an amount.", "amountPaise");
  if (v.kind === "leave_encashment" && !v.amountPaise && !v.days) throw new AppError("invalid", "Enter the days to encash, or an amount.", "days");
  if (v.kind === "expense") throw new AppError("invalid", "Expense claims are scheduled from the expense desk.");
  let sourceMonth: string | null = null;
  if (byDays) {
    sourceMonth = v.sourceMonth ?? run.period_month;
    if (sourceMonth > run.period_month || sourceMonth < addMonths(run.period_month, -3)) throw new AppError("invalid", "LOP changes can go back up to three months.", "sourceMonth");
  }
  if (v.componentId) {
    const [c] = await tx<{ kind: string }[]>`select kind from salary_components where id = ${v.componentId}`;
    if (!c) throw new AppError("invalid", "Pick a component.", "componentId");
    const earning = ["bonus", "adhoc_earning", "arrear", "overtime", "shift_allowance", "component_claim"].includes(v.kind);
    if (earning !== !["deduction", "adhoc_deduction"].includes(c.kind) || c.kind === "employer_contribution") throw new AppError("invalid", "That component doesn't match this kind of input.", "componentId");
  }
  const vals = { amount: byDays ? null : v.amountPaise ?? null, days: byDays || v.kind === "leave_encashment" ? v.days ?? null : null };
  let id = inputId;
  if (inputId) {
    const [cur] = await tx<{ kind: string; employee_id: string }[]>`select kind, employee_id from payroll_inputs where id = ${inputId} and pay_group_id = ${run.pay_group_id} and period_month = ${run.period_month}`;
    if (!cur) throw new AppError("not_found", "Input not found.");
    if (cur.kind === "expense") throw new AppError("invalid", "Expense claims are changed from the expense desk.");
    assertNotSelf(actor, cur.employee_id, "change payroll inputs for yourself");
    await tx`update payroll_inputs set employee_id = ${v.employeeId}, kind = ${v.kind}, component_id = ${v.componentId ?? null}, amount_paise = ${vals.amount}, days = ${vals.days},
             source_month = ${sourceMonth}, note = ${v.note || null}, updated_at = now() where id = ${inputId}`;
  } else {
    const [r] = await tx<{ id: string }[]>`
      insert into payroll_inputs (tenant_id, pay_group_id, period_month, employee_id, kind, component_id, amount_paise, days, source_month, note, created_by)
      values (${actor.tenant.id}, ${run.pay_group_id}, ${run.period_month}, ${v.employeeId}, ${v.kind}, ${v.componentId ?? null}, ${vals.amount}, ${vals.days}, ${sourceMonth}, ${v.note || null}, ${actor.userId})
      returning id`;
    id = r.id;
  }
  await bumpVersion(tx, runId, run.lock_version);
  await audit(tx, actor, { entityType: "payroll_input", entityId: id, action: inputId ? "payroll.input_updated" : "payroll.input_added", diff: { runId, ...v, sourceMonth } });
  return { id: id! };
}

export async function deleteInput(tx: Tx, actor: Actor, runId: string, inputId: string, expected?: number | null) {
  const run = await openRun(tx, actor, runId, expected);
  const [cur] = await tx<{ kind: string; employee_id: string }[]>`select kind, employee_id from payroll_inputs where id = ${inputId} and pay_group_id = ${run.pay_group_id} and period_month = ${run.period_month}`;
  if (!cur) throw new AppError("not_found", "Input not found.");
  if (cur.kind === "expense") throw new AppError("invalid", "Expense claims are unscheduled from the expense desk. You can hold one here instead.");
  assertNotSelf(actor, cur.employee_id, "remove payroll inputs for yourself");
  await tx`delete from payroll_inputs where id = ${inputId}`;
  await bumpVersion(tx, runId, run.lock_version);
  await audit(tx, actor, { entityType: "payroll_input", entityId: inputId, action: "payroll.input_deleted", diff: { runId, kind: cur.kind } });
}

/** Pay, hold (leave for a later month) or skip one input — used for claims scheduled by other modules too. */
export async function setInputAction(tx: Tx, actor: Actor, runId: string, inputId: string, action: "pay" | "hold" | "void", expected?: number | null) {
  const run = await openRun(tx, actor, runId, expected);
  const [cur] = await tx<{ employee_id: string; kind: string }[]>`select employee_id, kind from payroll_inputs where id = ${inputId} and pay_group_id = ${run.pay_group_id} and period_month = ${run.period_month}`;
  if (!cur) throw new AppError("not_found", "Input not found.");
  assertNotSelf(actor, cur.employee_id, "hold or release your own payments");
  if (cur.kind === "expense" && action === "void") throw new AppError("invalid", "Hold an expense claim instead; finance can unschedule it from the expense desk.");
  await tx`update payroll_inputs set action = ${action}, updated_at = now() where id = ${inputId}`;
  await bumpVersion(tx, runId, run.lock_version);
  await audit(tx, actor, { entityType: "payroll_input", entityId: inputId, action: "payroll.input_action", diff: { runId, action } });
}

/** A person's pay action for this month: process (default), hold processing, hold payout, don't pay, or paid outside erp. */
export async function setPayAction(tx: Tx, actor: Actor, runId: string, employeeId: string, action: LineAction, note: string | null, expected?: number | null) {
  if (!LINE_ACTIONS.includes(action)) throw new AppError("invalid", "Pick what to do with this person's pay.");
  const run = await openRun(tx, actor, runId, expected);
  assertNotSelf(actor, employeeId, "hold or release your own pay");
  await personInGroup(tx, run, employeeId);
  await tx`delete from payroll_inputs where pay_group_id = ${run.pay_group_id} and period_month = ${run.period_month} and employee_id = ${employeeId} and kind in ('pay_action','processing_hold','payout_hold')`;
  if (action !== "process") {
    await tx`insert into payroll_inputs (tenant_id, pay_group_id, period_month, employee_id, kind, source_ref, note, created_by)
             values (${actor.tenant.id}, ${run.pay_group_id}, ${run.period_month}, ${employeeId}, 'pay_action', ${tx.json({ action })}, ${note?.trim() || null}, ${actor.userId})`;
  }
  await bumpVersion(tx, runId, run.lock_version);
  await audit(tx, actor, { entityType: "payroll_run", entityId: runId, action: "payroll.pay_action", diff: { employeeId, action, note } });
}

export const OVERRIDE_CODES = ["PF_EMPLOYEE", "ESI", "PT", "LWF", "TDS"] as const;
/** Replace one statutory deduction for one person this month (null removes the override). A reason is required. */
export async function setOverride(tx: Tx, actor: Actor, runId: string, employeeId: string, code: (typeof OVERRIDE_CODES)[number], amountPaise: number | null, reason: string | null, expected?: number | null) {
  if (!OVERRIDE_CODES.includes(code)) throw new AppError("invalid", "Pick a statutory deduction.");
  if (amountPaise != null && (!Number.isSafeInteger(amountPaise) || amountPaise < 0)) throw new AppError("invalid", "Enter an amount of zero or more.", "amountPaise");
  if (amountPaise != null && !(reason ?? "").trim()) throw new AppError("invalid", "Say why you're overriding the calculated amount.", "reason");
  const run = await openRun(tx, actor, runId, expected);
  assertNotSelf(actor, employeeId, "override your own statutory deductions");
  await personInGroup(tx, run, employeeId);
  await tx`delete from payroll_inputs where pay_group_id = ${run.pay_group_id} and period_month = ${run.period_month} and employee_id = ${employeeId} and kind = 'statutory_override' and source_ref->>'code' = ${code}`;
  if (amountPaise != null) {
    await tx`insert into payroll_inputs (tenant_id, pay_group_id, period_month, employee_id, kind, amount_paise, source_ref, note, created_by)
             values (${actor.tenant.id}, ${run.pay_group_id}, ${run.period_month}, ${employeeId}, 'statutory_override', ${amountPaise}, ${tx.json({ code })}, ${reason!.trim()}, ${actor.userId})`;
  }
  await bumpVersion(tx, runId, run.lock_version);
  await audit(tx, actor, { entityType: "payroll_run", entityId: runId, action: "payroll.statutory_override", diff: { employeeId, code, amountPaise, reason } });
}

export async function markReviewed(tx: Tx, actor: Actor, runId: string, step: StepKey, reviewed: boolean, expected?: number | null) {
  if (!STEPS.some((s) => s.key === step)) throw new AppError("invalid", "Unknown step.");
  const run = await openRun(tx, actor, runId, expected);
  const state: StepState = { ...run.step_state, reviewed: { ...(run.step_state.reviewed ?? {}) } };
  if (reviewed) state.reviewed![step] = { by: actor.name, at: new Date().toISOString() }; else delete state.reviewed![step];
  // reviewing doesn't change the numbers, so the lines stay current
  const fresh = run.step_state.computedVersion === run.lock_version;
  const v = await bumpVersion(tx, runId, run.lock_version);
  if (fresh) state.computedVersion = v;
  await tx`update payroll_runs set step_state = ${tx.json(state as never)} where id = ${runId}`;
}

export async function calculate(tx: Tx, actor: Actor, runId: string, expected?: number | null) {
  await openRun(tx, actor, runId, expected);
  const r = await computeRun(tx, runId, { expectedVersion: expected ?? null });
  await audit(tx, actor, { entityType: "payroll_run", entityId: runId, action: "payroll.calculated", diff: { version: r.version, headcount: r.totals.headcount, net: r.totals.net } });
  return r;
}

// ---------------------------------------------------------------- finalise / roll back

/** Dates the run takes attendance from: this month up to the cut-off, and last month's tail when that was paid in erp. */
async function lockedDates(tx: Tx, run: RunRow) {
  const w = attendanceWindows(run.period_month, run.cutoff);
  const [prev] = await tx<{ status: string }[]>`select status from payroll_runs where pay_group_id = ${run.pay_group_id} and period_month = ${addMonths(run.period_month, -1)} and status <> 'rolled_back'`;
  return { from: prev && isLockedStatus(prev.status) && w.rolled ? w.rolled.from : w.current.from, to: w.current.to };
}

export async function finalizeRun(tx: Tx, actor: Actor, runId: string, expected?: number | null) {
  const run = await openRun(tx, actor, runId, expected);
  if (run.status !== "in_progress" || run.step_state.computedVersion !== run.lock_version) throw new AppError("conflict", "Recalculate the run first: something changed since the last calculation.");
  const lines = await tx<{ id: string; employee_id: string; net_paise: bigint; action: string }[]>`select id, employee_id, net_paise, action from payroll_lines where run_id = ${runId}`;
  if (!lines.length) throw new AppError("invalid", "There's nobody to pay in this run.");
  const view = await runView(tx, actor, runId);
  const open = view.steps.filter((s) => !s.done);
  if (open.length) throw new AppError("invalid", `Review these steps first: ${open.map((s) => s.title.toLowerCase()).join("; ")}.`);
  const negative = lines.filter((l) => slipped(l.action) && N(l.net_paise) < 0);
  if (negative.length) throw new AppError("invalid", `${negative.length} ${negative.length === 1 ? "person has" : "people have"} negative net pay. Reduce their deductions or hold their pay.`);
  await tx`update payroll_runs set status = 'finalized', finalized_at = now(), finalized_by = ${actor.userId}, lock_version = lock_version + 1, updated_at = now() where id = ${runId}`;
  await emitWebhook(tx, actor.tenant.id, "payroll.finalized", { run_id: runId, pay_group_id: run.pay_group_id, period_month: run.period_month, people: lines.length });
  for (const l of lines.filter((x) => slipped(x.action))) {
    await tx`insert into payslips (tenant_id, line_id, employee_id, period_month) values (${actor.tenant.id}, ${l.id}, ${l.employee_id}, ${run.period_month}) on conflict (line_id) do nothing`;
  }
  const d = await lockedDates(tx, run);
  const locked = await tx`update attendance_days set is_locked = true, updated_at = now() where employee_id = any(${lines.map((l) => l.employee_id)}::uuid[]) and date between ${d.from} and ${d.to} and not is_locked`;
  await audit(tx, actor, { entityType: "payroll_run", entityId: runId, action: "payroll.finalized", diff: { month: run.period_month, lines: lines.length, net: view.run.totals.net, attendanceDaysLocked: locked.count } });
  return { lines: lines.length };
}

export async function rollbackRun(tx: Tx, actor: Actor, runId: string, reason: string, expected?: number | null) {
  assertRunPayroll(actor);
  assertRollback(actor);
  const why = (reason ?? "").trim();
  if (why.length < 5) throw new AppError("invalid", "Say why the run is being rolled back (at least a few words).", "reason");
  const run = await getRun(tx, runId, true);
  if (expected != null && expected !== run.lock_version) throw new AppError("conflict", "Someone else changed this run since you opened it. Reload the page to see their changes.");
  if (!["finalized", "payslips_released"].includes(run.status)) throw new AppError("conflict", run.status === "paid" ? "This run has been paid, so it can't be rolled back. Correct it next month." : "Only a finalised run can be rolled back.");
  const [paid] = await tx`select 1 from payment_batches where run_id = ${runId} and status = 'paid' limit 1`;
  if (paid) throw new AppError("conflict", "Salaries in this run have already been marked paid, so it can't be rolled back.");
  const [later] = await tx`select 1 from payroll_runs where pay_group_id = ${run.pay_group_id} and period_month > ${run.period_month} and status <> 'rolled_back' limit 1`;
  if (later) throw new AppError("conflict", "A later month's run already exists for this pay group. Roll that back first.");
  const [fnf] = await tx`select 1 from fnf_settlements s join employees e on e.id = s.employee_id where s.status = 'finalized' and e.pay_group_id = ${run.pay_group_id} and s.settlement_month > ${run.period_month} limit 1`;
  if (fnf) throw new AppError("conflict", "A finalised full and final settlement depends on this month's run.");
  await tx`update payment_batches set status = 'cancelled', updated_at = now() where run_id = ${runId} and status = 'generated'`;
  const released = await tx<{ employee_id: string }[]>`delete from payslips p using payroll_lines l where l.id = p.line_id and l.run_id = ${runId} returning p.employee_id, p.released_at`;
  const people = (await tx<{ employee_id: string }[]>`select employee_id from payroll_lines where run_id = ${runId}`).map((l) => l.employee_id);
  const d = await lockedDates(tx, run);
  await tx`update attendance_days set is_locked = false, updated_at = now() where employee_id = any(${people}::uuid[]) and date between ${d.from} and ${d.to} and is_locked`;
  const state: StepState = { ...run.step_state, rollback: { by: actor.name, at: new Date().toISOString(), reason: why } };
  await tx`update payroll_runs set status = 'rolled_back', step_state = ${tx.json(state as never)}, lock_version = lock_version + 1, updated_at = now() where id = ${runId}`;
  for (const r of released as unknown as { employee_id: string; released_at: Date | null }[]) {
    if (r.released_at) await notifyEmployee(tx, actor.tenant.id, r.employee_id, "payroll.payslip_withdrawn", `Your ${monthLabel(run.period_month)} payslip was withdrawn`, "Payroll is correcting this month. You'll get a new payslip when it's done.", "/me/pay");
  }
  await audit(tx, actor, { entityType: "payroll_run", entityId: runId, action: "payroll.rolled_back", diff: { month: run.period_month, reason: why } });
}

// ---------------------------------------------------------------- after finalising: payout-level changes only

export async function releaseHeldPayout(tx: Tx, actor: Actor, lineId: string) {
  assertRunPayroll(actor);
  const [l] = await tx<{ run_id: string; employee_id: string; action: string; status: string }[]>`
    select l.run_id, l.employee_id, l.action, r.status from payroll_lines l join payroll_runs r on r.id = l.run_id where l.id = ${lineId} for update of l`;
  if (!l) throw new AppError("not_found", "Line not found.");
  assertNotSelf(actor, l.employee_id, "release your own salary");
  if (!isLockedStatus(l.status) || l.action !== "hold_payout") throw new AppError("conflict", "Only a held payout in a finalised run can be released.");
  await tx`update payroll_lines set action = 'process', updated_at = now() where id = ${lineId}`;
  await tx`update payroll_runs set status = case when status = 'paid' then 'payslips_released' else status end, lock_version = lock_version + 1 where id = ${l.run_id}`;
  await audit(tx, actor, { entityType: "payroll_line", entityId: lineId, action: "payroll.payout_released", diff: { employeeId: l.employee_id } });
}

export async function markLinePaidOutside(tx: Tx, actor: Actor, lineId: string, note: string) {
  assertRunPayroll(actor);
  if (!(note ?? "").trim()) throw new AppError("invalid", "Add how it was paid (for example a cheque number).", "note");
  const [l] = await tx<{ run_id: string; employee_id: string; action: string; status: string }[]>`
    select l.run_id, l.employee_id, l.action, r.status from payroll_lines l join payroll_runs r on r.id = l.run_id where l.id = ${lineId} for update of l`;
  if (!l) throw new AppError("not_found", "Line not found.");
  assertNotSelf(actor, l.employee_id, "mark your own salary as paid");
  if (!isLockedStatus(l.status) || !["process", "hold_payout"].includes(l.action)) throw new AppError("conflict", "Only an unpaid line in a finalised run can be marked as paid outside erp.");
  const [inBatch] = await tx`select 1 from payment_batches where run_id = ${l.run_id} and status in ('generated','paid') and ${lineId}::uuid = any(line_ids)`;
  if (inBatch) throw new AppError("conflict", "This salary is in a bank transfer file. Cancel that file first.");
  await tx`update payroll_lines set action = 'paid_outside', warnings = array_append(warnings, ${`Paid outside erp: ${note.trim()}`}), updated_at = now() where id = ${lineId}`;
  await audit(tx, actor, { entityType: "payroll_line", entityId: lineId, action: "payroll.paid_outside", diff: { note } });
  const { settleIfPaid } = await import("./payments");
  await settleIfPaid(tx, l.run_id);
}
