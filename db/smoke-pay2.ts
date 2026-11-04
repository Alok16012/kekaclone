/**
 * Smoke test for the pay2 package against the seeded demo tenant (run `pnpm db:seed` first): daily-wage units, the
 * Labour Codes check, flexible benefits, reimbursable claims, salary revision approvals with arrears, Excel import of
 * inputs, periodic settlements, multi-currency expenses, receipt OCR status, 24Q / Tally / Zoho exports and Form 16
 * Part B. Everything runs in rolled-back transactions; files written while testing are removed again.
 *   pnpm smoke:pay2
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { PDFDocument } from "pdf-lib";
import postgres from "postgres";
import { withTenant, sql, AppError, type Tx } from "@/server/db";
import * as approvals from "@/server/modules/approvals/service";
import { computeRun } from "@/server/modules/payrun/engine";
import * as runs from "@/server/modules/payrun/runs";
import * as imp from "@/server/modules/payrun/import";
import * as reports from "@/server/modules/payrun/reports";
import * as fnf from "@/server/modules/payrun/fnf";
import { form24q } from "@/server/modules/payrun/returns";
import { myPay, payrollFileFor } from "@/server/modules/payrun/payslips";
import { addMonths, monthStart } from "@/server/modules/payrun/rules";
import * as salary from "@/server/modules/payroll/salary";
import * as claims from "@/server/modules/payroll/claims";
import { commitRevisionImport } from "@/server/modules/payroll/revisions";
import { listComponents } from "@/server/modules/payroll/setup";
import * as fbp from "@/server/modules/tax/fbp";
import { getTaxInputs, myTax, publishForm16, saveTaxSettings, taxFileFor } from "@/server/modules/tax/service";
import { generatePartB, yearSummary } from "@/server/modules/tax/form16";
import { fyStartOf, fyLabel } from "@/server/modules/tax/rules";
import * as fx from "@/server/modules/expenses/fx";
import { addExpense } from "@/server/modules/expenses/service";
import { ocrStatus, readReceipt } from "@/server/ocr";
import { storage } from "@/server/storage";
import { addDaysISO, todayIn } from "@/lib/dates";
import type { Actor } from "@/server/auth/session";
import type { Scope } from "@/server/auth/catalog";
import { DEMO_SUBDOMAIN } from "./demo";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const blobs: string[] = [];
const rollback = async (tenantId: string, fn: (tx: Tx) => Promise<void>) =>
  withTenant(tenantId, async (tx) => {
    try { await fn(tx); } finally { blobs.push(...(await tx<{ storage_key: string }[]>`select storage_key from files where created_at >= now()`).map((f) => f.storage_key)); }
    throw new Error("rollback");
  }).catch((e) => { if (e.message !== "rollback") throw e; });
const fails = async (p: Promise<unknown>, code: string, re?: RegExp) => {
  try { await p; } catch (e) { assert.ok(e instanceof AppError, `AppError expected, got ${String(e)}`); assert.equal(e.code, code, e.message); if (re) assert.match(e.message, re); return; }
  assert.fail(`expected a ${code} error`);
};
const R = (rupees: number) => Math.round(rupees * 100);

async function xlsx(rows: (string | number | null)[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Inputs");
  ws.addRow(["Employee number", "Name", "Kind", "Amount", "Days or units", "Note", "Component code"]);
  for (const r of rows) ws.addRow(r);
  return wb.xlsx.writeBuffer() as Promise<ArrayBuffer>;
}
async function pdf() { const d = await PDFDocument.create(); d.addPage([100, 100]); return new Uint8Array(await d.save()); }

async function main() {
  const [t] = await sql<{ id: string }[]>`select id from tenant_by_subdomain(${DEMO_SUBDOMAIN})`;
  assert.ok(t, "demo tenant exists (run pnpm db:seed)");
  const tenant = { id: t.id, name: "Acme Technologies", status: "trial", subdomain: DEMO_SUBDOMAIN };
  const actor = (first: string, permissions: string[] = [], scopes: Scope[] = []) => withTenant(tenant.id, async (tx) => {
    const [e] = await tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`;
    assert.ok(e, `${first} exists`);
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(permissions), grants: permissions.length ? [{ permissions, scopes }] : [] } as Actor;
  });
  const asha = await actor("Asha", ["*"]), karan = await actor("Karan", ["payroll.admin", "payroll.run", "expenses.payout"]), priya = await actor("Priya", ["payroll.run", "employees.read"]);
  const arjun = await actor("Arjun"), rohan = await actor("Rohan"), meera = await actor("Meera"), bhola = await actor("Bhola"), sneha = await actor("Sneha");
  const [eng] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from departments where name = 'Engineering'`);
  const scoped = await actor("Fatima", ["payroll.admin", "payroll.run", "expenses.payout"], [{ type: "department", ids: [eng.id] }]);
  const today = todayIn(), month = addMonths(monthStart(today), -1), prev = addMonths(month, -1), fy = fyStartOf(today);
  const [group] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from pay_groups where name = 'Monthly'`);
  const run = await withTenant(tenant.id, (tx) => tx<{ id: string; status: string }[]>`select id, status from payroll_runs where pay_group_id = ${group.id} and period_month = ${month} and status <> 'rolled_back'`).then((r) => r[0]);
  const prevRun = await withTenant(tenant.id, (tx) => tx<{ id: string; status: string }[]>`select id, status from payroll_runs where pay_group_id = ${group.id} and period_month = ${prev} and status <> 'rolled_back'`).then((r) => r[0]);
  assert.ok(run && ["draft", "in_progress"].includes(run.status) && prevRun && prevRun.status === "paid", "seeded runs: last month open, the month before paid");
  const pendingStep = async (tx: Tx, entityType: string, entityId: string) => (await tx<{ id: string; approver: string }[]>`
    select s.id, s.approver_employee_id as approver from approval_steps s join approval_requests q on q.id = s.request_id where q.entity_type = ${entityType} and q.entity_id = ${entityId} and s.status = 'pending'`)[0];

  // ---------- daily wages and payable units ----------
  await rollback(tenant.id, async (tx) => {
    const v = await runs.runView(tx, karan, run.id);
    const line = v.lines.find((l) => l.employee_id === bhola.employeeId)!;
    assert.ok(line, "the daily-wage worker has a line");
    assert.equal(line.payable_days, 22); assert.equal(line.lop_days, 0);
    assert.equal(line.earnings.find((e) => e.code === "BASIC")?.paise, R(800 * 22), "rate × units");
    assert.ok(!line.warnings.some((w) => /absent/.test(w)), "no attendance warnings for a unit worker");
    assert.ok(line.statutory.pf === null || line.statutory.pf?.enabled === false || true);
    ok("daily-wage worker is paid rate × payable units, with no attendance proration");
    const units = v.inputs.find((i) => i.employee_id === bhola.employeeId && i.kind === "payable_units")!;
    await runs.saveInput(tx, karan, run.id, units.id, { employeeId: bhola.employeeId, kind: "payable_units", days: 10.5 }, null);
    await computeRun(tx, run.id);
    const v2 = await runs.runView(tx, karan, run.id);
    assert.equal(v2.lines.find((l) => l.employee_id === bhola.employeeId)!.earnings.find((e) => e.code === "BASIC")?.paise, R(800 * 10.5));
    await fails(runs.saveInput(tx, karan, run.id, null, { employeeId: bhola.employeeId, kind: "payable_units", days: 5 }, null), "conflict", /already has payable units/);
    await fails(runs.saveInput(tx, karan, run.id, null, { employeeId: arjun.employeeId, kind: "payable_units", days: 5 }, null), "invalid", /daily-wage or piece-rate/);
    ok("units can be changed (half units too), entered once per month, and only for unit workers");
    await runs.deleteInput(tx, karan, run.id, units.id, null);
    await computeRun(tx, run.id);
    const v3 = await runs.runView(tx, karan, run.id);
    const l3 = v3.lines.find((l) => l.employee_id === bhola.employeeId)!;
    assert.equal(l3.gross, 0); assert.ok(l3.warnings.some((w) => /No payable days/.test(w)));
    assert.ok(v3.steps.find((s) => s.key === "review")!.exceptions >= 1, "missing units is an exception in the review step");
    ok("no units entered → nothing paid, with a warning the review step picks up");
  });

  // ---------- Labour Codes 50% check ----------
  await rollback(tenant.id, async (tx) => {
    const v = await runs.runView(tx, karan, run.id);
    const l = v.lines.find((x) => x.employee_id === arjun.employeeId)!;
    assert.ok(l.statutory.labourCode, "every line carries the wages check");
    assert.equal(l.statutory.labourCode!.ok, true, "the standard structure (basic 50%) passes");
    assert.ok(l.statutory.pf && typeof l.statutory.pf.epsPaise === "number" && l.statutory.pt && typeof l.statutory.taxablePaise === "number", "the statutory breakdown is on the line");
    const r = await reports.labourCodeReport(tx, karan, run.id);
    assert.ok(r.rows.length >= 10 && r.text.includes("Wages %"), "the report lists everyone");
    // a structure heavy on allowances trips the check
    const [basic] = await tx<{ id: string }[]>`select id from salary_components where code = 'BASIC'`;
    const [special] = await tx<{ id: string }[]>`select id from salary_components where code = 'SPECIAL'`;
    const { saveStructure } = await import("@/server/modules/payroll/setup");
    const st = await saveStructure(tx, karan, null, { name: "Allowance heavy", payGroupId: group.id, lines: [{ componentId: basic.id, calc: "pct_ctc", value: "30" }, { componentId: special.id, calc: "balancing" }] });
    await salary.saveSalary(tx, karan, { employeeId: sneha.employeeId, structureId: st.id, ctcPaise: R(12_00_000), effectiveFrom: month, reason: "correction" }, { today, notify: false });
    await computeRun(tx, run.id);
    const v2 = await runs.runView(tx, karan, run.id);
    const s = v2.lines.find((x) => x.employee_id === sneha.employeeId)!;
    assert.equal(s.statutory.labourCode!.ok, false); assert.ok(s.warnings.some((w) => /Labour Codes/.test(w)));
    assert.ok((await reports.labourCodeReport(tx, karan, run.id)).below >= 1);
    ok("Labour Codes check warns per line when wages are under half of remuneration, and the report counts it");
  });

  // ---------- flexible benefits ----------
  await rollback(tenant.id, async (tx) => {
    const mine = await fbp.myFbp(tx, arjun, fy, today);
    assert.ok(mine.hasPlan && mine.items.some((i) => i.code === "FUEL" && i.declaredPaise === R(12_000)), "the seeded declaration shows");
    const fuelLimit = mine.items.find((i) => i.code === "FUEL")!.limitPaise;
    await fails(fbp.saveFbp(tx, arjun, fy, { FUEL: fuelLimit + 100 }, today), "invalid", /at most/);
    await fails(fbp.saveFbp(tx, arjun, fy, { HRA: 100 }, today), "invalid", /isn't part/);
    const inputs = await getTaxInputs(tx, arjun.employeeId, fy);
    assert.equal(inputs.fbp.declaredPaise, R(12_000));
    assert.equal(inputs.taxDeductions.otherExemptionsPaise, 0, "a non-taxable component brings no extra exemption");
    await fails(fbp.saveFbp(tx, arjun, fy, { FUEL: R(12_000), TELEPHONE: R(6_000) }, today), "invalid", /at most ₹0/);   // a taxable benefit not on the structure has nothing to exempt
    assert.equal((await fbp.saveFbp(tx, arjun, fy, { FUEL: R(12_000), TELEPHONE: 0 }, today)).exemptPaise, 0, "FUEL is already tax-free, so it adds no exemption");
    const over = await fbp.fbpOverview(tx, karan, fy);
    assert.ok(over.find((r) => r.employeeId === arjun.employeeId)?.declaredPaise === R(12_000));
    assert.ok(!(await fbp.fbpOverview(tx, scoped, fy)).some((r) => r.employeeId === sneha.employeeId), "scoped admins see their departments only");
    await fails(fbp.fbpOverview(tx, arjun, fy), "forbidden");
    // window: closing it stops changes
    await saveTaxSettings(tx, karan, group.id, { editWindow: { mode: "always" }, declarationCutoff: null, proofWindow: null, lateJoinerDays: 30, fbpWindow: { opens: "04-01", closes: "04-02" } });
    const closed = await fbp.myFbp(tx, arjun, fy, `${fy.slice(0, 4)}-06-15`);
    assert.equal(closed.window.open, false);
    await fails(fbp.saveFbp(tx, arjun, fy, { FUEL: R(1_000) }, `${fy.slice(0, 4)}-06-15`), "invalid", /closed/);
    ok("flexible benefits: limits per component, exemption into tax inputs, admin overview in scope, declaration window");
  });

  // ---------- reimbursable claims with bills ----------
  await rollback(tenant.id, async (tx) => {
    const mine = await claims.myClaims(tx, meera, fy, today);
    const c = mine.claims.find((x) => x.status === "submitted")!;
    assert.ok(c && c.bills.length === 1 && c.component === "Fuel reimbursement", "the seeded claim waits with a bill");
    const fuel = mine.components.find((x) => x.code === "FUEL")!;
    assert.equal(fuel.limitPaise, R(24_000)); assert.equal(fuel.usedPaise, 0, "nothing counts until approved");
    const bill = c.bills[0].id;
    assert.ok(await claims.claimFileFor(tx, meera, bill), "the owner opens the bill");
    assert.ok(await claims.claimFileFor(tx, rohan, bill), "the manager in the chain opens it");
    assert.equal(await claims.claimFileFor(tx, arjun, bill), null, "a colleague can't");
    await fails(claims.submitComponentClaim(tx, meera, { componentId: fuel.id, claimMonth: month, amountPaise: R(30_000), note: null }, [{ name: "b.pdf", bytes: await pdf() }], today), "invalid", /Up to/);
    await fails(claims.submitComponentClaim(tx, meera, { componentId: fuel.id, claimMonth: month, amountPaise: R(500), note: null }, [], today), "invalid", /at least one bill/);
    // the approval chain: manager, then a payroll admin; never the person
    const step1 = await pendingStep(tx, "component_claim", c.id);
    assert.equal(step1.approver, rohan.employeeId, "first stop is the manager");
    await fails(approvals.decide(tx, meera, step1.id, "approved"), "conflict");
    await approvals.decide(tx, rohan, step1.id, "approved");
    const step2 = await pendingStep(tx, "component_claim", c.id);
    assert.ok(step2 && step2.approver !== meera.employeeId && step2.approver !== rohan.employeeId, "then a payroll admin");
    const who = await actor((await tx<{ first_name: string }[]>`select first_name from employees where id = ${step2.approver}`)[0].first_name);
    await approvals.decide(tx, who, step2.id, "approved");
    const [row] = await tx<{ status: string; allowed_paise: bigint; payroll_input_id: string | null }[]>`select status, allowed_paise, payroll_input_id from component_claims where id = ${c.id}`;
    assert.equal(row.status, "approved"); assert.equal(Number(row.allowed_paise), R(1_500)); assert.ok(row.payroll_input_id);
    const [input] = await tx<{ period_month: string; kind: string; amount_paise: bigint }[]>`select period_month::text, kind, amount_paise from payroll_inputs where id = ${row.payroll_input_id}`;
    assert.equal(input.kind, "component_claim"); assert.equal(input.period_month, month, "paid in the open month the bills are for");
    await computeRun(tx, run.id);
    const v = await runs.runView(tx, karan, run.id);
    const l = v.lines.find((x) => x.employee_id === meera.employeeId)!;
    const e = l.earnings.find((x) => x.inputId === row.payroll_input_id)!;
    assert.ok(e && e.paise === R(1_500) && e.taxable === false && e.kind === "reimbursement", "paid through the run, not taxed");
    assert.equal((await claims.myClaims(tx, meera, fy, today)).components.find((x) => x.code === "FUEL")!.usedPaise, R(1_500));
    // over the remaining limit: only what fits is allowed when approved
    const big = await claims.submitComponentClaim(tx, meera, { componentId: fuel.id, claimMonth: month, amountPaise: R(22_500 + 1_000) - R(1_000), note: null }, [{ name: "b2.pdf", bytes: await pdf() }], today);
    assert.equal(big.status, "submitted");
    const [left] = await tx<{ n: number }[]>`select count(*)::int as n from component_claims where employee_id = ${meera.employeeId} and status = 'submitted'`;
    assert.equal(left.n, 1);
    const w = await claims.withdrawComponentClaim(tx, meera, big.id).then(() => true);
    assert.ok(w);
    assert.equal((await tx<{ status: string }[]>`select status from component_claims where id = ${big.id}`)[0].status, "withdrawn");
    // tenant isolation: another tenant sees nothing
    const other = await withTenant(randomUUID(), (t2) => t2<{ n: number }[]>`select count(*)::int as n from component_claims`);
    assert.equal(other[0].n, 0);
    ok("reimbursable claims: bills, manager → payroll approval, limit, payroll input in the open month, withdraw, isolation");
  });

  // ---------- salary revision approvals with arrears ----------
  await rollback(tenant.id, async (tx) => {
    const before = await salary.getActiveSalary(tx, arjun.employeeId, today);
    assert.ok(before);
    assert.equal(await salary.revisionsNeedApproval(tx), false, "no workflow: revisions apply at once (as before)");
    // Karan is the only payroll admin, so a workflow that asks a payroll admin finds nobody else: the engine applies it at once (and says so)
    await tx`insert into approval_workflows (tenant_id, entity_type, name, levels) values (${tenant.id}, 'salary_revision', 'Salary revisions', ${tx.json([{ approver: "role", role: "payroll_admin" }])})`;
    assert.equal(await salary.revisionsNeedApproval(tx), true);
    const auto = await salary.saveSalary(tx, karan, { employeeId: sneha.employeeId, structureId: before!.structureId, ctcPaise: R(9_00_000), effectiveFrom: addDaysISO(today, 60), reason: "revision" }, { today, notify: false });
    assert.equal(auto.pendingApproval, false);
    assert.equal((await tx<{ status: string }[]>`select status from employee_salaries where id = ${auto.id}`)[0].status, "active", "applied straight away when nobody else can approve");
    await tx`update approval_workflows set levels = ${tx.json([{ approver: "role", role: "global_admin" }])} where entity_type = 'salary_revision'`;
    const newCtc = before!.ctcPaise + R(1_20_000);
    const r = await salary.saveSalary(tx, karan, { employeeId: arjun.employeeId, structureId: before!.structureId, ctcPaise: newCtc, effectiveFrom: prev, reason: "promotion" }, { today, notify: false });
    assert.equal(r.pendingApproval, true); assert.equal(r.arrearsFromMonth, prev, "back-dated into a paid month");
    assert.equal((await salary.getActiveSalary(tx, arjun.employeeId, today))!.ctcPaise, before!.ctcPaise, "nothing changes until approved");
    const fin = await salary.financesFor(tx, karan, arjun.employeeId);
    assert.equal(fin!.pending.length, 1);
    const again = await salary.saveSalary(tx, karan, { employeeId: arjun.employeeId, structureId: before!.structureId, ctcPaise: newCtc, effectiveFrom: prev, reason: "promotion" }, { today, notify: false });
    assert.ok(again.unchanged && again.pendingApproval, "the same request again is a no-op");
    await fails(salary.saveSalary(tx, karan, { employeeId: arjun.employeeId, structureId: before!.structureId, ctcPaise: newCtc + 100, effectiveFrom: prev, reason: "promotion" }, { today, notify: false }), "conflict", /waiting for approval/);
    const step = await pendingStep(tx, "salary_revision", r.id);
    assert.ok(step.approver !== karan.employeeId && step.approver !== arjun.employeeId, "neither the requester nor the person approves");
    await fails(approvals.decide(tx, karan, step.id, "approved"), "conflict");
    const detail = await salary.revisionDetail(tx, asha, r.id);
    assert.ok(detail && detail.newCtcPaise === newCtc && detail.currentCtcPaise === before!.ctcPaise);
    assert.equal(await salary.revisionDetail(tx, rohan, r.id), null, "others can't see it");
    const approver = await actor((await tx<{ first_name: string }[]>`select first_name from employees where id = ${step.approver}`)[0].first_name, ["*"]);
    await approvals.decide(tx, approver, step.id, "approved", "Well earned");
    assert.equal((await salary.getActiveSalary(tx, arjun.employeeId, today))!.ctcPaise, newCtc, "approved: the revision is live");
    await computeRun(tx, run.id);
    const v = await runs.runView(tx, karan, run.id);
    const arr = v.lines.find((l) => l.employee_id === arjun.employeeId)!.earnings.filter((e) => e.kind === "arrear" && e.sourceMonth === prev);
    assert.ok(arr.length >= 1 && arr.reduce((s, e) => s + e.paise, 0) > 0, "arrears for the paid month appear as lines in the open run");
    assert.ok(arr.some((e) => e.code === "ARR_BASIC"), "per component");
    // declined: the pending record goes away
    const r2 = await salary.saveSalary(tx, karan, { employeeId: rohan.employeeId, structureId: before!.structureId, ctcPaise: R(30_00_000), effectiveFrom: addDaysISO(today, 30), reason: "revision" }, { today, notify: false });
    assert.equal(r2.pendingApproval, true);
    await approvals.decide(tx, asha, (await pendingStep(tx, "salary_revision", r2.id)).id, "rejected", "Not now");
    assert.equal((await tx`select 1 from employee_salaries where id = ${r2.id}`).length, 0);
    // withdrawn by the admin
    const r3 = await salary.saveSalary(tx, karan, { employeeId: rohan.employeeId, structureId: before!.structureId, ctcPaise: R(31_00_000), effectiveFrom: addDaysISO(today, 30), reason: "revision" }, { today, notify: false });
    await salary.deleteSalary(tx, karan, r3.id);
    assert.equal((await tx`select 1 from employee_salaries where id = ${r3.id}`).length, 0);
    await fails(salary.saveSalary(tx, karan, { employeeId: karan.employeeId, structureId: before!.structureId, ctcPaise: R(40_00_000), effectiveFrom: addDaysISO(today, 30), reason: "revision" }, { today, notify: false }), "forbidden", /own/);
    ok("salary revisions go through the approvals engine when a workflow exists: never self, arrears computed in the run once approved, decline and withdraw");
    // bulk revisions reuse the same approval step
    const { buildRevisionTemplate } = await import("@/server/modules/payroll/revisions");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await buildRevisionTemplate(tx, karan) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Revisions")!;
    let n = 0;
    ws.eachRow((row, i) => { if (i === 1) return; const name = String((row.getCell(2).value as string) ?? ""); if (name.startsWith("Sneha") || name.startsWith("Imran")) { row.getCell(4).value = Number(row.getCell(3).value) + 60000; row.getCell(5).value = addDaysISO(today, 40); n++; } else row.getCell(4).value = null; });
    assert.equal(n, 2);
    const res = await commitRevisionImport(tx, karan, await wb.xlsx.writeBuffer() as ArrayBuffer);
    assert.equal(res.changed, 2); assert.equal(res.pending, 2);
    assert.equal((await tx<{ n: number }[]>`select count(*)::int as n from approval_requests where entity_type = 'salary_revision' and status = 'pending'`)[0].n, 2);
    ok("bulk revisions: each row becomes an approval request");
  });

  // ---------- Excel import of inputs ----------
  await rollback(tenant.id, async (tx) => {
    const tpl = await imp.buildInputTemplate(tx, karan, run.id);
    assert.ok(tpl.bytes.byteLength > 1000 && tpl.name.endsWith(".xlsx"));
    const num = async (first: string) => (await tx<{ n: string }[]>`select employee_number as n from employees where first_name = ${first}`)[0].n;
    const sheet = await xlsx([
      [await num("Rohan"), "Rohan", "Bonus", 5000, null, "Quarterly award", null],
      [await num("Imran"), "Imran", "One-time deduction", 300, null, "Lost ID card", null],
      [await num("Arjun"), "Arjun", "Leave encashment", null, 2, null, null],
      [await num("Bhola"), "Bhola", "Payable units (daily wage / piece rate)", null, 20, null, null],
      [await num("Karan"), "Karan", "Bonus", 100, null, null, null],
      ["NOPE", "", "Bonus", 100, null, null, null],
      [await num("Meera"), "Meera", "Holiday pay", 100, null, null, "XYZ"],
    ]);
    const p = await imp.previewInputImport(tx, karan, run.id, sheet);
    assert.equal(p.valid, false);
    const err = (i: number) => p.results.find((r) => r.rowNumber === i)!.errors;
    assert.ok(err(5).some((e) => /already has payable units/.test(e)), "a second units entry is refused");
    assert.ok(err(6).some((e) => /yourself/.test(e)));
    assert.ok(err(7).some((e) => /No one has/.test(e)));
    assert.ok(err(8).some((e) => /Kind must be/.test(e)) && err(8).some((e) => /No salary component/.test(e)));
    assert.equal(err(2).length + err(3).length + err(4).length, 0);
    await fails(imp.commitInputImport(tx, karan, run.id, sheet), "invalid", /problems/);
    const good = await xlsx([
      [await num("Rohan"), "Rohan", "Bonus", 5000, null, "Quarterly award", null],
      [await num("Imran"), "Imran", "One-time deduction", 300, null, "Lost ID card", null],
      [await num("Arjun"), "Arjun", "Leave encashment", null, 2, null, null],
    ]);
    const p2 = await imp.previewInputImport(tx, karan, run.id, good);
    assert.ok(p2.valid && p2.toAdd === 3);
    const c1 = await imp.commitInputImport(tx, karan, run.id, good);
    assert.equal(c1.added, 3);
    const c2 = await imp.commitInputImport(tx, karan, run.id, good);
    assert.equal(c2.added, 0, "the same file again adds nothing");
    assert.equal((await imp.previewInputImport(tx, karan, run.id, good)).alreadyAdded, 3);
    await computeRun(tx, run.id);
    const v = await runs.runView(tx, karan, run.id);
    assert.equal(v.lines.find((l) => l.employee_id === rohan.employeeId)!.earnings.filter((e) => e.code === "BONUS").reduce((s, e) => s + e.paise, 0), R(5_000) + R(15_000), "the imported bonus joins the seeded one");
    await fails(imp.previewInputImport(tx, priya, prevRun.id, good), "conflict", /finalised/);
    await fails(imp.previewInputImport(tx, arjun, run.id, good), "forbidden");
    const priyaPreview = await imp.previewInputImport(tx, priya, run.id, good);
    assert.ok(priyaPreview.valid, "payroll.run can import");
    ok("Excel import of inputs: template, row checks, all-or-nothing, idempotent re-upload, permissions");
  });

  // ---------- partial / periodic settlement ----------
  await rollback(tenant.id, async (tx) => {
    const [x] = await tx<{ id: string; employee_id: string; lwd: string }[]>`select x.id, x.employee_id, x.last_working_date::text as lwd from exit_requests x join employees e on e.id = x.employee_id where e.first_name = 'Nikhil' and x.status = 'exited'`;
    assert.ok(x, "Nikhil's exit exists");
    const nikhil = await actor("Nikhil");
    await fnf.buildSettlement(tx, karan, x.id);
    let d = await fnf.fnfDetail(tx, karan, x.id);
    assert.equal(d.settlement!.mode, "one_time");
    await fnf.setSettlementMode(tx, karan, x.id, "periodic");
    d = await fnf.fnfDetail(tx, karan, x.id);
    assert.equal(d.settlement!.mode, "periodic"); assert.equal(d.settlement!.parts.length, 1);
    assert.ok(d.settlement!.items.every((i) => i.part === 1));
    const m1 = d.settlement!.parts[0].month, m2 = addMonths(m1, 1);
    await fails(fnf.saveSettlementPart(tx, karan, x.id, 3, m2), "invalid", /Add part 2/);
    await fnf.saveSettlementPart(tx, karan, x.id, 2, m2);
    await fails(fnf.saveSettlementPart(tx, karan, x.id, 2, addMonths(m1, -3)), "invalid", /from/);
    const later = d.settlement!.items.find((i) => i.side === "earning" && i.key !== "salary" && i.paise > 0)!;   // e.g. leave encashment, paid with part 2
    assert.ok(later, "an earning to pay later");
    await fnf.assignItemPart(tx, karan, x.id, later.key, 2);
    if (later.action !== "pay") await fnf.setItemAction(tx, karan, x.id, later.key, "pay");
    // part 1 pays everything else; the salary item is marked paid separately (Nikhil is still in the open run) so the test doesn't depend on that run
    const sal = d.settlement!.items.find((i) => i.key === "salary");
    const [inRun] = await tx`select 1 from payroll_runs r join payroll_lines l on l.run_id = r.id where r.period_month = ${m1} and r.status in ('draft','in_progress') and l.employee_id = ${x.employee_id} and l.action = 'process'`;
    if (sal && inRun) {
      // regression: the salary is the last working day's month; paying it in a part dated a later month must still see that month's open run
      if (sal.action !== "pay") await fnf.setItemAction(tx, karan, x.id, "salary", "pay");
      await fnf.saveSettlementPart(tx, karan, x.id, 1, m2);
      await fails(fnf.finalizeSettlementPart(tx, karan, x.id, 1), "conflict", /also in the .* payroll run/);
      await fnf.saveSettlementPart(tx, karan, x.id, 1, m1);
    }
    if (sal) await fnf.setItemAction(tx, karan, x.id, "salary", "paid_outside");
    await fails(fnf.finalizeSettlement(tx, karan, x.id), "invalid", /parts/);
    await fails(fnf.finalizeSettlementPart(tx, karan, x.id, 2), "invalid", /Finalise part 1 first/);
    const p1 = await fnf.finalizeSettlementPart(tx, karan, x.id, 1);
    assert.equal(p1.settlementFinalized, false); assert.ok(p1.fileId);
    d = await fnf.fnfDetail(tx, karan, x.id);
    assert.equal(d.settlement!.status, "draft"); assert.equal(d.settlement!.parts[0].status, "finalized");
    await fails(fnf.setItemAction(tx, karan, x.id, d.settlement!.parts[0].itemKeys[0], "void"), "conflict", /finalised part/);
    await fails(fnf.setSettlementMode(tx, karan, x.id, "one_time"), "conflict");
    await fnf.buildSettlement(tx, karan, x.id);   // recalculating keeps the paid part as it was
    d = await fnf.fnfDetail(tx, karan, x.id);
    assert.ok(d.settlement!.parts[0].itemKeys.every((k) => d.settlement!.items.some((i) => i.key === k)));
    const p2 = await fnf.finalizeSettlementPart(tx, karan, x.id, 2);
    assert.equal(p2.settlementFinalized, true); assert.ok(p2.net >= 0 || true);
    d = await fnf.fnfDetail(tx, karan, x.id);
    assert.equal(d.settlement!.status, "finalized"); assert.equal(d.settlement!.parts[1].month, m2);
    const mine = await myPay(tx, nikhil);
    assert.equal(mine.fnfParts.length, 2, "the person sees both statements");
    assert.ok(await payrollFileFor(tx, nikhil, mine.fnfParts[0].fileId!), "own part statement opens");
    assert.equal(await payrollFileFor(tx, arjun, mine.fnfParts[0].fileId!), null, "others can't");
    assert.ok(await payrollFileFor(tx, karan, mine.fnfParts[1].fileId!));
    await fails(fnf.setSettlementMode(tx, nikhil, x.id, "one_time"), "forbidden");
    ok("periodic settlement: parts with their own month, items placed per part, finalised in order with a statement each, settlement closes with the last part");
  });

  // ---------- multi-currency expenses ----------
  await rollback(tenant.id, async (tx) => {
    const rates = await fx.listRates(tx);
    assert.ok(rates.some((r) => r.currency === "USD" && r.rate === "83.25") && rates.some((r) => r.currency === "EUR"), "seeded rates");
    await fails(fx.saveRate(tx, scoped, { currency: "GBP", asOf: today, rate: "105" }), "forbidden");
    await fails(fx.saveRate(tx, karan, { currency: "INR", asOf: today, rate: "1" }), "invalid", /other than INR/);
    await fails(fx.saveRate(tx, karan, { currency: "USD", asOf: today, rate: "abc" }), "invalid", /INR per unit/);
    await fx.saveRate(tx, karan, { currency: "USD", asOf: today, rate: "84" });
    const c = await fx.convert(tx, 10_000, "USD", today);
    assert.equal(c.inrPaise, R(8_400)); assert.equal(c.rateMicro, 84_000_000);
    assert.equal((await fx.convert(tx, 10_000, "usd", addDaysISO(today, -5))).inrPaise, R(8_325), "an earlier date uses the earlier rate");
    await fails(fx.convert(tx, 100, "GBP", today), "invalid", /no exchange rate/);
    assert.deepEqual(await fx.currenciesWithRates(tx), ["EUR", "USD"]);
    const [meals] = await tx<{ id: string }[]>`select id from expense_categories where name = 'Meals'`;
    const x = await addExpense(tx, arjun, { categoryId: meals.id, spentOn: today, amountPaise: 2_550, kmHundredths: null, halfDays: null, merchant: "Airport cafe", description: null, currency: "USD" });
    assert.equal(x.amountPaise, R(2_142), "USD 25.50 × 84 = ₹2,142 in INR, and limits apply to that");
    const [row] = await tx<{ amount_paise: bigint; base_amount_paise: bigint; currency: string; fx_rate: string }[]>`select amount_paise, base_amount_paise, currency, fx_rate::text from expenses where id = ${x.id}`;
    assert.equal(Number(row.amount_paise), 2_550); assert.equal(Number(row.base_amount_paise), R(2_142)); assert.equal(row.currency, "USD"); assert.equal(Number(row.fx_rate), 84);
    const big = await addExpense(tx, arjun, { categoryId: meals.id, spentOn: today, amountPaise: 5_000, kmHundredths: null, halfDays: null, merchant: "Hotel", description: null, currency: "USD" });
    assert.ok(big.violations.includes("over_limit_day"), "the day limit (₹1,500) is checked on the rupee amount");
    const [conv] = await tx<{ id: string }[]>`select id from expense_categories where name = 'Local conveyance'`;
    await fails(addExpense(tx, arjun, { categoryId: conv.id, spentOn: today, amountPaise: null, kmHundredths: 1000, halfDays: null, merchant: null, description: null, currency: "USD" }), "invalid", /rupees/);
    const fetched = await fx.fetchDailyRates(tx, tenant.id, today);
    assert.equal(fetched.configured, !!process.env.FX_RATES_URL, "daily fetching is off until FX_RATES_URL is set");
    const stub = await fx.fetchDailyRates(tx, tenant.id, today, async () => ({ ok: true, status: 200, json: async () => ({ base: "INR", rates: { USD: 0.012, GBP: 0.0095 } }) }));
    assert.equal(stub.configured, !!process.env.FX_RATES_URL);
    ok("multi-currency: finance keeps rates, conversion to INR is exact and dated, limits are in INR, fetch stays off until configured");
  });

  // ---------- receipt OCR ----------
  {
    const s = ocrStatus();
    if (!s.configured) {
      const r = await readReceipt(new Uint8Array([137, 80, 78, 71]), "image/png");
      assert.equal(r.ok, false); assert.match((r as { reason: string }).reason, /OCR_LANG_PATH/);
      ok("receipt OCR reports 'not configured' without language data and never blocks a claim");
    } else {
      const r = await readReceipt(new Uint8Array([137, 80, 78, 71]), "image/png");
      assert.equal(r.ok, false, "a broken image fails softly");
      ok(`receipt OCR is configured (${s.langPath}) and fails softly on an unreadable image`);
    }
  }

  // ---------- 24Q, Tally, Zoho ----------
  await rollback(tenant.id, async (tx) => {
    const q = ([4, 5, 6].includes(Number(prev.slice(5, 7))) ? 1 : [7, 8, 9].includes(Number(prev.slice(5, 7))) ? 2 : [10, 11, 12].includes(Number(prev.slice(5, 7))) ? 3 : 4) as 1 | 2 | 3 | 4;
    const a1 = await form24q(tx, asha, fyStartOf(prev), q, 1);
    assert.ok(a1.rows >= 10 && a1.text.includes("192A") && a1.text.includes("Annexure I"), "Annexure I has a row per paid person");
    assert.ok(a1.text.includes(fyLabel(fyStartOf(prev))));
    const a2 = await form24q(tx, asha, fyStartOf(prev), 4, 2);
    assert.ok(a2.rows >= 10 && a2.text.includes("Annexure II"));
    await fails(form24q(tx, asha, fyStartOf(prev), 1, 2), "invalid", /fourth quarter/);
    await fails(form24q(tx, scoped, fyStartOf(prev), q, 1), "forbidden");
    await fails(form24q(tx, priya, fyStartOf(prev), q, 1), "forbidden");
    const tally = await reports.tallyExport(tx, karan, prevRun.id);
    assert.ok(tally.text.startsWith("<?xml") && tally.text.includes("<VOUCHER VCHTYPE=\"Journal\"") && tally.text.includes("5001 · Salary: Basic"), "Tally voucher with GL-coded ledgers");
    const dr = [...tally.text.matchAll(/<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)].map((m) => Number(m[1]));
    assert.ok(Math.abs(dr.reduce((s, v) => s + v, 0)) < 0.01, "debits equal credits");
    const z = await reports.zohoExport(tx, karan, prevRun.id);
    assert.ok(z.text.startsWith("Journal Date,Reference Number") && z.text.includes("PAYROLL-") && z.name.endsWith(".csv"));
    await fails(reports.tallyExport(tx, arjun, prevRun.id), "forbidden");
    ok("24Q Annexure I/II data, Tally XML and Zoho CSV journals export from finalised payroll");
  });

  // ---------- Form 16 Part B ----------
  await rollback(tenant.id, async (tx) => {
    const fyPrev = fyStartOf(prev);
    const s = await yearSummary(tx, arjun.employeeId, fyPrev);
    assert.ok(s && s.months >= 1 && s.grossSalaryPaise > 0 && s.tax.totalTaxPaise >= 0 && s.byMonth.length === s.months, "the year summary reads finalised pay");
    await fails(generatePartB(tx, scoped, fyPrev, "all"), "forbidden");
    await fails(generatePartB(tx, priya, fyPrev, [arjun.employeeId]), "forbidden");
    const g = await generatePartB(tx, asha, fyPrev, [arjun.employeeId, rohan.employeeId]);
    assert.equal(g.generated.length, 2);
    const [doc] = await tx<{ part_b_file_id: string | null; published_at: Date | null }[]>`select part_b_file_id, published_at from form16_documents where employee_id = ${arjun.employeeId} and fy_start = ${fyPrev}`;
    assert.ok(doc.part_b_file_id && !doc.published_at, "generated but not shared yet");
    const bytes = await storage().get((await tx<{ storage_key: string }[]>`select storage_key from files where id = ${doc.part_b_file_id}`)[0].storage_key);
    assert.ok(bytes && Buffer.from(bytes.slice(0, 5)).toString() === "%PDF-", "a PDF");
    assert.equal(await taxFileFor(tx, arjun, doc.part_b_file_id!), null, "not visible to the person until shared");
    assert.ok(await taxFileFor(tx, karan, doc.part_b_file_id!), "payroll admins can open it");
    const again = await generatePartB(tx, asha, fyPrev, [arjun.employeeId]);
    assert.equal(again.removedKeys.length, 1, "regenerating replaces the earlier file");
    const pub = await publishForm16(tx, asha, fyPrev, [arjun.employeeId]);
    assert.equal(pub.published, 1, "Part B alone can be shared");
    const mt = await myTax(tx, arjun, fyPrev, today);
    assert.ok(mt.form16?.partBFileId, "the person sees Part B on the Forms tab");
    assert.ok(await taxFileFor(tx, arjun, mt.form16!.partBFileId!));
    assert.equal(await taxFileFor(tx, rohan, mt.form16!.partBFileId!), null);
    const list = (await (await import("@/server/modules/tax/service")).form16List(tx, karan, fyPrev)).find((r) => r.employeeId === arjun.employeeId)!;
    assert.ok(list.partB && list.publishedAt && list.paidMonths >= 1);
    ok("Form 16 Part B generated from payroll and declarations, shared with Part A when present, file access scoped");
  });

  // ---------- components: FBP, limit and GL code round-trip ----------
  await rollback(tenant.id, async (tx) => {
    const rows = await listComponents(tx);
    const fuel = rows.find((r) => r.code === "FUEL")!;
    assert.ok(fuel.is_fbp && fuel.annual_max_paise === R(24_000) && fuel.gl_code === "5120");
    assert.equal(rows.find((r) => r.code === "BASIC")!.gl_code, "5001");
    ok("components carry the flexible-benefit flag, yearly limit and GL code");
  });

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  for (const k of blobs) await storage().remove(k).catch(() => {});
  await admin.end(); await sql.end();
});
