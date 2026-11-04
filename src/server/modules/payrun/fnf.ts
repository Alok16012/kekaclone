import "server-only";
import { autoTickExitTasks } from "@/server/modules/exits/checklist";
import { z } from "zod";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { audit } from "@/server/modules/audit/service";
import { notifyEmployee } from "@/server/modules/approvals/service";
import { balances } from "@/server/modules/leave/service";
import { noticeFor } from "@/server/modules/exits/service";
import { assetRecoveryFor } from "@/server/modules/assets/service";
import { loadRates, ratesNeedVerification } from "@/server/modules/statutory/service";
import { gratuity } from "@/server/modules/statutory/rules";
import { saveFile } from "@/server/storage";
import { outstandingForFnf, recoverLoanInFnf } from "@/server/modules/loans/service";
import { settleClaimsInFnf } from "@/server/modules/expenses/service";
import { assertNotSelf, assertRunPayroll, canRunPayroll } from "./access";
import { components, draftLine, loadPeople, runPeople, type RunRow } from "./engine";
import { renderFnfStatement } from "./pdf";
import { addMonths, dayRate, fnfNet, isLockedStatus, monthEnd, monthLabel, monthStart, noticeShortfall, slipped, type FnfItem } from "./rules";

const N = (v: bigint | number | null | undefined) => (v == null ? 0 : Number(v));

type ExitRow = {
  id: string; status: string; kind: "resignation" | "company_action"; resignation_date: string; last_working_date: string; notice_waived_days: number; reason: string | null;
  employee_id: string; name: string; number: string; designation: string | null; department: string | null; joining_date: string; pay_group_id: string | null;
  pay_group: string | null; cutoff: number | null; basis: RunRow["basis"] | null; legal_entity: string | null; legal_entity_id: string | null;
};
async function exitRow(tx: Tx, exitId: string) {
  const [x] = await tx<ExitRow[]>`
    select x.id, x.status, x.kind, x.resignation_date::text, x.last_working_date::text, x.notice_waived_days, r.name as reason,
      e.id as employee_id, e.display_name as name, e.employee_number as number, d.title as designation, dp.name as department, e.joining_date::text, e.pay_group_id,
      g.name as pay_group, g.attendance_cutoff_day as cutoff, g.payable_days_basis as basis, le.name as legal_entity, g.legal_entity_id
    from exit_requests x join employees e on e.id = x.employee_id left join exit_reasons r on r.id = x.reason_id
    left join designations d on d.id = e.designation_id left join departments dp on dp.id = e.department_id
    left join pay_groups g on g.id = e.pay_group_id left join legal_entities le on le.id = g.legal_entity_id
    where x.id = ${exitId}`;
  if (!x) throw new AppError("not_found", "Exit not found.");
  return x;
}
type Settlement = { id: string; status: "draft" | "approved" | "finalized"; items: FnfItem[]; net_paise: bigint | null; statement_file_id: string | null; settlement_month: string | null; updated_at: Date };
const settlementOf = async (tx: Tx, exitId: string) =>
  (await tx<Settlement[]>`select id, status, items, net_paise, statement_file_id, settlement_month::text, updated_at from fnf_settlements where exit_request_id = ${exitId}`)[0] ?? null;

/** Exits that need (or had) a full and final settlement, with where each one stands. */
export async function fnfList(tx: Tx, actor: Actor) {
  assertRunPayroll(actor);
  const rows = await tx<{ id: string; status: string; name: string; number: string; last_working_date: string; employee_id: string; fnf_status: string | null; net_paise: bigint | null }[]>`
    select x.id, x.status, e.display_name as name, e.employee_number as number, x.last_working_date::text, e.id as employee_id, s.status as fnf_status, s.net_paise
    from exit_requests x join employees e on e.id = x.employee_id left join fnf_settlements s on s.exit_request_id = x.id
    where x.status in ('in_progress','exited') order by (s.status = 'finalized') nulls first, x.last_working_date`;
  return rows.map((r) => ({ ...r, net: r.net_paise == null ? null : N(r.net_paise), self: r.employee_id === actor.employeeId }));
}

