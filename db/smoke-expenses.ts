/**
 * Smoke test for expenses against the seeded demo tenant (run `pnpm db:seed` first).
 * Everything runs in rolled-back transactions, so the demo data stays as seeded (stored receipt bytes are cleaned up at the end).
 *   pnpm smoke:expenses
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { PDFDocument } from "pdf-lib";
import { withTenant, sql, AppError, type Tx } from "@/server/db";
import * as approvals from "@/server/modules/approvals/service";
import * as admin from "@/server/modules/expenses/admin";
import * as exp from "@/server/modules/expenses/service";
import { storage } from "@/server/storage";
import { addDaysISO, todayIn } from "@/lib/dates";
import { monthOf } from "@/server/modules/expenses/rules";
import type { Actor } from "@/server/auth/session";
import type { Scope } from "@/server/auth/catalog";
import { DEMO_SUBDOMAIN } from "./demo";

const owner = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const rollback = async (tenantId: string, fn: (tx: Tx) => Promise<void>) =>
  withTenant(tenantId, async (tx) => { await fn(tx); await track(tx); throw new Error("rollback"); }).catch((e) => { if (e.message !== "rollback") throw e; });
const blobs: string[] = [];
const track = async (tx: Tx) => { for (const f of await tx<{ storage_key: string }[]>`select storage_key from files where created_at > now() - interval '10 minutes'`) blobs.push(f.storage_key); };

async function main() {
  const [t] = await sql<{ id: string }[]>`select id from tenant_by_subdomain(${DEMO_SUBDOMAIN})`;
  assert.ok(t, "demo tenant exists (run pnpm db:seed)");
  const tenant = { id: t.id, name: "Acme Technologies", status: "trial", subdomain: DEMO_SUBDOMAIN };
  const actor = (first: string, permissions: string[] = [], scopes: Scope[] = []) => withTenant(tenant.id, async (tx) => {
    const [e] = await tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`;
    assert.ok(e, `${first} exists`);
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(permissions), grants: permissions.length ? [{ permissions, scopes }] : [] } as Actor;
  });
  const FIN = ["expenses.approve", "expenses.payout"];
  const asha = await actor("Asha", ["*"]), karan = await actor("Karan", FIN), rohan = await actor("Rohan"), arjun = await actor("Arjun"), meera = await actor("Meera");
  const priya = await actor("Priya", ["employees.read", "employees.write", "leave.admin"]), vikram = await actor("Vikram"), sneha = await actor("Sneha"), imran = await actor("Imran");
  const [sales] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from departments where name = 'Sales'`);
  const salesFin = await actor("Fatima", FIN, [{ type: "department", ids: [sales.id] }]);
  const scopedAdmin = await actor("Priya", ["expenses.admin"], [{ type: "department", ids: [sales.id] }]);
  const today = todayIn();
  const cat = async (tx: Tx, name: string) => (await tx<{ id: string }[]>`select id from expense_categories where name = ${name}`)[0].id;
  const base = { amountPaise: null, kmHundredths: null, halfDays: null, merchant: null, description: null };
  const doc = await PDFDocument.create(); doc.addPage([100, 100]);
  const pdf = new Uint8Array(await doc.save());
  const pendingStep = async (tx: Tx, entityId: string) => (await tx<{ id: string; approver: string; level: number }[]>`
    select s.id, s.approver_employee_id as approver, s.level from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_id = ${entityId} and s.status = 'pending'`)[0];
  const claimOf = async (tx: Tx, id: string) => (await tx<{ status: string; total_paise: bigint; advance_applied_paise: bigint; payout: string; payout_month: string | null }[]>`
    select status, total_paise, advance_applied_paise, payout, payout_month::text from expense_claims where id = ${id}`)[0];
  /** Arjun's quick claim: one meal with a receipt, submitted. */
  const submitted = async (tx: Tx, who: Actor, amountPaise = 40000) => {
    const x = await exp.addExpense(tx, who, { ...base, categoryId: await cat(tx, "Meals"), spentOn: addDaysISO(today, -3), amountPaise, merchant: "Smoke cafe " + randomUUID().slice(0, 4) }, [{ name: "r.pdf", bytes: pdf }]);
    const c = await exp.createClaim(tx, who, { title: "Smoke claim", expenseIds: [x.id] });
    await exp.submitClaim(tx, who, c.id);
    return c.id;
  };

  // ---------- defaults ----------
  await rollback(tenant.id, async (tx) => {
    const count = async () => (await tx<{ n: string }[]>`select (select count(*) from expense_policies) || '/' || (select count(*) from expense_categories) || '/' || (select count(*) from roles where key = 'finance') as n`)[0].n;
    const before = await count();
    await admin.ensureExpenseDefaults(tx, tenant.id); await admin.ensureExpenseDefaults(tx, tenant.id);
    assert.equal(await count(), before, "defaults are idempotent");
    assert.equal(before, `1/${admin.DEFAULT_CATEGORIES.length}/1`);
    const p = await admin.policyFor(tx, arjun.employeeId);
    assert.deepEqual(p!.categories.map((c) => c.kind).sort(), ["general", "general", "general", "mileage", "per_diem", "travel"]);
  });
  ok("defaults: Standard policy with general, mileage, travel and per-diem categories and a Finance role; re-running adds nothing");

  // ---------- settings ----------
  await rollback(tenant.id, async (tx) => {
    const input = { name: "Sales policy", allowFutureDated: false, submissionDeadlineDays: 30, advanceMaxPaise: 2000000, advanceDueDays: 15 };
    await assert.rejects(admin.savePolicy(tx, arjun, null, input), /Only expense admins/);
    await assert.rejects(admin.savePolicy(tx, priya, null, input), /Only expense admins/, "HR without expenses.admin");
    await assert.rejects(admin.savePolicy(tx, scopedAdmin, null, input), /Only expense admins for the whole company/, "scoped expenses.admin can't change company policy");
    const p = await admin.savePolicy(tx, asha, null, input);
    await assert.rejects(admin.savePolicy(tx, asha, null, input), /already exists/);
    const catIn = { name: "Client gifts", kind: "general" as const, limitPaise: 200000, limitPeriod: null, ratePerKmPaise: null, receiptAbovePaise: 0, glCode: "6200" };
    await assert.rejects(admin.saveCategory(tx, asha, p.id, null, catIn), /per claim, day/);
    await assert.rejects(admin.saveCategory(tx, asha, p.id, null, { ...catIn, kind: "mileage", limitPaise: null }), /rate per km/);
    await assert.rejects(admin.saveCategory(tx, scopedAdmin, p.id, null, { ...catIn, limitPeriod: "month" }), /Only expense admins/);
    const c = await admin.saveCategory(tx, asha, p.id, null, { ...catIn, limitPeriod: "month" });
    await admin.assignPolicy(tx, asha, p.id, [imran.employeeId]);
    assert.equal((await admin.policyFor(tx, imran.employeeId))!.name, "Sales policy");
    assert.equal((await admin.policyFor(tx, arjun.employeeId))!.name, "Standard", "everyone else stays on the default");
    await assert.rejects(exp.addExpense(tx, imran, { ...base, categoryId: await cat(tx, "Meals"), spentOn: today, amountPaise: 100 }), /Pick one of your expense categories/, "a category from another policy");
    await exp.addExpense(tx, imran, { ...base, categoryId: c.id, spentOn: today, amountPaise: 100 }, [{ name: "r.pdf", bytes: pdf }]);
    await assert.rejects(admin.deleteCategory(tx, asha, c.id), /kept for the record/);
    await assert.rejects(admin.deletePolicy(tx, asha, p.id), /kept for the record/);
    const [std] = await tx<{ id: string }[]>`select id from expense_policies where name = 'Standard'`;
    await assert.rejects(admin.deletePolicy(tx, asha, std.id), /default policy/);
    const [used] = await tx<{ id: string }[]>`select id from expense_categories where name = 'Meals'`;
    await assert.rejects(admin.saveCategory(tx, asha, std.id, used.id, { ...catIn, name: "Meals", kind: "travel", limitPaise: null }), /type can't change/);
  });
  ok("settings: expenses.admin without a scope only; validation; policy assignment and fallback; used categories and the default policy are kept");

  // ---------- adding expenses ----------
  await rollback(tenant.id, async (tx) => {
    const m = await exp.addExpense(tx, arjun, { ...base, categoryId: await cat(tx, "Local conveyance"), spentOn: today, kmHundredths: 1234 });
    assert.equal(m.amountPaise, 12340, "12.34 km × ₹10 = ₹123.40");
    const d = await exp.addExpense(tx, arjun, { ...base, categoryId: await cat(tx, "Per diem"), spentOn: today, halfDays: 3 });
    assert.equal(d.amountPaise, 180000, "1.5 days × ₹1,200");
    await assert.rejects(exp.addExpense(tx, arjun, { ...base, categoryId: await cat(tx, "Local conveyance"), spentOn: today }), /distance/);
    await assert.rejects(exp.addExpense(tx, arjun, { ...base, categoryId: await cat(tx, "Meals"), spentOn: today, amountPaise: 0 }), /above zero/);
    await assert.rejects(exp.addExpense(tx, arjun, { ...base, categoryId: await cat(tx, "Meals"), spentOn: today, amountPaise: 100 }, [{ name: "r.svg", bytes: new TextEncoder().encode("<svg/>") }]), /PDF, PNG or JPG/);
    await assert.rejects(exp.addExpense(tx, arjun, { ...base, categoryId: await cat(tx, "Meals"), spentOn: today, amountPaise: 100 }, [{ name: "r.pdf", bytes: new TextEncoder().encode("MZ fake") }]), /doesn't look like/);
    const big = await exp.addExpense(tx, arjun, { ...base, categoryId: await cat(tx, "Meals"), spentOn: today, amountPaise: 160000, merchant: "Big dinner" });
    assert.deepEqual([...big.violations].sort(), ["over_limit_day", "receipt_missing"]);
    const fut = await exp.addExpense(tx, arjun, { ...base, categoryId: await cat(tx, "Local conveyance"), spentOn: addDaysISO(today, 2), kmHundredths: 100 });
    assert.deepEqual(fut.violations, ["future_dated"]);
    const c = await exp.createClaim(tx, arjun, { title: "Mixed", expenseIds: [big.id] });
    await assert.rejects(exp.submitClaim(tx, arjun, c.id), /need a receipt/, "blocking violation stops submit");
    const fixed = await exp.updateExpense(tx, arjun, big.id, { ...base, categoryId: await cat(tx, "Meals"), spentOn: today, amountPaise: 160000, merchant: "Big dinner" }, { add: [{ name: "bill.pdf", bytes: pdf }], remove: [] });
    assert.deepEqual(fixed.violations, ["over_limit_day"], "receipt attached: only the warning stays");
    await exp.moveExpenses(tx, arjun, c.id, [fut.id], []);
    await assert.rejects(exp.submitClaim(tx, arjun, c.id), /future/);
    await exp.moveExpenses(tx, arjun, c.id, [], [fut.id]);
    await assert.rejects(exp.updateExpense(tx, meera, big.id, { ...base, categoryId: await cat(tx, "Meals"), spentOn: today, amountPaise: 1 }, { add: [], remove: [] }), /not found/, "someone else's expense");
    await assert.rejects(exp.moveExpenses(tx, meera, c.id, [], []), /not found/);
    const r = await exp.submitClaim(tx, arjun, c.id);
    assert.equal(r.status, "submitted");
    assert.equal(Number((await claimOf(tx, c.id)).total_paise), 160000);
    await assert.rejects(exp.updateExpense(tx, arjun, big.id, { ...base, categoryId: await cat(tx, "Meals"), spentOn: today, amountPaise: 1 }, { add: [], remove: [] }), /already sent/);
    await assert.rejects(exp.submitClaim(tx, arjun, c.id), /already sent/, "double submit");
    await assert.rejects(exp.moveExpenses(tx, arjun, c.id, [fut.id], []), /already sent/);
  });
  ok("expenses: mileage and per-diem maths, receipt type and signature checks, limits and receipt rules flagged, blocking flags stop submit, sent claims are locked");

  // ---------- approvals ----------
  await rollback(tenant.id, async (tx) => {
    const id = await submitted(tx, arjun);
    const s1 = await pendingStep(tx, id);
    assert.equal(s1.approver, rohan.employeeId, "manager first");
    const [s2] = await tx<{ approver: string }[]>`select s.approver_employee_id as approver from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_id = ${id} and s.level = 2`;
    assert.equal(s2.approver, karan.employeeId, "then finance");
    await assert.rejects(exp.financeDecide(tx, karan, "expense_claim", id, "approved"), /still with the manager/, "finance can't skip the manager");
    await assert.rejects(exp.financeDecide(tx, arjun, "expense_claim", id, "approved"), /your own/);
    await exp.financeDecide(tx, rohan, "expense_claim", id, "approved");
    assert.equal((await claimOf(tx, id)).status, "submitted");
    await assert.rejects(exp.financeDecide(tx, salesFin, "expense_claim", id, "approved"), /isn't waiting for you/, "scoped finance outside their department");
    await assert.rejects(exp.financeDecide(tx, rohan, "expense_claim", id, "approved"), /isn't waiting for you/, "manager can't do the finance step");
    await exp.financeDecide(tx, karan, "expense_claim", id, "approved");
    assert.equal((await claimOf(tx, id)).status, "approved");
    await assert.rejects(exp.financeDecide(tx, karan, "expense_claim", id, "approved"), /already handled/, "idempotent: no second decision");
    await assert.rejects(approvals.decide(tx, karan, s1.id, "approved"), /already handled/);

    // Sales: scoped finance takes over the final review from Karan; Sneha's manager is Asha
    const sid = await submitted(tx, imran);
    const first = await pendingStep(tx, sid);
    assert.equal(first.approver, sneha.employeeId);
    await exp.financeDecide(tx, sneha, "expense_claim", sid, "approved");
    const q = await exp.approvalQueue(tx, salesFin);
    assert.ok(q.some((i) => i.entity_id === sid && !i.mine), "scoped finance sees Sales claims at the finance step");
    assert.ok(!q.some((i) => i.entity_id === id), "but nothing from Engineering");
    await exp.financeDecide(tx, salesFin, "expense_claim", sid, "rejected", "Please split personal items");
    assert.equal((await claimOf(tx, sid)).status, "rejected");
    const [aud] = await tx<{ n: number }[]>`select count(*)::int as n from audit_logs where entity_id = ${sid} and action = 'approval.taken_over'`;
    assert.equal(aud.n, 1);
    // rejected → reopen → draft → resubmit; withdraw while pending
    await assert.rejects(exp.withdrawClaim(tx, imran, sid), /Only a claim waiting/);
    await exp.reopenClaim(tx, imran, sid);
    assert.equal((await claimOf(tx, sid)).status, "draft");
    await exp.submitClaim(tx, imran, sid);
    await exp.withdrawClaim(tx, imran, sid);
    assert.equal((await claimOf(tx, sid)).status, "draft");
    assert.equal(await pendingStep(tx, sid), undefined, "withdrawing cancels the approval");
    await exp.deleteClaim(tx, imran, sid);
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from expenses where employee_id = ${imran.employeeId} and claim_id is null and merchant like 'Smoke cafe%'`;
    assert.equal(n, 1, "deleting a draft claim keeps its expenses");

    // finance's own claim never reaches themselves; the manager who also holds finance doesn't approve twice
    const kid = await submitted(tx, karan);
    const steps = await tx<{ approver: string }[]>`select s.approver_employee_id as approver from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_id = ${kid}`;
    assert.ok(steps.length >= 1 && steps.every((s) => s.approver !== karan.employeeId));
    await tx`insert into role_assignments (tenant_id, role_id, employee_id) select ${tenant.id}, id, ${rohan.employeeId} from roles where key = 'finance'`;
    const rid = await submitted(tx, meera);
    const ap = await tx<{ approver: string }[]>`select s.approver_employee_id as approver from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_id = ${rid} order by s.level`;
    assert.deepEqual(ap.map((s) => s.approver), [rohan.employeeId, karan.employeeId], "a finance reviewer other than the manager is preferred");
  });
  ok("approvals: manager then finance via the engine; scoped finance only in scope and only at the finance step (take-over audited); no self approval; withdraw, reopen, delete");

  // ---------- advances ----------
  await rollback(tenant.id, async (tx) => {
    await assert.rejects(exp.requestAdvance(tx, arjun, { amountPaise: 6000000, purpose: "Trip" }), /up to ₹50,000.00/);
    const a = await exp.requestAdvance(tx, arjun, { amountPaise: 300000, purpose: "Bengaluru customer visit" });
    await assert.rejects(exp.markAdvancePaid(tx, karan, a.id, null), /Only an approved advance/);
    await exp.financeDecide(tx, rohan, "expense_advance", a.id, "approved");
    await exp.financeDecide(tx, karan, "expense_advance", a.id, "approved");
    await assert.rejects(exp.markAdvancePaid(tx, arjun, a.id, null), /your own/);
    await assert.rejects(exp.markAdvancePaid(tx, salesFin, a.id, null), /don't have access/);
    await exp.markAdvancePaid(tx, karan, a.id, "NEFT 1234");
    await assert.rejects(exp.markAdvancePaid(tx, karan, a.id, null), /already paid/);
    await assert.rejects(exp.createClaim(tx, meera, { title: "x", expenseIds: [], advanceId: a.id }), /Pick one of your advances/);
    // claim of ₹2,000 against ₹3,000: fully covered, paid at once; the next ₹1,500 claim uses the last ₹1,000
    const x1 = await exp.addExpense(tx, arjun, { ...base, categoryId: await cat(tx, "Travel"), spentOn: today, amountPaise: 200000, merchant: "Cab" }, [{ name: "r.pdf", bytes: pdf }]);
    const c1 = await exp.createClaim(tx, arjun, { title: "Part 1", expenseIds: [x1.id], advanceId: a.id });
    await exp.submitClaim(tx, arjun, c1.id);
    await assert.rejects(exp.createClaim(tx, arjun, { title: "x", expenseIds: [], advanceId: a.id }).then(async (c) => exp.submitClaim(tx, arjun, c.id)), /already settling|at least one/);
    await exp.financeDecide(tx, rohan, "expense_claim", c1.id, "approved");
    await exp.financeDecide(tx, karan, "expense_claim", c1.id, "approved");
    let c = await claimOf(tx, c1.id);
    assert.equal(c.status, "paid"); assert.equal(Number(c.advance_applied_paise), 200000);
    const x2 = await exp.addExpense(tx, arjun, { ...base, categoryId: await cat(tx, "Travel"), spentOn: today, amountPaise: 150000, merchant: "Train" }, [{ name: "r.pdf", bytes: pdf }]);
    const c2 = await exp.createClaim(tx, arjun, { title: "Part 2", expenseIds: [x2.id], advanceId: a.id });
    await exp.submitClaim(tx, arjun, c2.id);
    await exp.financeDecide(tx, rohan, "expense_claim", c2.id, "approved");
    await exp.financeDecide(tx, karan, "expense_claim", c2.id, "approved");
    c = await claimOf(tx, c2.id);
    assert.equal(c.status, "approved"); assert.equal(Number(c.advance_applied_paise), 100000);
    const [adv] = await tx<{ status: string; settled_paise: bigint }[]>`select status, settled_paise from expense_advances where id = ${a.id}`;
    assert.equal(adv.status, "settled"); assert.equal(Number(adv.settled_paise), 300000);
    await assert.rejects(exp.closeAdvance(tx, karan, a.id, null), /Only a paid advance/);
    // another advance closed with money returned
    const b = await exp.requestAdvance(tx, meera, { amountPaise: 100000, purpose: "Stationery" });
    await exp.financeDecide(tx, rohan, "expense_advance", b.id, "approved");
    await exp.financeDecide(tx, karan, "expense_advance", b.id, "approved");
    await exp.markAdvancePaid(tx, karan, b.id, null);
    assert.equal((await exp.closeAdvance(tx, karan, b.id, "Returned in cash")).returnedPaise, 100000);
    const p = await exp.requestAdvance(tx, meera, { amountPaise: 100, purpose: "Withdraw me" });
    await exp.cancelAdvance(tx, meera, p.id);
    await assert.rejects(exp.cancelAdvance(tx, meera, b.id), /Only a request waiting/);
  });
  ok("advances: limit from the policy, approve → paid → settled against claims (exact paise, claim covered in full is paid at once), close with money returned, withdraw");

  // ---------- payouts ----------
  await rollback(tenant.id, async (tx) => {
    const [vc] = await tx<{ id: string }[]>`select id from expense_claims where employee_id = ${vikram.employeeId} and status = 'approved'`;
    const month = monthOf(today);
    await assert.rejects(exp.scheduleExpensePayout(tx, karan, vc.id, month), /isn't in a pay group/);
    const [le] = await tx<{ id: string }[]>`select id from legal_entities limit 1`;
    const [pg] = await tx<{ id: string }[]>`insert into pay_groups (tenant_id, legal_entity_id, name) values (${tenant.id}, ${le.id}, 'Smoke monthly') returning id`;
    await tx`update employees set pay_group_id = ${pg.id}`;
    await assert.rejects(exp.scheduleExpensePayout(tx, vikram, vc.id, month), /your own/);
    await assert.rejects(exp.scheduleExpensePayout(tx, salesFin, vc.id, month), /don't have access/, "scoped payout outside their department");
    await assert.rejects(exp.scheduleExpensePayout(tx, priya, vc.id, month), /don't have access/);
    await assert.rejects(exp.scheduleExpensePayout(tx, karan, vc.id, addDaysISO(month, -1).slice(0, 7) + "-01"), /passed/);
    const r1 = await exp.scheduleExpensePayout(tx, karan, vc.id, month);
    const r2 = await exp.scheduleExpensePayout(tx, karan, vc.id, month);
    assert.equal(r1.inputId, r2.inputId); assert.equal(r2.changed, false, "scheduling twice is a no-op");
    const rows = await tx<{ amount_paise: bigint; period_month: string; kind: string }[]>`select amount_paise, period_month::text, kind from payroll_inputs where source_ref->>'expense_claim_id' = ${vc.id}`;
    assert.equal(rows.length, 1); assert.equal(Number(rows[0].amount_paise), 99900); assert.equal(rows[0].kind, "expense");
    // finalised month: can't be moved out of, and can't be scheduled into
    await tx`insert into payroll_runs (tenant_id, pay_group_id, period_month, status) values (${tenant.id}, ${pg.id}, ${month}, 'finalized')`;
    const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 10);
    await assert.rejects(exp.scheduleExpensePayout(tx, karan, vc.id, next), /finalised/);
    await assert.rejects(exp.markClaimPaid(tx, karan, vc.id, "x"), /finalised/);
    await assert.rejects(exp.unscheduleExpensePayout(tx, karan, vc.id), /finalised/);
    assert.equal(await exp.markPayrollExpensesPaid(tx, pg.id, month), 1);
    assert.equal((await claimOf(tx, vc.id)).status, "paid");
    assert.equal(await exp.markPayrollExpensesPaid(tx, pg.id, month), 0, "idempotent");
    await assert.rejects(exp.scheduleExpensePayout(tx, karan, vc.id, next), /already paid/);
    // Sneha's claim: payable is what the advance didn't cover; scheduled, moved, then paid off-cycle instead
    const [sc] = await tx<{ id: string }[]>`select id from expense_claims where employee_id = ${sneha.employeeId} and status = 'approved'`;
    await assert.rejects(exp.scheduleExpensePayout(tx, karan, sc.id, month), /finalised/);
    await exp.scheduleExpensePayout(tx, salesFin, sc.id, next);
    const [inp] = await tx<{ amount_paise: bigint }[]>`select amount_paise from payroll_inputs where source_ref->>'expense_claim_id' = ${sc.id}`;
    assert.equal(Number(inp.amount_paise), 280000, "₹7,800 − ₹5,000 advance");
    const later = new Date(Date.UTC(Number(next.slice(0, 4)), Number(next.slice(5, 7)), 1)).toISOString().slice(0, 10);
    assert.equal((await exp.scheduleExpensePayout(tx, salesFin, sc.id, later)).changed, true);
    assert.equal((await tx`select 1 from payroll_inputs where source_ref->>'expense_claim_id' = ${sc.id}`).length, 1, "moved, not duplicated");
    await exp.markClaimPaid(tx, salesFin, sc.id, "UPI 9911");
    assert.equal((await tx`select 1 from payroll_inputs where source_ref->>'expense_claim_id' = ${sc.id}`).length, 0, "paid off-cycle: removed from payroll");
    const c = await claimOf(tx, sc.id);
    assert.equal(c.status, "paid"); assert.equal(c.payout, "off_cycle");
    await assert.rejects(exp.markClaimPaid(tx, salesFin, sc.id, null), /already paid/);
    const [mc] = await tx<{ id: string }[]>`select id from expense_claims where employee_id = ${meera.employeeId} and status = 'submitted'`;
    await assert.rejects(exp.markClaimPaid(tx, karan, mc.id, null), /Only approved/);
    const q = await exp.payoutQueue(tx, salesFin);
    assert.ok(q.claims.every((x) => x.employee_id === sneha.employeeId || x.employee_id === imran.employeeId), "payout queue is scoped");
  });
  ok("payouts: payroll month via one payroll_inputs row (idempotent, movable), finalised months locked, off-cycle payment removes it, payroll marks paid once; no self payout; scoped");

  // ---------- receipts, detail and reports ----------
  await rollback(tenant.id, async (tx) => {
    const [mc] = await tx<{ id: string }[]>`select id from expense_claims where employee_id = ${meera.employeeId} and status = 'submitted'`;
    const [f] = await tx<{ id: string }[]>`select unnest(receipt_file_ids) as id from expenses where claim_id = ${mc.id} limit 1`;
    assert.ok(await exp.receiptFor(tx, meera, f.id), "owner");
    assert.ok(await exp.receiptFor(tx, rohan, f.id), "manager who approved");
    assert.ok(await exp.receiptFor(tx, karan, f.id), "finance reviewer");
    assert.equal(await exp.receiptFor(tx, arjun, f.id), null, "a colleague can't");
    assert.equal(await exp.receiptFor(tx, salesFin, f.id), null, "finance for another department can't");
    assert.equal(await exp.receiptFor(tx, priya, f.id), null, "HR without expense access can't");
    assert.equal(await exp.claimDetail(tx, arjun, mc.id), null);
    const d = await exp.claimDetail(tx, karan, mc.id);
    assert.ok(d && d.can.decide && d.items.length === 2 && d.items.some((i) => i.receipts.length));
    const own = await exp.claimDetail(tx, meera, mc.id);
    assert.equal(own!.can.decide, false, "never decide your own");
    const rep = await exp.expenseReport(tx, karan, { from: addDaysISO(today, -60), to: today, includePending: true });
    assert.equal(rep.summary.totalPaise, rep.lines.reduce((s, l) => s + l.amountPaise, 0));
    assert.ok(rep.summary.byCategory.length >= 3);
    const approvedOnly = await exp.expenseReport(tx, karan, { from: addDaysISO(today, -60), to: today, includePending: false });
    assert.ok(approvedOnly.lines.every((l) => l.status !== "submitted"));
    const scoped = await exp.expenseReport(tx, salesFin, { from: addDaysISO(today, -60), to: today, includePending: true });
    assert.ok(scoped.lines.length > 0 && scoped.lines.every((l) => l.department === "Sales"), "reports are scoped");
    assert.equal((await exp.expenseReport(tx, arjun, { from: addDaysISO(today, -60), to: today, includePending: true })).lines.length, 0);
  });
  ok("receipts and claim detail: only the person, their approvers and finance in scope; reports total by category / department / month within scope");

  // ---------- tenant isolation ----------
  const otherId = randomUUID();
  await owner`insert into tenants (id, subdomain, name) values (${otherId}, ${"smoke-" + otherId.slice(0, 8)}, 'Smoke Co')`;
  try {
    const [c] = await withTenant(otherId, (tx) => tx<{ n: string }[]>`
      select concat_ws('/', (select count(*) from expense_policies), (select count(*) from expense_categories), (select count(*) from expenses),
        (select count(*) from expense_claims), (select count(*) from expense_advances), (select count(*) from files)) as n`);
    assert.equal(c.n, "0/0/0/0/0/0");
    const [mc] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from expense_claims limit 1`);
    const [f] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select unnest(receipt_file_ids) as id from expenses where cardinality(receipt_file_ids) > 0 limit 1`);
    const outsider = { ...asha, tenant: { ...tenant, id: otherId } } as Actor;
    assert.equal(await withTenant(otherId, (tx) => exp.claimDetail(tx, outsider, mc.id)), null);
    assert.equal(await withTenant(otherId, (tx) => exp.receiptFor(tx, outsider, f.id)), null);
    await assert.rejects(withTenant(otherId, (tx) => exp.markClaimPaid(tx, outsider, mc.id, null)), /not found/);
    await assert.rejects(withTenant(otherId, (tx) => tx`insert into expense_policies (tenant_id, name) values (${tenant.id}, 'sneaky')`), /row-level security/);
    const r = await withTenant(otherId, (tx) => tx`update expense_claims set status = 'paid' where id = ${mc.id}`);
    assert.equal(r.count, 0);
    ok("another tenant sees none of Acme's policies, expenses, claims, advances or receipts and can't pay or change them");
  } finally {
    await owner`delete from tenants where id = ${otherId}`;
  }

  for (const k of blobs) await storage().remove(k).catch(() => {});
  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await owner.end(); await sql.end(); }).catch(async (e) => {
  for (const k of blobs) await storage().remove(k).catch(() => {});
  console.error("\nFAILED:", e instanceof AppError ? `${e.code}: ${e.message}` : e); await owner.end(); await sql.end(); process.exit(1);
});
