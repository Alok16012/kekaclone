import "server-only";
import { z } from "zod";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import type { Placement } from "@/server/auth/permissions";
import { audit } from "@/server/modules/audit/service";
import { cancelApproval, notifyEmployee, startApproval, timeline } from "@/server/modules/approvals/service";
import { canPayrollFor, hasAnyPayrollAdmin, isPayrollAdmin } from "@/server/modules/payroll/access";
import { markOpenRunStale } from "@/server/modules/payrun/stale";
import { todayIn } from "@/lib/dates";
import {
  bpToRate, buildSchedule, checkFirstEmiMonth, checkRequest, defaultFirstEmiMonth, emiFor, formatPaise, isMonth, monthLabel, monthOf,
  outstandingPrincipal, planPrepayment, preEmiInterest, rateToBp, RATE_TYPES, scheduleTotals, skipTarget, type RateType,
} from "./rules";

const N = (v: bigint | number | string | null | undefined) => (v == null ? 0 : Number(v));
const bad = (message: string, field?: string) => new AppError("invalid", message, field);
const LOCKED_RUN = ["finalized", "payslips_released", "paid"];

type Person = Placement & { id: string; display_name: string; status: string; pay_group_id: string | null; manager_id: string | null };
async function person(tx: Tx, id: string): Promise<Person> {
  const [p] = await tx<Person[]>`select id, display_name, status, pay_group_id, manager_id, department_id, location_id, legal_entity_id, business_unit_id from employees where id = ${id}`;
  if (!p) throw new AppError("not_found", "Person not found.");
  return p;
}

// ---------------------------------------------------------------- categories (company policy)
export type CategoryRow = { id: string; name: string; maxAmountPaise: number | null; maxTenureMonths: number | null; interestRate: string; rateBp: number; rateType: RateType; loans: number; open: number };

export async function listCategories(tx: Tx): Promise<CategoryRow[]> {
  const rows = await tx<{ id: string; name: string; max_amount_paise: bigint | null; max_tenure_months: number | null; interest_rate: string; rate_type: RateType; loans: number; open: number }[]>`
    select c.id, c.name, c.max_amount_paise, c.max_tenure_months, c.interest_rate::text, c.rate_type,
      (select count(*)::int from loans l where l.category_id = c.id) as loans,
      (select count(*)::int from loans l where l.category_id = c.id and l.status in ('requested','approved','active')) as open
    from loan_categories c order by c.name`;
  return rows.map((r) => ({ id: r.id, name: r.name, maxAmountPaise: r.max_amount_paise == null ? null : N(r.max_amount_paise), maxTenureMonths: r.max_tenure_months, interestRate: r.interest_rate, rateBp: rateToBp(r.interest_rate) ?? 0, rateType: r.rate_type, loans: r.loans, open: r.open }));
}

const categoryInput = z.object({
  name: z.string().trim().min(2, "Enter a name.").max(80),
  maxAmountPaise: z.number().int().positive("The limit must be more than ₹0.").max(1_00_00_000_00).nullable(),
  maxTenureMonths: z.number().int().min(1, "Allow at least 1 month.").max(360, "At most 360 months.").nullable(),
  rateType: z.enum(RATE_TYPES),
  interestRate: z.string().trim(),
});

export const DEFAULT_CATEGORIES = [
  { name: "Salary advance", maxAmountPaise: 50_000_00, maxTenureMonths: 6, rateType: "zero" as const, interestRate: "0" },
  { name: "Emergency loan", maxAmountPaise: 2_00_000_00, maxTenureMonths: 12, rateType: "zero" as const, interestRate: "0" },
  { name: "Personal loan", maxAmountPaise: 5_00_000_00, maxTenureMonths: 36, rateType: "reducing" as const, interestRate: "8.00" },
];

/** Starter loan types for a new company. Idempotent. Company policy figures, not statutory. */
export async function ensureLoanDefaults(tx: Tx, tenantId: string) {
  for (const c of DEFAULT_CATEGORIES) {
    await tx`insert into loan_categories (tenant_id, name, max_amount_paise, max_tenure_months, interest_rate, rate_type)
             values (${tenantId}, ${c.name}, ${c.maxAmountPaise}, ${c.maxTenureMonths}, ${c.interestRate}, ${c.rateType}) on conflict (tenant_id, name) do nothing`;
  }
}

