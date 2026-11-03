/**
 * End-to-end checks for the time extras against the seeded demo tenant (run `pnpm db:seed` first):
 * overtime policies and requests, monthly settlement into payroll inputs / comp-off (idempotent, respects finalised
 * payroll), shift allowances, the roster and rotations (scoped, locked days), shift-change and weekly-off-swap
 * requests, biometric devices and punch ingest, notification settings + emails, the approvers' digest, tenant isolation.
 * Everything runs in rolled-back transactions so the demo data stays as seeded.
 *   pnpm smoke:time2
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { withTenant, sql, AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import type { Scope } from "@/server/auth/catalog";
import { addDaysISO, todayIn, weekday } from "@/lib/dates";
import * as approvals from "@/server/modules/approvals/service";
import * as requests from "@/server/modules/attendance/requests";
import * as overtime from "@/server/modules/attendance/overtime";
import * as roster from "@/server/modules/attendance/roster";
import * as devices from "@/server/modules/attendance/devices";
import { calendarFor, processAttendance, shiftsFor } from "@/server/modules/attendance/process";
import { DEFAULT_OVERTIME_RULES } from "@/server/modules/attendance/overtime-rules";
import { parseDeviceKey, formatDeviceKey } from "@/server/modules/attendance/device-rules";
import { notify, setNotificationChannels } from "@/server/modules/notifications/service";
import { publishDue } from "@/server/modules/engage/service";
import { digestIn } from "./jobs-digest";
import { DEMO_SUBDOMAIN } from "./demo";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const ROLLBACK = "rollback";
const rolledBack = async (tenantId: string, fn: (tx: Tx) => Promise<void>) =>
  withTenant(tenantId, async (tx) => { await fn(tx); throw new Error(ROLLBACK); }).catch((e) => { if (e.message !== ROLLBACK) throw e; });
const working = (d: string) => !["sat", "sun"].includes(weekday(d));
const ist = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`);
const fails = async (p: Promise<unknown>, re: RegExp, code?: AppError["code"]) => {
  const e = await p.then(() => null, (x) => x);
  assert.ok(e instanceof AppError, `expected an AppError, got ${e}`);
  assert.match(e.message, re);
  if (code) assert.equal(e.code, code);
};

async function main() {
  const [t] = await sql<{ id: string }[]>`select id from tenant_by_subdomain(${DEMO_SUBDOMAIN})`;
  assert.ok(t, "demo tenant exists (run pnpm db:seed)");
  const tenant = { id: t.id, name: "Acme Technologies", status: "trial", subdomain: DEMO_SUBDOMAIN };
  const people = await withTenant(tenant.id, (tx) => tx<{ id: string; user_id: string; display_name: string; first_name: string; department_id: string; employee_number: string; pay_group_id: string }[]>`
    select id, user_id, display_name, first_name, department_id, employee_number, pay_group_id from employees`);
  const actor = (first: string, perms: string[] = [], scopes: Scope[] = []): Actor => {
    const e = people.find((p) => p.first_name === first)!;
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(perms), grants: perms.length ? [{ permissions: perms, scopes }] : [] };
  };
  const asha = actor("Asha", ["*"]), arjun = actor("Arjun"), rohan = actor("Rohan"), vikram = actor("Vikram");
  const priyaScoped = actor("Priya", ["attendance.admin"], [{ type: "department", ids: [people.find((p) => p.first_name === "Priya")!.department_id] }]);
  const divya = people.find((p) => p.first_name === "Divya")!;    // Operations, outside Priya's (People) scope
  const today = todayIn();
  const pastWorking = Array.from({ length: 14 }, (_, i) => addDaysISO(today, -(i + 1))).filter(working);
  const oldDay = pastWorking[pastWorking.length - 1];
  const otDay = pastWorking[4];   // within the 7-day overtime claim window and clear of Arjun's seeded late days
  const lastSat = (() => { let d = addDaysISO(today, -1); while (weekday(d) !== "sat") d = addDaysISO(d, -1); return d; })();
  const nextWorking = (from = today) => { let d = addDaysISO(from, 1); while (!working(d)) d = addDaysISO(d, 1); return d; };
  const nextSat = (() => { let d = addDaysISO(today, 1); while (weekday(d) !== "sat") d = addDaysISO(d, 1); return d; })();
  const stepFor = async (tx: Tx, entityId: string, who: Actor) => (await approvals.inbox(tx, who)).find((i) => i.entity_id === entityId);
  const month = (d: string) => d.slice(0, 7);

  // ---------------------------------------------------------------- policies: company-wide admins only
  await rolledBack(tenant.id, async (tx) => {
    const [code] = await tx<{ id: string }[]>`select id from pay_codes where name = 'Double time'`;
    const rules = { ...DEFAULT_OVERTIME_RULES, working: { ...DEFAULT_OVERTIME_RULES.working, pay_code_id: code.id } };
    await fails(overtime.saveOvertimePolicy(tx, priyaScoped, null, { name: "Scoped try", rules }), /access/, "forbidden");
    await fails(overtime.savePayCode(tx, arjun, null, { name: "Mine", kind: "multiplier", value: 2 }), /access/, "forbidden");
    await fails(roster.saveShiftRule(tx, priyaScoped, null, { name: "x", allowedShiftIds: [], requestWindowDays: 10, maxRequestsPerMonth: 1, allowOnOffDays: false }), /access/, "forbidden");
    await fails(devices.createDevice(tx, priyaScoped, { name: "Gate", serial: "X-1", vendor: "generic", locationId: null }), /access/, "forbidden");
    await fails(overtime.settleOvertime(tx, tenant.id, month(today), priyaScoped), /access/, "forbidden");
    await fails(overtime.saveOvertimePolicy(tx, asha, null, { name: "No code", rules: { ...rules, working: { ...rules.working, pay_code_id: null } } }), /pay code/, "invalid");
    await fails(overtime.saveOvertimePolicy(tx, asha, null, { name: "Standard overtime", rules }), /already/, "conflict");
    const { id } = await overtime.saveOvertimePolicy(tx, asha, null, { name: "Second policy", rules });
    assert.ok((await overtime.listOvertimePolicies(tx)).some((p) => p.id === id));
    await fails(overtime.deletePayCode(tx, asha, code.id), /policy uses/, "conflict");
    await fails(overtime.saveAllowancePolicy(tx, asha, null, { name: "Bad", shiftIds: [], amountPaise: 100, per: "day", componentCode: "X" }), /at least one shift/, "invalid");
  });
  ok("overtime policies, pay codes, shift rules and devices need company-wide attendance.admin; validation and name clashes are friendly");

  // ---------------------------------------------------------------- overtime: computed, approved, settled (idempotent), locked month
  await rolledBack(tenant.id, async (tx) => {
    await tx`update punches set at = ${ist(otDay, "21:00")} where employee_id = ${arjun.employeeId} and direction = 'out' and (at at time zone 'Asia/Kolkata')::date = ${otDay}::date`;
    const r1 = await processAttendance(tx, tenant.id, arjun.employeeId, otDay);
    assert.equal(r1?.overtimeComputed, 150, "18:30 → 21:00 is 150 min of overtime");
    assert.equal(r1?.overtime, 0, "nothing counts until approved");
    const req = await requests.createRequest(tx, arjun, { kind: "overtime", date: otDay, minutes: 120, reason: "Deployment ran late" });
    assert.equal(req.status, "pending");
    await fails(requests.createRequest(tx, arjun, { kind: "overtime", date: otDay, minutes: 60, reason: "again" }), /already/);
    assert.equal(await stepFor(tx, req.id, arjun), undefined, "the requester never gets their own step");
    const step = await stepFor(tx, req.id, rohan);
    assert.ok(step, "the manager has it in the inbox");
    await approvals.decide(tx, rohan, step!.step_id, "approved", "ok");
    const [day] = await tx<{ overtime_minutes: number }[]>`select overtime_minutes from attendance_days where employee_id = ${arjun.employeeId} and date = ${otDay}`;
    assert.equal(day.overtime_minutes, 120, "approved minutes count, capped by what was worked");
    const detail = await requests.requestDetail(tx, rohan, req.id);
    assert.equal(detail?.day?.overtime, 120);

    // a Saturday worked → comp-off (off-day rule), needs approval too
    await tx`insert into punches (tenant_id, employee_id, at, direction, source) values (${tenant.id}, ${arjun.employeeId}, ${ist(lastSat, "10:00")}, 'in', 'web'), (${tenant.id}, ${arjun.employeeId}, ${ist(lastSat, "16:30")}, 'out', 'web')`;
    const sat = await processAttendance(tx, tenant.id, arjun.employeeId, lastSat);
    assert.equal(sat?.day.status, "present");
    assert.equal(sat?.overtimeComputed, 390);
    const req2 = await requests.createRequest(tx, arjun, { kind: "overtime", date: lastSat, minutes: 390, reason: "Weekend release" });
    await approvals.decide(tx, rohan, (await stepFor(tx, req2.id, rohan))!.step_id, "approved");

    const m = month(otDay);
    const s1 = await overtime.settleOvertime(tx, tenant.id, m, asha);
    const mine = s1.lines.find((l) => l.employeeId === arjun.employeeId)!;
    assert.equal(mine.result, "updated");
    assert.ok(mine.amountPaise > 0, "paid overtime has an amount");
    const expectedHourly = Math.round(5750000 / 208);
    assert.equal(mine.amountPaise, Math.round((120 / 60) * expectedHourly * 2), "2 hours at double the basic hourly wage");
    const satInMonth = month(lastSat) === m;
    if (satInMonth) assert.equal(mine.compOffDays, 0.5, "390 min on an off day earns half a day of comp-off");
    const inputs = () => tx<{ id: string; amount_paise: bigint }[]>`select id, amount_paise from payroll_inputs where employee_id = ${arjun.employeeId} and kind = 'overtime'`;
    assert.equal((await inputs()).length, 1);
    const s2 = await overtime.settleOvertime(tx, tenant.id, m, asha);
    assert.equal(s2.lines.find((l) => l.employeeId === arjun.employeeId)!.result, "unchanged");
    assert.equal((await inputs()).length, 1, "re-running never duplicates the input");
    if (satInMonth) {
      const ledger = await tx<{ amount: string }[]>`select amount from leave_ledger where employee_id = ${arjun.employeeId} and kind = 'comp_off_credit' and ref_type = 'overtime_month'`;
      assert.equal(ledger.length, 1); assert.equal(Number(ledger[0].amount), 0.5);
    }
    const [sett] = await tx<{ minutes: number; mode: string }[]>`select minutes, mode from overtime_settlements where employee_id = ${arjun.employeeId} and month = ${m + "-01"}`;
    assert.ok(sett && sett.minutes >= 120);
    const [note] = await tx`select 1 from notifications where user_id = ${arjun.userId} and kind = 'attendance.overtime'`;
    assert.ok(note, "the person is told");
    const [mail] = await tx`select 1 from outbound_emails where kind = 'attendance.overtime' and status = 'queued'`;
    assert.ok(mail, "and emailed (default channels)");
    const rows = await overtime.overtimeMonth(tx, m);
    assert.ok(rows.find((r) => r.employeeId === arjun.employeeId)?.settled);

    // a finalised payroll month is never touched
    const payGroup = people.find((p) => p.first_name === "Arjun")!.pay_group_id;
    await tx`delete from payroll_runs where pay_group_id = ${payGroup} and period_month = ${m + "-01"}`;
    await tx`insert into payroll_runs (tenant_id, pay_group_id, period_month, status) values (${tenant.id}, ${payGroup}, ${m + "-01"}, 'finalized')`;
    await tx`update punches set at = ${ist(otDay, "22:00")} where employee_id = ${arjun.employeeId} and direction = 'out' and (at at time zone 'Asia/Kolkata')::date = ${otDay}::date`;
    const s3 = await overtime.settleOvertime(tx, tenant.id, m, asha);
    const l3 = s3.lines.find((l) => l.employeeId === arjun.employeeId)!;
    assert.equal(l3.result, "skipped"); assert.match(l3.why ?? "", /finalised/);
    assert.equal(Number((await inputs())[0].amount_paise), mine.amountPaise, "the locked input keeps its amount");
    await fails(overtime.settleOvertime(tx, tenant.id, addDaysISO(today, 40).slice(0, 7), asha), /hasn't started/);
  });
  ok("overtime is computed from punches, counts only once approved (never by the requester), settles into one payroll input / comp-off credit per month, re-runs are no-ops, finalised months are skipped");

  // ---------------------------------------------------------------- shift allowance
  await rolledBack(tenant.id, async (tx) => {
    const [night] = await tx<{ id: string }[]>`select id from shifts where code = 'NIGHT'`;
    const days = pastWorking.slice(-2);
    await roster.saveRoster(tx, asha, days.map((date) => ({ employeeId: arjun.employeeId, date, value: night.id })));
    for (const d of days) {
      const [row] = await tx<{ shift_id: string; status: string }[]>`select shift_id, status from attendance_days where employee_id = ${arjun.employeeId} and date = ${d}`;
      assert.equal(row.shift_id, night.id, "the roster shift is what the day was processed with");
    }
    // the night window moves the day's punches (09:xx–18:xx fall before the night shift opens), so give him night punches
    for (const d of days) await tx`insert into punches (tenant_id, employee_id, at, direction, source) values (${tenant.id}, ${arjun.employeeId}, ${ist(d, "22:00")}, 'in', 'web'), (${tenant.id}, ${arjun.employeeId}, ${ist(addDaysISO(d, 1), "06:05")}, 'out', 'web')`;
    for (const d of days) await processAttendance(tx, tenant.id, arjun.employeeId, d);
    const m = month(days[0]);
    const a1 = await overtime.settleShiftAllowance(tx, tenant.id, m, asha);
    const line = a1.lines.find((l) => l.employeeId === arjun.employeeId)!;
    const inMonth = days.filter((d) => month(d) === m).length;
    assert.equal(line.days, inMonth); assert.equal(line.amountPaise, inMonth * 20000); assert.equal(line.result, "updated");
    const a2 = await overtime.settleShiftAllowance(tx, tenant.id, m, asha);
    assert.equal(a2.lines.find((l) => l.employeeId === arjun.employeeId)!.result, "unchanged");
    assert.equal((await tx`select 1 from payroll_inputs where employee_id = ${arjun.employeeId} and kind = 'shift_allowance'`).length, 1);
  });
  ok("shift allowances: days worked on the allowance's shifts become one payroll input per month, idempotently");

  // ---------------------------------------------------------------- roster: scopes, processing, locks, rotations
  await rolledBack(tenant.id, async (tx) => {
    const [night] = await tx<{ id: string }[]>`select id from shifts where code = 'NIGHT'`;
    const week = await roster.rosterWeek(tx, priyaScoped, today);
    assert.ok(week.people.length >= 1 && week.people.every((p) => p.department === "People"), "a scoped admin sees only their people");
    await fails(roster.saveRoster(tx, priyaScoped, [{ employeeId: divya.id, date: nextWorking(), value: night.id }]), /can't roster/, "forbidden");
    await fails(roster.saveRoster(tx, asha, [{ employeeId: arjun.employeeId, date: addDaysISO(today, 400), value: night.id }]), /year ahead/);
    await fails(roster.saveRoster(tx, asha, [{ employeeId: arjun.employeeId, date: nextWorking(), value: randomUUID() }]), /no longer exists/);
    // "off" on a working day → weekly off for attendance; a shift on a Saturday → working day
    const d = pastWorking[pastWorking.length - 2];
    const r = await roster.saveRoster(tx, asha, [{ employeeId: arjun.employeeId, date: d, value: "off" }, { employeeId: arjun.employeeId, date: lastSat, value: night.id }]);
    assert.equal(r.changed, 2);
    const typeOn = await calendarFor(tx, arjun.employeeId, d < lastSat ? d : lastSat, d < lastSat ? lastSat : d);
    assert.equal(typeOn(d), "weekly_off"); assert.equal(typeOn(lastSat), "working");
    const shiftOn = await shiftsFor(tx, arjun.employeeId, lastSat, lastSat);
    assert.equal(shiftOn(lastSat)?.id, night.id);
    const [row] = await tx<{ day_type: string }[]>`select day_type from attendance_days where employee_id = ${arjun.employeeId} and date = ${d}`;
    assert.equal(row.day_type, "weekly_off", "past days are re-processed with the roster");
    const [note] = await tx`select 1 from notifications where user_id = ${arjun.userId} and kind = 'attendance.roster'`;
    assert.equal(note, undefined, "no notification for past-only changes");
    // clearing goes back to the regular assignment
    await roster.saveRoster(tx, asha, [{ employeeId: arjun.employeeId, date: d, value: null }]);
    assert.equal((await calendarFor(tx, arjun.employeeId, d, d))(d), "working");
    // a locked day is skipped
    await tx`update attendance_days set is_locked = true where employee_id = ${arjun.employeeId} and date = ${oldDay}`;
    const r2 = await roster.saveRoster(tx, asha, [{ employeeId: arjun.employeeId, date: oldDay, value: "off" }]);
    assert.equal(r2.changed, 0); assert.equal(r2.skippedLocked, 1);
    // rotation, with a future notification
    const r3 = await roster.applyRotation(tx, asha, { employeeIds: [arjun.employeeId, vikram.employeeId], rotation: { kind: "cycle", sequence: [night.id, night.id, "off"] }, start: nextWorking(), days: 6 });
    assert.equal(r3.changed, 12);
    assert.ok(await tx`select 1 from notifications where user_id = ${arjun.userId} and kind = 'attendance.roster'`.then((x) => x.length === 1));
    await fails(roster.applyRotation(tx, asha, { employeeIds: [arjun.employeeId], rotation: { kind: "weekly", week: [null, null, null, null, null, null, null] }, start: today, days: 7 }), /at least one/);
    const board = await roster.rosterWeek(tx, asha, nextWorking());
    const cell = board.people.find((p) => p.id === arjun.employeeId)!.cells[nextWorking()];
    assert.equal(cell.source, "roster"); assert.equal(cell.value, night.id);
  });
  ok("roster: scoped writes, off/shift overrides feed attendance processing, locked days are skipped, rotations expand and notify");

  // ---------------------------------------------------------------- shift change + weekly-off swap requests
  await rolledBack(tenant.id, async (tx) => {
    const [night] = await tx<{ id: string }[]>`select id from shifts where code = 'NIGHT'`;
    const [gen] = await tx<{ id: string }[]>`select id from shifts where code = 'GEN'`;
    const d1 = nextWorking();
    await fails(requests.createRequest(tx, arjun, { kind: "shift_change", from: oldDay, to: oldDay, shiftId: night.id, reason: "x" }), /today or later/);
    await fails(requests.createRequest(tx, arjun, { kind: "shift_change", from: nextSat, to: nextSat, shiftId: night.id, reason: "x" }), /weekly off or holiday/);
    await fails(requests.createRequest(tx, arjun, { kind: "shift_change", from: d1, to: d1, shiftId: gen.id, reason: "x" }), /already your shift/);
    await fails(requests.createRequest(tx, arjun, { kind: "shift_change", from: addDaysISO(today, 45), to: addDaysISO(today, 45), shiftId: night.id, reason: "x" }), /30 days ahead/);
    const req = await requests.createRequest(tx, arjun, { kind: "shift_change", from: d1, to: d1, shiftId: night.id, reason: "Covering the night desk" });
    assert.equal(req.status, "pending");
    await fails(requests.createRequest(tx, arjun, { kind: "shift_change", from: d1, to: d1, shiftId: night.id, reason: "dup" }), /already have a shift change/);
    const allowance = await requests.requestAllowance(tx, arjun.employeeId, today);
    assert.equal(allowance.shiftChange.used, 1); assert.equal(allowance.shiftChange.maxPerMonth, 2);
    await approvals.decide(tx, rohan, (await stepFor(tx, req.id, rohan))!.step_id, "approved");
    const [entry] = await tx<{ shift_id: string }[]>`select shift_id from roster_entries where employee_id = ${arjun.employeeId} and date = ${d1}`;
    assert.equal(entry.shift_id, night.id, "approval puts the shift on the roster");
    assert.equal((await shiftsFor(tx, arjun.employeeId, d1, d1))(d1)?.id, night.id);
    // swap a weekly off: take d2 off, work next Saturday
    const d2 = nextWorking(d1);
    const sameMonth = month(d2) === month(nextSat);
    if (sameMonth) {
      await fails(requests.createRequest(tx, arjun, { kind: "weekly_off_change", offDate: nextSat, workDate: d2, reason: "x" }), /weekly offs/);
      const swap = await requests.createRequest(tx, arjun, { kind: "weekly_off_change", offDate: d2, workDate: nextSat, reason: "Family function" });
      await approvals.decide(tx, rohan, (await stepFor(tx, swap.id, rohan))!.step_id, "approved");
      const typeOn = await calendarFor(tx, arjun.employeeId, d2, nextSat);
      assert.equal(typeOn(d2), "weekly_off"); assert.equal(typeOn(nextSat), "working");
      // the monthly cap (2) is now used up
      const d3 = nextWorking(d2);
      await fails(requests.createRequest(tx, arjun, { kind: "shift_change", from: d3, to: d3, shiftId: night.id, reason: "x" }), /all 2/);
    }
    const mine = await requests.myRequests(tx, arjun.employeeId);
    assert.ok(mine.some((r) => r.kind === "shift_change" && r.status === "approved"));
    assert.match(requests.describe("shift_change", d1, d1, { shiftName: "Night (NIGHT)" }), /Shift change .* to Night/);
  });
  ok("shift-change and weekly-off-swap requests follow the rule (window, cap, off days), go through the manager and land on the roster");

  // ---------------------------------------------------------------- devices + ingest
  const otherId = randomUUID();
  await admin`insert into tenants (id, subdomain, name) values (${otherId}, ${"smoke-" + otherId.slice(0, 8)}, 'Smoke Co')`;
  try {
    let keyForOther = "";
    await rolledBack(tenant.id, async (tx) => {
      const { id, key } = await devices.createDevice(tx, asha, { name: "Gate A", serial: "GA-1", vendor: "zkteco", locationId: null });
      keyForOther = key;
      await fails(devices.createDevice(tx, asha, { name: "Gate B", serial: "GA-1", vendor: "zkteco", locationId: null }), /serial/, "conflict");
      const parsed = parseDeviceKey(key)!;
      assert.equal(parsed.deviceId, id);
      const dev = await devices.authenticateDevice(tx, key);
      assert.equal(dev?.id, id);
      assert.equal(await devices.authenticateDevice(tx, formatDeviceKey(id, "x".repeat(43))), null, "wrong secret");
      assert.equal(await devices.authenticateDevice(tx, "nonsense"), null);
      const [stored] = await tx<{ api_key_hash: string }[]>`select api_key_hash from devices where id = ${id}`;
      assert.ok(!stored.api_key_hash.includes(parsed.secret), "only a hash is stored");
      const emp = people.find((p) => p.first_name === "Arjun")!;
      const y = pastWorking[0];
      const batch = [
        { employee: emp.employee_number, at: ist(y, "09:02").toISOString(), direction: "in" as const, external_id: "ga1-1" },
        { employee: emp.employee_number, at: ist(y, "19:10").toISOString(), direction: "out" as const, external_id: "ga1-2" },
        { employee: "NOPE-1", at: ist(y, "09:02").toISOString(), direction: "in" as const, external_id: "ga1-3" },
        { employee: emp.employee_number, at: new Date(Date.now() - 60 * 864e5).toISOString(), direction: "in" as const, external_id: "ga1-4" },
      ];
      const r1 = await devices.ingestPunches(tx, dev!, batch);
      assert.deepEqual([r1.accepted, r1.duplicates, r1.unknown, r1.rejected.length, r1.processedDays], [2, 0, ["NOPE-1"], 1, 1]);
      const r2 = await devices.ingestPunches(tx, dev!, batch);
      assert.equal(r2.accepted, 0); assert.equal(r2.duplicates, 2);
      const rows = await tx<{ source: string; device_id: string }[]>`select source, device_id from punches where external_id like 'ga1-%'`;
      assert.equal(rows.length, 2); assert.ok(rows.every((r) => r.source === "biometric" && r.device_id === id));
      const [day] = await tx<{ first_in: Date; last_out: Date }[]>`select first_in, last_out from attendance_days where employee_id = ${emp.id} and date = ${y}`;
      assert.equal(day.first_in.toISOString(), ist(y, "09:02").toISOString(), "the day was re-processed with the device punch");
      assert.equal(day.last_out.toISOString(), ist(y, "19:10").toISOString());
      const list = await devices.listDevices(tx, today);
      assert.ok(list.find((d) => d.id === id)?.online);
      const rotated = await devices.rotateDeviceKey(tx, asha, id);
      assert.equal(await devices.authenticateDevice(tx, key), null, "the old key stops working");
      assert.equal((await devices.authenticateDevice(tx, rotated.key))?.id, id);
      await devices.deleteDevice(tx, asha, id);
      assert.equal((await tx`select 1 from punches where external_id like 'ga1-%'`).length, 2, "punches survive the device");
      // the same key means nothing on another tenant (RLS: the device row isn't visible there)
      assert.equal(await withTenant(otherId, (sp) => devices.authenticateDevice(sp, keyForOther)), null);
    });
    ok("devices: hashed keys shown once, wrong/old keys refused, batches idempotent by external id, unknown people reported, days re-processed, keys don't cross tenants");

    // ---------------------------------------------------------------- notification settings, emails, announcements, digest
    await rolledBack(tenant.id, async (tx) => {
      await fails(setNotificationChannels(tx, arjun, "approval.pending", ["email"]), /access/, "forbidden");
      await fails(setNotificationChannels(tx, asha, "made.up", ["email"]), /Unknown/, "invalid");
      assert.deepEqual(await setNotificationChannels(tx, asha, "approvals.digest", ["in_app", "email"]), ["email"], "digest stays email-only");
      await setNotificationChannels(tx, asha, "approval.pending", ["in_app"]);
      const before = (await tx<{ n: number }[]>`select count(*)::int as n from outbound_emails`)[0].n;
      const r1 = await notify(tx, tenant.id, [arjun.employeeId], "approval.pending", "Test", "body", "/inbox");
      assert.deepEqual(r1, { inApp: 1, emails: 0 });
      await setNotificationChannels(tx, asha, "approval.pending", ["email"]);
      const r2 = await notify(tx, tenant.id, [arjun.employeeId, vikram.employeeId], "approval.pending", "Test 2", "body", "/inbox");
      assert.deepEqual(r2, { inApp: 0, emails: 2 });
      const after = (await tx<{ n: number }[]>`select count(*)::int as n from outbound_emails`)[0].n;
      assert.equal(after - before, 2);
      const [mail] = await tx<{ to_email: string; subject: string; html: string }[]>`select to_email, subject, html from outbound_emails where kind = 'approval.pending' order by created_at desc limit 1`;
      assert.match(mail.subject, /Test 2/); assert.match(mail.html, /acme\./);
      await setNotificationChannels(tx, asha, "approval.pending", []);
      assert.deepEqual(await notify(tx, tenant.id, [arjun.employeeId], "approval.pending", "Silent", "body", "/inbox"), { inApp: 0, emails: 0 });
      // an unknown kind is in-app only by default
      assert.deepEqual(await notify(tx, tenant.id, [arjun.employeeId], "helpdesk.note", "x", "y", "/me"), { inApp: 1, emails: 0 });
      // decisions flow through the same switch: leave decision → request.approved respects settings
      await setNotificationChannels(tx, asha, "request.approved", ["in_app", "email"]);
      const req = await requests.createRequest(tx, vikram, { kind: "wfh", from: nextWorking(), to: nextWorking(), half: null, reason: "Plumber" });
      const mailsBefore = (await tx<{ n: number }[]>`select count(*)::int as n from outbound_emails where kind = 'request.approved'`)[0].n;
      await approvals.decide(tx, rohan, (await stepFor(tx, req.id, rohan))!.step_id, "approved");
      const mailsAfter = (await tx<{ n: number }[]>`select count(*)::int as n from outbound_emails where kind = 'request.approved'`)[0].n;
      assert.equal(mailsAfter - mailsBefore, 1, "the requester is emailed about the decision");
      // announcements email their audience
      await tx`insert into posts (tenant_id, author_employee_id, kind, audience, title, body, publish_at) values (${tenant.id}, ${asha.employeeId}, 'announcement', ${tx.json({ type: "org" })}, 'Office closed Friday', 'Diwali', now() - interval '1 minute')`;
      const pub = await publishDue(tx, tenant.id);
      assert.ok(pub.posts >= 1);
      const ann = (await tx<{ n: number }[]>`select count(*)::int as n from outbound_emails where kind = 'engage.announcement' and subject like 'Office closed Friday%'`)[0].n;
      const [{ active }] = await tx<{ active: number }[]>`select count(*)::int as active from employees e join users u on u.id = e.user_id and u.status = 'active' where e.status <> 'relieved'`;
      assert.equal(ann, active - 1, "every active account but the author gets the announcement email");
      // digest: one email per approver with pending items, once a day
      await tx`delete from outbound_emails where kind = 'approvals.digest'`;   // pnpm jobs:daily may already have sent today's
      const d1 = await digestIn(tx, tenant.id);
      assert.ok(d1.approvers >= 1 && d1.sent >= 1, "Rohan has pending items from the seed");
      const d2 = await digestIn(tx, tenant.id);
      assert.equal(d2.sent, 0); assert.equal(d2.skipped, d1.sent);
      const [dg] = await tx<{ subject: string; text_body: string }[]>`select subject, text_body from outbound_emails where kind = 'approvals.digest' limit 1`;
      assert.match(dg.subject, /waiting for you/); assert.match(dg.text_body, /inbox/i);
      await setNotificationChannels(tx, asha, "approvals.digest", []);
      await tx`delete from outbound_emails where kind = 'approvals.digest'`;
      assert.equal((await digestIn(tx, tenant.id)).sent, 0, "switched off, nothing is sent");
    });
    ok("notification settings drive in-app vs email per event (approvals, decisions, announcements); the daily digest is per approver and once a day");

    // ---------------------------------------------------------------- tenant isolation
    const [c] = await withTenant(otherId, (tx) => tx<Record<string, number>[]>`
      select (select count(*)::int from overtime_policies) as policies, (select count(*)::int from pay_codes) as codes, (select count(*)::int from shift_allowance_policies) as allowances,
             (select count(*)::int from shift_rules) as rules, (select count(*)::int from devices) as devices, (select count(*)::int from roster_entries) as roster,
             (select count(*)::int from notification_settings) as settings, (select count(*)::int from overtime_settlements) as settlements`);
    assert.deepEqual(c, { policies: 0, codes: 0, allowances: 0, rules: 0, devices: 0, roster: 0, settings: 0, settlements: 0 });
    await assert.rejects(withTenant(otherId, (tx) => tx`insert into roster_entries (tenant_id, employee_id, date) values (${tenant.id}, ${arjun.employeeId}, ${today})`), /row-level security/);
    assert.equal((await withTenant(otherId, (tx) => tx`update devices set name = 'pwned' where tenant_id = ${tenant.id} returning id`)).length, 0);
    assert.deepEqual(await withTenant(otherId, (tx) => overtime.overtimeMonth(tx, month(today))), []);
    ok("another tenant sees none of Acme's overtime, pay codes, devices, roster, rules or settings and can't write into them");
  } finally {
    await admin`delete from tenants where id = ${otherId}`;
  }
  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await admin.end(); await sql.end(); }).catch(async (e) => { console.error("\nFAILED:", e); await admin.end(); await sql.end(); process.exit(1); });