/** Whether the month before the last working day has been finalised (needed before settling). */
async function prerequisite(tx: Tx, x: ExitRow) {
  if (!x.pay_group_id) return { ok: false, message: `${x.name} isn't in a pay group, so erp can't work out their final salary.` };
  const lwdMonth = monthStart(x.last_working_date), prev = addMonths(lwdMonth, -1);
  if (x.joining_date >= lwdMonth) return { ok: true, message: null };
  const [r] = await tx<{ status: string }[]>`select status from payroll_runs where pay_group_id = ${x.pay_group_id} and period_month = ${prev} and status <> 'rolled_back'`;
  if (!r || !isLockedStatus(r.status)) return { ok: false, message: `Finalise the ${monthLabel(prev)} payroll for ${x.pay_group} first, so the settlement starts from a closed month.` };
  return { ok: true, message: null };
}

/** The settlement items erp works out itself. Pure reads; nothing is saved. */
async function autoItems(tx: Tx, actor: Actor, x: ExitRow): Promise<{ items: FnfItem[]; notes: string[] }> {
  const items: FnfItem[] = [], notes: string[] = [];
  const lwd = x.last_working_date, lwdMonth = monthStart(lwd);
  const item = (key: string, label: string, side: FnfItem["side"], paise: number, note: string | null = null): FnfItem => ({ key, label, side, paise, action: paise > 0 ? "pay" : "void", auto: true, note });
  const [sal] = await tx<{ breakup: Record<string, number> }[]>`
    select breakup from employee_salaries where employee_id = ${x.employee_id} and status in ('active','superseded') and effective_from <= ${lwd} order by effective_from desc limit 1`;
  const comps = await components(tx);
  const basic = sal?.breakup.BASIC ?? 0;
  const monthlyGross = sal ? Object.entries(sal.breakup).reduce((t, [c, v]) => t + (comps[c]?.kind === "employer_contribution" ? 0 : v), 0) : 0;

  // 1. salary for the last month, unless a finalised regular run already paid it. Loan EMIs and scheduled expense claims are
  //    left out of it: outstanding loans (6) and unpaid claims (7) are settled as their own lines.
  if (x.pay_group_id && x.cutoff != null && x.basis) {
    const [paid] = await tx<{ action: string }[]>`
      select l.action from payroll_lines l join payroll_runs r on r.id = l.run_id
      where l.employee_id = ${x.employee_id} and r.period_month = ${lwdMonth} and r.status in ('finalized','payslips_released','paid')`;
    if (paid && slipped(paid.action)) notes.push(`Salary for ${monthLabel(lwdMonth)} was paid in the regular payroll.`);
    else {
      const run = { id: "fnf", pay_group_id: x.pay_group_id, period_month: lwdMonth, status: "draft", step_state: {}, totals: {}, lock_version: 0, finalized_at: null, finalized_by: null,
        created_at: new Date(), pay_group: x.pay_group!, cutoff: 31, basis: x.basis, legal_entity_id: x.legal_entity_id!, legal_entity: x.legal_entity! } satisfies RunRow;
      const person = (await runPeople(tx, x.pay_group_id, lwdMonth)).find((p) => p.id === x.employee_id);
      const [d] = person ? await loadPeople(tx, run, [person]) : [];
      const line = d ? await draftLine(tx, run, { ...d, inputs: d.inputs.filter((i) => i.kind !== "pay_action" && i.kind !== "processing_hold" && i.kind !== "payout_hold" && i.kind !== "loan_emi" && i.kind !== "expense") },
        { components: comps, rates: new Map(), prevLocked: true, tenantId: actor.tenant.id }) : null;
      if (!line) notes.push("No salary is on record for the last month, so there's no final salary to pay.");
      else {
        const r = line.result;
        const salaryPart = r.earnings.filter((e) => e.kind === "salary" || e.kind === "reimbursement").reduce((t, e) => t + e.paise, 0);
        items.push(item("salary", `Salary for ${monthLabel(lwdMonth)} (${line.payableDays} of ${line.periodDays} days)`, "earning", salaryPart));
        for (const e of r.earnings.filter((e) => e.kind !== "salary" && e.kind !== "reimbursement")) items.push(item(`salary:${e.code}:${e.sourceMonth ?? ""}`, e.label, "earning", e.paise));
        for (const e of r.deductions) items.push(item(`deduction:${e.code}`, e.label, "deduction", e.paise));
        if (r.warnings.length) notes.push(...r.warnings.filter((w) => !/full and final/.test(w)));
      }
    }
  }
  // 2. leave encashment: what's left of encashable leave on the last day
  const encashable = await tx<{ leave_type_id: string; code: string; encash_max: string | null }[]>`
    select r.leave_type_id, t.code, r.year_end->>'encash_max' as encash_max from leave_plan_rules r join leave_types t on t.id = r.leave_type_id
    where r.leave_plan_id = (select leave_plan_id from employees where id = ${x.employee_id}) and t.kind = 'regular' and t.is_paid`;
  const bals = await balances(tx, x.employee_id, lwd);
  for (const b of bals) {
    const rule = encashable.find((r) => r.leave_type_id === b.id);
    if (!rule || (!(Number(rule.encash_max) > 0) && rule.code !== "EL") || b.unlimited || b.available <= 0) continue;
    items.push(item(`encash:${b.id}`, `Leave encashment: ${b.name} (${b.available} days)`, "earning", dayRate(basic, b.available), "Basic ÷ 30 per day"));
  }
  // 3. gratuity (statutory engine)
  const rates = await loadRates(tx, lwd, null);
  const g = gratuity({ config: rates.gratuity.config, lastMonthlyWagePaise: basic, joiningDate: x.joining_date, lastWorkingDate: lwd, reason: x.kind === "company_action" ? "termination" : "resignation" });
  items.push(item("gratuity", g.eligible ? `Gratuity (${g.countedYears} ${g.countedYears === 1 ? "year" : "years"} counted)` : "Gratuity (not eligible)", "earning", g.amountPaise,
    g.eligible ? `15 ÷ 26 × last basic × years served; rates not CA-verified` : `Not eligible: ${g.completedYears} completed ${g.completedYears === 1 ? "year" : "years"} of service, ${rates.gratuity.config.minYears} needed`));
  // 4. notice shortfall recovery (resignations)
  if (x.kind === "resignation") {
    const n = await noticeFor(tx, x.employee_id, x.resignation_date);
    const short = noticeShortfall({ resignationDate: x.resignation_date, lastWorkingDate: lwd, noticeDays: n.days, waivedDays: x.notice_waived_days });
    if (short > 0) items.push(item("notice", `Notice pay recovery (${short} ${short === 1 ? "day" : "days"} short)`, "deduction", dayRate(monthlyGross, short), "Monthly gross ÷ 30 per day"));
  }
  // 5. asset damage or loss
  const assets = await assetRecoveryFor(tx, x.employee_id);
  for (const a of assets.items) items.push(item(`asset:${a.tag}`, `Asset recovery: ${a.asset} (${a.tag}, ${a.condition})`, "deduction", N(a.recovery_paise)));
  // 6. loans still outstanding: principal left (interest not yet due isn't charged), less EMIs already in a finalised payroll
  const owed = await outstandingForFnf(tx, x.employee_id);
  for (const l of owed.loans) {
    const due = l.outstandingPaise - l.lockedPaise;
    if (due > 0) items.push(item(`loan:${l.loanId}`, `Loan balance recovered: ${l.category}`, "deduction", due,
      `Outstanding principal${l.lockedPaise ? `, after EMIs already in a finalised payroll` : ""}; recorded against the loan when you finalise`));
    else if (l.note) notes.push(`${l.category}: ${l.note}`);
  }
  // 7. approved expense claims not yet paid (and not already in a finalised payroll)
  const claims = await tx<{ id: string; number: number; title: string | null; total_paise: bigint; advance_applied_paise: bigint }[]>`
    select c.id, c.number, c.title, c.total_paise, c.advance_applied_paise from expense_claims c
    where c.employee_id = ${x.employee_id} and c.status = 'approved'
      and not exists (select 1 from payroll_inputs i join payroll_runs r on r.pay_group_id = i.pay_group_id and r.period_month = i.period_month
                      where i.kind = 'expense' and i.source_ref->>'expense_claim_id' = c.id::text and r.status in ('finalized','payslips_released','paid'))`;
  for (const c of claims) items.push(item(`expense:${c.id}`, `Expense claim #${c.number}${c.title ? ` (${c.title})` : ""}`, "earning", Math.max(0, N(c.total_paise) - N(c.advance_applied_paise))));
  return { items, notes };
}

