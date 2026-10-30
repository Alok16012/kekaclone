/**
 * Smoke test for the payroll foundation against the seeded demo tenant (run `pnpm db:seed` first).
 * Everything runs in rolled-back transactions, so the demo data stays as seeded.
 *   pnpm smoke:payfoundation
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import ExcelJS from "exceljs";
import { withTenant, sql, AppError, type Tx } from "@/server/db";
import * as setup from "@/server/modules/payroll/setup";
import * as statutory from "@/server/modules/statutory/service";
import { bannerProps } from "@/features/payroll/page-data";
import * as salary from "@/server/modules/payroll/salary";
import * as revisions from "@/server/modules/payroll/revisions";
import { ensurePayrollDefaults } from "@/server/modules/payroll/defaults";
import { computeBreakup } from "@/server/modules/payroll/rules";
import { addDaysISO, todayIn } from "@/lib/dates";
import type { Actor } from "@/server/auth/session";
import type { Scope } from "@/server/auth/catalog";
import { DEMO_SUBDOMAIN } from "./demo";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const rollback = async (tenantId: string, fn: (tx: Tx) => Promise<void>) =>
  withTenant(tenantId, async (tx) => { await fn(tx); throw new Error("rollback"); }).catch((e) => { if (e.message !== "rollback") throw e; });

async function xlsx(rows: (string | number | Date | null)[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Revisions");
  ws.addRow(["Employee number *", "Name", "Current annual CTC", "New annual CTC *", "Effective from *", "Reason", "Structure"]);
  for (const r of rows) ws.addRow(r);
  const b = await wb.xlsx.writeBuffer();
  return new Uint8Array(b as ArrayBuffer).slice().buffer;
}

async function main() {
  const [t] = await sql<{ id: string }[]>`select id from tenant_by_subdomain(${DEMO_SUBDOMAIN})`;
  assert.ok(t, "demo tenant exists (run pnpm db:seed)");
  const tenant = { id: t.id, name: "Acme Technologies", status: "trial", subdomain: DEMO_SUBDOMAIN };
  const actor = (first: string, permissions: string[] = [], scopes: Scope[] = []) => withTenant(tenant.id, async (tx) => {
    const [e] = await tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`;
    assert.ok(e, `${first} exists`);
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(permissions), grants: permissions.length ? [{ permissions, scopes }] : [] } as Actor;
  });
  const P = ["payroll.admin"];
  const asha = await actor("Asha", ["*"]), karan = await actor("Karan", P), priya = await actor("Priya", ["employees.read", "employees.write", "leave.admin", "exits.manage"]);
  const arjun = await actor("Arjun"), rohan = await actor("Rohan"), sneha = await actor("Sneha");
  const [eng] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from departments where name = 'Engineering'`);
  const engPayroll = await actor("Fatima", P, [{ type: "department", ids: [eng.id] }]);
  const today = todayIn();
  const [std] = await withTenant(tenant.id, (tx) => tx<{ id: string; pay_group_id: string }[]>`select id, pay_group_id from salary_structures where name = 'Standard'`);

  // ---------- defaults + seed ----------
  await rollback(tenant.id, async (tx) => {
    const count = async () => (await tx<{ n: string }[]>`select concat_ws('/', (select count(*) from salary_components), (select count(*) from pay_groups), (select count(*) from salary_structures), (select count(*) from salary_structure_lines)) as n`)[0].n;
    const before = await count();
    await ensurePayrollDefaults(tx, tenant.id); await ensurePayrollDefaults(tx, tenant.id);
    assert.equal(await count(), before, "defaults are idempotent");
    assert.equal(before, "9/1/1/4");
    const people = await tx<{ n: number; with: number }[]>`select count(*)::int as n, count(*) filter (where exists (select 1 from employee_salaries s where s.employee_id = e.id))::int as with from employees e where status <> 'relieved'`;
    assert.equal(people[0].with, people[0].n, "every active employee has a CTC");
    const a = await salary.getActiveSalary(tx, arjun.employeeId, today);
    assert.equal(a?.ctcPaise, 13_80_000_00);
    assert.equal((await salary.getActiveSalary(tx, arjun.employeeId, `${today.slice(0, 4)}-03-31`))?.ctcPaise, 12_00_000_00, "the salary in force on a past date");
    assert.equal(await salary.getActiveSalary(tx, arjun.employeeId, "2020-01-01"), null);
    assert.equal((await salary.getStatutoryProfile(tx, arjun.employeeId)).ptState, null, "no state on the location yet");
    await tx`update locations set state_code = 'KA' where id = (select location_id from employees where id = ${arjun.employeeId})`;
    const sp = await salary.getStatutoryProfile(tx, arjun.employeeId);
    assert.equal(sp.ptState, "KA"); assert.equal(sp.ptStateSource, "location");
  });
  ok("defaults: 9 components, Monthly pay group, Standard structure (idempotent); every active employee has a CTC; getActiveSalary by date; PT state from location");

  // ---------- money maths on a real structure ----------
  await rollback(tenant.id, async (tx) => {
    const s = await setup.getStructure(tx, std.id);
    for (const ctc of [3_00_000_00, 12_00_000_00, 10_00_001_00, 99_99_999_99]) {
      const b = computeBreakup(setup.toDef(s!.lines), ctc);
      assert.ok(b.ok);
      assert.equal(b.lines.reduce((x, l) => x + l.monthlyPaise, 0), b.monthlyCtcPaise, "lines add up to monthly CTC");
      assert.equal(b.monthlyCtcPaise, Math.round(ctc / 12));
    }
    const [row] = await tx<{ breakup: Record<string, number> }[]>`select breakup from employee_salaries where employee_id = ${rohan.employeeId} and status = 'active'`;
    assert.deepEqual(row.breakup, { BASIC: 1_00_000_00, HRA: 40_000_00, PF_EMPLOYER: 1_800_00, SPECIAL: 58_200_00 }, "₹24 lakh frozen breakup");
  });
  ok("money: integer paise, monthly lines add to CTC/12 exactly, breakup frozen on the salary row");

  // ---------- company-wide setup needs an unscoped payroll.admin ----------
  await rollback(tenant.id, async (tx) => {
    const input = { name: "Leave travel", code: "lta", kind: "reimbursable", taxable: false, taxSection: "10(5)", lopProrated: false, frequency: "yearly", onPayslip: true, inArrears: false, pfWage: false, esiWage: false };
    await assert.rejects(setup.saveComponent(tx, engPayroll, null, input), /whole company/);
    await assert.rejects(setup.saveComponent(tx, priya, null, input), /whole company/);
    const c = await setup.saveComponent(tx, karan, null, input);
    const [row] = await tx<{ code: string; tax_section: string }[]>`select code, tax_section from salary_components where id = ${c.id}`;
    assert.equal(row.code, "LTA"); assert.equal(row.tax_section, "10(5)");
    await assert.rejects(setup.saveComponent(tx, karan, null, { ...input, name: "Again" }), /already uses this code/);
    await assert.rejects(setup.saveComponent(tx, karan, null, { ...input, code: "GROSS" }), /reserved/);
    const [basic] = await tx<{ id: string }[]>`select id from salary_components where code = 'BASIC'`;
    await assert.rejects(setup.saveComponent(tx, karan, basic.id, { ...input, code: "BASIC2", kind: "earning" }), /code can't change/);
    await assert.rejects(setup.deleteComponent(tx, karan, basic.id), /structure/);
    await setup.deleteComponent(tx, karan, c.id);
    const [le] = await tx<{ id: string }[]>`select id from legal_entities limit 1`;
    await assert.rejects(setup.savePayGroup(tx, engPayroll, null, { name: "Weekly", legalEntityId: le.id, cutoffDay: 20, payableDaysBasis: "fixed_30" }), /whole company/);
    const g = await setup.savePayGroup(tx, karan, null, { name: "Contractors", legalEntityId: le.id, cutoffDay: 20, payableDaysBasis: "fixed_30" });
    await assert.rejects(setup.savePayGroup(tx, karan, null, { name: "Contractors", legalEntityId: le.id, cutoffDay: 20, payableDaysBasis: "fixed_30" }), /already exists/);
    await assert.rejects(setup.savePayGroup(tx, karan, null, { name: "X", legalEntityId: le.id, cutoffDay: 32, payableDaysBasis: "calendar" }), /1 to 31/);
    await assert.rejects(setup.deletePayGroup(tx, karan, std.pay_group_id), /Move everyone/);
    await setup.deletePayGroup(tx, karan, g.id);
    const { fingerprint } = await statutory.verificationStatus(tx);
    await assert.rejects(statutory.recordVerification(tx, engPayroll, { verifiedByName: "R Kumar", verifiedOn: today, note: "ICAI 123456", fingerprint, confirm: true }, today), /company-wide access/);
  });
  ok("setup: components, pay groups and CA sign-off need payroll.admin for the whole company (scoped payroll and HR refused); codes unique, reserved and frozen once used; protected deletes");

  // ---------- structures: validation, cycles, live preview parity ----------
  await rollback(tenant.id, async (tx) => {
    const comps = await tx<{ id: string; code: string }[]>`select id, code from salary_components`;
    const id = (c: string) => comps.find((x) => x.code === c)!.id;
    const base = { name: "Senior", payGroupId: std.pay_group_id };
    await assert.rejects(setup.saveStructure(tx, karan, null, { ...base, lines: [{ componentId: id("BASIC"), calc: "formula", formula: "[HRA] * 2" }, { componentId: id("HRA"), calc: "formula", formula: "[BASIC] / 2" }, { componentId: id("SPECIAL"), calc: "balancing" }] }), /Circular reference/);
    await assert.rejects(setup.saveStructure(tx, karan, null, { ...base, lines: [{ componentId: id("BASIC"), calc: "pct_ctc", value: "40" }] }), /balancing/);
    await assert.rejects(setup.saveStructure(tx, karan, null, { ...base, lines: [{ componentId: id("BASIC"), calc: "formula", formula: "[NOPE]" }, { componentId: id("SPECIAL"), calc: "balancing" }] }), /isn't on this structure/);
    await assert.rejects(setup.saveStructure(tx, karan, null, { ...base, lines: [{ componentId: id("PT"), calc: "flat", value: "200" }, { componentId: id("SPECIAL"), calc: "balancing" }] }), /only earnings/);
    await assert.rejects(setup.saveStructure(tx, karan, null, { ...base, lines: [{ componentId: id("BASIC"), calc: "formula", formula: "[CTC] / ([CTC] - [CTC])" }, { componentId: id("SPECIAL"), calc: "balancing" }] }), /Division by zero/);
    await assert.rejects(setup.saveStructure(tx, engPayroll, null, { ...base, lines: [] }), /whole company/);
    const s = await setup.saveStructure(tx, karan, null, { ...base, lines: [{ componentId: id("BASIC"), calc: "pct_ctc", value: "40" }, { componentId: id("HRA"), calc: "pct_gross", value: "10" }, { componentId: id("PF_EMPLOYER"), calc: "flat", value: "1,800" }, { componentId: id("SPECIAL"), calc: "balancing" }] });
    const got = await setup.getStructure(tx, s.id);
    assert.deepEqual(got!.lines.map((l) => l.code), ["BASIC", "HRA", "PF_EMPLOYER", "SPECIAL"]);
    const b = computeBreakup(setup.toDef(got!.lines), 12_00_000_00);
    assert.ok(b.ok); assert.equal(b.breakup.HRA, 9_820_00, "10% of gross (₹98,200)");
    await assert.rejects(setup.saveStructure(tx, karan, null, { ...base, lines: got!.lines.map((l) => ({ componentId: l.component_id, calc: l.calc, value: l.value, formula: l.formula })) }), /already has a structure/);
    await assert.rejects(setup.deleteStructure(tx, karan, std.id), /use this structure/);
    await setup.deleteStructure(tx, karan, s.id);
  });
  ok("structures: circular references, missing balancing line, unknown codes, deductions and division by zero refused; % of gross; order kept; in-use structure protected");

  // ---------- salary: permissions, scopes, no self-service ----------
  await rollback(tenant.id, async (tx) => {
    const rev = (who: string, ctc: number, from = addDaysISO(today, 30)) => ({ employeeId: who, structureId: std.id, ctcPaise: ctc, effectiveFrom: from, reason: "revision" });
    await assert.rejects(salary.saveSalary(tx, karan, rev(karan.employeeId, 99_00_000_00)), /your own salary/);
    await assert.rejects(salary.saveSalary(tx, asha, rev(asha.employeeId, 99_00_000_00)), /your own salary/, "even a global admin can't raise their own pay");
    await assert.rejects(salary.saveSalary(tx, priya, rev(arjun.employeeId, 20_00_000_00)), /don't manage payroll/, "HR admin without payroll.admin");
    await assert.rejects(salary.saveSalary(tx, arjun, rev(arjun.employeeId, 20_00_000_00)), /don't manage payroll/);
    await assert.rejects(salary.saveSalary(tx, engPayroll, rev(sneha.employeeId, 20_00_000_00)), /don't manage payroll/, "scoped to Engineering; Sneha is in Sales");
    const r = await salary.saveSalary(tx, engPayroll, rev(arjun.employeeId, 15_00_000_00));
    assert.equal(r.arrearsFromMonth, null, "future-dated revision: no arrears");
    // viewing
    assert.equal(await salary.financesFor(tx, rohan, arjun.employeeId), null, "his manager can't see his salary");
    assert.equal(await salary.financesFor(tx, priya, arjun.employeeId), null, "HR without payroll.admin can't either");
    assert.equal(await salary.financesFor(tx, engPayroll, sneha.employeeId), null, "out-of-scope payroll admin can't");
    const mine = await salary.financesFor(tx, arjun, arjun.employeeId);
    assert.ok(mine && mine.self && !mine.canEdit && mine.structures.length === 0, "self sees read-only");
    assert.equal(mine.current!.ctcPaise, 13_80_000_00);
    assert.deepEqual(mine.upcoming, [{ effectiveFrom: addDaysISO(today, 30), ctcPaise: 15_00_000_00 }]);
    const theirs = await salary.financesFor(tx, karan, arjun.employeeId);
    assert.ok(theirs?.canEdit && theirs.structures.length === 1);
    const own = await salary.financesFor(tx, karan, karan.employeeId);
    assert.ok(own && !own.canEdit, "payroll admin sees but can't edit their own");
    // notification
    const [n] = await tx<{ title: string }[]>`select title from notifications where user_id = ${arjun.userId} and kind = 'salary.updated' order by created_at desc limit 1`;
    assert.equal(n.title, "Your salary has been revised");
  });
  ok("salary: payroll.admin in scope only; no one (not even a global admin) sets their own pay; managers and HR can't see salaries; the employee sees their own read-only");

  // ---------- revisions: effective dating, arrears, idempotency, statuses ----------
  await rollback(tenant.id, async (tx) => {
    const base = { employeeId: sneha.employeeId, structureId: std.id, reason: "promotion" as const };
    const future = addDaysISO(today, 45);
    const a = await salary.saveSalary(tx, karan, { ...base, ctcPaise: 12_00_000_00, effectiveFrom: future });
    const again = await salary.saveSalary(tx, karan, { ...base, ctcPaise: 12_00_000_00, effectiveFrom: future });
    assert.ok(again.unchanged && again.id === a.id, "same revision twice is a no-op");
    await assert.rejects(salary.saveSalary(tx, karan, { ...base, ctcPaise: 13_00_000_00, effectiveFrom: future }), /already starts on this date/);
    assert.equal((await salary.getActiveSalary(tx, sneha.employeeId, today))?.ctcPaise, 10_00_000_00, "future revision isn't in force yet");
    assert.equal((await salary.getActiveSalary(tx, sneha.employeeId, future))?.ctcPaise, 12_00_000_00);
    const statuses = await tx<{ effective_from: string; status: string; reason: string }[]>`select effective_from::text, status, reason from employee_salaries where employee_id = ${sneha.employeeId} order by effective_from`;
    assert.deepEqual(statuses.map((s) => s.status), ["superseded", "superseded", "active"]);
    assert.equal(statuses[2].reason, "promotion");
    // backdated → arrears from that month
    const back = `${addDaysISO(`${today.slice(0, 7)}-01`, -40).slice(0, 7)}-15`;
    const b = await salary.saveSalary(tx, karan, { ...base, ctcPaise: 11_00_000_00, effectiveFrom: back, reason: "correction" });
    assert.equal(b.arrearsFromMonth, `${back.slice(0, 7)}-01`);
    // a finalised run for this month makes even a this-month revision carry arrears
    await tx`insert into payroll_runs (tenant_id, pay_group_id, period_month, status) values (${tenant.id}, ${std.pay_group_id}, ${`${today.slice(0, 7)}-01`}, 'finalized')`;
    const c = await salary.saveSalary(tx, karan, { employeeId: arjun.employeeId, structureId: std.id, ctcPaise: 14_00_000_00, effectiveFrom: `${today.slice(0, 7)}-01`, reason: "revision" });
    assert.equal(c.arrearsFromMonth, `${today.slice(0, 7)}-01`);
    // limits
    await assert.rejects(salary.saveSalary(tx, karan, { ...base, ctcPaise: 12_00_000_00, effectiveFrom: "2001-01-01" }), /before .* joined/);
    await assert.rejects(salary.saveSalary(tx, karan, { ...base, ctcPaise: 0, effectiveFrom: addDaysISO(today, 60) }), /annual CTC/);
    // delete the future one → the backdated correction is the latest again
    await salary.deleteSalary(tx, karan, a.id);
    const [cur] = await tx<{ ctc_paise: bigint }[]>`select ctc_paise from employee_salaries where employee_id = ${sneha.employeeId} and status = 'active'`;
    assert.equal(Number(cur.ctc_paise), 11_00_000_00);
    await assert.rejects(salary.deleteSalary(tx, sneha, b.id), /own salary|don't manage/);
    const [first] = await tx<{ id: string }[]>`select id from employee_salaries where employee_id = ${sneha.employeeId} and reason = 'joining'`;
    await assert.rejects(salary.deleteSalary(tx, karan, first.id), /first salary/);
  });
  ok("revisions: effective-dated, one per date (same one twice is a no-op), future-dated not yet in force, backdated or locked-month ones carry arrears, delete restores the previous one");

  // ---------- bank + statutory ----------
  await rollback(tenant.id, async (tx) => {
    const acct = "123456789012";
    await assert.rejects(salary.saveBankAccount(tx, karan, karan.employeeId, { bankName: "HDFC Bank", ifsc: "HDFC0001234", accountNumber: acct, holderName: "Karan" }), /your own/);
    await assert.rejects(salary.saveBankAccount(tx, arjun, arjun.employeeId, { bankName: "HDFC Bank", ifsc: "HDFC0001234", accountNumber: acct, holderName: "Arjun" }), /don't manage/);
    await assert.rejects(salary.saveBankAccount(tx, karan, arjun.employeeId, { bankName: "HDFC Bank", ifsc: "HDFC1001234", accountNumber: acct, holderName: "Arjun" }), /IFSC/);
    await assert.rejects(salary.saveBankAccount(tx, karan, arjun.employeeId, { bankName: "HDFC Bank", ifsc: "HDFC0001234", accountNumber: "12ab", holderName: "Arjun" }), /9 to 18 digits/);
    await salary.saveBankAccount(tx, karan, arjun.employeeId, { bankName: "HDFC Bank", ifsc: "hdfc0001234", accountNumber: "1234 5678 9012", holderName: "Arjun Rao" });
    const [row] = await tx<{ enc: Uint8Array; last4: string; ifsc: string; n: number }[]>`select account_number_enc as enc, account_last4 as last4, ifsc, (select count(*)::int from employee_bank_accounts where employee_id = ${arjun.employeeId}) as n from employee_bank_accounts where employee_id = ${arjun.employeeId}`;
    assert.equal(row.n, 1, "replaced, not duplicated");
    assert.equal(row.last4, "9012"); assert.equal(row.ifsc, "HDFC0001234");
    assert.ok(!Buffer.from(row.enc).toString("latin1").includes(acct), "encrypted at rest");
    assert.equal((await salary.bankAccountFor(tx, tenant.id, arjun.employeeId))?.accountNumber, acct);
    await tx`update employee_bank_accounts set account_number_enc = (select account_number_enc from employee_bank_accounts where employee_id = ${sneha.employeeId}) where employee_id = ${arjun.employeeId}`;
    await assert.rejects(salary.bankAccountFor(tx, tenant.id, arjun.employeeId), "a ciphertext copied from another person doesn't decrypt");
    const view = await salary.financesFor(tx, arjun, arjun.employeeId);
    assert.equal(JSON.stringify(view).includes(acct), false, "the full number never reaches the page");
    const [note] = await tx<{ body: string }[]>`select body from notifications where user_id = ${arjun.userId} and kind = 'bank.updated' order by created_at desc limit 1`;
    assert.match(note.body, /ending 9012/);

    await assert.rejects(salary.saveStatutory(tx, karan, arjun.employeeId, { pfEnabled: true, uan: "123", pfOnFullWage: false, esiEnabled: false, taxRegime: "new" }), /12 digits/);
    await assert.rejects(salary.saveStatutory(tx, karan, arjun.employeeId, { pfEnabled: true, pfOnFullWage: false, esiEnabled: false, ptState: "ZZ", taxRegime: "new" }), /Pick a state/);
    await assert.rejects(salary.saveStatutory(tx, arjun, arjun.employeeId, { pfEnabled: false, pfOnFullWage: false, esiEnabled: false, taxRegime: "old" }), /don't manage/);
    await salary.saveStatutory(tx, karan, arjun.employeeId, { pfEnabled: false, uan: "100200300499", pfOnFullWage: true, esiEnabled: false, esiNumber: "1234567890", ptState: "MH", taxRegime: "old" });
    const sp = await salary.getStatutoryProfile(tx, arjun.employeeId);
    assert.deepEqual([sp.pfEnabled, sp.pfOnFullWage, sp.uan, sp.ptState, sp.ptStateSource, sp.lwfState, sp.taxRegime], [false, false, "100200300499", "MH", "profile", null, "old"]);
  });
  ok("bank: IFSC and account checks, AES-256-GCM at rest bound to the person, last 4 only on the page, person notified; statutory profile validated, PT state override vs location; never self-service");

  // ---------- bulk revision import ----------
  await rollback(tenant.id, async (tx) => {
    const nums = Object.fromEntries((await tx<{ first_name: string; employee_number: string }[]>`select first_name, employee_number from employees`).map((e) => [e.first_name, e.employee_number]));
    const when = addDaysISO(today, 20);
    await assert.rejects(revisions.previewRevisionImport(tx, priya, await xlsx([[nums.Arjun, null, null, 1500000, when, "revision", null]])), /access to salaries/);
    const bad = await revisions.previewRevisionImport(tx, engPayroll, await xlsx([
      [nums.Arjun, null, null, 1500000, when, "revision", null],
      [nums.Sneha, null, null, 1500000, when, null, null],
      [nums.Fatima, null, null, 1500000, when, null, null],
      ["NOPE-1", null, null, 1500000, when, null, null],
      [nums.Meera, null, null, "lots", "someday", "bonus", "Nope"],
    ]));
    assert.equal(bad.valid, false);
    const errs = (i: number) => bad.results[i].errors.join(" ");
    assert.equal(errs(0), "");
    assert.match(errs(1), /don't manage payroll/);
    assert.match(errs(2), /don't manage payroll|own salary/);
    assert.match(errs(3), /No one has employee number/);
    assert.match(errs(4), /amount in rupees/); assert.match(errs(4), /must be a date/); assert.match(errs(4), /Reason must be/); assert.match(errs(4), /No structure called Nope/);
    await assert.rejects(revisions.commitRevisionImport(tx, engPayroll, await xlsx([[nums.Arjun, null, null, 1500000, when, null, null], [nums.Sneha, null, null, 1500000, when, null, null]])), /Some rows have problems/);
    assert.equal((await tx`select 1 from employee_salaries where effective_from = ${when}`).length, 0, "all or nothing");

    const file = await xlsx([[nums.Arjun, "Arjun", 1380000, "15,00,000", new Date(`${when}T00:00:00Z`), "promotion", "Standard"], [nums.Meera, null, null, 1600000, when, null, null], [nums.Rohan, null, null, null, null, null, null]]);
    const pv = await revisions.previewRevisionImport(tx, karan, file);
    assert.ok(pv.valid); assert.equal(pv.total, 2, "rows without a new CTC are skipped"); assert.equal(pv.changes, 2);
    const c1 = await revisions.commitRevisionImport(tx, karan, file);
    assert.equal(c1.changed, 2);
    const c2 = await revisions.commitRevisionImport(tx, karan, file);
    assert.equal(c2.changed, 0, "re-uploading the same file changes nothing");
    assert.equal((await revisions.previewRevisionImport(tx, karan, file)).changes, 0);
    const [r] = await tx<{ ctc_paise: bigint; reason: string }[]>`select ctc_paise, reason from employee_salaries where employee_id = ${arjun.employeeId} and effective_from = ${when}`;
    assert.equal(Number(r.ctc_paise), 15_00_000_00); assert.equal(r.reason, "promotion");
    const self = await revisions.previewRevisionImport(tx, karan, await xlsx([[nums.Karan, null, null, 9900000, when, null, null]]));
    assert.match(self.results[0].errors.join(" "), /your own salary/);
    const tpl = await revisions.buildRevisionTemplate(tx, engPayroll);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(new Uint8Array(tpl).buffer);
    const listed: string[] = []; wb.getWorksheet("Revisions")!.eachRow((row, i) => { if (i > 1) listed.push(String(row.getCell(1).value)); });
    assert.ok(listed.includes(nums.Arjun) && !listed.includes(nums.Sneha) && !listed.includes(nums.Fatima), "template lists only people in scope, not yourself");
  });
  ok("bulk revisions: Excel preview checks every row (scope, self, codes, amounts, dates, reasons, structures), all-or-nothing commit, re-upload is idempotent, template scoped");

  // ---------- pay groups ----------
  await rollback(tenant.id, async (tx) => {
    const [le2] = await tx<{ id: string }[]>`insert into legal_entities (tenant_id, name) values (${tenant.id}, 'Acme Labs') returning id`;
    const g = await setup.savePayGroup(tx, karan, null, { name: "Labs", legalEntityId: le2.id, cutoffDay: 25, payableDaysBasis: "working" });
    await assert.rejects(setup.assignPayGroup(tx, karan, g.id, [arjun.employeeId]), /different legal entity/);
    await assert.rejects(setup.assignPayGroup(tx, engPayroll, std.pay_group_id, [arjun.employeeId]), /whole company/);
    const g2 = await setup.savePayGroup(tx, karan, null, { name: "Monthly 2", legalEntityId: (await tx<{ id: string }[]>`select legal_entity_id as id from pay_groups where id = ${std.pay_group_id}`)[0].id, cutoffDay: 25, payableDaysBasis: "calendar" });
    assert.equal((await setup.assignPayGroup(tx, karan, g2.id, [arjun.employeeId])).moved, 1);
    assert.equal((await setup.assignPayGroup(tx, karan, g2.id, [arjun.employeeId])).moved, 0, "idempotent");
    await assert.rejects(salary.saveSalary(tx, karan, { employeeId: arjun.employeeId, structureId: std.id, ctcPaise: 20_00_000_00, effectiveFrom: addDaysISO(today, 10) }), /another pay group/);
    assert.equal((await salary.getActiveSalary(tx, arjun.employeeId, today))?.ctcPaise, 13_80_000_00, "current salary stays until revised");
  });
  ok("pay groups: legal entity must match, unscoped admin only, moves are idempotent, salaries must use a structure from the person's pay group");

  // ---------- CA sign-off ----------
  await rollback(tenant.id, async (tx) => {
    const before = await bannerProps(tx, karan);
    assert.equal(before.verified, false, "warning shows until a CA signs off");
    const { fingerprint } = await statutory.verificationStatus(tx);
    await assert.rejects(statutory.recordVerification(tx, karan, { verifiedByName: "R Kumar", verifiedOn: today, note: "ICAI 123456", fingerprint } as never, today), /Confirm/);
    await assert.rejects(statutory.recordVerification(tx, karan, { verifiedByName: "R Kumar", verifiedOn: addDaysISO(today, 1), note: "ICAI 123456", fingerprint, confirm: true }, today), /future/);
    await statutory.recordVerification(tx, karan, { verifiedByName: "R Kumar", verifiedOn: today, note: "Kumar & Co, ICAI 123456", fingerprint, confirm: true }, today);
    const after = await bannerProps(tx, karan);
    assert.equal(after.verified, true); assert.equal(after.caName, "R Kumar");
    await assert.rejects(tx`insert into statutory_rates (kind, effective_from, config, source_note) values ('pf', '2026-04-01', '{}', 'x')`, /permission denied/, "the app can't edit statutory rates");
  });
  ok("statutory: warning until an unscoped payroll admin records a CA review (confirmed, dated, not future); the app can't write statutory_rates");

  // ---------- tenant isolation ----------
  const otherId = randomUUID();
  await admin`insert into tenants (id, subdomain, name) values (${otherId}, ${"smoke-" + otherId.slice(0, 8)}, 'Smoke Co')`;
  try {
    const [c] = await withTenant(otherId, (tx) => tx<{ n: string }[]>`
      select concat_ws('/', (select count(*) from salary_components), (select count(*) from pay_groups), (select count(*) from salary_structures), (select count(*) from salary_structure_lines),
        (select count(*) from employee_salaries), (select count(*) from employee_bank_accounts), (select count(*) from employee_statutory)) as n`);
    assert.equal(c.n, "0/0/0/0/0/0/0");
    const outsider = { ...karan, tenant: { ...tenant, id: otherId } } as Actor;
    assert.equal(await withTenant(otherId, (tx) => salary.financesFor(tx, outsider, arjun.employeeId)), null);
    assert.equal(await withTenant(otherId, (tx) => salary.getActiveSalary(tx, arjun.employeeId, today)), null);
    await assert.rejects(withTenant(otherId, (tx) => salary.saveSalary(tx, outsider, { employeeId: arjun.employeeId, structureId: std.id, ctcPaise: 1_00_00_000_00, effectiveFrom: today })), /not found/);
    await assert.rejects(withTenant(otherId, (tx) => tx`insert into salary_components (tenant_id, code, name, kind) values (${tenant.id}, 'SNEAKY', 'x', 'earning')`), /row-level security/);
    const r = await withTenant(otherId, (tx) => tx`update employee_salaries set ctc_paise = 1 where employee_id = ${arjun.employeeId}`);
    assert.equal(r.count, 0);
    assert.equal((await withTenant(otherId, (tx) => setup.listStructures(tx))).length, 0);
    ok("another tenant sees none of Acme's components, pay groups, structures, salaries, bank or statutory rows and can't write them");
  } finally {
    await admin`delete from tenants where id = ${otherId}`;
  }

  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await admin.end(); await sql.end(); }).catch(async (e) => {
  console.error("\nFAILED:", e instanceof AppError ? `${e.code}: ${e.message}` : e); await admin.end(); await sql.end(); process.exit(1);
});
