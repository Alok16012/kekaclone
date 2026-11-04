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
type Settlement = { id: string; status: "draft" | "approved" | "finalized"; mode: "one_time" | "periodic"; items: FnfItem[]; net_paise: bigint | null; statement_file_id: string | null; settlement_month: string | null; updated_at: Date };
const settlementOf = async (tx: Tx, exitId: string) =>
  (await tx<Settlement[]>`select id, status, mode, items, net_paise, statement_file_id, settlement_month::text, updated_at from fnf_settlements where exit_request_id = ${exitId}`)[0] ?? null;
export type Part = { id: string; part_no: number; settlement_month: string; item_keys: string[]; net_paise: bigint | null; status: "draft" | "finalized"; statement_file_id: string | null; finalized_at: Date | null };
const partsOf = (tx: Tx, settlementId: string) =>
  tx<Part[]>`select id, part_no, settlement_month::text, item_keys, net_paise, status, statement_file_id, finalized_at from fnf_settlement_parts where settlement_id = ${settlementId} order by part_no`;
export type PartView = { partNo: number; month: string; status: "draft" | "finalized"; net: number; fileId: string | null; finalizedAt: string | null; itemKeys: string[] };
const partView = (items: FnfItem[]) => (p: Part): PartView => ({
  partNo: p.part_no, month: p.settlement_month, status: p.status, fileId: p.statement_file_id, finalizedAt: p.finalized_at?.toISOString() ?? null, itemKeys: p.item_keys,
  net: p.status === "finalized" ? N(p.net_paise) : fnfNet(items.filter((i) => i.part === p.part_no)),
});

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
  settlement: { status: string; mode: "one_time" | "periodic"; items: FnfItem[]; net: number; fileId: string | null; updatedAt: string; parts: PartView[] } | null;
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
    settlement: s ? { status: s.status, mode: s.mode, items: s.items, net: N(s.net_paise), fileId: s.statement_file_id, updatedAt: s.updated_at.toISOString(), parts: (await partsOf(tx, s.id)).map(partView(s.items)) } : null,
    preview: auto.items, notes: auto.notes, prerequisite: await prerequisite(tx, x), self, canEdit: !self && s?.status !== "finalized" && ["in_progress", "exited"].includes(x.status),
  };
}

async function editable(tx: Tx, actor: Actor, exitId: string) {
  assertRunPayroll(actor);
  const x = await exitRow(tx, exitId);
  assertNotSelf(actor, x.employee_id, "work on your own final settlement");
  if (!["in_progress", "exited"].includes(x.status)) throw new AppError("invalid", "Settlements are for exits that are under way or complete.");
  const [s] = await tx<Settlement[]>`select id, status, mode, items, net_paise, statement_file_id, settlement_month::text, updated_at from fnf_settlements where exit_request_id = ${exitId} for update`;
  if (s?.status === "finalized") throw new AppError("conflict", "This settlement is finalised and can't change.");
  return { x, s: s ?? null };
}
/** Keys of items already paid in a finalised part: they can't change any more. */
async function frozenKeys(tx: Tx, s: Settlement | null) {
  if (!s || s.mode !== "periodic") return new Set<string>();
  return new Set((await partsOf(tx, s.id)).filter((p) => p.status === "finalized").flatMap((p) => p.item_keys));
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
  const frozen = await frozenKeys(tx, s);
  const items = [...auto.items.map((i) => { const p = prior.get(i.key); return p && frozen.has(i.key) ? p : p && i.paise > 0 ? { ...i, action: p.action, part: p.part ?? null } : { ...i, part: p?.part ?? null }; }), ...(s?.items ?? []).filter((i) => !i.auto)];
  // auto items that vanished but were already paid in a part stay on the record
  for (const [k, p] of prior) if (p.auto && frozen.has(k) && !items.some((i) => i.key === k)) items.push(p);
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
  if ((await frozenKeys(tx, s)).has(key)) throw new AppError("conflict", "This item was paid in a finalised part, so it can't change.");
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
  if ((await frozenKeys(tx, s)).has(key)) throw new AppError("conflict", "This item was paid in a finalised part, so it can't be removed.");
  const net = await save(tx, actor, x, s, s.items.filter((i) => i.key !== key));
  await audit(tx, actor, { entityType: "fnf_settlement", entityId: exitId, action: "fnf.item_removed", diff: { key, net } });
  return { net };
}