export type FnfView = {
  exit: Pick<ExitRow, "id" | "status" | "kind" | "resignation_date" | "last_working_date" | "reason" | "name" | "number" | "designation" | "department" | "joining_date" | "pay_group" | "employee_id">;
  settlement: { status: string; items: FnfItem[]; net: number; fileId: string | null; updatedAt: string } | null;
  preview: FnfItem[]; notes: string[]; prerequisite: { ok: boolean; message: string | null }; self: boolean; canEdit: boolean;
};

export async function fnfDetail(tx: Tx, actor: Actor, exitId: string): Promise<FnfView> {
  assertRunPayroll(actor);
  const x = await exitRow(tx, exitId);
  const s = await settlementOf(tx, exitId);
  const self = x.employee_id === actor.employeeId;
  const auto = s?.status === "finalized" ? { items: [], notes: [] } : await autoItems(tx, actor, x);
  return {
    exit: { id: x.id, status: x.status, kind: x.kind, resignation_date: x.resignation_date, last_working_date: x.last_working_date, reason: x.reason, name: x.name, number: x.number,
      designation: x.designation, department: x.department, joining_date: x.joining_date, pay_group: x.pay_group, employee_id: x.employee_id },
    settlement: s ? { status: s.status, items: s.items, net: N(s.net_paise), fileId: s.statement_file_id, updatedAt: s.updated_at.toISOString() } : null,
    preview: auto.items, notes: auto.notes, prerequisite: await prerequisite(tx, x), self, canEdit: !self && s?.status !== "finalized" && ["in_progress", "exited"].includes(x.status),
  };
}

