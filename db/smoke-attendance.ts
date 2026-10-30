/**
 * End-to-end checks for M2 attendance against the seeded demo tenant (run `pnpm db:seed` first).
 * Capture enforcement, night shifts, processing + penalties + idempotent ledger, requests through approvals,
 * time settings permissions and scopes, dated assignments, the team view, the nightly job and tenant isolation.
 * Almost everything runs in rolled-back transactions so the demo data stays as seeded.
 *   pnpm smoke:attendance
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { withTenant, sql, AppError, type Tx } from "@/server/db";
import * as attendance from "@/server/modules/attendance/service";
import * as requests from "@/server/modules/attendance/requests";
import * as policies from "@/server/modules/attendance/policies";
import { processAttendance, reprocessFrom } from "@/server/modules/attendance/process";
import { teamAttendance } from "@/server/modules/attendance/team";
import { processTenantDate } from "@/server/modules/attendance/job";
import * as approvals from "@/server/modules/approvals/service";
import * as leave from "@/server/modules/leave/service";
import { addDaysISO, todayIn, weekday } from "@/lib/dates";
import type { Actor } from "@/server/auth/session";
import type { Scope } from "@/server/auth/catalog";
import { DEMO_SUBDOMAIN } from "./demo";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const ROLLBACK = "rollback";
const rolledBack = async (tenantId: string, fn: (tx: Tx) => Promise<void>) =>
  withTenant(tenantId, async (tx) => { await fn(tx); throw new Error(ROLLBACK); }).catch((e) => { if (e.message !== ROLLBACK) throw e; });
const working = (d: string) => !["sat", "sun"].includes(weekday(d));
const ist = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`);

async function main() {
  const [t] = await sql<{ id: string }[]>`select id from tenant_by_subdomain(${DEMO_SUBDOMAIN})`;
  assert.ok(t, "demo tenant exists (run pnpm db:seed)");
  const tenant = { id: t.id, name: "Acme Technologies", status: "trial", subdomain: DEMO_SUBDOMAIN };
  const people = await withTenant(tenant.id, (tx) => tx<{ id: string; user_id: string; display_name: string; first_name: string; department_id: string }[]>`
    select id, user_id, display_name, first_name, department_id from employees`);
  const actor = (first: string, perms: string[] = [], scopes: Scope[] = []): Actor => {
    const e = people.find((p) => p.first_name === first)!;
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(perms), grants: perms.length ? [{ permissions: perms, scopes }] : [] };
  };
  const asha = actor("Asha", ["*"]), priya = actor("Priya", ["attendance.admin", "employees.write"]);
  const arjun = actor("Arjun"), rohan = actor("Rohan"), meera = actor("Meera"), karan = actor("Karan"), sneha = actor("Sneha"), vikram = actor("Vikram");
  const today = todayIn();
  const pastWorking = Array.from({ length: 10 }, (_, i) => addDaysISO(today, -(i + 1))).filter(working);
  const nextWorking = (() => { let d = addDaysISO(today, 1); while (!working(d)) d = addDaysISO(d, 1); return d; })();
  const stepFor = async (tx: Tx, entityId: string, who: Actor) => (await approvals.inbox(tx, who)).find((i) => i.entity_id === entityId);

  // ---------------------------------------------------------------- capture enforcement
  await rolledBack(tenant.id, async (tx) => {
    const st = await attendance.today(tx, sneha.employeeId);
    const expect = st.clockedIn ? "out" : "in";
    assert.equal(st.capture.locationCapture, true);
    const e1 = await tx.savepoint((sp) => attendance.punch(sp as unknown as Tx, sneha, { ip: "198.51.100.7", expect })).catch((e) => e);
    assert.ok(e1 instanceof AppError && e1.field === "location", "off-network without location asks for location");
    const e2 = await tx.savepoint((sp) => attendance.punch(sp as unknown as Tx, sneha, { ip: "198.51.100.7", lat: 12.99, lng: 77.5946, accuracy: 10, expect })).catch((e) => e);
    assert.ok(e2 instanceof AppError && /km from Bengaluru office/.test(e2.message), "outside the geofence is refused with the distance");
    const p1 = await attendance.punch(tx, sneha, { ip: "198.51.100.7", lat: 12.9718, lng: 77.5947, accuracy: 15, expect });
    assert.equal(p1.fence, "Bengaluru office");
    const [row] = await tx<{ source: string }[]>`select source from punches where employee_id = ${sneha.employeeId} order by created_at desc limit 1`;
    assert.equal(row.source, "mobile");
    const p2 = await attendance.punch(tx, sneha, { ip: "203.0.113.40", expect: expect === "in" ? "out" : "in" });
    assert.equal(p2.fence, null, "office network works without location");
    // default policy (Arjun) accepts any network; a garbage IP header is stored as null, not a crash
    const a = await attendance.today(tx, arjun.employeeId);
    await attendance.punch(tx, arjun, { ip: "not-an-ip", expect: a.clockedIn ? "out" : "in" });
  });
  ok("capture: off-network asks for location, outside the fence refused with distance, inside = mobile punch, office IP ok, open policy ok");

  await rolledBack(tenant.id, async (tx) => {
    await tx`update capture_policies set web = ${tx.json({ enabled: true, comment_required: true, ip_ranges: ["203.0.113.0/24"] })} where name = 'Office network or location'`;
    const st = await attendance.today(tx, sneha.employeeId);
    const expect = st.clockedIn ? "out" : "in";
    const e = await tx.savepoint((sp) => attendance.punch(sp as unknown as Tx, sneha, { ip: "203.0.113.40", expect })).catch((x) => x);
    assert.ok(e instanceof AppError && e.field === "comment");
    // approved WFH today: clock in from anywhere
    await tx`insert into attendance_requests (tenant_id, employee_id, kind, from_date, to_date, status, reason) values (${tenant.id}, ${sneha.employeeId}, 'wfh', ${st.date}, ${st.date}, 'approved', 'smoke')`;
    assert.equal((await attendance.today(tx, sneha.employeeId)).capture.remoteToday, "wfh");
    await attendance.punch(tx, sneha, { ip: "198.51.100.7", comment: "From home", expect });
  });
  ok("capture: comment required when the policy says so; approved WFH lets you clock in from anywhere");

  // ---------------------------------------------------------------- night shift
  await rolledBack(tenant.id, async (tx) => {
    const d = pastWorking.find((x) => working(addDaysISO(x, 1))) ?? pastWorking[0];
    const [night] = await tx<{ id: string }[]>`select id from shifts where code = 'NIGHT'`;
    await policies.assign(tx, asha, { employeeIds: [vikram.employeeId], kind: "shift", policyId: night.id, from: d });
    await tx`delete from punches where employee_id = ${vikram.employeeId} and at >= ${ist(d, "00:00")} and at < ${ist(addDaysISO(d, 2), "00:00")}`;
    await tx`insert into punches (tenant_id, employee_id, at, direction, source) values
      (${tenant.id}, ${vikram.employeeId}, ${ist(d, "22:20")}, 'in', 'web'), (${tenant.id}, ${vikram.employeeId}, ${ist(addDaysISO(d, 1), "06:05")}, 'out', 'web')`;
    const r = await processAttendance(tx, tenant.id, vikram.employeeId, d);
    assert.equal(r!.status, "present"); assert.equal(r!.day.effective, 465); assert.equal(r!.day.late, 20);
    const [row] = await tx<{ first_in: Date; last_out: Date }[]>`select first_in, last_out from attendance_days where employee_id = ${vikram.employeeId} and date = ${d}`;
    assert.equal(row.last_out.toISOString(), ist(addDaysISO(d, 1), "06:05").toISOString(), "the 06:05 punch belongs to the night it started");
    const next = await processAttendance(tx, tenant.id, vikram.employeeId, addDaysISO(d, 1));
    assert.equal(next!.day.firstIn, null, "the next day doesn't see the previous night's punches");
  });
  ok("night shift: 22:20 → 06:05 counts for the start date (late 20, 7h45 worked), next day untouched");

  // ---------------------------------------------------------------- penalties + idempotent ledger
  await rolledBack(tenant.id, async (tx) => {
    const cl = (await tx<{ id: string }[]>`select id from leave_types where code = 'CL'`)[0].id;
    const ledger = async () => (await tx<{ n: number; s: string }[]>`select count(*)::int as n, coalesce(sum(amount), 0) as s from leave_ledger where employee_id = ${arjun.employeeId} and kind = 'penalty'`)[0];
    const late = pastWorking.slice(0, 4).sort();
    const before = await ledger();
    assert.equal(Number(before.s), -0.5, "seed: Arjun's 4th late arrival this month cost half a casual leave");
    for (const d of late) await processAttendance(tx, tenant.id, arjun.employeeId, d);
    for (const d of late) await processAttendance(tx, tenant.id, arjun.employeeId, d);
    assert.deepEqual(await ledger(), before, "re-processing posts nothing new");
    // no attendance → absent + loss of pay, never from leave
    const gap = pastWorking[5];
    await tx`delete from punches where employee_id = ${arjun.employeeId} and at >= ${ist(gap, "00:00")} and at < ${ist(gap, "23:59")}`;
    const r = await processAttendance(tx, tenant.id, arjun.employeeId, gap);
    assert.equal(r!.status, "absent"); assert.equal(r!.lop, 1);
    assert.equal(r!.penalties[0].rule, "no_attendance"); assert.equal(r!.penalties[0].deductions[0].leaveTypeId, null);
    // no balance left in CL → the late penalty falls through to LOP; a credit later moves it back to CL
    const bal0 = (await leave.balances(tx, arjun.employeeId)).find((b) => b.id === cl)!;
    const cycle = (await tx<{ c: string }[]>`select cycle_start::text as c from leave_ledger where employee_id = ${arjun.employeeId} and leave_type_id = ${cl} order by cycle_start desc limit 1`)[0].c;   // the current leave year (the leave seed also has last year)
    await tx`insert into leave_ledger (tenant_id, employee_id, leave_type_id, cycle_start, entry_date, kind, amount, idempotency_key)
      values (${tenant.id}, ${arjun.employeeId}, ${cl}, ${cycle}, ${today}, 'adjust', ${-(bal0.available + 0.5)}, ${"smoke-drain:" + randomUUID()})`;   // 0.5 below zero once this day's own ½ is given back
    const lateDay = late[3];
    const r2 = await processAttendance(tx, tenant.id, arjun.employeeId, lateDay);
    assert.equal(r2!.penalties[0].deductions.find((x) => x.leaveTypeId === null)?.days, 0.5, "with nothing left in CL the penalty is loss of pay");
    const after = await ledger();
    assert.equal(Number(after.s), 0, "the earlier CL deduction for that day was reversed");
    assert.equal(after.n, before.n + 1, "by one reversing entry");
  });
  ok("penalties: 4th late costs ½ CL, re-runs post nothing, no attendance = LOP, empty balance falls back to LOP with a reversing entry");

  // review fix: a penalty that is reversed and then applies again must be posted again (unique ledger key per posting)
  await rolledBack(tenant.id, async (tx) => {
    const d = pastWorking.slice(0, 4).sort()[3];
    const pen = async () => Number((await tx<{ s: string }[]>`select coalesce(sum(amount), 0) as s from leave_ledger where employee_id = ${arjun.employeeId} and kind = 'penalty' and entry_date = ${d}`)[0].s);
    const [{ pid }] = await tx<{ pid: string }[]>`select penalization_policy_id as pid from employees where id = ${arjun.employeeId}`;
    assert.equal(await pen(), -0.5);
    await tx`update employees set penalization_policy_id = null where id = ${arjun.employeeId}`;
    await processAttendance(tx, tenant.id, arjun.employeeId, d);
    assert.equal(await pen(), 0, "policy off: penalty reversed");
    await tx`update employees set penalization_policy_id = ${pid} where id = ${arjun.employeeId}`;
    await processAttendance(tx, tenant.id, arjun.employeeId, d);
    assert.equal(await pen(), -0.5, "policy back: penalty posted again");
    await processAttendance(tx, tenant.id, arjun.employeeId, d);
    assert.equal(await pen(), -0.5, "and re-runs still post nothing");
  });
  ok("penalties: reversed then re-applied penalty is posted again, not swallowed by the idempotency key");

  // ---------------------------------------------------------------- requests through approvals
  await rolledBack(tenant.id, async (tx) => {
    const d = pastWorking.slice(0, 4).sort()[3];   // a late day with a ½ CL penalty
    const pen0 = (await tx<{ s: string }[]>`select coalesce(sum(amount), 0) as s from leave_ledger where employee_id = ${arjun.employeeId} and kind = 'penalty' and entry_date = ${d}`)[0].s;
    assert.equal(Number(pen0), -0.5);
    const r = await requests.createRequest(tx, arjun, { kind: "regularization", date: d, inTime: "09:28", outTime: "18:40", reason: "Badge reader skipped me" });
    assert.equal(r.status, "pending");
    assert.equal(await stepFor(tx, r.id, meera), undefined, "only the manager gets it");
    const step = await stepFor(tx, r.id, rohan);
    assert.ok(step);
    await assert.rejects(tx.savepoint((sp) => approvals.decide(sp as unknown as Tx, meera, step.step_id, "approved")), /isn't waiting for you/);
    const detail = await requests.requestDetail(tx, rohan, r.id);
    assert.ok(detail && detail.day?.firstIn, "approver sees the day as recorded");
    assert.equal(await requests.requestDetail(tx, karan, r.id), null, "a colleague can't read it");
    const salesDept = (await tx<{ id: string }[]>`select id from departments where name = 'Sales'`)[0]?.id ?? randomUUID();
    assert.equal(await requests.requestDetail(tx, actor("Karan", ["attendance.admin"], [{ type: "department", ids: [salesDept] }]), r.id), null, "an admin scoped to another department can't read it");
    assert.ok(await requests.requestDetail(tx, actor("Karan", ["attendance.admin"], [{ type: "department", ids: [people.find((p) => p.first_name === "Arjun")!.department_id] }]), r.id), "an admin scoped to Arjun's department can");
    await approvals.decide(tx, rohan, step.step_id, "approved", "ok");
    const [day] = await tx<{ first_in: Date; late_minutes: number; status: string }[]>`select first_in, late_minutes, status from attendance_days where employee_id = ${arjun.employeeId} and date = ${d}`;
    assert.equal(day.first_in.toISOString(), ist(d, "09:28").toISOString()); assert.equal(day.late_minutes, 0);
    const pen1 = (await tx<{ s: string }[]>`select coalesce(sum(amount), 0) as s from leave_ledger where employee_id = ${arjun.employeeId} and kind = 'penalty' and entry_date = ${d}`)[0].s;
    assert.equal(Number(pen1), 0, "the late penalty is given back");
    const [n] = await tx<{ c: number }[]>`select count(*)::int as c from notifications where user_id = ${arjun.userId} and kind = 'request.approved' and link = '/me/attendance'`;
    assert.ok(n.c >= 1, "Arjun is told");
    // limits: future day, outside the window, monthly cap
    await assert.rejects(tx.savepoint((sp) => requests.createRequest(sp as unknown as Tx, arjun, { kind: "regularization", date: today, inTime: "09:30", outTime: "18:30", reason: "x" })), /past days/);
    await assert.rejects(tx.savepoint((sp) => requests.createRequest(sp as unknown as Tx, arjun, { kind: "regularization", date: addDaysISO(today, -20), inTime: "09:30", outTime: "18:30", reason: "x" })), /days back/);
    await tx`update capture_policies set limits = jsonb_set(limits, '{regularization_per_month}', '1') where name = 'Default'`;
    const sameMonth = pastWorking.find((x) => x.slice(0, 7) === d.slice(0, 7) && x !== d);
    if (sameMonth) await assert.rejects(tx.savepoint((sp) => requests.createRequest(sp as unknown as Tx, arjun, { kind: "regularization", date: sameMonth, inTime: "09:30", outTime: "18:30", reason: "x" })), /used all 1/);
  });
  ok("regularize: manager-only approval, detail visible to approver not colleagues, punches replaced, late penalty reversed, limits enforced");

  await rolledBack(tenant.id, async (tx) => {
    // the seeded WFH request for Arjun is pending; an overlapping one is refused
    await assert.rejects(tx.savepoint((sp) => requests.createRequest(sp as unknown as Tx, arjun, { kind: "on_duty", from: nextWorking, to: nextWorking, half: null, reason: "client visit" })), /already have/);
    const [wfh] = await tx<{ id: string }[]>`select id from attendance_requests where employee_id = ${arjun.employeeId} and kind = 'wfh' and status = 'pending'`;
    await assert.rejects(tx.savepoint((sp) => requests.cancelRequest(sp as unknown as Tx, meera, wfh.id)), /Only requests/);
    await requests.cancelRequest(tx, arjun, wfh.id);
    assert.equal(await stepFor(tx, wfh.id, rohan), undefined, "withdrawn request leaves the inbox");
    // WFH over a past absent day: approved → status wfh, no LOP
    const gap = pastWorking[4];   // 5 working days always fit in the 7-day window; [0..3] are the late days
    await tx`delete from punches where employee_id = ${arjun.employeeId} and at >= ${ist(gap, "00:00")} and at < ${ist(gap, "23:59")}`;
    await processAttendance(tx, tenant.id, arjun.employeeId, gap);
    const w = await requests.createRequest(tx, arjun, { kind: "wfh", from: gap, to: gap, half: null, reason: "Worked from home, forgot to ask" });
    await approvals.decide(tx, rohan, (await stepFor(tx, w.id, rohan))!.step_id, "approved");
    const [day] = await tx<{ status: string; penalties: unknown[] }[]>`select status, penalties from attendance_days where employee_id = ${arjun.employeeId} and date = ${gap}`;
    assert.equal(day.status, "wfh"); assert.deepEqual(day.penalties, []);
    // partial day: monthly allowance in minutes (240 by default)
    const pd = pastWorking[0];
    await requests.createRequest(tx, meera, { kind: "partial_day", date: pd, type: "late_arrival", minutes: 180, reason: "Doctor" });
    await assert.rejects(tx.savepoint((sp) => requests.createRequest(sp as unknown as Tx, meera, { kind: "partial_day", date: pd, type: "early_leave", minutes: 90, reason: "x" })), /allowance/);
    await assert.rejects(tx.savepoint((sp) => requests.createRequest(sp as unknown as Tx, meera, { kind: "partial_day", date: pd, type: "late_arrival", minutes: 30, reason: "x" })), /already asked/);
    // rejected requests change nothing
    const rj = await requests.createRequest(tx, meera, { kind: "on_duty", from: nextWorking, to: nextWorking, half: "first", reason: "Vendor meeting" });
    await approvals.decide(tx, rohan, (await stepFor(tx, rj.id, rohan))!.step_id, "rejected", "Please reschedule");
    const [st] = await tx<{ status: string }[]>`select status from attendance_requests where id = ${rj.id}`;
    assert.equal(st.status, "rejected");
  });
  ok("WFH / on duty / partial day: overlaps refused, only the owner withdraws, approved WFH clears an absence, partial-day quota, rejection");

  await rolledBack(tenant.id, async (tx) => {
    // the founder has no manager: their request is approved straight away
    const d = pastWorking[0];
    if (d >= (await tx<{ j: string }[]>`select joining_date::text as j from employees where id = ${asha.employeeId}`)[0].j) {
      const r = await requests.createRequest(tx, asha, { kind: "regularization", date: d, inTime: "09:00", outTime: "18:00", reason: "x" });
      assert.equal(r.status, "approved");
    } else {
      await assert.rejects(tx.savepoint((sp) => requests.createRequest(sp as unknown as Tx, asha, { kind: "regularization", date: d, inTime: "09:00", outTime: "18:00", reason: "x" })), /before you joined/);
    }
  });
  ok("requests: nobody to ask → approved at once; days before joining refused");

  // ---------------------------------------------------------------- time settings: permissions, validation
  await rolledBack(tenant.id, async (tx) => {
    const shift = { name: "Early", code: "EARLY", kind: "fixed" as const, timings: { mon: { start: "07:00", end: "15:00" } }, break_minutes: 30, grace_minutes: 5, half_day_minutes: 240 };
    await assert.rejects(policies.saveShift(tx, arjun, null, shift), /access/);
    const eng = people.find((p) => p.first_name === "Arjun")!.department_id;
    const engHr = actor("Meera", ["attendance.admin"], [{ type: "department", ids: [eng] }]);
    await assert.rejects(policies.saveShift(tx, engHr, null, shift), /access/, "a department-scoped admin can't change company-wide shifts");
    const { id } = await policies.saveShift(tx, priya, null, shift);
    await assert.rejects(policies.saveShift(tx, priya, null, { ...shift, name: "Early 2" }), /already uses this code/);
    await assert.rejects(policies.saveShift(tx, priya, null, { ...shift, code: "BAD", timings: { mon: { start: "07:00", end: "07:00" } } }), /same time/);
    await policies.deleteShift(tx, priya, id);
    const [gen] = await tx<{ id: string }[]>`select id from shifts where code = 'GEN'`;
    await assert.rejects(policies.deleteShift(tx, priya, gen.id), /can't be deleted/);
    await assert.rejects(policies.saveWeeklyOff(tx, priya, null, { name: "Never work", grid: Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, Array(5).fill("off")])) }), /working day/);
    await policies.saveWeeklyOff(tx, priya, null, { name: "Sundays", grid: { sun: Array(5).fill("off") } });
    const cap = { name: "Smoke", web: { enabled: true, comment_required: false, ip_ranges: ["10.0.0.0/33"] }, mobile: { enabled: true, fences: [] }, remote: { wfh: true, od: true }, limits: { regularization_per_month: 3, regularization_past_days: 7, partial_day_minutes_per_month: 240 } };
    await assert.rejects(policies.saveCapture(tx, priya, null, cap), /isn't an IP address/);
    const c = await policies.saveCapture(tx, priya, null, { ...cap, web: { ...cap.web, ip_ranges: ["10.0.0.0/8", "2001:db8::/32"] }, mobile: { enabled: true, fences: [{ name: "Pune", lat: 18.52, lng: 73.85, radius_m: 300 }] } });
    const saved = (await policies.listCapture(tx)).find((x) => x.id === c.id)!;
    assert.equal(saved.fences.length, 1); assert.deepEqual(saved.web.ip_ranges, ["10.0.0.0/8", "2001:db8::/32"]);
    await policies.saveCapture(tx, priya, c.id, { ...cap, web: { ...cap.web, ip_ranges: [] }, mobile: { enabled: true, fences: [{ id: saved.fences[0].id, name: "Pune HQ", lat: 18.52, lng: 73.85, radius_m: 250 }] } });
    const again = (await policies.listCapture(tx)).find((x) => x.id === c.id)!;
    assert.equal(again.fences[0].id, saved.fences[0].id); assert.equal(again.fences[0].radius_m, 250);
    const [dflt] = await tx<{ id: string }[]>`select id from capture_policies where name = 'Default'`;
    await assert.rejects(policies.deleteCapture(tx, priya, dflt.id), /company default/);
    await assert.rejects(policies.savePenalty(tx, priya, null, { name: "Bad", late_arrival: { enabled: true, free_per_month: 2, deduct_days: 0.3 }, deduct_from: [] }), /half a day/);
  });
  ok("time settings: employees and scoped admins can't edit policies; duplicate code, bad timings, all-off week, bad CIDR refused; fences kept on edit");

  // ---------------------------------------------------------------- dated assignments + scopes
  await rolledBack(tenant.id, async (tx) => {
    const [night] = await tx<{ id: string }[]>`select id from shifts where code = 'NIGHT'`;
    const [flex] = await tx<{ id: string }[]>`select id from shifts where code = 'FLEX'`;
    const later = addDaysISO(today, 10), sooner = addDaysISO(today, 5);
    await policies.assign(tx, priya, { employeeIds: [meera.employeeId], kind: "shift", policyId: night.id, from: later });
    await policies.assign(tx, priya, { employeeIds: [meera.employeeId], kind: "shift", policyId: flex.id, from: sooner });   // replaces the later plan
    const periods = await tx<{ code: string; lo: string; hi: string | null }[]>`
      select s.code, lower(a.period)::text as lo, upper(a.period)::text as hi from shift_assignments a join shifts s on s.id = a.shift_id
      where a.employee_id = ${meera.employeeId} order by lower(a.period)`;
    assert.deepEqual(periods.map((p) => [p.code, p.hi]), [["GEN", sooner], ["FLEX", null]], "previous period ends, future plan replaced, no overlap");
    const eng = people.find((p) => p.first_name === "Arjun")!.department_id;
    const engHr = actor("Priya", ["attendance.admin"], [{ type: "department", ids: [eng] }]);
    await assert.rejects(policies.assign(tx, engHr, { employeeIds: [arjun.employeeId, karan.employeeId], kind: "shift", policyId: flex.id, from: sooner }), /Karan/);
    await policies.assign(tx, engHr, { employeeIds: [arjun.employeeId], kind: "weekly_off", policyId: (await tx<{ id: string }[]>`select id from weekly_off_policies where name = 'Alternate Saturdays'`)[0].id, from: sooner });
    const visible = await policies.listAssignments(tx, engHr, today);
    assert.ok(visible.length > 0 && visible.every((r) => r.department === "Engineering"), "scoped admin only sees their people");
    assert.equal(visible.find((r) => r.id === arjun.employeeId)!.next_weekly_off, "Alternate Saturdays");
    await assert.rejects(policies.assign(tx, arjun, { employeeIds: [arjun.employeeId], kind: "penalty", policyId: null, from: today }), /can't change/);
    // penalty policy removed → this month's penalties re-processed away
    await policies.assign(tx, priya, { employeeIds: [arjun.employeeId], kind: "penalty", policyId: null, from: today });
    const [{ s }] = await tx<{ s: string }[]>`select coalesce(sum(amount), 0) as s from leave_ledger where employee_id = ${arjun.employeeId} and kind = 'penalty' and entry_date >= ${today.slice(0, 8) + "01"}`;
    assert.equal(Number(s), 0);
  });
  ok("assignments: dated shift change ends the old period and replaces future plans; scoped admin limited to their department; reprocessing follows");

  // ---------------------------------------------------------------- team view + month log
  await withTenant(tenant.id, async (tx) => {
    const month = today.slice(0, 8) + "01";
    const team = await teamAttendance(tx, rohan, month);
    assert.deepEqual(team.members.map((m) => m.name.split(" ")[0]).sort(), ["Arjun", "Meera", "Vikram"]);
    const days = Object.keys(team.grid[arjun.employeeId]);
    assert.equal(days[0], month); assert.ok(days.length >= 28);
    assert.ok(team.pendingAttendance >= 2, "seeded regularization and WFH wait for Rohan");
    assert.equal(team.entries.length, 3);
    const none = await teamAttendance(tx, karan, month);
    assert.ok(none.members.every((m) => m.id !== arjun.employeeId), "Karan doesn't see Rohan's team");
    const log = await attendance.monthLog(tx, arjun.employeeId, month);
    assert.equal(log[0].date, today, "newest first, ends today");
    assert.ok(log.some((r) => r.penalties.some((p) => p.rule === "late_arrival")));
  });
  ok("team: Rohan sees Arjun, Meera, Vikram with a full month grid, today's status and pending requests; the log shows penalties");

  // ---------------------------------------------------------------- nightly job
  {
    const y = addDaysISO(today, -1);
    const count = () => withTenant(tenant.id, (tx) => tx<{ n: number; s: string }[]>`select count(*)::int as n, coalesce(sum(amount), 0) as s from leave_ledger where kind = 'penalty'`).then((r) => r[0]);
    const before = await count();
    const r1 = await processTenantDate(tenant.id, y);
    const mid = await count();
    const r2 = await processTenantDate(tenant.id, y);
    assert.equal(r1.failed.length + r2.failed.length, 0);
    assert.ok(r1.done > 0);
    assert.deepEqual(await count(), mid, "running the same date twice changes nothing");
    assert.equal(mid.n >= before.n, true);
  }
  ok("job: processes every active person for a date; running it twice is a no-op");

  // ---------------------------------------------------------------- integration with the leave module
  await rolledBack(tenant.id, async (tx) => {
    const cl = (await tx<{ id: string }[]>`select id from leave_types where code = 'CL'`)[0].id;
    // approved backdated leave replaces an absence (and its loss of pay) without waiting for the nightly run
    const gap = pastWorking[5];
    await tx`delete from punches where employee_id = ${arjun.employeeId} and at >= ${ist(gap, "00:00")} and at < ${ist(gap, "23:59")}`;
    const r0 = await processAttendance(tx, tenant.id, arjun.employeeId, gap);
    assert.equal(r0!.status, "absent"); assert.equal(r0!.lop, 1);
    await tx`update leave_plan_rules set application = application || ${tx.json({ backdateDays: 30 })}
             where leave_type_id = ${cl} and leave_plan_id = (select leave_plan_id from employees where id = ${arjun.employeeId})`;
    const req = await leave.apply(tx, arjun, { leaveTypeId: cl, from: gap, to: gap, fromPart: "full", toPart: "full" });
    assert.equal(req.status, "pending");
    const step = await stepFor(tx, req.id, rohan);
    assert.ok(step, "backdated leave is in Rohan's inbox");
    await approvals.decide(tx, rohan, step!.step_id, "approved");
    const [day] = await tx<{ status: string; penalties: { deductions: { leaveTypeId: string | null }[] }[] }[]>`
      select status, penalties from attendance_days where employee_id = ${arjun.employeeId} and date = ${gap}`;
    assert.equal(day.status, "leave", "the approved leave shows on the attendance day");
    assert.ok(!day.penalties.some((p) => p.deductions.some((x) => x.leaveTypeId === null)), "no loss of pay left on a leave day");
    // a floater the person picked is a holiday for them (same holiday calendar as leave), not for colleagues
    const fl = pastWorking[6];
    const [list] = await tx<{ id: string }[]>`
      select hl.id from holiday_lists hl where hl.name = ${await leave.holidayListNameFor(tx, arjun.employeeId)} and hl.year = ${Number(fl.slice(0, 4))}`;
    assert.ok(list, "Arjun has a holiday list for this year");
    const [h] = await tx<{ id: string }[]>`insert into holidays (tenant_id, holiday_list_id, name, date, is_floater) values (${tenant.id}, ${list.id}, 'Smoke floater', ${fl}, true) returning id`;
    await tx`insert into floater_choices (holiday_id, employee_id, tenant_id) values (${h.id}, ${arjun.employeeId}, ${tenant.id})`;
    await tx`delete from punches where employee_id in (${arjun.employeeId}, ${meera.employeeId}) and at >= ${ist(fl, "00:00")} and at < ${ist(fl, "23:59")}`;
    assert.equal((await processAttendance(tx, tenant.id, arjun.employeeId, fl))!.status, "holiday", "picked floater is a holiday");
    assert.equal((await processAttendance(tx, tenant.id, meera.employeeId, fl))!.status, "absent", "colleague who didn't pick it is absent");
  });
  ok("with leave: approving backdated leave reprocesses the day (absence and LOP cleared); picked floaters count as holidays");

  // ---------------------------------------------------------------- locked days
  await rolledBack(tenant.id, async (tx) => {
    const d = pastWorking[0];
    await tx`update attendance_days set is_locked = true, status = 'present' where employee_id = ${karan.employeeId} and date = ${d}`;
    assert.equal(await processAttendance(tx, tenant.id, karan.employeeId, d), null);
    assert.ok((await reprocessFrom(tx, tenant.id, karan.employeeId, d)) >= 1);
    const [row] = await tx<{ is_locked: boolean }[]>`select is_locked from attendance_days where employee_id = ${karan.employeeId} and date = ${d}`;
    assert.equal(row.is_locked, true);
  });
  ok("locked (payroll-finalised) days are never recomputed");

  // ---------------------------------------------------------------- tenant isolation
  const otherId = randomUUID();
  await admin`insert into tenants (id, subdomain, name) values (${otherId}, ${"smoke-" + otherId.slice(0, 8)}, 'Smoke Co')`;
  try {
    const [c] = await withTenant(otherId, (tx) => tx<Record<string, number>[]>`
      select (select count(*)::int from shifts) as shifts, (select count(*)::int from punches) as punches, (select count(*)::int from attendance_days) as days,
             (select count(*)::int from attendance_requests) as reqs, (select count(*)::int from geofences) as fences, (select count(*)::int from capture_policies) as caps,
             (select count(*)::int from penalization_policies) as pens, (select count(*)::int from shift_assignments) as assigns`);
    assert.deepEqual(c, { shifts: 0, punches: 0, days: 0, reqs: 0, fences: 0, caps: 0, pens: 0, assigns: 0 });
    await assert.rejects(withTenant(otherId, (tx) => tx`insert into punches (tenant_id, employee_id, at, source) values (${tenant.id}, ${arjun.employeeId}, now(), 'web')`), /row-level security/);
    await assert.rejects(withTenant(otherId, (tx) => tx`insert into attendance_requests (tenant_id, employee_id, kind, from_date, to_date) values (${tenant.id}, ${arjun.employeeId}, 'wfh', ${today}, ${today})`), /row-level security/);
    assert.equal((await withTenant(otherId, (tx) => tx`update attendance_days set status = 'absent' where tenant_id = ${tenant.id} returning id`)).length, 0);
    assert.equal(await withTenant(otherId, (tx) => requests.requestDetail(tx, { ...asha, tenant: { ...tenant, id: otherId } }, randomUUID())), null);
    ok("another tenant sees none of Acme's shifts, punches, days, requests, fences or policies and can't write into them");
  } finally {
    await admin`delete from tenants where id = ${otherId}`;
  }
  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await admin.end(); await sql.end(); }).catch(async (e) => { console.error("\nFAILED:", e); await admin.end(); await sql.end(); process.exit(1); });
