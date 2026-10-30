/**
 * Smoke test for payroll runs, payslips, payments, reports and full and final settlements, against the seeded demo
 * tenant (run `pnpm db:seed` first). Everything runs in rolled-back transactions, so the demo data stays as seeded;
 * payslip and bank files written while testing are removed again.
 *   pnpm smoke:payrun
 *
 * The end-to-end golden check builds a "Golden" pay group inside a rolled-back transaction: 18 people with fixed
 * joining dates, salaries, states and attendance, and runs September 2026 for them. The expected net pay of each one
 * is worked out by hand in the comments (same rates and rounding as src/server/modules/payrun/rules.test.ts, but with
 * no earlier months in erp, so the income-tax projection starts from zero).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { withTenant, sql, AppError, type Tx } from "@/server/db";
import { createEmployee } from "@/server/modules/employees/service";
import * as salary from "@/server/modules/payroll/salary";
import { encryptField } from "@/server/modules/payroll/secret";
import { computeRun, getRun } from "@/server/modules/payrun/engine";
import * as runs from "@/server/modules/payrun/runs";
import * as slips from "@/server/modules/payrun/payslips";
import * as pay from "@/server/modules/payrun/payments";
import * as reports from "@/server/modules/payrun/reports";
import * as fnf from "@/server/modules/payrun/fnf";
import { canRunPayroll } from "@/server/modules/payrun/access";
import { addMonths, monthStart, STEPS } from "@/server/modules/payrun/rules";
import { storage } from "@/server/storage";
import { todayIn } from "@/lib/dates";
import type { Actor } from "@/server/auth/session";
import type { Scope } from "@/server/auth/catalog";
import { DEMO_SUBDOMAIN } from "./demo";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const blobs: string[] = [];
/** Run in a transaction that is always rolled back; files written inside it are removed afterwards. */
const rollback = async (tenantId: string, fn: (tx: Tx) => Promise<void>) =>
  withTenant(tenantId, async (tx) => {
    try { await fn(tx); } finally { blobs.push(...(await tx<{ storage_key: string }[]>`select storage_key from files where created_at >= now()`).map((f) => f.storage_key)); }
    throw new Error("rollback");
  }).catch((e) => { if (e.message !== "rollback") throw e; });
const R = (rupees: number) => Math.round(rupees * 100);