/** Lock the settlement, render the statement PDF and tell the person. Needs last month's payroll finalised. */
export async function finalizeSettlement(tx: Tx, actor: Actor, exitId: string) {
  const { x, s } = await editable(tx, actor, exitId);
  if (!s) throw new AppError("invalid", "Work out the settlement first.");
  if (s.mode === "periodic") throw new AppError("invalid", "This settlement is paid in parts: finalise each part instead.");
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

// ---------------------------------------------------------------- partial / periodic settlement

const MAX_PARTS = 12;

/** Pay the settlement in one go (the default) or in parts, each with its own month and statement. */
export async function setSettlementMode(tx: Tx, actor: Actor, exitId: string, mode: "one_time" | "periodic") {
  if (mode !== "one_time" && mode !== "periodic") throw new AppError("invalid", "Pick one payment or payment in parts.");
  const { x, s } = await editable(tx, actor, exitId);
  if (!s) throw new AppError("invalid", "Work out the settlement first.");
  if (s.mode === mode) return;
  const parts = await partsOf(tx, s.id);
  if (parts.some((p) => p.status === "finalized")) throw new AppError("conflict", "A part has already been finalised, so the settlement stays in parts.");
  if (mode === "periodic") {
    if (!parts.length) await tx`insert into fnf_settlement_parts (tenant_id, settlement_id, part_no, settlement_month) values (${actor.tenant.id}, ${s.id}, 1, ${monthStart(x.last_working_date)})`;
    await tx`update fnf_settlements set mode = 'periodic', items = ${tx.json(s.items.map((i) => ({ ...i, part: i.part ?? 1 })) as never)}, updated_at = now() where id = ${s.id}`;
  } else {
    await tx`delete from fnf_settlement_parts where settlement_id = ${s.id}`;
    await tx`update fnf_settlements set mode = 'one_time', items = ${tx.json(s.items.map((i) => ({ ...i, part: null })) as never)}, updated_at = now() where id = ${s.id}`;
  }
  await audit(tx, actor, { entityType: "fnf_settlement", entityId: exitId, action: "fnf.mode", diff: { mode } });
}

/** Add a part or change the month a draft part is paid in. Months run from the last working day's month on. */
export async function saveSettlementPart(tx: Tx, actor: Actor, exitId: string, partNo: number, month: string) {
  if (!Number.isInteger(partNo) || partNo < 1 || partNo > MAX_PARTS) throw new AppError("invalid", `Parts are numbered 1 to ${MAX_PARTS}.`);
  if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(month)) throw new AppError("invalid", "Pick a month.", "month");
  const { x, s } = await editable(tx, actor, exitId);
  if (!s || s.mode !== "periodic") throw new AppError("invalid", "Switch the settlement to payment in parts first.");
  if (month < monthStart(x.last_working_date)) throw new AppError("invalid", `Parts are paid from ${monthLabel(monthStart(x.last_working_date))} on.`, "month");
  const parts = await partsOf(tx, s.id);
  const cur = parts.find((p) => p.part_no === partNo);
  if (cur?.status === "finalized") throw new AppError("conflict", "This part is finalised; its month can't change.");
  if (!cur && partNo !== parts.length + 1) throw new AppError("invalid", `Add part ${parts.length + 1} next.`);
  await tx`insert into fnf_settlement_parts (tenant_id, settlement_id, part_no, settlement_month) values (${actor.tenant.id}, ${s.id}, ${partNo}, ${month})
           on conflict (settlement_id, part_no) do update set settlement_month = excluded.settlement_month, updated_at = now()`;
  await audit(tx, actor, { entityType: "fnf_settlement", entityId: exitId, action: "fnf.part_saved", diff: { partNo, month } });
}

/** Remove the last draft part; its items go back to part 1. */
export async function removeSettlementPart(tx: Tx, actor: Actor, exitId: string, partNo: number) {
  const { x, s } = await editable(tx, actor, exitId);
  if (!s || s.mode !== "periodic") throw new AppError("invalid", "This settlement isn't paid in parts.");
  const parts = await partsOf(tx, s.id);
  const last = parts[parts.length - 1];
  if (!last || last.part_no !== partNo || partNo === 1) throw new AppError("invalid", "Only the last part can be removed, and part 1 stays.");
  if (last.status === "finalized") throw new AppError("conflict", "This part is finalised.");
  await tx`delete from fnf_settlement_parts where id = ${last.id}`;
  await save(tx, actor, x, s, s.items.map((i) => (i.part === partNo ? { ...i, part: 1 } : i)));
  await audit(tx, actor, { entityType: "fnf_settlement", entityId: exitId, action: "fnf.part_removed", diff: { partNo } });
}

/** Put an item into a part. */
export async function assignItemPart(tx: Tx, actor: Actor, exitId: string, key: string, partNo: number) {
  const { x, s } = await editable(tx, actor, exitId);
  if (!s || s.mode !== "periodic") throw new AppError("invalid", "This settlement isn't paid in parts.");
  const it = s.items.find((i) => i.key === key);
  if (!it) throw new AppError("not_found", "Item not found.");
  const parts = await partsOf(tx, s.id);
  const target = parts.find((p) => p.part_no === partNo);
  if (!target) throw new AppError("invalid", "Add that part first.");
  if (target.status === "finalized") throw new AppError("conflict", "That part is already finalised.");
  if ((await frozenKeys(tx, s)).has(key)) throw new AppError("conflict", "This item was paid in a finalised part.");
  await save(tx, actor, x, s, s.items.map((i) => (i.key === key ? { ...i, part: partNo } : i)));
  await audit(tx, actor, { entityType: "fnf_settlement", entityId: exitId, action: "fnf.item_part", diff: { key, partNo } });
}

