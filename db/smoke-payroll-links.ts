/**
 * Smoke test for the links between payroll runs, tax declarations and loans, against the seeded demo tenant
 * (run `pnpm db:seed` first). Everything runs in rolled-back transactions.
 *   pnpm smoke:payroll-links
 *
 * Checks that: a payroll run turns the month's loan EMIs into deductions by itself (idempotent, follows the schedule);
 * paying a run marks only the EMIs that were really deducted; a submitted declaration drives the TDS regime and
 * deductions while a draft doesn't; and a leaver's full and final settlement recovers the loan's outstanding principal
 * and closes the loan when finalised.
 */
import assert from "node:assert/strict";
import { withTenant, sql, type Tx } from "@/server/db";
import { computeRun } from "@/server/modules/payrun/engine";
import * as runs from "@/server/modules/payrun/runs";
import * as fnf from "@/server/modules/payrun/fnf";
import * as loans from "@/server/modules/loans/service";
import { addMonths, monthStart } from "@/server/modules/payrun/rules";
import { todayIn } from "@/lib/dates";
import type { Actor } from "@/server/auth/session";
import { DEMO_SUBDOMAIN } from "./demo";

let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const rollback = async (tenantId: string, fn: (tx: Tx) => Promise<void>) =>
  withTenant(tenantId, async (tx) => { await fn(tx); throw new Error("rollback"); }).catch((e) => { if (e.message !== "rollback") throw e; });
type Item = { code: string; paise: number; inputId?: string };