async function main() {
  const [t] = await sql<{ id: string }[]>`select id from tenant_by_subdomain(${DEMO_SUBDOMAIN})`;
  assert.ok(t, "demo tenant exists (run pnpm db:seed)");
  const tenant = { id: t.id, name: "Acme Technologies", status: "trial", subdomain: DEMO_SUBDOMAIN };
  const actor = (first: string, permissions: string[] = [], scopes: Scope[] = []) => withTenant(tenant.id, async (tx) => {
    const [e] = await tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`;
    assert.ok(e, `${first} exists`);
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(permissions), grants: permissions.length ? [{ permissions, scopes }] : [] } as Actor;
  });
  const asha = await actor("Asha", ["*"]), karan = await actor("Karan", ["payroll.admin"]), priya = await actor("Priya", ["payroll.run", "employees.read"]);
  const arjun = await actor("Arjun"), rohan = await actor("Rohan");
  const [eng] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from departments where name = 'Engineering'`);
  const scoped = await actor("Fatima", ["payroll.admin", "payroll.run"], [{ type: "department", ids: [eng.id] }]);
  const today = todayIn(), thisMonth = monthStart(today), lastMonth = addMonths(thisMonth, -1);
  const seeded = await withTenant(tenant.id, (tx) => tx<{ id: string; period_month: string; status: string; pay_group_id: string }[]>`select id, period_month::text, status, pay_group_id from payroll_runs order by period_month`);
  const prevRun = seeded.find((r) => r.period_month === lastMonth)!, openRun = seeded.find((r) => r.period_month === thisMonth)!;

  // ---------- seeded state ----------
  await rollback(tenant.id, async (tx) => {
    assert.equal(prevRun.status, "paid", "last month's seeded run is paid");
    assert.equal(openRun.status, "in_progress");
    const [p] = await tx<{ total: number; released: number; files: number }[]>`
      select count(*)::int as total, count(released_at)::int as released, count(file_id)::int as files from payslips p join payroll_lines l on l.id = p.line_id where l.run_id = ${prevRun.id}`;
    assert.ok(p.total >= 12 && p.released === p.total && p.files === p.total, "every payslip released with a PDF");
    const [unl] = await tx<{ n: number }[]>`select count(*)::int as n from attendance_days where not is_locked and date between ${lastMonth} and ${lastMonth}::date + 24`;
    assert.equal(unl.n, 0, "last month's attendance (to the cut-off) is locked");
    const v = await runs.runView(tx, karan, openRun.id);
    assert.ok(v.inputs.some((i) => i.kind === "bonus") && v.inputs.some((i) => i.kind === "lop_adjust"));
    const vik = v.lines.find((l) => l.name.startsWith("Vikram"))!;
    assert.ok(vik.earnings.some((e) => e.kind === "lop" && e.sourceMonth === lastMonth && e.paise < 0), "last month's late LOP adjustment is deducted at last month's rate");
    const nik = v.lines.find((l) => l.name.startsWith("Nikhil"));
    if (nik) assert.equal(nik.action, "void");
    const mine = await slips.myPay(tx, arjun);
    assert.equal(mine.slips.length, 1); assert.equal(mine.slips[0].month, lastMonth);
    assert.ok(mine.finances?.current, "salary breakup shown");
    const arjunFile = mine.slips[0].fileId!;
    const [rohanFile] = await tx<{ file_id: string }[]>`select file_id from payslips where employee_id = ${rohan.employeeId} and file_id is not null`;
    assert.ok(await slips.payrollFileFor(tx, arjun, arjunFile), "own payslip opens");
    assert.equal(await slips.payrollFileFor(tx, arjun, rohanFile.file_id), null, "someone else's payslip doesn't");
    assert.ok(await slips.payrollFileFor(tx, karan, rohanFile.file_id), "payroll opens anyone's");
    const [bf] = await tx<{ file_id: string }[]>`select file_id from payment_batches where run_id = ${prevRun.id}`;
    assert.equal(await slips.payrollFileFor(tx, arjun, bf.file_id), null, "bank files are payroll-only");
    assert.ok(await slips.payrollFileFor(tx, karan, bf.file_id));
    const bytes = await storage().get((await tx<{ storage_key: string }[]>`select storage_key from files where id = ${arjunFile}`)[0].storage_key);
    assert.ok(bytes && Buffer.from(bytes.slice(0, 5)).toString() === "%PDF-", "the payslip is a PDF");
    const home = await runs.payrollHome(tx, karan, today);
    const card = home.cards.find((c) => c.name === "Monthly")!;
    assert.equal(card.run?.id, openRun.id); assert.equal(card.trend.length, 1); assert.ok(card.trend[0].cost > 0);
  });
  ok("seed: last month paid with released PDF payslips and locked attendance; this month open with inputs; payslips and bank files open only for their owner or payroll");

  // ---------- permissions ----------
  await rollback(tenant.id, async (tx) => {
    assert.equal(canRunPayroll(arjun), false); assert.equal(canRunPayroll(scoped), false, "a scoped grant isn't enough");
    assert.equal(canRunPayroll(priya), true); assert.equal(canRunPayroll(karan), true);
    for (const who of [arjun, scoped]) {
      await assert.rejects(runs.payrollHome(tx, who), /whole company/);
      await assert.rejects(runs.runView(tx, who, openRun.id), /whole company/);
      await assert.rejects(runs.calculate(tx, who, openRun.id), /whole company/);
      await assert.rejects(fnf.fnfList(tx, who), /whole company/);
    }
    await assert.rejects(runs.saveInput(tx, karan, openRun.id, null, { employeeId: karan.employeeId, kind: "bonus", amountPaise: 100_00 }), /yourself/);
    await assert.rejects(runs.setPayAction(tx, karan, openRun.id, karan.employeeId, "hold_payout", null), /your own/);
    await assert.rejects(runs.setOverride(tx, karan, openRun.id, karan.employeeId, "TDS", 0, "test"), /your own/);
    await assert.rejects(runs.setOverride(tx, karan, openRun.id, rohan.employeeId, "TDS", 0, ""), /why/);
    const v = await runs.runView(tx, priya, openRun.id);
    await runs.saveInput(tx, priya, openRun.id, null, { employeeId: rohan.employeeId, kind: "adhoc_earning", amountPaise: 500_00 }, v.run.lock_version);
    await assert.rejects(runs.saveInput(tx, priya, openRun.id, null, { employeeId: rohan.employeeId, kind: "adhoc_earning", amountPaise: 500_00 }, v.run.lock_version), /Someone else changed/, "optimistic lock");
    await assert.rejects(runs.rollbackRun(tx, priya, prevRun.id, "Not allowed for runners"), /payroll admin/);
  });
  ok("permissions: payroll.run or payroll.admin without scope only; nobody adds inputs, holds, overrides or settles their own pay; stale versions are refused; only payroll admins roll back");

  // ---------- golden end-to-end: September 2026 for a fresh pay group ----------
  const M = "2026-09-01", OCT = "2026-10-01";
  await rollback(tenant.id, async (tx) => {
    const [le] = await tx<{ id: string }[]>`select id from legal_entities order by created_at limit 1`;
    const [g] = await tx<{ id: string }[]>`insert into pay_groups (tenant_id, legal_entity_id, name) values (${tenant.id}, ${le.id}, 'Golden') returning id`;
    const [st] = await tx<{ id: string }[]>`insert into salary_structures (tenant_id, pay_group_id, name) values (${tenant.id}, ${g.id}, 'Golden standard') returning id`;
    await tx`insert into salary_structure_lines (tenant_id, structure_id, component_id, calc, value, formula, position)
             select ${tenant.id}, ${st.id}, l.component_id, l.calc, l.value, l.formula, l.position from salary_structure_lines l join salary_structures s on s.id = l.structure_id where s.name = 'Standard'`;
    const [lwp] = await tx<{ id: string }[]>`select id from leave_types where code = 'LWP'`;
    const ids: Record<string, string> = {};
    const mk = async (key: string, o: { ctc: number; join?: string; state?: string; gender?: "male" | "female"; regime?: "old" | "new"; pf?: boolean; fullWage?: boolean; bank?: boolean; exitDate?: string }) => {
      const join = o.join ?? "2025-01-01";
      const e = await createEmployee(tx, tenant.id, { firstName: key, lastName: "Golden", workEmail: `${key.toLowerCase()}@golden.test`, joiningDate: join, gender: o.gender ?? "male" }, null);
      ids[key] = e.employeeId;
      await tx`update employees set pay_group_id = ${g.id}, exit_date = ${o.exitDate ?? null} where id = ${e.employeeId}`;
      await salary.saveSalary(tx, asha, { employeeId: e.employeeId, structureId: st.id, ctcPaise: R(o.ctc), effectiveFrom: join, reason: "joining" }, { today: "2026-09-15", notify: false });
      await tx`update employee_salaries set arrears_from_month = null where employee_id = ${e.employeeId}`;
      await salary.saveStatutory(tx, asha, e.employeeId, { pfEnabled: o.pf ?? true, uan: `9${String(Object.keys(ids).length).padStart(11, "0")}`, pfNumber: null, pfOnFullWage: !!o.fullWage,
        esiEnabled: true, esiNumber: null, ptState: o.state ?? "KA", lwfState: null, taxRegime: o.regime ?? "new" });
      if (o.bank !== false) await salary.saveBankAccount(tx, asha, e.employeeId, { bankName: "State Bank of India", ifsc: "SBIN0004321", accountNumber: `6010${String(Object.keys(ids).length).padStart(8, "0")}`, holderName: key }, { notify: false });
      await tx`insert into employee_identities (tenant_id, employee_id, kind, number_enc, number_last4) values (${tenant.id}, ${e.employeeId}, 'pan', ${encryptField("ABCPG1234K", ["identity", tenant.id, e.employeeId])}, '234K')`;
      return e.employeeId;
    };
    const lop = (emp: string, date: string, days = 1) => tx`
      insert into attendance_days (tenant_id, employee_id, date, day_type, status, penalties) values (${tenant.id}, ${emp}, ${date}, 'working', 'absent',
        ${tx.json([{ rule: "no_attendance", days, detail: "No clock-in and no leave", deductions: [{ days, leaveTypeId: null }] }])})
      on conflict (employee_id, date) do update set status = 'absent', penalties = excluded.penalties, is_locked = false`;
    await mk("G01", { ctc: 24_00_000 });   // 1,98,200 − PF 1,800 − PT 200 − TDS 11,419 = 1,84,781
    //   annual 1,98,200 × 7 = 13,87,400; − 75,000 = 13,12,400; 20,000 + 40,000 + 15% × 1,12,400 = 76,860; + 4% = 79,934.40 → 79,930; ÷ 7 = 11,418.57 → 11,419
    await mk("G02", { ctc: 12_00_000 });   // 98,200 − 1,800 − 200 = 96,200 (annual 6,87,400: rebate)
    await mk("G03", { ctc: 2_40_000 });    // 18,800 − 1,200 − ESI 141 = 17,459
    const g04 = await mk("G04", { ctc: 6_00_000 });   // LOP 8 and 9 Sep: 28/30 → 44,986 − 1,800 − 200 = 42,986
    await lop(g04, "2026-09-08"); await lop(g04, "2026-09-09");
    await lop(g04, "2026-09-28");   // after the 25th cut-off: not in September, rolls into October
    await mk("G05", { ctc: 48_00_000, regime: "old", pf: false });   // 3,98,200 − 200 − TDS 94,153 = 3,03,847
    //   annual 27,87,400 − 50,000 = 27,37,400; 12,500 + 1,00,000 + 30% × 17,37,400 = 6,33,720; + 4% = 6,59,068.80 → 6,59,070; ÷ 7 = 94,152.86 → 94,153
    await mk("G06", { ctc: 12_00_000, join: "2026-09-16", bank: false });   // 15/30 → 49,100 − 1,800 − 200 = 47,100
    await mk("G07", { ctc: 10_00_000, exitDate: "2026-09-10" });   // 10/30 → 27,178 − PF 1,667 − 200 = 25,311
    const g08 = await mk("G08", { ctc: 6_00_000 });   // ₹7.2L from 16 Sep → 53,200 − 1,800 − 200 = 51,200
    await salary.saveSalary(tx, asha, { employeeId: g08, structureId: st.id, ctcPaise: R(7_20_000), effectiveFrom: "2026-09-16", reason: "revision" }, { today: "2026-09-15", notify: false });
    await mk("G09", { ctc: 3_60_000, state: "TN" });   // TN half-yearly: half-year gross 28,200 → ₹180; 28,200 − 1,800 − 180 = 26,220
    await mk("G10", { ctc: 2_40_000, state: "MH", gender: "female" });   // no PT: 17,459
    const g11 = await mk("G11", { ctc: 2_40_000, state: "MH" });   // PT 200: 17,259
    const g12 = await mk("G12", { ctc: 12_00_000 });   // bonus 20,000, deduction 1,500 → 1,14,700
    const g13 = await mk("G13", { ctc: 3_60_000 });   // expense 4,250.50, loan EMI 5,000 → 25,450.50
    const g14 = await mk("G14", { ctc: 12_00_000 });   // 1 day LOP added by hand: 29/30 → 94,926 − 1,800 − 200 = 92,926
    const g15 = await mk("G15", { ctc: 12_00_000, fullWage: true });   // PF 6,000 on full wages, PT overridden to 0 → 92,200
    const g16 = await mk("G16", { ctc: 6_00_000 });   // processing on hold → nothing this month
    const g17 = await mk("G17", { ctc: 2_40_000 });   // ₹25,000 recovery → −7,541 (blocks finalising)
    const g18 = await mk("G18", { ctc: 3_60_000 });   // 1 day approved unpaid leave on 17 Sep: 29/30 → 27,260 − PF 1,740 − 200 = 25,320
    await tx`insert into leave_requests (tenant_id, employee_id, leave_type_id, from_date, to_date, days, status) values (${tenant.id}, ${g18}, ${lwp.id}, '2026-09-17', '2026-09-17', 1, 'approved')`;

    const { id: run } = await runs.createRun(tx, karan, g.id, M, "2026-09-20");
    await assert.rejects(runs.createRun(tx, karan, g.id, M, "2026-09-20"), /already has a run/, "one run per pay group and month");
    await runs.saveInput(tx, karan, run, null, { employeeId: g12, kind: "bonus", amountPaise: R(20000) });
    await runs.saveInput(tx, karan, run, null, { employeeId: g12, kind: "adhoc_deduction", amountPaise: R(1500), note: "Canteen" });
    await tx`insert into payroll_inputs (tenant_id, pay_group_id, period_month, employee_id, kind, amount_paise, source_ref, note) values
             (${tenant.id}, ${g.id}, ${M}, ${g13}, 'expense', ${R(4250.5)}, ${tx.json({ expense_claim_id: randomUUID() })}, 'Expense claim #900'),
             (${tenant.id}, ${g.id}, ${M}, ${g13}, 'loan_emi', ${R(5000)}, null, 'Loan EMI')`;
    await runs.saveInput(tx, karan, run, null, { employeeId: g14, kind: "lop_adjust", days: 1, sourceMonth: M });
    await assert.rejects(runs.saveInput(tx, karan, run, null, { employeeId: g14, kind: "lop_reversal", days: 1, sourceMonth: "2026-05-01" }), /three months/);
    await runs.setOverride(tx, karan, run, g15, "PT", 0, "Exempt: certificate on file");
    await runs.setPayAction(tx, karan, run, g16, "hold_processing", "Bank details being checked");
    const deduction = await runs.saveInput(tx, karan, run, null, { employeeId: g17, kind: "adhoc_deduction", amountPaise: R(25000), note: "Advance recovery" });

    const first = await computeRun(tx, run);
    const net = async () => Object.fromEntries((await tx<{ first_name: string; net_paise: bigint; action: string }[]>`
      select e.first_name, l.net_paise, l.action from payroll_lines l join employees e on e.id = l.employee_id where l.run_id = ${run}`).map((r) => [r.first_name, Number(r.net_paise)]));
    const expected: Record<string, number> = {
      G01: R(184781), G02: R(96200), G03: R(17459), G04: R(42986), G05: R(303847), G06: R(47100), G07: R(25311), G08: R(51200), G09: R(26220),
      G10: R(17459), G11: R(17259), G12: R(114700), G13: R(25450.5), G14: R(92926), G15: R(92200), G16: 0, G17: -R(7541), G18: R(25320),
    };
    assert.deepEqual(await net(), expected);
    assert.equal(first.totals.headcount, 18); assert.equal(first.totals.negative, 1); assert.equal(first.totals.held, 1);
    const snapshot = async () => tx`select employee_id, earnings, deductions, employer, statutory - 'context' as s, gross_paise, net_paise, warnings from payroll_lines where run_id = ${run} order by employee_id`;
    const before = await snapshot();
    await computeRun(tx, run);
    assert.deepEqual(await snapshot(), before, "recalculating gives exactly the same lines");
    let v = await runs.runView(tx, karan, run);
    const line = (k: string) => v.lines.find((l) => l.employee_id === ids[k])!;
    assert.equal(line("G04").lop_days, 2); assert.equal((line("G04").statutory.context as { lateLop: number }).lateLop, 1);
    assert.ok(line("G06").warnings.some((w) => /bank account/.test(w)));
    assert.equal(line("G16").action, "hold_processing");
    assert.equal(line("G13").statutory.taxablePaise, R(28200), "reimbursements aren't taxed");
    assert.equal(v.steps.find((s) => s.key === "holds")!.done, false, "held pay needs a review");
    await assert.rejects(runs.finalizeRun(tx, karan, run), /Review these steps|negative/);
    await runs.deleteInput(tx, karan, run, deduction.id);
    await computeRun(tx, run);
    assert.equal((await net()).G17, R(17459));
    v = await runs.runView(tx, karan, run);
    await assert.rejects(runs.finalizeRun(tx, karan, run, v.run.lock_version - 1), /Someone else changed/);
    for (const s of v.steps) if (!s.done) await runs.markReviewed(tx, karan, run, s.key, true);
    v = await runs.runView(tx, karan, run);
    assert.ok(v.fresh && v.steps.every((s) => s.done), "reviews don't make the calculation stale");
    await runs.saveInput(tx, karan, run, null, { employeeId: g12, kind: "adhoc_earning", amountPaise: R(10) });
    await assert.rejects(runs.finalizeRun(tx, karan, run), /Recalculate/);
    await tx`delete from payroll_inputs where employee_id = ${g12} and kind = 'adhoc_earning'`;
    await computeRun(tx, run);
    await runs.finalizeRun(tx, karan, run);
    assert.equal((await getRun(tx, run)).status, "finalized");
    const [locked] = await tx<{ is_locked: boolean }[]>`select is_locked from attendance_days where employee_id = ${g04} and date = '2026-09-08'`;
    assert.equal(locked.is_locked, true, "finalising locks the month's attendance");
    await assert.rejects(runs.saveInput(tx, karan, run, null, { employeeId: g12, kind: "bonus", amountPaise: R(1) }), /finalised/);
    await assert.rejects(computeRun(tx, run), /finalised/);

    // payslips, roll back, run again
    const rel = await slips.releasePayslips(tx, karan, run);
    assert.equal(rel.released, 17, "everyone but the held person gets a payslip");
    assert.equal((await slips.releasePayslips(tx, karan, run)).released, 0, "releasing again does nothing");
    const [g01line] = await tx<{ id: string }[]>`select id from payroll_lines where run_id = ${run} and employee_id = ${ids.G01}`;
    const pdf = await slips.previewPayslip(tx, karan, g01line.id);
    assert.equal(await slips.previewPayslip(tx, arjun, g01line.id), null);
    assert.ok(pdf && Buffer.from(pdf.slice(0, 5)).toString() === "%PDF-");
    await assert.rejects(runs.rollbackRun(tx, karan, run, "no"), /why/);
    await runs.rollbackRun(tx, karan, run, "Bonus for G12 was approved for October instead");
    assert.equal((await getRun(tx, run)).status, "rolled_back");
    const [{ n: slipsLeft }] = await tx<{ n: number }[]>`select count(*)::int as n from payslips p join payroll_lines l on l.id = p.line_id where l.run_id = ${run}`;
    assert.equal(slipsLeft, 0);
    const [unlocked] = await tx<{ is_locked: boolean }[]>`select is_locked from attendance_days where employee_id = ${g04} and date = '2026-09-08'`;
    assert.equal(unlocked.is_locked, false, "rolling back unlocks attendance");
    const { id: run2 } = await runs.createRun(tx, karan, g.id, M, "2026-09-20");
    await computeRun(tx, run2);
    assert.deepEqual(await tx`select employee_id, net_paise from payroll_lines where run_id = ${run2} order by employee_id`, await tx`select employee_id, net_paise from payroll_lines where run_id = ${run} order by employee_id`, "the re-run matches");
    let v2 = await runs.runView(tx, karan, run2);
    for (const s of v2.steps) if (!s.done) await runs.markReviewed(tx, karan, run2, s.key, true);
    await runs.finalizeRun(tx, karan, run2);
    await slips.releasePayslips(tx, karan, run2);

    // reports
    const reg = await reports.registerXlsx(tx, karan, run2);
    assert.equal(Buffer.from(reg.bytes.slice(0, 2)).toString(), "PK", "the register is an xlsx");
    const ecr = await reports.pfEcr(tx, karan, run2);
    assert.equal(ecr.text.trim().split("\n").length, 16, "PF for everyone processed but G05 (no PF) and G16 (held)");
    assert.ok(ecr.text.includes("#~#G01 GOLDEN#~#198200#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#0#~#0"));
    const esi = await reports.esiFile(tx, karan, run2);
    assert.equal(esi.text.trim().split("\r\n").length, 1 + 4, "ESI for the four people at ₹18,800");
    const pt = await reports.ptSummary(tx, karan, run2);
    assert.deepEqual(pt.summary.map((s) => s.state), ["KA", "MH", "TN"]);
    assert.equal(pt.summary.find((s) => s.state === "TN")!.pt, R(180));
    const j = await reports.journal(tx, karan, run2);
    assert.equal(j.totalDebit, j.totalCredit, "the journal balances");
    await assert.rejects(reports.registerXlsx(tx, arjun, run2), /whole company/);

    // payments
    const b = await pay.createBatch(tx, karan, run2, "hdfc_bulk");
    assert.equal(b.people, 16, "G06 has no bank account, G16 is held");
    await assert.rejects(pay.createBatch(tx, karan, run2, "neft_csv"), /already in a bank file|bank account/);
    v2 = await runs.runView(tx, karan, run2);
    await pay.markBatchPaid(tx, karan, b.id);
    assert.equal((await getRun(tx, run2)).status, "payslips_released", "not paid while G06 is unpaid");
    await assert.rejects(runs.rollbackRun(tx, karan, run2, "Too late for this"), /paid/);
    await runs.markLinePaidOutside(tx, karan, v2.lines.find((l) => l.employee_id === ids.G06)!.id, "Cheque 11");
    assert.equal((await getRun(tx, run2)).status, "paid");
    assert.equal((await pay.markBatchPaid(tx, karan, b.id)).changed, false, "marking paid twice does nothing");

    // October: back-dated revision → arrears; late September LOP rolls in; YTD flows into TDS; a final settlement
    await salary.saveSalary(tx, asha, { employeeId: ids.G02, structureId: st.id, ctcPaise: R(13_20_000), effectiveFrom: M, reason: "revision" }, { today: "2026-10-05", notify: false });
    await tx`insert into exit_requests (tenant_id, employee_id, kind, resignation_date, last_working_date, status) values (${tenant.id}, ${g11}, 'resignation', '2026-09-25', '2026-10-20', 'in_progress')`;
    const { id: oct } = await runs.createRun(tx, karan, g.id, OCT, "2026-10-05");
    await computeRun(tx, oct);
    const ov = await runs.runView(tx, karan, oct);
    const ol = (k: string) => ov.lines.find((l) => l.employee_id === ids[k])!;
    // ₹13.2L: BASIC 55,000, HRA 22,000, SPECIAL 31,200 → arrears for September 5,000 + 2,000 + 3,000
    assert.deepEqual(ol("G02").earnings.filter((e) => e.kind === "arrear").map((e) => [e.code, e.paise]).sort(), [["ARR_BASIC", R(5000)], ["ARR_HRA", R(2000)], ["ARR_SPECIAL", R(3000)]]);
    // 28 Sep at September's rate (÷ 30): 833.33 → 833, 333.33 → 333, 440
    assert.equal(ol("G04").earnings.filter((e) => e.kind === "lop").reduce((t, e) => t + e.paise, 0), -R(1606));
    // G01: same annual projection, 11,419 already deducted: (79,930 − 11,419) ÷ 6 = 11,418.50 → 11,419
    assert.equal(ol("G01").deduction_items.find((d) => d.code === "TDS")!.paise, R(11419));
    assert.ok(ol("G16").earnings.some((e) => e.kind === "arrear" && e.sourceMonth === M), "salary held in September is paid as arrears");
    assert.ok(ol("G11").warnings.some((w) => /full and final/.test(w)));

    const [x] = await tx<{ id: string }[]>`select id from exit_requests where employee_id = ${g11}`;
    await assert.rejects(fnf.buildSettlement(tx, { ...karan, employeeId: g11 }, x.id), /your own/);
    const d = await fnf.fnfDetail(tx, karan, x.id);
    assert.ok(d.prerequisite.ok, "September is finalised");
    const sal = d.preview.find((i) => i.key === "salary")!;
    // 20 of 31 days on ₹2.4L: 6,451.61 → 6,452 + 2,580.65 → 2,581 + 3,096.77 → 3,097 = 12,130
    assert.equal(sal.paise, R(12130));
    // 30 days' notice, 25 served: 5 × 18,800 ÷ 30 = 3,133.33 → 3,133
    assert.equal(d.preview.find((i) => i.key === "notice")!.paise, R(3133));
    assert.equal(d.preview.find((i) => i.key === "gratuity")!.action, "void", "under five years: no gratuity");
    await fnf.buildSettlement(tx, karan, x.id);
    await fnf.addManualItem(tx, karan, x.id, { label: "Joining bonus clawback", side: "deduction", paise: R(1000) });
    await fnf.setItemAction(tx, karan, x.id, "notice", "void");
    await assert.rejects(fnf.finalizeSettlement(tx, karan, x.id), /also in the October 2026 payroll/);
    await runs.setPayAction(tx, karan, oct, g11, "void", "Paid in the settlement");
    await computeRun(tx, oct);
    const fin = await fnf.finalizeSettlement(tx, karan, x.id);
    const after = await fnf.fnfDetail(tx, karan, x.id);
    assert.equal(after.settlement!.status, "finalized"); assert.equal(after.settlement!.net, fin.net);
    assert.equal(fin.net, after.settlement!.items.filter((i) => i.action === "pay").reduce((t, i) => t + (i.side === "earning" ? i.paise : -i.paise), 0));
    await assert.rejects(fnf.setItemAction(tx, karan, x.id, "notice", "pay"), /finalised/);
    const [stmt] = await tx<{ storage_key: string }[]>`select f.storage_key from files f join fnf_settlements s on s.statement_file_id = f.id where s.exit_request_id = ${x.id}`;
    assert.equal(Buffer.from((await storage().get(stmt.storage_key))!.slice(0, 5)).toString(), "%PDF-");
    await runs.setPayAction(tx, karan, oct, g11, "process", null);
    await computeRun(tx, oct);
    assert.equal((await runs.runView(tx, karan, oct)).lines.find((l) => l.employee_id === g11)!.action, "void", "a settled final month isn't paid twice");
  });
  ok("golden: 18 people's September net pay matches hand-worked figures (LOP, unpaid leave, joiner, leaver, mid-month revision, TN/MH PT, bonus, claims, loan, override, hold); recalculation is identical; finalise locks attendance; roll back and re-run; payslips, reports and bank files; arrears, rolled-over LOP and TDS year-to-date next month; full and final settlement");

  // ---------- F&F permissions and prerequisites on the seed ----------
  await rollback(tenant.id, async (tx) => {
    const [x] = await tx<{ id: string; employee_id: string }[]>`select x.id, x.employee_id from exit_requests x join employees e on e.id = x.employee_id where e.first_name = 'Nikhil'`;
    const d = await fnf.fnfDetail(tx, karan, x.id);
    assert.equal(d.settlement?.status, "draft");
    assert.ok(d.prerequisite.ok);
    const nikhil = { ...karan, employeeId: x.employee_id };
    await assert.rejects(fnf.buildSettlement(tx, nikhil, x.id), /your own/);
    await assert.rejects(fnf.buildSettlement(tx, arjun, x.id), /whole company/);
    await fnf.finalizeSettlement(tx, karan, x.id);
    const me = await slips.myPay(tx, { ...arjun, employeeId: x.employee_id });
    assert.ok(me.fnf?.fileId);
    assert.ok(await slips.payrollFileFor(tx, { ...arjun, employeeId: x.employee_id }, me.fnf!.fileId!), "the person opens their own statement");
    assert.equal(await slips.payrollFileFor(tx, arjun, me.fnf!.fileId!), null);
    const [divya] = await tx<{ id: string }[]>`select x.id from exit_requests x join employees e on e.id = x.employee_id where e.first_name = 'Divya' and x.status = 'in_progress'`;
    if (divya) {
      const dv = await fnf.fnfDetail(tx, karan, divya.id);
      if (!dv.prerequisite.ok) await assert.rejects(fnf.buildSettlement(tx, karan, divya.id).then(() => fnf.finalizeSettlement(tx, karan, divya.id)), /Finalise the/);
    }
  });
  ok("full and final: payroll only and never your own; finalising writes a statement the person can open; needs the previous month finalised");

  // ---------- tenant isolation ----------
  const otherId = randomUUID();
  await admin`insert into tenants (id, subdomain, name) values (${otherId}, ${"smoke-" + otherId.slice(0, 8)}, 'Smoke Co')`;
  try {
    const [c] = await withTenant(otherId, (tx) => tx<{ n: string }[]>`
      select concat_ws('/', (select count(*) from payroll_runs), (select count(*) from payroll_lines), (select count(*) from payslips), (select count(*) from payment_batches), (select count(*) from fnf_settlements), (select count(*) from payroll_inputs)) as n`);
    assert.equal(c.n, "0/0/0/0/0/0");
    const outsider = { ...asha, tenant: { ...tenant, id: otherId } } as Actor;
    await assert.rejects(withTenant(otherId, (tx) => runs.runView(tx, outsider, openRun.id)), /not found/);
    await assert.rejects(withTenant(otherId, (tx) => runs.saveInput(tx, outsider, openRun.id, null, { employeeId: rohan.employeeId, kind: "bonus", amountPaise: 1 })), /not found/);
    const [f] = await withTenant(tenant.id, (tx) => tx<{ file_id: string }[]>`select file_id from payslips where file_id is not null limit 1`);
    assert.equal(await withTenant(otherId, (tx) => slips.payrollFileFor(tx, outsider, f.file_id)), null);
    await assert.rejects(withTenant(otherId, (tx) => tx`insert into payroll_runs (tenant_id, pay_group_id, period_month) values (${tenant.id}, ${openRun.pay_group_id}, '2030-01-01')`), /row-level security/);
    assert.deepEqual((await withTenant(otherId, (tx) => runs.payrollHome(tx, outsider))).cards, []);
  } finally {
    await admin`delete from tenants where id = ${otherId}`;
  }
  ok("another tenant sees none of Acme's runs, lines, payslips, bank files, settlements or inputs and can't read or write them");

  void STEPS;
  for (const k of blobs) await storage().remove(k).catch(() => {});
  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await admin.end(); await sql.end(); }).catch(async (e) => {
  for (const k of blobs) await storage().remove(k).catch(() => {});
  console.error("\nFAILED:", e instanceof AppError ? `${e.code}: ${e.message}` : e); await admin.end(); await sql.end(); process.exit(1);
});
