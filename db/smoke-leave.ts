/**
 * Smoke test for leave administration against the seeded demo tenant (run `pnpm db:seed` first):
 * permissions and scopes, types/plans/rules, plan assignment, accrual idempotency and probation stop, balance
 * adjustments and Excel import, year-end carry/encash/lapse, comp-off approval + expiry, holidays and floaters,
 * the team calendar, and tenant isolation. Everything runs in rolled-back transactions.
 *   pnpm smoke:leave
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import ExcelJS from "exceljs";
import { withTenant, sql, AppError, type Tx } from "@/server/db";
import * as leave from "@/server/modules/leave/service";
import * as admin from "@/server/modules/leave/admin";
import * as holidays from "@/server/modules/leave/holidays";
import * as compOff from "@/server/modules/leave/comp-off";
import { teamLeaveMonth } from "@/server/modules/leave/team";
import { processCompOffExpiry, runAccrual, runLeaveJobs, yearEndPreview, yearEndRun, encashMonths } from "@/server/modules/leave/accrual";
import * as approvals from "@/server/modules/approvals/service";
import { addDaysISO, todayIn, weekday } from "@/lib/dates";
import type { Actor } from "@/server/auth/session";
import type { Scope } from "@/server/auth/catalog";
import { DEMO_SUBDOMAIN } from "./demo";

const owner = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const ROLLBACK = "rollback";

async function main() {
  const [t] = await sql<{ id: string }[]>`select id from tenant_by_subdomain(${DEMO_SUBDOMAIN})`;
  assert.ok(t, "demo tenant exists (run pnpm db:seed)");
  const tenant = { id: t.id, name: "Acme Technologies", status: "trial", subdomain: DEMO_SUBDOMAIN };
  const rolled = async (fn: (tx: Tx) => Promise<void>) => {
    await withTenant(tenant.id, async (tx) => { await fn(tx); throw new Error(ROLLBACK); }).catch((e) => { if (e.message !== ROLLBACK) throw e; });
  };
  const people = await withTenant(tenant.id, (tx) => tx<{ id: string; first_name: string; user_id: string; display_name: string; department_id: string }[]>`
    select id, first_name, user_id, display_name, department_id from employees`);
  const P = Object.fromEntries(people.map((p) => [p.first_name, p]));
  const actor = (first: string, perms: string[] = [], scopes: Scope[] = []): Actor => ({
    tenant, userId: P[first].user_id, employeeId: P[first].id, name: P[first].display_name, email: "", title: null, roles: [],
    permissions: new Set(perms), grants: perms.length ? [{ permissions: perms, scopes }] : [],
  });
  const asha = actor("Asha", ["*"]);
  const arjun = actor("Arjun"), rohan = actor("Rohan"), meera = actor("Meera"), karan = actor("Karan");
  const engineering = P.Arjun.department_id;
  const scopedHr = actor("Priya", ["leave.admin"], [{ type: "department", ids: [engineering] }]);
  const today = todayIn();
  const typeId = async (tx: Tx, code: string) => (await tx<{ id: string }[]>`select id from leave_types where code = ${code}`)[0].id;
  const [standard] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from leave_plans where is_default`);
  const workday = async (tx: Tx, emp: string, from: string) => {
    const cal = await leave.calendarFor(tx, emp);
    let d = from; while (["sat", "sun"].includes(weekday(d)) || cal.holidays.has(d)) d = addDaysISO(d, 1);
    return d;
  };
  const ledgerSum = (tx: Tx, emp: string, type: string, cycle?: string) =>
    tx<{ s: string }[]>`select coalesce(sum(amount), 0) as s from leave_ledger where employee_id = ${emp} and leave_type_id = ${type} and (${cycle ?? null}::date is null or cycle_start = ${cycle ?? null})`.then((r) => Number(r[0].s));

  // ---------- permissions
  await rolled(async (tx) => {
    const forbidden = /Only leave admins|don't have access|can't/;
    await assert.rejects(admin.saveType(tx, arjun, null, { name: "Fun leave", code: "FUN", kind: "regular", paid: true, color: "var(--chart-1)" }), forbidden);
    await assert.rejects(admin.savePlan(tx, scopedHr, null, { name: "Scoped plan", yearStart: "jan" }), /Only leave admins for the whole company/);
    await assert.rejects(holidays.saveHolidayList(tx, arjun, null, { name: "X", year: 2026, floaterLimit: 0 }), forbidden);
    await assert.rejects(yearEndPreview(tx, scopedHr, standard.id), forbidden);
    await assert.rejects(admin.balanceTable(tx, arjun), /don't have access/);
    const cl = await typeId(tx, "CL");
    await assert.rejects(admin.adjustBalance(tx, arjun, { employeeId: P.Meera.id, leaveTypeId: cl, amount: 1, reason: "nice try" }), /can't adjust/);
    // scoped HR: Engineering only
    const table = await admin.balanceTable(tx, scopedHr);
    assert.ok(table.rows.length > 0 && table.rows.every((r) => people.find((p) => p.id === r.id)!.department_id === engineering));
    await admin.adjustBalance(tx, scopedHr, { employeeId: P.Arjun.id, leaveTypeId: cl, amount: 1, reason: "Worked on a holiday" });
    await assert.rejects(admin.adjustBalance(tx, scopedHr, { employeeId: P.Karan.id, leaveTypeId: cl, amount: 1, reason: "Out of scope" }), /can't adjust/);
    await assert.rejects(admin.assignPlan(tx, scopedHr, standard.id, [P.Karan.id]), /can't change the leave plan for Karan/);
  });
  ok("permissions: employees can't touch leave settings; department-scoped HR sees and adjusts only their department, can't edit company policies");

  // ---------- leave types
  await rolled(async (tx) => {
    const r = await admin.saveType(tx, asha, null, { name: "Marriage leave", code: "ml", kind: "incident", paid: true, color: "var(--chart-5)" });
    const [row] = await tx<{ code: string }[]>`select code from leave_types where id = ${r.id}`;
    assert.equal(row.code, "ML");
    await assert.rejects(admin.saveType(tx, asha, null, { name: "Another", code: "CL", kind: "regular", paid: true, color: "#2a78d6" }), /already uses this code/);
    // the duplicate didn't abort the transaction (savepoint)
    await assert.rejects(admin.saveType(tx, asha, null, { name: "Bad", code: "LW2", kind: "unpaid", paid: true, color: "#2a78d6" }), /can't be marked as paid/);
    await assert.rejects(admin.saveType(tx, asha, null, { name: "Bad", code: "X1", kind: "regular", paid: true, color: "red" }), /colour/);
    const cl = await typeId(tx, "CL");
    await assert.rejects(admin.saveType(tx, asha, cl, { name: "Casual leave", code: "CL", kind: "unpaid", paid: false, color: "#2a78d6" }), /kind can't change/);
    await assert.rejects(admin.deleteType(tx, asha, cl), /Remove this leave type from every leave plan/);
    await admin.deleteType(tx, asha, r.id);
    const [gone] = await tx`select 1 from leave_types where id = ${r.id}`;
    assert.equal(gone, undefined);
    const [a] = await tx<{ c: number }[]>`select count(*)::int as c from audit_logs where entity_type = 'leave_type' and entity_id = ${r.id}`;
    assert.equal(a.c, 2);
  });
  ok("leave types: codes upper-cased and unique (friendly error, transaction survives), used types keep their kind, delete only when unused, audited");

  // ---------- plans, rules, approval chains
  await rolled(async (tx) => {
    const p = await admin.savePlan(tx, asha, null, { name: "Contractors", yearStart: "apr" });
    await assert.rejects(admin.savePlan(tx, asha, p.id, { name: "Contractors", yearStart: "jan" }), /leave year can't change/);
    await admin.savePlan(tx, asha, p.id, { name: "Contractors 2026", description: "Fixed-term staff" });
    await assert.rejects(admin.savePlan(tx, asha, null, { name: "Contractors 2026", yearStart: "jan" }), /already exists/);
    await assert.rejects(admin.deletePlan(tx, asha, standard.id), /default plan can't be deleted/);
    const cl = await typeId(tx, "CL"), co = await typeId(tx, "CO");
    const rule = await admin.addTypeToPlan(tx, asha, p.id, cl);
    await assert.rejects(admin.addTypeToPlan(tx, asha, p.id, cl), /already in the plan/);
    const coRule = await admin.addTypeToPlan(tx, asha, p.id, co);
    const base: admin.RuleInput = {
      quota: 6, accrual: { frequency: "quarterly", day: 1, prorate_joining: true, stop_in_probation: false },
      application: { allowHalfDay: true, backdateDays: 3, sandwich: { enabled: false } }, year_end: { carry: "none" }, approval: { auto: true },
    };
    await admin.saveRule(tx, asha, rule.id, base);
    await assert.rejects(admin.saveRule(tx, asha, coRule.id, { ...base, quota: 5 }), /no yearly quota/);
    await assert.rejects(admin.saveRule(tx, asha, rule.id, { ...base, year_end: { carry: "upto" } }), /how many days can carry/);
    await assert.rejects(admin.saveRule(tx, asha, rule.id, { ...base, accrual: { ...base.accrual, day: 31 } }), /Check/);
    // bulk assign Arjun + Meera → accrual under the new plan; plan with people can't be deleted
    const moved = await admin.assignPlan(tx, asha, p.id, [P.Arjun.id, P.Meera.id]);
    assert.equal(moved.moved, 2);
    const [{ c }] = await tx<{ c: number }[]>`select count(*)::int as c from employees where leave_plan_id = ${p.id}`;
    assert.equal(c, 2);
    await assert.rejects(admin.deletePlan(tx, asha, p.id), /2 people are on this plan/);
    // auto-approve chain: Arjun's casual leave is approved straight away
    const d = await workday(tx, P.Arjun.id, addDaysISO(today, 20));
    const auto = await leave.apply(tx, arjun, { leaveTypeId: cl, from: d, to: d, fromPart: "full", toPart: "full" });
    assert.equal(auto.status, "approved");
    // two-level chain: manager then HR admin
    await admin.saveRule(tx, asha, rule.id, { ...base, approval: { levels: [{ approver: "manager" }, { approver: "role", role: "hr_admin" }] } });
    const d2 = await workday(tx, P.Meera.id, addDaysISO(d, 1));
    const chained = await leave.apply(tx, meera, { leaveTypeId: cl, from: d2, to: d2, fromPart: "full", toPart: "full" });
    assert.equal(chained.status, "pending");
    const steps = await approvals.timeline(tx, "leave", chained.id);
    assert.deepEqual(steps.map((s) => [s.approver, s.status]), [["Rohan Mehta", "pending"], ["Priya Nair", "waiting"]]);
  });
  ok("plans: leave year locked after create, unique names, default can't go, bulk assign credits the new plan; rules validated; per-type chains (auto-approve, manager → HR)");

  // ---------- accrual engine
  await rolled(async (tx) => {
    const first = await runAccrual(tx, tenant.id, today);
    const again = await runAccrual(tx, tenant.id, today);
    assert.equal(again.posted, 0, `second run posts nothing (first posted ${first.posted})`);
    const cl = await typeId(tx, "CL");
    const cycle = `${today.slice(0, 4)}-01-01`;
    const months = Number(today.slice(5, 7));
    assert.equal(await ledgerSum(tx, P.Arjun.id, cl, cycle), months, "monthly casual leave: one day per month so far");
    const [k] = await tx<{ c: number }[]>`select count(*)::int as c from leave_ledger where employee_id = ${P.Arjun.id} and leave_type_id = ${cl} and idempotency_key = ${`accrual:${P.Arjun.id}:${cl}:${today.slice(0, 7)}`}`;
    assert.equal(k.c, 1, "ledger key accrual:{employee}:{type}:{period}");
    // quota raised mid-year → one top-up, then idempotent again
    await tx`update leave_plan_rules set yearly_quota = 24 where leave_plan_id = ${standard.id} and leave_type_id = ${cl}`;
    await runAccrual(tx, tenant.id, today, { employeeIds: [P.Arjun.id] });
    assert.equal(await ledgerSum(tx, P.Arjun.id, cl, cycle), months * 2);
    assert.equal((await runAccrual(tx, tenant.id, today, { employeeIds: [P.Arjun.id] })).posted, 0);
    // lowered quota never claws back
    await tx`update leave_plan_rules set yearly_quota = 6 where leave_plan_id = ${standard.id} and leave_type_id = ${cl}`;
    assert.equal((await runAccrual(tx, tenant.id, today)).posted, 0);
    assert.equal(await ledgerSum(tx, P.Arjun.id, cl, cycle), months * 2);
    // probation stop + joining proration on a brand-new person
    await tx`update leave_plan_rules set yearly_quota = 12, accrual = ${tx.json({ frequency: "monthly", day: 1, prorate_joining: true, stop_in_probation: true })}
             where leave_plan_id = ${standard.id} and leave_type_id = ${cl}`;
    const joining = `${today.slice(0, 4)}-06-01`, probationEnd = `${today.slice(0, 4)}-09-15`;
    const [n] = await tx<{ id: string }[]>`
      insert into employees (tenant_id, employee_number, first_name, display_name, work_email, joining_date, leave_plan_id, probation_status, probation_end_date)
      values (${tenant.id}, 'SMOKE-ACC', 'Acc', 'Acc Rual', 'acc@acme.test', ${joining}, ${standard.id}, 'in_probation', ${probationEnd}) returning id`;
    await runAccrual(tx, tenant.id, `${today.slice(0, 4)}-10-30`, { employeeIds: [n.id] });
    assert.equal(await ledgerSum(tx, n.id, cl, cycle), 1, "June–September were in probation; October credited");
    assert.equal(await ledgerSum(tx, n.id, await typeId(tx, "EL"), cycle), 6.25, "earned leave doesn't stop: 5 × 1.25");
    assert.equal(await ledgerSum(tx, n.id, await typeId(tx, "SL"), cycle), 4.5, "upfront sick leave prorated: 8 × 7/12 → 4.5");
    // the leave job wrapper runs accrual + expiry
    const job = await runLeaveJobs(tx, tenant.id, `${today.slice(0, 4)}-10-30`);
    assert.equal(job.accrual.posted, 0);
  });
  ok("accrual: idempotent re-runs, period ledger keys, quota increase tops up once, decrease never claws back, probation stop, joining proration");

  // ---------- balances admin: adjust + ledger + audit + notification
  await rolled(async (tx) => {
    const el = await typeId(tx, "EL");
    const before = (await leave.balances(tx, P.Karan.id)).find((b) => b.id === el)!;
    await admin.adjustBalance(tx, asha, { employeeId: P.Karan.id, leaveTypeId: el, amount: 2.5, reason: "Carried over from the old HR system" });
    await admin.adjustBalance(tx, asha, { employeeId: P.Karan.id, leaveTypeId: el, amount: -1, reason: "Correction" });
    const after = (await leave.balances(tx, P.Karan.id)).find((b) => b.id === el)!;
    assert.equal(after.available, before.available + 1.5);
    await assert.rejects(admin.adjustBalance(tx, asha, { employeeId: P.Karan.id, leaveTypeId: el, amount: 0, reason: "nothing" }), /days to add or remove/);
    await assert.rejects(admin.adjustBalance(tx, asha, { employeeId: P.Karan.id, leaveTypeId: el, amount: 1, reason: "" }), /Say why/);
    const [trainee] = await tx<{ id: string }[]>`select id from leave_plans where name = 'Trainees'`;
    const [aditya] = await tx<{ leave_plan_id: string }[]>`select leave_plan_id from employees where id = ${P.Aditya.id}`;
    assert.equal(aditya.leave_plan_id, trainee.id);
    await assert.rejects(admin.adjustBalance(tx, asha, { employeeId: P.Aditya.id, leaveTypeId: el, amount: 1, reason: "not in plan" }), /isn't in the person's leave plan/);
    const [aud] = await tx<{ c: number }[]>`select count(*)::int as c from audit_logs where entity_id = ${P.Karan.id} and action = 'leave.adjust'`;
    assert.equal(aud.c, 2);
    const [note] = await tx<{ c: number }[]>`select count(*)::int as c from notifications where user_id = ${P.Karan.user_id} and kind = 'leave.adjusted'`;
    assert.equal(note.c, 2);
    const led = await admin.ledgerFor(tx, asha, P.Karan.id);
    assert.deepEqual(led.entries.filter((e) => e.kind === "adjust").map((e) => Number(e.amount)).sort(), [-1, 2.5]);
    await assert.rejects(admin.ledgerFor(tx, arjun, P.Karan.id), /don't have access/);
  });
  ok("balances: credit/debit with a reason → ledger 'adjust', audit log, notification; zero and reasonless refused; type must be in the plan");

  // ---------- opening balance import
  await rolled(async (tx) => {
    const tpl = await admin.buildBalanceTemplate(tx, asha);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(new Uint8Array(tpl).buffer);
    const ws = wb.getWorksheet("Balances")!;
    const [arjunNo] = await tx<{ n: string }[]>`select employee_number as n from employees where id = ${P.Arjun.id}`;
    let setRow = 0;
    ws.eachRow((r, i) => { if (i > 1 && r.getCell(1).value === arjunNo.n && r.getCell(3).value === "EL") { r.getCell(4).value = 20; setRow = i; } });
    assert.ok(setRow, "template lists Arjun's earned leave");
    const good = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
    const p1 = await admin.previewBalanceImport(tx, asha, good);
    assert.equal(p1.valid, true); assert.equal(p1.changes, 1);
    const r1 = await admin.commitBalanceImport(tx, asha, good);
    assert.equal(r1.changed, 1);
    const el = (await leave.balances(tx, P.Arjun.id)).find((b) => b.code === "EL")!;
    assert.equal(el.credited - el.used, 20);
    assert.equal((await admin.commitBalanceImport(tx, asha, good)).changed, 0, "same file again changes nothing");
    // broken rows: all or nothing
    ws.addRow(["NOPE-1", "", "EL", 3]); ws.addRow([arjunNo.n, "", "ZZ", "lots"]); ws.addRow([arjunNo.n, "", "LWP", 3]);
    const bad = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
    const p2 = await admin.previewBalanceImport(tx, asha, bad);
    assert.equal(p2.valid, false);
    const errs = p2.results.filter((r) => r.errors.length).map((r) => r.errors.join(" | "));
    assert.equal(errs.length, 3);
    assert.match(errs[0], /No one has employee number/); assert.match(errs[1], /Unknown leave type code ZZ.*number of days/); assert.match(errs[2], /no limit/);
    await assert.rejects(admin.commitBalanceImport(tx, asha, bad), /Some rows have problems/);
    const scoped = await admin.previewBalanceImport(tx, scopedHr, good);
    assert.equal(scoped.valid, false, "scoped HR can't import balances for people outside their department");
  });
  ok("balance import: template round-trip sets balances by difference (re-import is a no-op), row errors, all-or-nothing, scope enforced");

  // ---------- year-end
  await rolled(async (tx) => {
    const el = await typeId(tx, "EL"), cl = await typeId(tx, "CL");
    await tx`update leave_plan_rules set year_end = ${tx.json({ carry: "upto", carry_max: 5, encash_max: 3 })} where leave_plan_id = ${standard.id} and leave_type_id = ${el}`;
    const [le] = await tx<{ id: string }[]>`select id from legal_entities limit 1`;
    const [pg] = await tx<{ id: string }[]>`insert into pay_groups (tenant_id, legal_entity_id, name) values (${tenant.id}, ${le.id}, 'Smoke pay group') returning id`;
    await tx`update employees set pay_group_id = ${pg.id} where id = ${P.Arjun.id}`;
    const pv = await yearEndPreview(tx, asha, standard.id);
    const prev = `${Number(today.slice(0, 4)) - 1}-01-01`, cur = `${today.slice(0, 4)}-01-01`;
    const elRow = pv.rows.find((r) => r.employeeId === P.Arjun.id && r.typeId === el)!;
    const closing = await ledgerSum(tx, P.Arjun.id, el, prev);
    assert.ok(closing > 8, `Arjun earned leave last year: ${closing}`);
    assert.deepEqual([elRow.cycleStart, elRow.closing, elRow.carry, elRow.encash, elRow.lapse], [prev, closing, 5, 3, closing - 8]);
    const clRow = pv.rows.find((r) => r.employeeId === P.Arjun.id && r.typeId === cl)!;
    assert.equal(clRow.lapse, clRow.closing, "casual leave resets");
    assert.ok(pv.totals.people > 0);
    await assert.rejects(yearEndRun(tx, asha, standard.id, "1999-01"), /next four payroll months/);
    const elNowBefore = await ledgerSum(tx, P.Arjun.id, el, cur);
    const run = await yearEndRun(tx, asha, standard.id, encashMonths()[1]);
    assert.ok(run.processed > 0);
    assert.equal(await ledgerSum(tx, P.Arjun.id, el, prev), 0, "last year is closed out");
    assert.equal(await ledgerSum(tx, P.Arjun.id, el, cur), elNowBefore + 5, "5 days carried into this year");
    const [pi] = await tx<{ days: string; period_month: string }[]>`select days, period_month::text from payroll_inputs where employee_id = ${P.Arjun.id} and kind = 'leave_encashment'`;
    assert.deepEqual([Number(pi.days), pi.period_month], [3, encashMonths()[1] + "-01"]);
    const again = await yearEndRun(tx, asha, standard.id, encashMonths()[1]);
    assert.equal(again.processed, 0, "running twice changes nothing");
    const [{ c }] = await tx<{ c: number }[]>`select count(*)::int as c from payroll_inputs where employee_id = ${P.Arjun.id}`;
    assert.equal(c, 1);
    assert.ok((await yearEndPreview(tx, asha, standard.id)).rows.filter((r) => r.employeeId === P.Arjun.id && r.typeId === el).every((r) => r.done));
  });
  ok("year-end: preview splits carry/encash/lapse per rule, run closes last year, carries into this one, queues encashment for payroll, runs once");

  // ---------- comp-off
  await rolled(async (tx) => {
    let sun = addDaysISO(today, -1); while (weekday(sun) !== "sun") sun = addDaysISO(sun, -1);
    let work = addDaysISO(today, -1); while (["sat", "sun"].includes(weekday(work)) || (await leave.calendarFor(tx, P.Arjun.id)).holidays.has(work)) work = addDaysISO(work, -1);
    await assert.rejects(compOff.requestCompOff(tx, arjun, { dates: [work] }), /working day/);
    await assert.rejects(compOff.requestCompOff(tx, arjun, { dates: [addDaysISO(today, 400)] }), /future/);
    const r = await compOff.requestCompOff(tx, arjun, { dates: [sun], note: "Hotfix" });
    assert.equal(r.status, "pending");
    await assert.rejects(compOff.requestCompOff(tx, arjun, { dates: [sun] }), /already claimed/);
    const inbox = await approvals.inbox(tx, rohan);
    const item = inbox.find((i) => i.entity_id === r.id);
    assert.ok(item && item.entity_type === "comp_off", "comp-off claim waits in Rohan's inbox");
    assert.equal((await approvals.inbox(tx, meera)).some((i) => i.entity_id === r.id), false);
    const detail = await compOff.compOffDetail(tx, r.id);
    assert.equal(detail!.dates[0].dayType, "weekly_off");
    await approvals.decide(tx, rohan, item.step_id, "approved");
    const co = await typeId(tx, "CO");
    const bal = (await leave.balances(tx, P.Arjun.id)).find((b) => b.id === co)!;
    assert.equal(bal.available, 1); assert.equal(bal.unlimited, false);
    const [q] = await tx<{ expires_on: string; status: string }[]>`select expires_on::text, status from comp_off_requests where id = ${r.id}`;
    assert.equal(q.status, "approved"); assert.equal(q.expires_on, addDaysISO(today, 60));
    // a comp-off day already taken is not expired (first in, first out)
    const [m] = await tx<{ id: string }[]>`select id from comp_off_requests where employee_id = ${P.Meera.id} and status = 'approved'`;
    assert.ok(m, "seeded approved comp-off for Meera");
    await tx`insert into leave_ledger (tenant_id, employee_id, leave_type_id, cycle_start, entry_date, kind, amount, idempotency_key)
             values (${tenant.id}, ${P.Meera.id}, ${co}, ${`${today.slice(0, 4)}-01-01`}, ${today}, 'use', -1, 'smoke-use')`;
    // expiry: nothing before the use-by date, the unused day after it, once
    assert.equal((await processCompOffExpiry(tx, tenant.id, addDaysISO(today, 60))).expired, 0);
    const e1 = await processCompOffExpiry(tx, tenant.id, addDaysISO(today, 61));
    assert.ok(e1.expired >= 1);
    assert.equal((await processCompOffExpiry(tx, tenant.id, addDaysISO(today, 61))).expired, 0);
    assert.equal(await ledgerSum(tx, P.Arjun.id, co), 0);
    // withdraw a pending claim; can't withdraw a decided one
    const r2 = await compOff.requestCompOff(tx, arjun, { dates: [addDaysISO(sun, -1)] });
    await compOff.cancelCompOff(tx, arjun, r2.id);
    await assert.rejects(compOff.cancelCompOff(tx, arjun, r.id), /Only pending/);
    await assert.rejects(compOff.cancelCompOff(tx, meera, r2.id), /not found/);
    const [ex] = await tx<{ amount: string }[]>`select amount from leave_ledger where idempotency_key = ${"expiry:" + m.id}`;
    assert.equal(Number(ex.amount), 0);
  });
  ok("comp-off: off days only, no repeats, manager approves in the inbox → credit with use-by date, expiry once (FIFO), withdraw pending only");

  // ---------- holidays and floaters
  await rolled(async (tx) => {
    const year = Number(today.slice(0, 4));
    const lists = await holidays.listHolidayLists(tx);
    const head = lists.lists.find((l) => l.year === year && l.name === "Head office")!;
    await assert.rejects(holidays.saveHoliday(tx, asha, head.id, null, { name: "Wrong year", date: `${year + 1}-03-03`, floater: false }), /Pick a date in/);
    await assert.rejects(holidays.saveHolidayList(tx, asha, null, { name: "Head office", year, floaterLimit: 0 }), /already a list called/);
    let fd = addDaysISO(today, 3); while (["sat", "sun"].includes(weekday(fd))) fd = addDaysISO(fd, 1);
    const extra: string[] = [];
    for (const [i, name] of ["Smoke floater A", "Smoke floater B", "Smoke floater C"].entries()) {
      let d = addDaysISO(fd, i); while (["sat", "sun"].includes(weekday(d))) d = addDaysISO(d, 1);
      if (d.slice(0, 4) !== String(year)) continue;
      extra.push((await holidays.saveHoliday(tx, asha, head.id, null, { name, date: d, floater: true })).id);
    }
    if (extra.length === 3) {
      await tx`update holiday_lists set floater_limit = 2 where id = ${head.id}`;
      await holidays.chooseFloater(tx, arjun, extra[0], true);
      await holidays.chooseFloater(tx, arjun, extra[1], true);
      await assert.rejects(holidays.chooseFloater(tx, arjun, extra[2], true), /you've used them all/);
      const cal = await leave.calendarFor(tx, P.Arjun.id);
      const [d0] = await tx<{ date: string }[]>`select date::text from holidays where id = ${extra[0]}`;
      const [d2] = await tx<{ date: string }[]>`select date::text from holidays where id = ${extra[2]}`;
      assert.equal(cal.holidays.has(d0.date), true, "a chosen floater is a holiday for that person");
      assert.equal((await leave.calendarFor(tx, P.Meera.id)).holidays.has(d0.date), false, "but not for others");
      assert.equal(cal.holidays.has(d2.date), false);
      await holidays.chooseFloater(tx, arjun, extra[0], false);
      await holidays.chooseFloater(tx, arjun, extra[2], true);
      const up = await holidays.upcomingHolidays(tx, P.Arjun.id);
      assert.deepEqual(up.holidays.filter((h) => extra.includes(h.id)).map((h) => h.chosen), [false, true, true]);
    }
    const nonFloater = (await tx<{ id: string }[]>`select id from holidays where holiday_list_id = ${head.id} and not is_floater limit 1`)[0];
    await assert.rejects(holidays.chooseFloater(tx, arjun, nonFloater.id, true), /holiday for everyone/);
    const [past] = await tx<{ id: string }[]>`insert into holidays (tenant_id, holiday_list_id, name, date, is_floater) values (${tenant.id}, ${head.id}, 'Old floater', ${`${year}-01-02`}, true) returning id`;
    if (today > `${year}-01-02`) await assert.rejects(holidays.chooseFloater(tx, arjun, past.id, true), /passed/);
    // another list for another location / person: Karan gets it as a personal override
    const other = await holidays.saveHolidayList(tx, asha, null, { name: "Bengaluru", year, floaterLimit: 0 });
    let h = addDaysISO(today, 9); while (["sat", "sun"].includes(weekday(h))) h = addDaysISO(h, 1);
    if (h.slice(0, 4) === String(year)) {
      await holidays.saveHoliday(tx, asha, other.id, null, { name: "Karnataka day", date: h, floater: false });
      await holidays.assignHolidayList(tx, asha, other.id, { locationIds: [], employeeIds: [P.Karan.id] });
      assert.equal((await leave.calendarFor(tx, P.Karan.id)).holidays.has(h), true);
      assert.equal((await leave.calendarFor(tx, P.Arjun.id)).holidays.has(h), false);
      await assert.rejects(holidays.chooseFloater(tx, karan, extra[0] ?? nonFloater.id, true), /isn't on your holiday list/);
    }
    // copy to next year keeps names; the year can't change once it has holidays
    await assert.rejects(holidays.saveHolidayList(tx, asha, head.id, { name: "Head office", year: year + 5, floaterLimit: 2 }), /year can't change/);
    const copy = await holidays.copyHolidayList(tx, asha, head.id, year + 2);
    const [{ c }] = await tx<{ c: number }[]>`select count(*)::int as c from holidays where holiday_list_id = ${copy.id}`;
    assert.ok(c >= 6);
  });
  ok("holidays: dates must match the list's year, unique list names per year, floaters within the limit (personal, not past), per-person list, copy to a new year");

  // ---------- team calendar
  await rolled(async (tx) => {
    const month = today.slice(0, 7);
    const mine = await teamLeaveMonth(tx, rohan, { month });
    const names = mine.people.map((p) => p.name);
    for (const n of ["Rohan Mehta", "Arjun Rao", "Meera Iyer", "Vikram Joshi"]) assert.ok(names.includes(n), `${n} on Rohan's calendar`);
    assert.equal(mine.people[0].isMe, true);
    assert.ok(!names.includes("Fatima Sheikh"));
    const all = await teamLeaveMonth(tx, arjun, { month, view: "all" });
    assert.equal(all.view, "team", "only leave admins get the everyone view");
    const hr = await teamLeaveMonth(tx, scopedHr, { month, view: "all" });
    assert.equal(hr.view, "all");
    assert.ok(hr.people.filter((p) => !p.isMe).every((p) => people.find((x) => x.id === p.id)!.department_id === engineering));
    const sat = mine.days.find((d) => d.weekday === "sat")!;
    assert.equal(mine.people[0].cells[sat.date]?.kind, "weekly_off");
    await assert.rejects(teamLeaveMonth(tx, rohan, { month: "2026-13" }), AppError);
  });
  ok("team calendar: manager sees self + team, admins (in scope) see everyone, weekly offs marked, bad month refused");

  // ---------- tenant isolation for leave tables
  const otherId = randomUUID();
  await owner`insert into tenants (id, subdomain, name) values (${otherId}, ${"smoke-" + otherId.slice(0, 8)}, 'Smoke Co')`;
  try {
    const [c] = await withTenant(otherId, (tx) => tx<{ n: number }[]>`
      select ((select count(*) from leave_types) + (select count(*) from leave_plans) + (select count(*) from leave_plan_rules) + (select count(*) from leave_ledger)
            + (select count(*) from holiday_lists) + (select count(*) from holidays) + (select count(*) from floater_choices) + (select count(*) from comp_off_requests))::int as n`);
    assert.equal(c.n, 0);
    await assert.rejects(withTenant(otherId, (tx) => tx`insert into holiday_lists (tenant_id, name, year) values (${tenant.id}, 'Sneaky', 2026)`), /row-level security/);
    const [co] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from comp_off_requests limit 1`);
    const upd = await withTenant(otherId, (tx) => tx`update comp_off_requests set status = 'approved' where id = ${co.id} returning id`);
    assert.equal(upd.length, 0);
    const runOther = await withTenant(otherId, (tx) => runAccrual(tx, otherId, todayIn()));
    assert.equal(runOther.posted, 0, "the leave job for one tenant never touches another's people");
  } finally {
    await owner`delete from tenants where id = ${otherId}`;
  }
  ok("another tenant sees none of Acme's leave types, plans, ledger, holidays or comp-off and can't write into them");

  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await owner.end(); await sql.end(); }).catch(async (e) => { console.error("\nFAILED:", e); await owner.end(); await sql.end(); process.exit(1); });