async function main() {
  const [t] = await sql<{ id: string }[]>`select id from tenant_by_subdomain(${DEMO_SUBDOMAIN})`;
  assert.ok(t, "demo tenant exists (run pnpm db:seed)");
  const tenant = { id: t.id, name: "Acme Technologies", status: "trial", subdomain: DEMO_SUBDOMAIN };
  const actor = (first: string, permissions: string[] = []) => withTenant(tenant.id, async (tx) => {
    const [e] = await tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`;
    assert.ok(e, `${first} exists`);
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(permissions), grants: permissions.length ? [{ permissions, scopes: [] }] : [] } as Actor;
  });
  const karan = await actor("Karan", ["payroll.admin"]), sneha = await actor("Sneha"), arjun = await actor("Arjun"), meera = await actor("Meera");
  const today = todayIn(), openMonth = addMonths(monthStart(today), -1);
  const [open] = await withTenant(tenant.id, (tx) => tx<{ id: string; pay_group_id: string }[]>`select id, pay_group_id from payroll_runs where period_month = ${openMonth} and status in ('draft','in_progress')`);
  assert.ok(open, "the seed leaves last month's run open");
  const [loan] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from loans where employee_id = ${sneha.employeeId} and status = 'active'`);
  assert.ok(loan, "Sneha's seeded loan is being repaid");
  const lineOf = async (tx: Tx, who: Actor) => (await tx<{ id: string; action: string; deductions: Item[]; statutory: { tds: { regime: string; standardDeductionOnly: boolean } | null } }[]>`
    select id, action, deductions, statutory from payroll_lines where run_id = ${open.id} and employee_id = ${who.employeeId}`)[0];

  // ---------- loan EMIs flow into the run ----------
  await rollback(tenant.id, async (tx) => {
    // bring Sneha's first EMI into the open run's month
    const [first] = await tx<{ id: string; principal_paise: bigint; interest_paise: bigint }[]>`
      select id, principal_paise, interest_paise from loan_installments where loan_id = ${loan.id} and status = 'scheduled' order by due_month limit 1`;
    await tx`update loan_installments set due_month = ${openMonth} where id = ${first.id}`;
    const emi = Number(first.principal_paise) + Number(first.interest_paise);
    await computeRun(tx, open.id);
    const l1 = await lineOf(tx, sneha);
    const d1 = l1.deductions.filter((d) => d.code === "LOAN_EMI");
    assert.equal(d1.length, 1, "one EMI deduction"); assert.equal(d1[0].paise, emi, "EMI = principal + interest, in paise");
    await computeRun(tx, open.id);
    assert.equal((await lineOf(tx, sneha)).deductions.filter((d) => d.code === "LOAN_EMI").length, 1, "recalculating doesn't add it twice");
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from payroll_inputs where kind = 'loan_emi' and source_ref->>'loan_installment_id' = ${first.id}`;
    assert.equal(n, 1);
    // skipping the EMI takes it out of the run on the next calculation
    await loans.skipEmi(tx, karan, loan.id, openMonth, "Smoke test");
    await computeRun(tx, open.id);
    assert.equal((await lineOf(tx, sneha)).deductions.filter((d) => d.code === "LOAN_EMI").length, 0, "a skipped EMI leaves the run");
  });
  await rollback(tenant.id, async (tx) => {
    const [first] = await tx<{ id: string }[]>`select id from loan_installments where loan_id = ${loan.id} and status = 'scheduled' order by due_month limit 1`;
    await tx`update loan_installments set due_month = ${openMonth} where id = ${first.id}`;
    await computeRun(tx, open.id);
    // a held line didn't take the EMI, so paying the run doesn't mark it deducted
    const l = await lineOf(tx, sneha);
    await tx`update payroll_lines set action = 'hold_processing' where id = ${l.id}`;
    assert.equal((await loans.markLoanEmisDeducted(tx, open.pay_group_id, openMonth, { runId: open.id })).deducted, 0, "held line: EMI stays scheduled");
    await tx`update payroll_lines set action = 'process' where id = ${l.id}`;
    assert.equal((await loans.markLoanEmisDeducted(tx, open.pay_group_id, openMonth, { runId: open.id })).deducted, 1, "processed line: EMI deducted");
    const [s] = await tx<{ status: string }[]>`select status from loan_installments where id = ${first.id}`;
    assert.equal(s.status, "deducted");
  });
  ok("loans → payroll: the run writes the month's EMI as a deduction by itself (principal + interest, once, gone when skipped); paying marks only EMIs on processed lines");

  // ---------- tax declarations drive TDS ----------
  await rollback(tenant.id, async (tx) => {
    await tx`update employee_statutory set tax_regime = 'new' where employee_id = ${arjun.employeeId}`;
    await computeRun(tx, open.id);
    const a = (await lineOf(tx, arjun)).statutory.tds, s = (await lineOf(tx, sneha)).statutory.tds, m = (await lineOf(tx, meera)).statutory.tds;
    assert.ok(a && s && m, "TDS worked out");
    assert.equal(a.regime, "old", "Arjun's submitted declaration (old regime) wins over his profile");
    assert.equal(a.standardDeductionOnly, false, "Arjun's declared 80C, 80D and rent count");
    assert.equal(m.standardDeductionOnly, false, "Meera's submitted declaration counts");
    assert.equal(s.standardDeductionOnly, true, "Sneha's draft declaration doesn't count yet");
  });
  ok("tax → payroll: a submitted declaration sets the regime and deductions for TDS; a draft one doesn't");

  // ---------- F&F recovers the loan ----------
  await rollback(tenant.id, async (tx) => {
    const [x] = await tx<{ id: string; employee_id: string }[]>`select x.id, x.employee_id from exit_requests x join employees e on e.id = x.employee_id where e.first_name = 'Nikhil'`;
    assert.ok(x, "Nikhil's seeded exit");
    await tx`update loans set employee_id = ${x.employee_id} where id = ${loan.id}`;   // hand Sneha's loan to the leaver
    const owed = await loans.outstandingForFnf(tx, x.employee_id);
    assert.ok(owed.totalPaise > 0);
    await fnf.buildSettlement(tx, karan, x.id);
    const d = await fnf.fnfDetail(tx, karan, x.id);
    const item = d.settlement!.items.find((i) => i.key === `loan:${loan.id}`);
    assert.ok(item, "a loan line per open loan");
    assert.equal(item.paise, owed.totalPaise, "outstanding principal from the loans module (no future interest)");
    assert.equal(item.side, "deduction");
    // finalise as the seeded smoke does: open run first, then avoid paying the last salary twice
    const lwdMonth = (await tx<{ m: string }[]>`select date_trunc('month', last_working_date)::date::text as m from exit_requests where id = ${x.id}`)[0].m;
    if (!d.prerequisite.ok) {
      for (const s of (await runs.runView(tx, karan, open.id)).steps) if (!s.done) await runs.markReviewed(tx, karan, open.id, s.key, true);
      await runs.finalizeRun(tx, karan, open.id);
    }
    if (lwdMonth === openMonth && d.settlement!.items.some((i) => i.key === "salary" && i.action === "pay")) {
      const inOpen = (await runs.runView(tx, karan, open.id)).lines.some((l) => l.employee_id === x.employee_id && l.action === "process");
      if (inOpen) await fnf.setItemAction(tx, karan, x.id, "salary", "paid_outside");
    }
    await fnf.finalizeSettlement(tx, karan, x.id);
    const [l] = await tx<{ status: string }[]>`select status from loans where id = ${loan.id}`;
    const [p] = await tx<{ amount_paise: bigint; reference: string }[]>`select amount_paise, reference from loan_prepayments where loan_id = ${loan.id}`;
    assert.ok(p && Number(p.amount_paise) === owed.totalPaise && /Final settlement/.test(p.reference), "recovery recorded against the loan");
    if (owed.loans[0].lockedPaise === 0) assert.equal(l.status, "closed", "nothing left: the loan closes");
    assert.equal((await loans.outstandingForFnf(tx, x.employee_id)).totalPaise, 0);
  });
  ok("loans → F&F: the settlement recovers the outstanding principal per loan and finalising records it and closes the loan");

  console.log(`\n${passed} checks passed`);
  await sql.end();
}
main().catch(async (e) => { console.error("FAILED:", e); await sql.end(); process.exit(1); });