/** Loan types are company policy: payroll.admin without a scope. Existing loans keep the terms they were given. */
export async function saveCategory(tx: Tx, actor: Actor, id: string | null, raw: unknown) {
  if (!isPayrollAdmin(actor)) throw new AppError("forbidden", "Only payroll admins for the whole company can change loan types.");
  const p = categoryInput.safeParse(raw);
  if (!p.success) throw bad(p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
  const v = p.data;
  const bp = v.rateType === "zero" ? 0 : rateToBp(v.interestRate);
  if (bp == null) throw bad("Enter the yearly interest rate, like 8 or 9.5.", "interestRate");
  if (v.rateType !== "zero" && bp === 0) throw bad("Pick “Interest-free” for loans without interest.", "interestRate");
  const rate = bpToRate(bp);
  try {
    const r = await tx.savepoint(async (sp) => id
      ? sp<{ id: string }[]>`update loan_categories set name = ${v.name}, max_amount_paise = ${v.maxAmountPaise}, max_tenure_months = ${v.maxTenureMonths}, rate_type = ${v.rateType}, interest_rate = ${rate}, updated_at = now() where id = ${id} returning id`
      : sp<{ id: string }[]>`insert into loan_categories (tenant_id, name, max_amount_paise, max_tenure_months, rate_type, interest_rate) values (${actor.tenant.id}, ${v.name}, ${v.maxAmountPaise}, ${v.maxTenureMonths}, ${v.rateType}, ${rate}) returning id`);
    if (!r[0]) throw new AppError("not_found", "Loan type not found.");
    await audit(tx, actor, { entityType: "loan_category", entityId: r[0].id, action: id ? "update" : "create", diff: { ...v, interestRate: rate } });
    return { id: r[0].id };
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new AppError("conflict", "A loan type with this name already exists.", "name");
    throw e;
  }
}

export async function deleteCategory(tx: Tx, actor: Actor, id: string) {
  if (!isPayrollAdmin(actor)) throw new AppError("forbidden", "Only payroll admins for the whole company can change loan types.");
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from loans where category_id = ${id}`;
  if (n) throw bad("Loans have been given under this type, so it can't be deleted.");
  const r = await tx`delete from loan_categories where id = ${id}`;
  if (!r.count) throw new AppError("not_found", "Loan type not found.");
  await audit(tx, actor, { entityType: "loan_category", entityId: id, action: "delete" });
}

// ---------------------------------------------------------------- loans
type LoanRaw = {
  id: string; employee_id: string; category_id: string; category: string; principal_paise: bigint; interest_rate: string; rate_type: RateType; tenure_months: number;
  emi_paise: bigint | null; disbursed_on: string | null; first_emi_month: string | null; reason: string | null; status: string; pre_emi_interest_paise: bigint;
  disbursal_ref: string | null; closed_on: string | null; created_at: Date;
};
const loanCols = (tx: Tx) => tx`l.id, l.employee_id, l.category_id, c.name as category, l.principal_paise, l.interest_rate::text, l.rate_type, l.tenure_months, l.emi_paise,
  l.disbursed_on::text, l.first_emi_month::text, l.reason, l.status, l.pre_emi_interest_paise, l.disbursal_ref, l.closed_on::text, l.created_at`;
async function loanRow(tx: Tx, id: string, lock = false) {
  const [l] = lock
    ? await tx<LoanRaw[]>`select ${loanCols(tx)} from loans l join loan_categories c on c.id = l.category_id where l.id = ${id} for update of l`
    : await tx<LoanRaw[]>`select ${loanCols(tx)} from loans l join loan_categories c on c.id = l.category_id where l.id = ${id}`;
  return l ?? null;
}

type InstRaw = { id: string; due_month: string; principal_paise: bigint; interest_paise: bigint; status: "scheduled" | "deducted" | "skipped" | "prepaid"; in_payroll: boolean; locked: boolean };
async function installments(tx: Tx, loanId: string, payGroupId: string | null) {
  return tx<InstRaw[]>`
    select i.id, i.due_month::text, i.principal_paise, i.interest_paise, i.status,
      exists (select 1 from payroll_inputs p where p.kind = 'loan_emi' and p.source_ref->>'loan_installment_id' = i.id::text) as in_payroll,
      exists (select 1 from payroll_runs r where r.pay_group_id = ${payGroupId} and r.period_month = i.due_month and r.status in ${tx(LOCKED_RUN)}) as locked
    from loan_installments i where i.loan_id = ${loanId} order by i.due_month`;
}
async function prepaidTotal(tx: Tx, loanId: string) {
  const [r] = await tx<{ s: bigint | null }[]>`select sum(amount_paise) as s from loan_prepayments where loan_id = ${loanId}`;
  return N(r?.s);
}

const requestInput = z.object({
  categoryId: z.uuid("Pick a loan type."),
  amountPaise: z.number().int(),
  months: z.number().int(),
  reason: z.string().trim().min(5, "Say briefly what the loan is for.").max(500),
});

/** Ask for a loan. It goes through approvals (manager, then a payroll admin) and is never approved by the person asking. */
export async function requestLoan(tx: Tx, actor: Actor, raw: unknown) {
  const p = requestInput.safeParse(raw);
  if (!p.success) throw bad(p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
  const v = p.data;
  const me = await person(tx, actor.employeeId);
  if (me.status === "relieved" || me.status === "notice") throw bad("Loans can't be requested during notice or after leaving.");
  const [c] = (await listCategories(tx)).filter((x) => x.id === v.categoryId);
  if (!c) throw bad("Pick a loan type.", "categoryId");
  const err = checkRequest({ name: c.name, maxAmountPaise: c.maxAmountPaise, maxTenureMonths: c.maxTenureMonths }, { amountPaise: v.amountPaise, months: v.months });
  if (err) throw bad(err.message, err.field === "amount" ? "amountPaise" : "months");
  const [open] = await tx`select 1 from loans where employee_id = ${me.id} and category_id = ${c.id} and status in ('requested','approved')`;
  if (open) throw new AppError("conflict", `You already have a ${c.name.toLowerCase()} request waiting. Withdraw it or wait for a decision first.`);
  const emi = emiFor({ principalPaise: v.amountPaise, rateBp: c.rateBp, rateType: c.rateType, months: v.months });
  const [l] = await tx<{ id: string }[]>`
    insert into loans (tenant_id, employee_id, category_id, principal_paise, interest_rate, rate_type, tenure_months, emi_paise, reason)
    values (${actor.tenant.id}, ${me.id}, ${c.id}, ${v.amountPaise}, ${c.interestRate}, ${c.rateType}, ${v.months}, ${emi}, ${v.reason}) returning id`;
  const summary = `${c.name}: ${formatPaise(v.amountPaise)} over ${v.months} month${v.months === 1 ? "" : "s"}`;
  const a = await startApproval(tx, { tenantId: actor.tenant.id, entityType: "loan", entityId: l.id, requesterId: me.id, summary });
  if (a.status === "approved") {
    // nobody else could be asked: a loan is never self-approved, so refuse instead of auto-approving
    throw new AppError("invalid", "There's nobody to approve a loan for you yet (no manager or other payroll admin). Ask HR to set one up.");
  }
  await audit(tx, actor, { entityType: "loan", entityId: l.id, action: "loan.request", diff: { categoryId: c.id, amountPaise: v.amountPaise, months: v.months } });
  return { id: l.id, emiPaise: emi };
}

/** Withdraw your own request while it waits for approval. */
export async function withdrawLoan(tx: Tx, actor: Actor, id: string) {
  const [l] = await tx<{ id: string }[]>`update loans set status = 'cancelled' where id = ${id} and employee_id = ${actor.employeeId} and status = 'requested' returning id`;
  if (!l) throw new AppError("conflict", "Only a request that's still waiting for approval can be withdrawn.");
  await cancelApproval(tx, "loan", id);
  await audit(tx, actor, { entityType: "loan", entityId: id, action: "loan.withdraw" });
}


/** Payroll admin for this person (in scope) and never for your own loan. */
async function adminLoan(tx: Tx, actor: Actor, id: string, lock = true) {
  const l = await loanRow(tx, id, lock);
  if (!l) throw new AppError("not_found", "Loan not found.");
  const p = await person(tx, l.employee_id);
  if (!canPayrollFor(actor, p)) throw new AppError("not_found", "Loan not found.");
  if (l.employee_id === actor.employeeId) throw new AppError("forbidden", "You can't manage your own loan. Another payroll admin has to.");
  return { l, p };
}

const disburseInput = z.object({
  disbursedOn: z.iso.date("Pick the date the money was paid."),
  firstEmiMonth: z.string(),
  reference: z.string().trim().max(120).optional(),
});

/** Record the payout (made outside erp, by bank transfer) and build the EMI schedule. Idempotent on an already-active loan. */
export async function disburseLoan(tx: Tx, actor: Actor, id: string, raw: unknown, today = todayIn()) {
  const { l, p } = await adminLoan(tx, actor, id);
  const v = disburseInput.safeParse(raw);
  if (!v.success) throw bad(v.error.issues[0].message, String(v.error.issues[0].path[0] ?? ""));
  const first = v.data.firstEmiMonth || defaultFirstEmiMonth(v.data.disbursedOn);
  if (l.status === "active" && l.disbursed_on === v.data.disbursedOn && l.first_emi_month === first) return { alreadyDone: true };
  if (l.status !== "approved") throw bad(l.status === "requested" ? "This loan is still waiting for approval." : "Only an approved loan can be paid out.");
  if (v.data.disbursedOn > today) throw bad("The payout date can't be in the future.", "disbursedOn");
  const e = checkFirstEmiMonth(v.data.disbursedOn, first);
  if (e) throw bad(e, "firstEmiMonth");
  if (!p.pay_group_id) throw bad(`${p.display_name} isn't in a pay group, so EMIs can't be taken from salary. Add them to one first.`);
  const [locked] = await tx`select 1 from payroll_runs where pay_group_id = ${p.pay_group_id} and period_month = ${first} and status in ${tx(LOCKED_RUN)}`;
  if (locked) throw bad(`Payroll for ${monthLabel(first)} is already finalised. Start EMIs from a later month.`, "firstEmiMonth");
  const rateBp = rateToBp(l.interest_rate) ?? 0;
  const pre = preEmiInterest({ principalPaise: N(l.principal_paise), rateBp, rateType: l.rate_type, disbursedOn: v.data.disbursedOn, firstEmiMonth: first });
  const rows = buildSchedule({ principalPaise: N(l.principal_paise), rateBp, rateType: l.rate_type, months: l.tenure_months, firstMonth: first, extraFirstInterestPaise: pre.interestPaise });
  for (const r of rows) {
    await tx`insert into loan_installments (tenant_id, loan_id, due_month, principal_paise, interest_paise) values (${actor.tenant.id}, ${l.id}, ${r.dueMonth}, ${r.principalPaise}, ${r.interestPaise})`;
  }
  await markOpenRunStale(tx, p.pay_group_id, first);   // an already-calculated run for that month must pick the first EMI up
  await tx`update loans set status = 'active', disbursed_on = ${v.data.disbursedOn}, first_emi_month = ${first}, pre_emi_interest_paise = ${pre.interestPaise},
             emi_paise = ${emiFor({ principalPaise: N(l.principal_paise), rateBp, rateType: l.rate_type, months: l.tenure_months })},
             disbursed_by = ${actor.userId}, disbursal_ref = ${v.data.reference || null} where id = ${l.id}`;
  await audit(tx, actor, { entityType: "loan", entityId: l.id, action: "loan.disburse", diff: { employeeId: l.employee_id, disbursedOn: v.data.disbursedOn, firstEmiMonth: first, preEmiInterestPaise: pre.interestPaise, installments: rows.length } });
  await notifyEmployee(tx, actor.tenant.id, l.employee_id, "loan.disbursed", "Your loan has been paid out",
    `${l.category}: ${formatPaise(N(l.principal_paise))}. EMIs start in ${monthLabel(first)}.`, "/me/loans");
  return { alreadyDone: false, installments: rows.length, preEmiInterestPaise: pre.interestPaise };
}

/** Cancel an approved loan before it's paid out (e.g. the person no longer needs it). */
export async function cancelApprovedLoan(tx: Tx, actor: Actor, id: string) {
  const { l } = await adminLoan(tx, actor, id);
  if (l.status !== "approved") throw bad("Only an approved loan that hasn't been paid out can be cancelled.");
  await tx`update loans set status = 'cancelled' where id = ${l.id}`;
  await audit(tx, actor, { entityType: "loan", entityId: l.id, action: "loan.cancel", diff: { employeeId: l.employee_id } });
  await notifyEmployee(tx, actor.tenant.id, l.employee_id, "loan.cancelled", "Your loan was cancelled", `${l.category}: ${formatPaise(N(l.principal_paise))}. Talk to your payroll team if this is unexpected.`, "/me/loans");
}

/** Remove an installment's payroll input if payroll hasn't locked that month (the EMI changed or was skipped). */
async function dropInput(tx: Tx, installmentId: string) {
  const gone = await tx<{ pay_group_id: string; period_month: string }[]>`
    delete from payroll_inputs p where p.kind = 'loan_emi' and p.source_ref->>'loan_installment_id' = ${installmentId}
      and not exists (select 1 from payroll_runs r where r.pay_group_id = p.pay_group_id and r.period_month = p.period_month and r.status in ${tx(LOCKED_RUN)})
    returning p.pay_group_id, p.period_month::text`;
  // an open run that already took this EMI must be recalculated before it can be finalised
  for (const g of gone) await markOpenRunStale(tx, g.pay_group_id, g.period_month);
}

/** Skip one month's EMI: it moves after the last EMI (no extra interest). Not for a month payroll has finalised. */
export async function skipEmi(tx: Tx, actor: Actor, id: string, month: string, reason?: string) {
  const { l, p } = await adminLoan(tx, actor, id);
  if (l.status !== "active") throw bad("Only a loan being repaid can skip an EMI.");
  if (!isMonth(month)) throw bad("Pick the month to skip.", "month");
  const rows = await installments(tx, l.id, p.pay_group_id);
  const row = rows.find((r) => r.due_month === month);
  if (row?.locked) throw bad(`Payroll for ${monthLabel(month)} is already finalised, so that EMI can't be skipped.`);
  const t = skipTarget(rows.map((r) => ({ dueMonth: r.due_month, status: r.status })), month);
  if (!t.ok) throw bad(t.error, "month");
  await tx`update loan_installments set status = 'skipped' where id = ${row!.id} and status = 'scheduled'`;
  await dropInput(tx, row!.id);
  await tx`insert into loan_installments (tenant_id, loan_id, due_month, principal_paise, interest_paise) values (${actor.tenant.id}, ${l.id}, ${t.newMonth}, ${N(row!.principal_paise)}, ${N(row!.interest_paise)})`;
  await tx`update loans set tenure_months = tenure_months + 1 where id = ${l.id}`;
  await audit(tx, actor, { entityType: "loan", entityId: l.id, action: "loan.skip_emi", diff: { employeeId: l.employee_id, month, movedTo: t.newMonth, reason: reason ?? null } });
  await notifyEmployee(tx, actor.tenant.id, l.employee_id, "loan.skip", "A loan EMI was skipped", `No EMI will be taken in ${monthLabel(month)}. It moves to ${monthLabel(t.newMonth)}.`, "/me/loans");
  return { movedTo: t.newMonth };
}

const prepayInput = z.object({
  amountPaise: z.number().int().positive("Enter the amount paid back."),
  paidOn: z.iso.date("Pick the date it was paid."),
  reference: z.string().trim().max(120).optional(),
});

/**
 * Money paid back outside payroll (bank transfer, or recovered in the final settlement). Full payment closes the loan;
 * part payment rebuilds the open EMIs on the lower balance over the same months. Pays principal only.
 */
export async function prepayLoan(tx: Tx, actor: Actor, id: string, raw: unknown, today = todayIn()) {
  const { l, p } = await adminLoan(tx, actor, id);
  return applyPrepayment(tx, actor, l, p, raw, today);
}

/**
 * Full and final settlement: recover what's left of a leaver's loan out of the settlement (recorded as a prepayment).
 * The caller (payrun F&F finalise) has already checked the actor may run payroll and isn't settling their own exit.
 */
export async function recoverLoanInFnf(tx: Tx, actor: Actor, id: string, raw: unknown, today = todayIn()) {
  const l = await loanRow(tx, id, true);
  if (!l) throw new AppError("not_found", "Loan not found.");
  if (l.employee_id === actor.employeeId) throw new AppError("forbidden", "You can't settle your own loan. Another payroll admin has to.");
  return applyPrepayment(tx, actor, l, await person(tx, l.employee_id), raw, today);
}

async function applyPrepayment(tx: Tx, actor: Actor, l: NonNullable<Awaited<ReturnType<typeof loanRow>>>, p: Awaited<ReturnType<typeof person>>, raw: unknown, today: string) {
  if (l.status !== "active") throw bad("Only a loan being repaid can take a prepayment.");
  const v = prepayInput.safeParse(raw);
  if (!v.success) throw bad(v.error.issues[0].message, String(v.error.issues[0].path[0] ?? ""));
  if (v.data.paidOn > today) throw bad("The payment date can't be in the future.", "paidOn");
  if (l.disbursed_on && v.data.paidOn < l.disbursed_on) throw bad("The payment can't be before the loan was paid out.", "paidOn");
  const rows = await installments(tx, l.id, p.pay_group_id);
  const outstanding = outstandingPrincipal(N(l.principal_paise), rows.map((r) => ({ principalPaise: N(r.principal_paise), status: r.status })), await prepaidTotal(tx, l.id));
  const lockedRows = rows.filter((r) => r.status === "scheduled" && r.locked);
  const openRows = rows.filter((r) => r.status === "scheduled" && !r.locked);
  const plan = planPrepayment({
    terms: { rateBp: rateToBp(l.interest_rate) ?? 0, rateType: l.rate_type }, outstandingPaise: outstanding,
    lockedPrincipalPaise: lockedRows.reduce((s, r) => s + N(r.principal_paise), 0), amountPaise: v.data.amountPaise, openMonths: openRows.map((r) => r.due_month),
  });
  if (!plan.ok) throw bad(plan.error, "amountPaise");
  await tx`insert into loan_prepayments (tenant_id, loan_id, paid_on, amount_paise, reference, closes_loan, recorded_by)
           values (${actor.tenant.id}, ${l.id}, ${v.data.paidOn}, ${v.data.amountPaise}, ${v.data.reference || null}, ${plan.closes}, ${actor.userId})`;
  for (const r of openRows) await dropInput(tx, r.id);
  if (plan.closes) {
    if (openRows.length) await tx`update loan_installments set status = 'prepaid' where id = any(${openRows.map((r) => r.id)}::uuid[])`;
    if (!lockedRows.length) await tx`update loans set status = 'closed', closed_on = ${v.data.paidOn} where id = ${l.id}`;
  } else {
    await tx`delete from loan_installments where id = any(${openRows.map((r) => r.id)}::uuid[])`;
    for (const r of plan.rows) await tx`insert into loan_installments (tenant_id, loan_id, due_month, principal_paise, interest_paise) values (${actor.tenant.id}, ${l.id}, ${r.dueMonth}, ${r.principalPaise}, ${r.interestPaise})`;
  }
  await audit(tx, actor, { entityType: "loan", entityId: l.id, action: plan.closes ? "loan.close" : "loan.prepay", diff: { employeeId: l.employee_id, amountPaise: v.data.amountPaise, paidOn: v.data.paidOn, outstandingBeforePaise: outstanding } });
  await notifyEmployee(tx, actor.tenant.id, l.employee_id, "loan.prepay", plan.closes ? "Your loan is paid off" : "Your loan prepayment was recorded",
    plan.closes ? `${l.category}: nothing more will be taken from your salary${lockedRows.length ? " after this month's EMI" : ""}.` : `${l.category}: ${formatPaise(v.data.amountPaise)} received. Your remaining EMIs are lower now.`, "/me/loans");
  return { closed: plan.closes && !lockedRows.length, outstandingPaise: outstanding - v.data.amountPaise };
}

// ---------------------------------------------------------------- reading loans
export type LoanView = {
  id: string; employeeId: string; employee: string; category: string; principalPaise: number; interestRate: string; rateType: RateType; tenureMonths: number;
  emiPaise: number | null; disbursedOn: string | null; firstEmiMonth: string | null; reason: string | null; status: string; preEmiInterestPaise: number;
  disbursalRef: string | null; closedOn: string | null; createdAt: string; outstandingPaise: number; repaidPaise: number; nextDue: { month: string; amountPaise: number } | null;
};

async function toView(tx: Tx, l: LoanRaw & { employee: string; pay_group_id: string | null }): Promise<LoanView & { schedule: { id: string; dueMonth: string; principalPaise: number; interestPaise: number; status: string; inPayroll: boolean; locked: boolean }[]; prepayments: { paidOn: string; amountPaise: number; reference: string | null }[] }> {
  const rows = ["active", "closed", "written_off", "disbursed"].includes(l.status) ? await installments(tx, l.id, l.pay_group_id) : [];
  const pre = await tx<{ paid_on: string; amount_paise: bigint; reference: string | null }[]>`select paid_on::text, amount_paise, reference from loan_prepayments where loan_id = ${l.id} order by paid_on, created_at`;
  const prepaid = pre.reduce((s, r) => s + N(r.amount_paise), 0);
  const outstanding = ["active", "disbursed"].includes(l.status) ? outstandingPrincipal(N(l.principal_paise), rows.map((r) => ({ principalPaise: N(r.principal_paise), status: r.status })), prepaid) : 0;
  const next = rows.find((r) => r.status === "scheduled");
  return {
    id: l.id, employeeId: l.employee_id, employee: l.employee, category: l.category, principalPaise: N(l.principal_paise), interestRate: l.interest_rate, rateType: l.rate_type,
    tenureMonths: l.tenure_months, emiPaise: l.emi_paise == null ? null : N(l.emi_paise), disbursedOn: l.disbursed_on, firstEmiMonth: l.first_emi_month, reason: l.reason,
    status: l.status, preEmiInterestPaise: N(l.pre_emi_interest_paise), disbursalRef: l.disbursal_ref, closedOn: l.closed_on, createdAt: l.created_at.toISOString(),
    outstandingPaise: outstanding, repaidPaise: N(l.principal_paise) - outstanding,
    nextDue: next && l.status === "active" ? { month: next.due_month, amountPaise: N(next.principal_paise) + N(next.interest_paise) } : null,
    schedule: rows.map((r) => ({ id: r.id, dueMonth: r.due_month, principalPaise: N(r.principal_paise), interestPaise: N(r.interest_paise), status: r.status, inPayroll: r.in_payroll, locked: r.locked })),
    prepayments: pre.map((r) => ({ paidOn: r.paid_on, amountPaise: N(r.amount_paise), reference: r.reference })),
  };
}
export type LoanDetail = Awaited<ReturnType<typeof toView>> & { steps: Awaited<ReturnType<typeof timeline>>; canManage: boolean; mine: boolean; preview: { emiPaise: number; totalInterestPaise: number } };

const listCols = (tx: Tx) => tx`${loanCols(tx)}, e.display_name as employee, e.pay_group_id`;

/** One loan, for its owner, payroll admins covering them, or someone in its approval chain. */
export async function loanDetail(tx: Tx, actor: Actor, id: string): Promise<LoanDetail | null> {
  const [l] = await tx<(LoanRaw & { employee: string; pay_group_id: string | null })[]>`select ${listCols(tx)} from loans l join loan_categories c on c.id = l.category_id join employees e on e.id = l.employee_id where l.id = ${id}`;
  if (!l) return null;
  const p = await person(tx, l.employee_id);
  const mine = l.employee_id === actor.employeeId;
  const admin = canPayrollFor(actor, p);
  const [approver] = await tx`select 1 from approval_requests r join approval_steps s on s.request_id = r.id where r.entity_type = 'loan' and r.entity_id = ${id} and s.approver_employee_id = ${actor.employeeId}`;
  if (!mine && !admin && !approver) return null;
  const v = await toView(tx, l);
  const rateBp = rateToBp(l.interest_rate) ?? 0;
  const sched = buildSchedule({ principalPaise: N(l.principal_paise), rateBp, rateType: l.rate_type, months: l.tenure_months, firstMonth: l.first_emi_month ?? monthOf(todayIn()) });
  return { ...v, steps: await timeline(tx, "loan", id), canManage: admin && !mine, mine, preview: { emiPaise: emiFor({ principalPaise: N(l.principal_paise), rateBp, rateType: l.rate_type, months: l.tenure_months }), totalInterestPaise: scheduleTotals(sched).interestPaise } };
}

export async function myLoans(tx: Tx, actor: Actor) {
  const rows = await tx<(LoanRaw & { employee: string; pay_group_id: string | null })[]>`
    select ${listCols(tx)} from loans l join loan_categories c on c.id = l.category_id join employees e on e.id = l.employee_id where l.employee_id = ${actor.employeeId} order by l.created_at desc`;
  const loans = [];
  for (const r of rows) loans.push(await toView(tx, r));
  return { loans, categories: await listCategories(tx) };
}

/** Every loan for people this payroll admin covers (scoped admins see only their people). */
export async function loanDesk(tx: Tx, actor: Actor) {
  if (!hasAnyPayrollAdmin(actor)) throw new AppError("forbidden", "Only payroll admins can manage loans.");
  const rows = await tx<(LoanRaw & { employee: string; pay_group_id: string | null } & Placement)[]>`
    select ${listCols(tx)}, e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id
    from loans l join loan_categories c on c.id = l.category_id join employees e on e.id = l.employee_id
    where l.status not in ('cancelled') order by l.created_at desc`;
  const out: (LoanView & { mine: boolean })[] = [];
  for (const r of rows.filter((x) => canPayrollFor(actor, x))) {
    const v: Partial<Awaited<ReturnType<typeof toView>>> = await toView(tx, r);
    delete v.schedule; delete v.prepayments;
    out.push({ ...(v as LoanView), mine: r.employee_id === actor.employeeId });
  }
  return out;
}

// ---------------------------------------------------------------- payroll + final settlement
export type LoanEmiResult = { locked: boolean; written: number; updated: number; removed: number; totalPaise: number };

/**
 * Writes this month's loan EMIs for a pay group into payroll_inputs (kind 'loan_emi', one row per installment, amount =
 * principal + interest, details in source_ref). Idempotent: re-running updates changed amounts and removes inputs for EMIs
 * that were skipped, prepaid or rescheduled. Does nothing once payroll for that month is finalised. The payroll run calls it.
 */
export async function loanEmisForMonth(tx: Tx, payGroupId: string, month: string): Promise<LoanEmiResult> {
  if (!isMonth(month)) throw bad("Pick a month (the first day of it).");
  const [run] = await tx<{ status: string }[]>`select status from payroll_runs where pay_group_id = ${payGroupId} and period_month = ${month} and status <> 'rolled_back'`;
  if (run && LOCKED_RUN.includes(run.status)) return { locked: true, written: 0, updated: 0, removed: 0, totalPaise: 0 };
  const due = await tx<{ id: string; loan_id: string; employee_id: string; principal_paise: bigint; interest_paise: bigint; category: string }[]>`
    select i.id, i.loan_id, l.employee_id, i.principal_paise, i.interest_paise, c.name as category
    from loan_installments i join loans l on l.id = i.loan_id join loan_categories c on c.id = l.category_id join employees e on e.id = l.employee_id
    where e.pay_group_id = ${payGroupId} and l.status = 'active' and i.due_month = ${month} and i.status = 'scheduled'`;
  let written = 0, updated = 0, total = 0;
  for (const d of due) {
    const amount = N(d.principal_paise) + N(d.interest_paise);
    total += amount;
    const ref = { loan_installment_id: d.id, loan_id: d.loan_id, principal_paise: N(d.principal_paise), interest_paise: N(d.interest_paise) };
    const note = `Loan EMI: ${d.category}`;
    const [r] = await tx<{ inserted: boolean }[]>`
      insert into payroll_inputs (tenant_id, pay_group_id, period_month, employee_id, kind, amount_paise, source_month, source_ref, action, note)
      values (app_tenant(), ${payGroupId}, ${month}, ${d.employee_id}, 'loan_emi', ${amount}, ${month}, ${tx.json(ref)}, 'pay', ${note})
      on conflict ((source_ref->>'loan_installment_id')) where kind = 'loan_emi'
      do update set amount_paise = excluded.amount_paise, pay_group_id = excluded.pay_group_id, period_month = excluded.period_month,
        employee_id = excluded.employee_id, source_ref = excluded.source_ref, note = excluded.note
      where (payroll_inputs.amount_paise, payroll_inputs.pay_group_id, payroll_inputs.period_month, payroll_inputs.source_ref)
        is distinct from (excluded.amount_paise, excluded.pay_group_id, excluded.period_month, excluded.source_ref)
      returning (xmax = 0) as inserted`;
    if (r?.inserted) written++; else if (r) updated++;
  }
  const keep = due.map((d) => d.id);
  const gone = await tx`
    delete from payroll_inputs where kind = 'loan_emi' and pay_group_id = ${payGroupId} and period_month = ${month}
      and source_ref ? 'loan_installment_id' and not ((source_ref->>'loan_installment_id') = any(${keep}::text[]))`;   // hand-entered EMIs stay
  return { locked: false, written, updated, removed: gone.count, totalPaise: total };
}

/** After the payroll run for the month is paid: mark the EMIs it took as deducted and close loans with nothing left. */
export async function markLoanEmisDeducted(tx: Tx, payGroupId: string, month: string, opts: { runId?: string } = {}) {
  if (!isMonth(month)) throw bad("Pick a month (the first day of it).");
  // with a run: only EMIs that actually appear as a deduction on a processed line (not on a held or unpaid one)
  const inRun = opts.runId
    ? tx`and exists (select 1 from payroll_lines l where l.run_id = ${opts.runId} and l.employee_id = p.employee_id and l.action not in ('hold_processing','void')
                     and l.deductions @> jsonb_build_array(jsonb_build_object('inputId', p.id::text)))`
    : tx``;
  const rows = await tx<{ loan_id: string }[]>`
    update loan_installments i set status = 'deducted'
    from payroll_inputs p where p.kind = 'loan_emi' and p.pay_group_id = ${payGroupId} and p.period_month = ${month} and p.action in ('pay','partial','paid_outside')
      and p.source_ref->>'loan_installment_id' = i.id::text and i.status = 'scheduled' ${inRun}
    returning i.loan_id`;
  const loans = [...new Set(rows.map((r) => r.loan_id))];
  if (loans.length) {
    await tx`update loans l set status = 'closed', closed_on = (date_trunc('month', ${month}::date) + interval '1 month - 1 day')::date
             where l.id = any(${loans}::uuid[]) and l.status = 'active' and not exists (select 1 from loan_installments i where i.loan_id = l.id and i.status = 'scheduled')`;
  }
  return { deducted: rows.length };
}

/**
 * What a leaver still owes, for the final settlement: outstanding principal per open loan (interest not yet due is not
 * charged). To settle, the F&F flow records the recovery with prepayLoan(…, { amountPaise: outstanding }) once it's paid.
 */
export async function outstandingForFnf(tx: Tx, employeeId: string) {
  const rows = await tx<(LoanRaw & { employee: string; pay_group_id: string | null })[]>`
    select ${listCols(tx)} from loans l join loan_categories c on c.id = l.category_id join employees e on e.id = l.employee_id
    where l.employee_id = ${employeeId} and l.status in ('active','disbursed','approved') order by l.created_at`;
  const loans = [];
  for (const r of rows) {
    const v = await toView(tx, r);
    if (r.status === "approved") { loans.push({ loanId: r.id, category: r.category, status: r.status, principalPaise: v.principalPaise, outstandingPaise: 0, pendingInstallments: 0, scheduledInterestPaise: 0, lockedPaise: 0, note: "Approved but not paid out: cancel it instead." }); continue; }
    const pending = v.schedule.filter((s) => s.status === "scheduled");
    const locked = pending.filter((s) => s.locked).reduce((a, s) => a + s.principalPaise, 0);
    loans.push({ loanId: r.id, category: r.category, status: r.status, principalPaise: v.principalPaise, outstandingPaise: v.outstandingPaise, pendingInstallments: pending.length,
      scheduledInterestPaise: pending.reduce((a, s) => a + s.interestPaise, 0), lockedPaise: locked, note: null as string | null });
  }
  return { totalPaise: loans.reduce((s, l) => s + l.outstandingPaise - l.lockedPaise, 0), loans };
}