async function editable(tx: Tx, actor: Actor, exitId: string) {
  assertRunPayroll(actor);
  const x = await exitRow(tx, exitId);
  assertNotSelf(actor, x.employee_id, "work on your own final settlement");
  if (!["in_progress", "exited"].includes(x.status)) throw new AppError("invalid", "Settlements are for exits that are under way or complete.");
  const [s] = await tx<Settlement[]>`select id, status, items, net_paise, statement_file_id, settlement_month::text, updated_at from fnf_settlements where exit_request_id = ${exitId} for update`;
  if (s?.status === "finalized") throw new AppError("conflict", "This settlement is finalised and can't change.");
  return { x, s: s ?? null };
}
async function save(tx: Tx, actor: Actor, x: ExitRow, s: Settlement | null, items: FnfItem[]) {
  const net = fnfNet(items);
  if (s) await tx`update fnf_settlements set items = ${tx.json(items as never)}, net_paise = ${net}, updated_at = now() where id = ${s.id}`;
  else await tx`insert into fnf_settlements (tenant_id, exit_request_id, employee_id, items, net_paise, settlement_month) values (${actor.tenant.id}, ${x.id}, ${x.employee_id}, ${tx.json(items as never)}, ${net}, ${monthStart(x.last_working_date)})`;
  return net;
}