/**
 * Lock one part: its items are paid (loans and expense claims in it are settled), it gets its own statement, and the
 * person is told. When every item to pay sits in a finalised part, the settlement itself is finalised.
 */
export async function finalizeSettlementPart(tx: Tx, actor: Actor, exitId: string, partNo: number) {
  const { x, s } = await editable(tx, actor, exitId);
  if (!s || s.mode !== "periodic") throw new AppError("invalid", "This settlement isn't paid in parts.");
  const parts = await partsOf(tx, s.id);
  const part = parts.find((p) => p.part_no === partNo);
  if (!part) throw new AppError("not_found", "Part not found.");
  if (part.status === "finalized") throw new AppError("conflict", "This part is already finalised.");
  const earlier = parts.find((p) => p.part_no < partNo && p.status !== "finalized");
  if (earlier) throw new AppError("invalid", `Finalise part ${earlier.part_no} first: parts are paid in order.`);
  const mine = s.items.filter((i) => i.part === partNo);
  if (!mine.some((i) => i.action === "pay" || i.action === "paid_outside")) throw new AppError("invalid", "Put at least one item to pay into this part first.");
  if (mine.some((i) => i.key === "salary" && i.action === "pay")) {
    const pre = await prerequisite(tx, x);
    if (!pre.ok) throw new AppError("invalid", pre.message!);
    const [open] = await tx<{ status: string }[]>`
      select r.status from payroll_runs r join payroll_lines l on l.run_id = r.id
      where r.pay_group_id = ${x.pay_group_id} and r.period_month = ${part.settlement_month} and r.status in ('draft','in_progress') and l.employee_id = ${x.employee_id} and l.action = 'process'`;
    if (open) throw new AppError("conflict", `${x.name} is also in the ${monthLabel(part.settlement_month)} payroll run. Recalculate that run after finalising, or mark the salary here as paid separately.`);
  }
  const net = fnfNet(mine);
  const [t] = await tx<{ name: string }[]>`select name from tenants where id = ${actor.tenant.id}`;
  const today = new Date().toISOString().slice(0, 10);
  const bytes = await renderFnfStatement({
    company: t?.name ?? actor.tenant.name, legalEntity: x.legal_entity ?? "",
    employee: { name: x.name, number: x.number, designation: x.designation, department: x.department, joining: x.joining_date, lastDay: x.last_working_date, reason: `${x.reason ?? "-"} · part ${partNo} of ${parts.length}, ${monthLabel(part.settlement_month)}` },
    items: mine, net, finalizedOn: today, unverified: await ratesNeedVerification(tx),
  });
  const fileId = await saveFile(tx, { tenantId: actor.tenant.id, userId: actor.userId, name: `Final settlement ${x.number} part ${partNo}.pdf`, mime: "application/pdf", bytes, ext: "pdf" });
  for (const i of mine) {
    if (!i.key.startsWith("loan:") || i.action !== "pay" || i.paise <= 0) continue;
    await recoverLoanInFnf(tx, actor, i.key.slice(5), { amountPaise: i.paise, paidOn: today, reference: `Final settlement ${x.number} part ${partNo}` }, today);
  }
  await settleClaimsInFnf(tx, actor, mine.filter((i) => i.key.startsWith("expense:") && (i.action === "pay" || i.action === "paid_outside")).map((i) => i.key.slice(8)), `Final settlement ${x.number} part ${partNo}`);
  await tx`update fnf_settlement_parts set status = 'finalized', net_paise = ${net}, item_keys = ${mine.map((i) => i.key)}::text[], statement_file_id = ${fileId}, finalized_at = now(), updated_at = now() where id = ${part.id}`;
  const left = s.items.filter((i) => (i.action === "pay" || i.action === "paid_outside") && i.part !== partNo && !parts.some((p) => p.status === "finalized" && p.item_keys.includes(i.key)));
  const done = left.length === 0;
  await tx`update fnf_settlements set ${done ? tx`status = 'finalized', settlement_month = ${part.settlement_month},` : tx``} net_paise = ${fnfNet(s.items)}, statement_file_id = ${fileId}, updated_at = now() where id = ${s.id}`;
  await notifyEmployee(tx, actor.tenant.id, x.employee_id, "payroll.fnf", done ? "Your full and final settlement is complete" : `Part ${partNo} of your final settlement is ready`, "Open My finances to download the statement.", "/me/pay");
  await audit(tx, actor, { entityType: "fnf_settlement", entityId: exitId, action: "fnf.part_finalized", diff: { partNo, net, items: mine.length, settlementFinalized: done } });
  return { net, fileId, settlementFinalized: done };
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