/**
 * Work the settlement out (again): erp's own items are recalculated, keeping any pay / don't-pay / paid-separately choice
 * made on them; manual items stay as they are. Draft until finalised.
 */
export async function buildSettlement(tx: Tx, actor: Actor, exitId: string) {
  const { x, s } = await editable(tx, actor, exitId);
  const auto = await autoItems(tx, actor, x);
  const prior = new Map((s?.items ?? []).map((i) => [i.key, i]));
  const items = [...auto.items.map((i) => { const p = prior.get(i.key); return p && i.paise > 0 ? { ...i, action: p.action } : i; }), ...(s?.items ?? []).filter((i) => !i.auto)];
  const net = await save(tx, actor, x, s, items);
  await audit(tx, actor, { entityType: "fnf_settlement", entityId: exitId, action: s ? "fnf.recalculated" : "fnf.started", diff: { items: items.length, net } });
  return { net, notes: auto.notes };
}

export async function setItemAction(tx: Tx, actor: Actor, exitId: string, key: string, action: FnfItem["action"]) {
  if (!["pay", "void", "paid_outside"].includes(action)) throw new AppError("invalid", "Pick pay, don't pay, or paid separately.");
  const { x, s } = await editable(tx, actor, exitId);
  if (!s) throw new AppError("invalid", "Work out the settlement first.");
  const it = s.items.find((i) => i.key === key);
  if (!it) throw new AppError("not_found", "Item not found.");
  const items = s.items.map((i) => (i.key === key ? { ...i, action } : i));
  const net = await save(tx, actor, x, s, items);
  await audit(tx, actor, { entityType: "fnf_settlement", entityId: exitId, action: "fnf.item_action", diff: { key, action, net } });
  return { net };
}

const manualInput = z.object({
  label: z.string().trim().min(2, "Describe the item").max(120),
  side: z.enum(["earning", "deduction"]),
  paise: z.number().int("Amounts are in whole paise").positive("Enter an amount more than zero").max(1_00_00_000_00, "That amount is too large"),
  note: z.string().trim().max(200).nullable().optional(),
});
export async function addManualItem(tx: Tx, actor: Actor, exitId: string, raw: unknown) {
  const p = manualInput.safeParse(raw);
  if (!p.success) throw new AppError("invalid", p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
  const { x, s } = await editable(tx, actor, exitId);
  if (!s) throw new AppError("invalid", "Work out the settlement first.");
  const key = `manual:${crypto.randomUUID()}`;
  const items = [...s.items, { key, label: p.data.label, side: p.data.side, paise: p.data.paise, action: "pay" as const, auto: false, note: p.data.note ?? null }];
  const net = await save(tx, actor, x, s, items);
  await audit(tx, actor, { entityType: "fnf_settlement", entityId: exitId, action: "fnf.item_added", diff: { ...p.data, net } });
  return { key, net };
}
export async function removeManualItem(tx: Tx, actor: Actor, exitId: string, key: string) {
  const { x, s } = await editable(tx, actor, exitId);
  const it = s?.items.find((i) => i.key === key);
  if (!s || !it) throw new AppError("not_found", "Item not found.");
  if (it.auto) throw new AppError("invalid", "erp's own items can't be removed; mark them as not paid instead.");
  const net = await save(tx, actor, x, s, s.items.filter((i) => i.key !== key));
  await audit(tx, actor, { entityType: "fnf_settlement", entityId: exitId, action: "fnf.item_removed", diff: { key, net } });
  return { net };
}

/** Lock the settlement, render the statement PDF and tell the person. Needs last month's payroll finalised. */
export async function finalizeSettlement(tx: Tx, actor: Actor, exitId: string) {
  const { x, s } = await editable(tx, actor, exitId);
  if (!s) throw new AppError("invalid", "Work out the settlement first.");
  const pre = await prerequisite(tx, x);
  if (!pre.ok) throw new AppError("invalid", pre.message!);
  const lwdMonth = monthStart(x.last_working_date);
  const [open] = await tx<{ status: string }[]>`
    select r.status from payroll_runs r join payroll_lines l on l.run_id = r.id
    where r.pay_group_id = ${x.pay_group_id} and r.period_month = ${lwdMonth} and r.status in ('draft','in_progress') and l.employee_id = ${x.employee_id} and l.action = 'process'`;
  if (open && s.items.some((i) => i.key === "salary" && i.action === "pay")) throw new AppError("conflict", `${x.name} is also in the ${monthLabel(lwdMonth)} payroll run. Recalculate that run after finalising, or mark the salary here as paid separately.`);
  const net = fnfNet(s.items);
  const [t] = await tx<{ name: string }[]>`select name from tenants where id = ${actor.tenant.id}`;
  const today = new Date().toISOString().slice(0, 10);
  const bytes = await renderFnfStatement({
    company: t?.name ?? actor.tenant.name, legalEntity: x.legal_entity ?? "",
    employee: { name: x.name, number: x.number, designation: x.designation, department: x.department, joining: x.joining_date, lastDay: x.last_working_date, reason: x.reason },
    items: s.items, net, finalizedOn: today, unverified: await ratesNeedVerification(tx),
  });
  const fileId = await saveFile(tx, { tenantId: actor.tenant.id, userId: actor.userId, name: `Final settlement ${x.number}.pdf`, mime: "application/pdf", bytes, ext: "pdf" });
  // recovered loan balances close (or reduce) the loans, so payroll stops taking EMIs
  for (const i of s.items) {
    if (!i.key.startsWith("loan:") || i.action !== "pay" || i.paise <= 0) continue;
    await recoverLoanInFnf(tx, actor, i.key.slice(5), { amountPaise: i.paise, paidOn: today, reference: `Final settlement ${x.number}` }, today);
  }
  // expense claims the settlement pays (or that were paid separately) are closed, and leave any open payroll month
  const claimIds = s.items.filter((i) => i.key.startsWith("expense:") && (i.action === "pay" || i.action === "paid_outside")).map((i) => i.key.slice(8));
  await settleClaimsInFnf(tx, actor, claimIds, `Final settlement ${x.number}`);
  await tx`update fnf_settlements set status = 'finalized', net_paise = ${net}, statement_file_id = ${fileId}, settlement_month = ${lwdMonth}, updated_at = now() where id = ${s.id}`;
  await autoTickExitTasks(tx, { employeeId: x.employee_id });   // the exit checklist's "Final settlement" task ticks itself
  await notifyEmployee(tx, actor.tenant.id, x.employee_id, "payroll.fnf", "Your full and final settlement is ready", "Open My finances to download the statement.", "/me/pay");
  await audit(tx, actor, { entityType: "fnf_settlement", entityId: exitId, action: "fnf.finalized", diff: { net, items: s.items.length } });
  return { net, fileId };
}

/** For the exit drawer: where the settlement stands, and whether this person may open it. */
export async function fnfSummary(tx: Tx, actor: Actor, exitId: string) {
  const [x] = await tx<{ employee_id: string }[]>`select employee_id from exit_requests where id = ${exitId}`;
  if (!x) throw new AppError("not_found", "Exit not found.");
  const s = await settlementOf(tx, exitId);
  const payroll = canRunPayroll(actor);
  // The amount is pay data: only payroll and the person themselves see it; anyone else who can open the exit sees the status.
  const seesAmount = payroll || x.employee_id === actor.employeeId;
  return { status: s?.status ?? null, net: seesAmount && s?.net_paise != null ? N(s.net_paise) : null, canOpen: payroll, monthEnd: s?.settlement_month ? monthEnd(s.settlement_month) : null };
}
