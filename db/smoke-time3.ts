/**
 * End-to-end checks for time3 against the seeded demo tenant (run `pnpm db:seed` first): applying leave on behalf,
 * the employee's view of the approval chain, event-based grants, accrual stop rules, the generated policy document,
 * holiday and assignment Excel imports, selfie + first-device clock-in approval, the ADMS push endpoints, the in-app
 * scheduler's shared daily run, and tenant isolation. Everything that can be runs in rolled-back transactions.
 *   pnpm smoke:time3
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import ExcelJS from "exceljs";
import { withTenant, sql, AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import type { Scope } from "@/server/auth/catalog";
import { addDaysISO, todayIn, weekday } from "@/lib/dates";
import * as approvals from "@/server/modules/approvals/service";
import * as leave from "@/server/modules/leave/service";
import * as grants from "@/server/modules/leave/grants";
import { runAccrual, runLeaveJobs } from "@/server/modules/leave/accrual";
import { cycleStartFor } from "@/server/modules/leave/effects";
import { describeRule, policyFor, policyPdf } from "@/server/modules/leave/policy-doc";
import { buildHolidayTemplate, commitHolidayImport, previewHolidayImport } from "@/server/modules/leave/holidays-import";
import * as policies from "@/server/modules/attendance/policies";
import * as attendance from "@/server/modules/attendance/service";
import * as requests from "@/server/modules/attendance/requests";
import * as devices from "@/server/modules/attendance/devices";
import { buildAssignmentTemplate, commitAssignmentImport, previewAssignmentImport } from "@/server/modules/attendance/assignments-import";
import { attlogToPunches, parseAttlog } from "@/server/modules/attendance/adms-rules";
import { fileFor } from "@/server/modules/documents/service";
import { runDaily } from "@/server/modules/corehr/daily-run";
import { GET as admsHandshake, POST as admsPush } from "@/app/iclock/cdata/route";
import { GET as admsPoll } from "@/app/iclock/getrequest/route";
import { DEMO_SUBDOMAIN } from "./demo";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const ROLLBACK = "rollback";
const rolledBack = async (tenantId: string, fn: (tx: Tx) => Promise<void>) =>
  withTenant(tenantId, async (tx) => { await fn(tx); throw new Error(ROLLBACK); }).catch((e) => { if (e.message !== ROLLBACK) throw e; });
const working = (d: string) => !["sat", "sun"].includes(weekday(d));
const fails = async (p: Promise<unknown>, re: RegExp, code?: AppError["code"]) => {
  const e = await p.then(() => null, (x) => x);
  assert.ok(e instanceof AppError, `expected an AppError, got ${e}`);
  assert.match(e.message, re);
  if (code) assert.equal(e.code, code);
};
const xlsx = async (sheet: string, header: string[], rows: unknown[][]) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  ws.addRow(header);
  for (const r of rows) ws.addRow(r);
  return wb.xlsx.writeBuffer() as Promise<ArrayBuffer>;
};
const selfie = () => { const b = Buffer.alloc(700, 0); b[0] = 0xff; b[1] = 0xd8; b[698] = 0xff; b[699] = 0xd9; return `data:image/jpeg;base64,${b.toString("base64")}`; };

async function main() {
  const [t] = await sql<{ id: string }[]>`select id from tenant_by_subdomain(${DEMO_SUBDOMAIN})`;
  assert.ok(t, "demo tenant exists (run pnpm db:seed)");
  const tenant = { id: t.id, name: "Acme Technologies", status: "trial", subdomain: DEMO_SUBDOMAIN };
  const people = await withTenant(tenant.id, (tx) => tx<{ id: string; user_id: string; display_name: string; first_name: string; department_id: string; employee_number: string; manager_id: string | null; leave_plan_id: string }[]>`
    select id, user_id, display_name, first_name, department_id, employee_number, manager_id, leave_plan_id from employees`);
  const P = Object.fromEntries(people.map((p) => [p.first_name, p]));
  const actor = (first: string, perms: string[] = [], scopes: Scope[] = []): Actor => {
    const e = P[first];
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(perms), grants: perms.length ? [{ permissions: perms, scopes }] : [] };
  };
  const asha = actor("Asha", ["*"]), rohan = actor("Rohan"), arjun = actor("Arjun"), divya = actor("Divya"), priya = actor("Priya");
  const priyaScoped = actor("Priya", ["leave.admin", "attendance.admin"], [{ type: "department", ids: [P.Divya.department_id] }]);   // Operations only
  const today = todayIn();
  const nextWorking = (from = today) => { let d = addDaysISO(from, 1); while (!working(d)) d = addDaysISO(d, 1); return d; };
  const cl = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from leave_types where code = 'CL'`).then((r) => r[0].id);
  const ml = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from leave_types where code = 'MRG'`).then((r) => r[0].id);
  const stepFor = async (tx: Tx, entityId: string, who: Actor) => (await approvals.inbox(tx, who)).find((i) => i.entity_id === entityId);

  // ---------------------------------------------------------------- apply on behalf
  await rolledBack(tenant.id, async (tx) => {
    const d1 = nextWorking(addDaysISO(today, 20)), d2 = nextWorking(d1);
    const base = { leaveTypeId: cl, from: d1, to: d2, fromPart: "full" as const, toPart: "full" as const };
    await fails(leave.applyOnBehalf(tx, rohan, P.Arjun.id, base), /note/, "invalid");
    await fails(leave.applyOnBehalf(tx, rohan, P.Rohan.id, { ...base, note: "me" }), /own leave/, "invalid");
    await fails(leave.applyOnBehalf(tx, arjun, P.Meera.id, { ...base, note: "peer" }), /can't apply/, "forbidden");
    await fails(leave.applyOnBehalf(tx, priyaScoped, P.Arjun.id, { ...base, note: "outside my scope" }), /can't apply/, "forbidden");
    // Rohan is Arjun's manager and the approver: applying approves his own step as he goes
    const r = await leave.applyOnBehalf(tx, rohan, P.Arjun.id, { ...base, note: "Called in from the hospital, asked me to apply" });
    assert.equal(r.status, "approved"); assert.equal(r.employee, P.Arjun.display_name);
    const [row] = await tx<{ status: string; applied_by: string; employee_id: string }[]>`select status, applied_by, employee_id from leave_requests where id = ${r.id}`;
    assert.equal(row.status, "approved"); assert.equal(row.applied_by, rohan.userId); assert.equal(row.employee_id, P.Arjun.id);
    const steps = await approvals.timeline(tx, "leave", r.id);
    assert.equal(steps.length, 1); assert.equal(steps[0].status, "approved"); assert.equal(steps[0].approver, P.Rohan.display_name); assert.equal(steps[0].comment, "Applied on their behalf");
    const [ledger] = await tx`select 1 from leave_ledger where ref_id = ${r.id} and kind = 'use'`;
    assert.ok(ledger, "the days are debited");
    const [audit] = await tx<{ diff: { note: string } }[]>`select diff from audit_logs where entity_type = 'leave_request' and entity_id = ${r.id} and action = 'leave.apply_on_behalf'`;
    assert.ok(audit && audit.diff.note.includes("hospital"), "audited with the note");
    const [note] = await tx<{ body: string }[]>`select body from notifications where user_id = ${P.Arjun.user_id} and kind = 'leave.on_behalf'`;
    assert.ok(note && /approved/.test(note.body), "the person is told");
    const mine = (await leave.myRequests(tx, P.Arjun.id)).find((x) => x.id === r.id)!;
    assert.equal(mine.applied_by_name, P.Rohan.display_name, "the request says who applied");
    // HR (company-wide) applies for Karan: Karan's manager Asha is the approver, HR isn't, so it stays pending for Asha
    const hr = actor("Priya", ["leave.admin"]);
    const r2 = await leave.applyOnBehalf(tx, hr, P.Karan.id, { ...base, from: nextWorking(d2), to: nextWorking(d2), note: "Family emergency" });
    assert.equal(r2.status, "pending");
    assert.ok(await stepFor(tx, r2.id, asha), "the manager still reviews it");
    assert.ok(await stepFor(tx, r2.id, priya) === undefined);
    const candidates = await leave.onBehalfCandidates(tx, rohan);
    assert.ok(candidates.some((c) => c.id === P.Arjun.id && c.why === "report") && !candidates.some((c) => c.id === P.Rohan.id));
  });
  ok("apply on behalf: manager or scoped leave admin, note required, audited, person notified, applier's own step approved, others still review");

  // ---------------------------------------------------------------- event-based grants
  await rolledBack(tenant.id, async (tx) => {
    const win0 = nextWorking(addDaysISO(today, 30)), win1 = addDaysISO(win0, 20);
    await fails(grants.grantLeave(tx, asha, { employeeId: P.Asha.id, leaveTypeId: ml, event: "Wedding", days: 2, validFrom: win0, validTo: win1 }), /yourself/, "forbidden");
    await fails(grants.grantLeave(tx, priyaScoped, { employeeId: P.Arjun.id, leaveTypeId: ml, event: "Wedding", days: 2, validFrom: win0, validTo: win1 }), /can't grant/, "forbidden");
    await fails(grants.grantLeave(tx, asha, { employeeId: P.Arjun.id, leaveTypeId: cl, event: "Wedding", days: 2, validFrom: win0, validTo: win1 }), /event-based/, "invalid");
    await fails(grants.grantLeave(tx, asha, { employeeId: P.Arjun.id, leaveTypeId: ml, event: "Wedding", days: 2, validFrom: win1, validTo: win0 }), /before it starts/, "invalid");
    // before a grant: the type is in the plan but there's nothing to draw on
    const none = await leave.preview(tx, P.Arjun.id, { leaveTypeId: ml, from: win0, to: win0, fromPart: "full", toPart: "full" });
    assert.ok(none.violations.some((v) => v.code === "grant" && v.blocking && /Ask HR/.test(v.message)));
    const g = await grants.grantLeave(tx, asha, { employeeId: P.Arjun.id, leaveTypeId: ml, event: "Wedding", days: 3, validFrom: win0, validTo: win1, note: "Best wishes" });
    const bal = (await leave.balances(tx, P.Arjun.id)).find((b) => b.id === ml)!;
    assert.equal(bal.unlimited, false); assert.equal(bal.credited, 3); assert.equal(bal.available, 3);
    const [note] = await tx`select 1 from notifications where user_id = ${P.Arjun.user_id} and kind = 'leave.adjusted' and title like 'Marriage leave%'`;
    assert.ok(note);
    // outside the window / too many days / inside and within
    const outside = await leave.preview(tx, P.Arjun.id, { leaveTypeId: ml, from: addDaysISO(win1, 1), to: addDaysISO(win1, 2), fromPart: "full", toPart: "full" });
    assert.ok(outside.violations.some((v) => v.code === "grant" && /doesn't cover/.test(v.message)));
    const tooMany = await leave.preview(tx, P.Arjun.id, { leaveTypeId: ml, from: win0, to: addDaysISO(win0, 6), fromPart: "full", toPart: "full" });
    assert.ok(tooMany.violations.some((v) => v.code === "grant" && /left of this grant/.test(v.message)));
    const r = await leave.apply(tx, arjun, { leaveTypeId: ml, from: win0, to: addDaysISO(win0, 1), fromPart: "full", toPart: "full" });
    const [req] = await tx<{ grant_id: string }[]>`select grant_id from leave_requests where id = ${r.id}`;
    assert.equal(req.grant_id, g.id, "the request draws on the grant");
    const [mine] = (await grants.myGrants(tx, P.Arjun.id)).filter((x) => x.id === g.id);
    assert.ok(mine.used >= 1, "used days show on the grant");
    assert.ok((await grants.listGrants(tx, asha)).some((x) => x.id === g.id));
    await fails(grants.listGrants(tx, arjun), /access/, "forbidden");
    assert.equal((await grants.listGrants(tx, priyaScoped)).some((x) => x.id === g.id), false, "scoped admins see only their people");
    // withdrawing returns what's left; lapsing after the window does the same via the nightly job, once
    const c = await grants.cancelGrant(tx, asha, g.id);
    assert.equal(c.left, 3 - mine.used);
    await fails(grants.cancelGrant(tx, asha, g.id), /already closed/, "invalid");
    const g2 = await grants.grantLeave(tx, asha, { employeeId: P.Meera.id, leaveTypeId: ml, event: "Bereavement", days: 2, validFrom: today, validTo: today });
    const l1 = await grants.lapseExpiredGrants(tx, tenant.id, addDaysISO(today, 1));
    assert.equal(l1.lapsed, 1); assert.equal(l1.days, 2);
    const l2 = await grants.lapseExpiredGrants(tx, tenant.id, addDaysISO(today, 1));
    assert.equal(l2.lapsed, 0, "idempotent");
    const [lapsed] = await tx<{ status: string }[]>`select status from leave_grants where id = ${g2.id}`;
    assert.equal(lapsed.status, "lapsed");
    const jobs = await runLeaveJobs(tx, tenant.id, addDaysISO(today, 1));
    assert.equal(jobs.grants.lapsed, 0, "the nightly job runs the same step");
  });
  ok("event-based grants: HR grants per event inside their scope, requests consume the grant within its window, withdraw and lapse post to the ledger once");

  // ---------------------------------------------------------------- accrual stop rules
  await rolledBack(tenant.id, async (tx) => {
    const [plan] = await tx<{ id: string }[]>`select id from leave_plans where is_default`;
    const who = people.find((p) => p.leave_plan_id === plan.id && p.first_name !== "Asha")!;
    const cycle = await cycleStartFor(tx, who.id, today);   // the cap looks at this leave year's balance, like the balances screen
    const [{ balance }] = await tx<{ balance: string }[]>`select coalesce(sum(amount), 0) as balance from leave_ledger where employee_id = ${who.id} and leave_type_id = ${cl} and cycle_start = ${cycle}`;
    await tx`update leave_plan_rules r set accrual = r.accrual || ${tx.json({ cap_balance: Number(balance) })} where r.leave_plan_id = ${plan.id} and r.leave_type_id = ${cl}`;
    const nextMonth = addDaysISO(today.slice(0, 8) + "01", 32).slice(0, 8) + "01";
    const r1 = await runAccrual(tx, tenant.id, addDaysISO(nextMonth, 2), { employeeIds: [who.id] });
    const rows = await tx<{ kind: string; amount: string; note: string }[]>`select kind, amount, note from leave_ledger where employee_id = ${who.id} and leave_type_id = ${cl} and idempotency_key like ${`accrual:${who.id}:${cl}:${nextMonth.slice(0, 7)}%`} order by kind`;
    assert.equal(rows.length, 2, "the accrual and the withheld part");
    const acc = rows.find((r) => r.kind === "accrual")!, lapse = rows.find((r) => r.kind === "lapse")!;
    assert.equal(Number(acc.amount) + Number(lapse.amount), 0, "nothing net: the balance sits at the cap");
    assert.match(lapse.note, /at the cap/);
    assert.ok(r1.posted >= 1);   // (a top-up of last leave year may post too; it has no cap entry of its own)
    const r2 = await runAccrual(tx, tenant.id, addDaysISO(nextMonth, 2), { employeeIds: [who.id] });
    assert.equal(r2.posted, 0, "re-running posts nothing more");
    const [{ after }] = await tx<{ after: string }[]>`select coalesce(sum(amount), 0) as after from leave_ledger where employee_id = ${who.id} and leave_type_id = ${cl} and cycle_start = ${cycle}`;
    assert.equal(Number(after), Number(balance));
    // stop after N taken: with a limit above what's taken the credit goes through
    await tx`update leave_plan_rules r set accrual = r.accrual || ${tx.json({ cap_balance: null, stop_after_days_taken: 0 })} where r.leave_plan_id = ${plan.id} and r.leave_type_id = ${cl}`;
    const month2 = addDaysISO(nextMonth, 32).slice(0, 8) + "01";
    await runAccrual(tx, tenant.id, addDaysISO(month2, 2), { employeeIds: [who.id] });
    const [w] = await tx<{ note: string }[]>`select note from leave_ledger where employee_id = ${who.id} and leave_type_id = ${cl} and idempotency_key = ${`accrual:${who.id}:${cl}:${month2.slice(0, 7)}:withheld`}`;
    assert.ok(w && /already taken/.test(w.note), "stop-after-taken withholds with its own reason");
  });
  ok("accrual stop rules: balance cap and stop-after-days-taken withhold credit visibly, idempotently");

  // ---------------------------------------------------------------- policy document
  await withTenant(tenant.id, async (tx) => {
    const [plan] = await tx<{ id: string }[]>`select id from leave_plans where is_default`;
    const doc = (await policyFor(tx, plan.id, today))!;
    assert.ok(doc.sections.length >= 5);
    const clSec = doc.sections.find((s) => s.code === "CL")!;
    assert.ok(clSec.lines.some((l) => /12 days a leave year, credited every month/.test(l)));
    const mlSec = doc.sections.find((s) => s.code === "MRG")!;
    assert.ok(mlSec.lines.some((l) => /granted by HR for a specific event/.test(l)));
    const el = doc.sections.find((s) => s.code === "EL")!;
    assert.ok(el.lines.some((l) => /up to 30 days carry forward/.test(l) && /encashed/.test(l)));
    assert.ok(el.lines.some((l) => /Apply at least 7 days/.test(l) && /count as leave/.test(l)));
    assert.ok(doc.holidays.length >= 2, "both holiday lists are described");
    const lines = describeRule({ leave_type_id: "x", name: "Test", code: "T", kind: "regular", color: "", is_paid: true, yearly_quota: "10", accrual: { frequency: "quarterly", cap_balance: 20, stop_after_days_taken: 5 }, application: { allowHalfDay: true }, year_end: { carry: "none" }, approval: { levels: [{ approver: "manager" }, { approver: "role", role: "hr_admin" }] } });
    assert.ok(lines.some((l) => /every quarter/.test(l)) && lines.some((l) => /reaches 20 days/.test(l) && /after 5 days have been taken/.test(l)) && lines.some((l) => /reporting manager, then 2\. someone holding the role hr_admin/.test(l)));
    const pdf = await policyPdf(doc);
    assert.equal(Buffer.from(pdf.slice(0, 5)).toString(), "%PDF-");
    assert.equal(await policyFor(tx, randomUUID(), today), null);
  });
  ok("policy document: plain-English sections generated from the plan rules, and a PDF of the same");

  // ---------------------------------------------------------------- holiday Excel import
  await rolledBack(tenant.id, async (tx) => {
    const year = Number(today.slice(0, 4));
    await fails(buildHolidayTemplate(tx, priyaScoped, year), /whole company/, "forbidden");
    const tpl = await buildHolidayTemplate(tx, asha, year);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(tpl.buffer.slice(tpl.byteOffset, tpl.byteOffset + tpl.byteLength) as ArrayBuffer);
    assert.ok(wb.getWorksheet("Holidays")!.rowCount > 5, "pre-filled with this year's lists");
    const header = ["Holiday list", "Year", "Date", "Name", "Optional", "Description"];
    const bad = await xlsx("Holidays", header, [["Chennai office", year, `${year + 1}-01-15`, "Pongal", "no", ""], ["", year, `${year}-01-26`, "Republic Day", "no", ""], ["Chennai office", year, "sometime", "Diwali", "maybe", ""]]);
    const p1 = await previewHolidayImport(tx, asha, bad);
    assert.equal(p1.valid, false);
    assert.ok(p1.results[0].errors.some((e) => /isn't in/.test(e)) && p1.results[1].errors.some((e) => /empty/.test(e)) && p1.results[2].errors.some((e) => /Date must/.test(e)) && p1.results[2].errors.some((e) => /yes or no/.test(e)));
    await fails(commitHolidayImport(tx, asha, bad), /Some rows/, "invalid");
    const good = await xlsx("Holidays", header, [["Chennai office", year, `${year}-01-15`, "Pongal", "no", "Harvest festival"], ["Chennai office", year, `${year}-01-26`, "Republic Day", "no", ""], ["Head office", year, `${year}-01-26`, "Republic Day", "no", ""], ["Chennai office", year, `${year}-12-24`, "Christmas Eve", "yes", ""]]);
    const p2 = await previewHolidayImport(tx, asha, good);
    assert.equal(p2.valid, true); assert.equal(p2.toAdd, 3); assert.equal(p2.skipped, 1, "Head office already has Republic Day"); assert.deepEqual(p2.newLists, [`Chennai office (${year})`]);
    const c1 = await commitHolidayImport(tx, asha, good);
    assert.equal(c1.added, 3); assert.equal(c1.createdLists, 1);
    const [list] = await tx<{ id: string; n: number }[]>`select hl.id, (select count(*)::int from holidays h where h.holiday_list_id = hl.id) as n from holiday_lists hl where hl.name = 'Chennai office' and hl.year = ${year}`;
    assert.equal(list.n, 3);
    const [opt] = await tx<{ is_floater: boolean }[]>`select is_floater from holidays where holiday_list_id = ${list.id} and name = 'Christmas Eve'`;
    assert.equal(opt.is_floater, true);
    const c2 = await commitHolidayImport(tx, asha, good);
    assert.equal(c2.added, 0, "uploading the same file again changes nothing");
    await fails(previewHolidayImport(tx, priyaScoped, good), /whole company/, "forbidden");
  });
  ok("holiday Excel import: template, per-row validation, lists created as needed, duplicates skipped, idempotent");

  // ---------------------------------------------------------------- assignment Excel import
  await rolledBack(tenant.id, async (tx) => {
    const tpl = await buildAssignmentTemplate(tx, priyaScoped);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(tpl.buffer.slice(tpl.byteOffset, tpl.byteOffset + tpl.byteLength) as ArrayBuffer);
    const ws = wb.getWorksheet("Assignments")!;
    const numbers = new Set<string>(); ws.eachRow((r, n) => { if (n > 1) numbers.add(String(r.getCell(1).value)); });
    assert.ok(numbers.has(P.Divya.employee_number) && !numbers.has(P.Arjun.employee_number), "a scoped admin's template lists only their people");
    await fails(buildAssignmentTemplate(tx, arjun), /access/, "forbidden");
    const header = ["Employee number", "Name", "Shift code", "Weekly off policy", "Clock-in rules", "Penalty policy", "Overtime policy", "Effective from"];
    const from = nextWorking(addDaysISO(today, 3));
    const bad = await xlsx("Assignments", header, [[P.Arjun.employee_number, "", "NIGHT", "", "", "", "", from], [P.Divya.employee_number, "", "NOPE", "", "", "", "", from], [P.Divya.employee_number, "", "", "", "", "", "", from], ["ZZZ999", "", "GEN", "", "", "", "", "not a date"]]);
    const p1 = await previewAssignmentImport(tx, priyaScoped, bad);
    assert.equal(p1.valid, false);
    assert.ok(p1.results[0].errors.some((e) => /can't change/.test(e)) && p1.results[1].errors.some((e) => /Unknown shift code/.test(e)) && p1.results[2].errors.some((e) => /Nothing to change|earlier row/.test(e)) && p1.results[3].errors.some((e) => /No one/.test(e)) && p1.results[3].errors.some((e) => /date/.test(e)));
    const good = await xlsx("Assignments", header, [[P.Divya.employee_number, "", "NIGHT", "Alternate Saturdays", "Office network or location", "none", "", from]]);
    const p2 = await previewAssignmentImport(tx, priyaScoped, good);
    assert.equal(p2.valid, true); assert.equal(p2.people, 1);
    assert.deepEqual(p2.results[0].changes.map((c) => c.kind).sort(), ["capture", "penalty", "shift", "weekly_off"], "a blank cell changes nothing; 'none' removes the penalty policy she has");
    const c = await commitAssignmentImport(tx, priyaScoped, good);
    assert.equal(c.changes, 4);
    const row = (await policies.listAssignments(tx, priyaScoped, today)).find((r) => r.id === P.Divya.id)!;
    assert.equal(row.next_shift, "Night"); assert.equal(row.next_shift_from, from); assert.equal(row.next_weekly_off, "Alternate Saturdays"); assert.equal(row.capture, "Office network or location"); assert.equal(row.penalty, null);
    const again = await previewAssignmentImport(tx, priyaScoped, good);
    assert.equal(again.changes, 0, "the same file again has nothing left to change");
  });
  ok("assignment Excel import: scoped template, validation report, shift / weekly off / policies applied through the same bulk assignment");

  // ---------------------------------------------------------------- selfie + first clock-in approval + geofence polish
  await rolledBack(tenant.id, async (tx) => {
    // Divya is on the seeded "Field staff" policy: no office network, Whitefield fence, selfie, new devices approved, 150 m accuracy
    const inside = { ip: "1.2.3.4", lat: 12.9699, lng: 77.7501 };
    const st0 = await attendance.today(tx, P.Divya.id);
    assert.equal(st0.capture.selfie, true); assert.equal(st0.capture.firstClockInApproval, true); assert.equal(st0.capture.accuracyM, 150); assert.equal(st0.capture.webEnabled, false);
    await fails(attendance.punch(tx, divya, { ip: "1.2.3.4", expect: "in" }), /Share your location/, "invalid");
    await fails(attendance.punch(tx, divya, { ...inside, expect: "in", accuracy: 20, fixAgeMs: 120_000, selfie: selfie() }), /old reading/, "invalid");
    await fails(attendance.punch(tx, divya, { ...inside, expect: "in", accuracy: 400, fixAgeMs: 100, selfie: selfie() }), /accurate to about 400 m/, "invalid");
    await fails(attendance.punch(tx, divya, { ...inside, expect: "in", accuracy: 20, fixAgeMs: 100 }), /selfie/, "invalid");
    await fails(attendance.punch(tx, divya, { ...inside, expect: "in", accuracy: 20, fixAgeMs: 100, selfie: "data:image/png;base64,AAAA" }), /didn't come through/, "invalid");
    const key = "device-key-smoke-0001";
    const r = await attendance.punch(tx, divya, { ...inside, expect: "in", accuracy: 20, fixAgeMs: 100, selfie: selfie(), deviceKey: key, deviceLabel: "Chrome on Android" });
    assert.equal(r.pendingApproval, true); assert.equal(r.fence, "Whitefield client site");
    const [p] = await tx<{ id: string; status: string; selfie_file_id: string; source: string }[]>`select id, status, selfie_file_id, source from punches where employee_id = ${P.Divya.id} order by at desc limit 1`;
    assert.equal(p.status, "pending_approval"); assert.equal(p.source, "mobile"); assert.ok(p.selfie_file_id, "the selfie is stored through the storage module");
    const st1 = await attendance.today(tx, P.Divya.id);
    assert.equal(st1.clockedIn, false, "a pending punch doesn't count yet"); assert.ok(st1.pendingClockIn?.requestId);
    await fails(attendance.punch(tx, divya, { ...inside, expect: "out", accuracy: 20, fixAgeMs: 100, selfie: selfie(), deviceKey: key }), /waiting for your manager/, "conflict");
    // the selfie is readable by the person, their manager and HR; not by a colleague
    assert.ok(await fileFor(tx, divya, p.selfie_file_id)); assert.ok(await fileFor(tx, priya, p.selfie_file_id)); assert.ok(await fileFor(tx, asha, p.selfie_file_id));
    assert.equal(await fileFor(tx, arjun, p.selfie_file_id), null);
    // the manager sees it in the inbox with the device, fence and selfie, approves: punch counts, device trusted
    const step = await stepFor(tx, st1.pendingClockIn!.requestId!, priya);
    assert.ok(step, "Divya's manager has the clock-in to review");
    const detail = await requests.requestDetail(tx, priya, st1.pendingClockIn!.requestId!);
    assert.equal(detail?.kind, "remote_clock_in"); assert.equal(detail?.payload.deviceLabel, "Chrome on Android"); assert.equal(detail?.payload.selfieFileId, p.selfie_file_id);
    assert.match(detail?.summary ?? "", /New device clock-in/);
    assert.equal(await requests.requestDetail(tx, arjun, st1.pendingClockIn!.requestId!), null, "colleagues can't read it");
    await approvals.decide(tx, priya, step!.step_id, "approved");
    const [p2] = await tx<{ status: string }[]>`select status from punches where id = ${p.id}`;
    assert.equal(p2.status, "valid");
    const [trust] = await tx<{ label: string }[]>`select label from clock_in_trust where employee_id = ${P.Divya.id}`;
    assert.equal(trust.label, "Chrome on Android");
    const st2 = await attendance.today(tx, P.Divya.id);
    assert.equal(st2.clockedIn, true); assert.equal(st2.pendingClockIn, null);
    const [day] = await tx<{ status: string }[]>`select status from attendance_days where employee_id = ${P.Divya.id} and date = ${st2.date}`;
    assert.ok(day, "the day is processed once approved");
    // same device again: clocks straight out; a different device would wait again
    const out = await attendance.punch(tx, divya, { ...inside, expect: "out", accuracy: 20, fixAgeMs: 100, selfie: selfie(), deviceKey: key, deviceLabel: "Chrome on Android" });
    assert.equal(out.pendingApproval, false);
    const r3 = await attendance.punch(tx, divya, { ...inside, expect: "in", accuracy: 20, fixAgeMs: 100, selfie: selfie(), deviceKey: "another-device-key-0002", deviceLabel: "Safari on iOS" });
    assert.equal(r3.pendingApproval, true);
    const st3 = await attendance.today(tx, P.Divya.id);
    const step3 = await stepFor(tx, st3.pendingClockIn!.requestId!, priya);
    await approvals.decide(tx, priya, step3!.step_id, "rejected", "Not your phone");
    // the punch is read through its request: punches in one transaction share the same `at`, so "latest" isn't a stable order
    const [p3] = await tx<{ status: string }[]>`select p.status from attendance_requests r join punches p on p.id = (r.payload->>'punchId')::uuid where r.id = ${st3.pendingClockIn!.requestId!}`;
    assert.equal(p3.status, "rejected", "a declined first clock-in never counts");
    assert.equal((await tx`select 1 from clock_in_trust where employee_id = ${P.Divya.id}`).length, 1, "no trust for the declined device");
    // the person's Time tab lists these clock-ins with the selfie for HR; policy editing is company-wide only
    const { timeTab } = await import("@/server/modules/corehr/people");
    const tab = (await timeTab(tx, priya, P.Divya.id))!;
    assert.ok(tab.clockIns.some((c) => c.selfieFileId === p.selfie_file_id && c.status === "valid") && tab.clockIns.some((c) => c.status === "rejected"));
    await fails(policies.saveCapture(tx, priyaScoped, null, { name: "x", web: { enabled: true, comment_required: false, ip_ranges: [] }, mobile: { enabled: true, fences: [], selfie: true, accuracy_m: 100 }, remote: { wfh: true, od: true }, limits: { regularization_per_month: 3, regularization_past_days: 7, partial_day_minutes_per_month: 240 } }), /access/, "forbidden");
    await fails(policies.saveCapture(tx, asha, null, { name: "x", web: { enabled: true, comment_required: false, ip_ranges: [] }, mobile: { enabled: true, fences: [], accuracy_m: 5 }, remote: { wfh: true, od: true }, limits: { regularization_per_month: 3, regularization_past_days: 7, partial_day_minutes_per_month: 240 } }), /between 10 and 5000/, "invalid");
  });
  ok("location clock-in: fresh fix and accuracy enforced, selfie stored and permission-checked, first clock-in from a new device waits for the manager, approval trusts the device, rejection discards the punch");

  // ---------------------------------------------------------------- ADMS push (pure parts + ingest in a rolled-back tx)
  await rolledBack(tenant.id, async (tx) => {
    const dev = await devices.deviceBySerial(tx, "AEXC2230001");
    assert.ok(dev && dev.clock_offset_seconds === 90, "the seeded ADMS device is found by serial");
    assert.equal(await devices.deviceBySerial(tx, "RG-001"), null, "a JSON-protocol device never answers the ADMS endpoints");
    const [emp] = await tx<{ id: string; employee_number: string }[]>`select id, employee_number from employees where id = ${P.Meera.id}`;
    const d = addDaysISO(today, -1);
    const body = `${emp.employee_number}\t${d} 09:30:00\t0\t1\t0\t0\n${emp.employee_number}\t${d} 18:31:30\t1\t1\n${emp.employee_number}\t${d} 09:30:00\t0\t1\nGHOST\t${d} 09:00:00\t0\t1\n`;
    const { rows, bad } = parseAttlog(body);
    assert.equal(bad, 0);
    const { items } = attlogToPunches(rows, dev!.timezone, dev!.clock_offset_seconds);
    assert.equal(items.length, 3, "the repeated line collapses");
    assert.equal(items[0].at, new Date(`${d}T09:28:30+05:30`).toISOString(), "the device's clock offset is corrected");
    const r1 = await devices.ingestPunches(tx, dev!, items);
    assert.equal(r1.accepted, 2); assert.deepEqual(r1.unknown, ["GHOST"]);
    const r2 = await devices.ingestPunches(tx, dev!, items);
    assert.equal(r2.accepted, 0); assert.equal(r2.duplicates, 2, "a resent log counts nothing twice");
    const [day] = await tx<{ status: string }[]>`select status from attendance_days where employee_id = ${P.Meera.id} and date = ${d}`;
    assert.equal(day.status, "present", "the day is processed");
    const [stored] = await tx<{ at: Date }[]>`select at from punches where device_id = ${dev!.id} and employee_id = ${P.Meera.id} order by at limit 1`;
    assert.ok(Math.abs(stored.at.getTime() - new Date(`${d}T09:28:30+05:30`).getTime()) < 1000, "stored at the corrected time");
  });
  // the HTTP endpoints themselves: handshake, poll, push; the tenant comes from the host header, unknown serials are refused
  {
    const req = (path: string, init: RequestInit & { tenant?: string | null } = {}) => new Request(`http://acme.localhost${path}`, { ...init, headers: { "x-erp-tenant": init.tenant === undefined ? DEMO_SUBDOMAIN : (init.tenant ?? ""), "x-forwarded-for": "198.51.100.7", ...(init.headers ?? {}) } });
    const hs = await admsHandshake(req("/iclock/cdata?SN=AEXC2230001&options=all&pushver=2.4.1"));
    assert.equal(hs.status, 200);
    const text = await hs.text();
    assert.match(text, /^GET OPTION FROM: AEXC2230001\n/); assert.match(text, /ATTLOGStamp=0/); assert.match(text, /TimeZone=5\.5/);
    assert.equal((await admsHandshake(req("/iclock/cdata?SN=NOPE-1"))).status, 401, "unregistered serials are refused");
    assert.equal((await admsHandshake(req("/iclock/cdata"))).status, 400);
    assert.equal((await admsHandshake(req("/iclock/cdata?SN=AEXC2230001", { tenant: "nobody-here" }))).status, 404, "the serial only works on its own company's host");
    assert.equal(await (await admsPoll(req("/iclock/getrequest?SN=AEXC2230001"))).text(), "OK");
    const op = await admsPush(req("/iclock/cdata?SN=AEXC2230001&table=OPERLOG&Stamp=1", { method: "POST", body: "OPLOG 0\t1\t2026-11-03 09:00:00\n" }));
    assert.equal(await op.text(), "OK: 1", "operator logs are acknowledged and dropped");
    const d = addDaysISO(today, -2);
    const line = `${P.Vikram.employee_number}\t${d} 09:45:00\t0\t1\t0\t0\n`;
    const push = await admsPush(req("/iclock/cdata?SN=AEXC2230001&table=ATTLOG&Stamp=9", { method: "POST", body: line }));
    assert.equal(await push.text(), "OK: 1");
    try {
      const rows = await withTenant(tenant.id, (tx) => tx<{ external_id: string; source: string; device_id: string }[]>`select external_id, source, device_id from punches where employee_id = ${P.Vikram.id} and external_id like ${`${P.Vikram.employee_number}@${d}%`}`);
      assert.equal(rows.length, 1); assert.equal(rows[0].source, "biometric"); assert.equal(rows[0].external_id, `${P.Vikram.employee_number}@${d} 09:45:00`);
      assert.equal(await (await admsPush(req("/iclock/cdata?SN=AEXC2230001&table=ATTLOG&Stamp=9", { method: "POST", body: line }))).text(), "OK: 1", "the device may resend; still one punch");
      assert.equal((await withTenant(tenant.id, (tx) => tx`select 1 from punches where employee_id = ${P.Vikram.id} and external_id like ${`${P.Vikram.employee_number}@${d}%`}`)).length, 1);
      const [dev] = await withTenant(tenant.id, (tx) => tx<{ last_seen_at: Date | null }[]>`select last_seen_at from devices where serial = 'AEXC2230001'`);
      assert.ok(dev.last_seen_at && Date.now() - dev.last_seen_at.getTime() < 60_000, "the device shows as online");
    } finally {
      await withTenant(tenant.id, async (tx) => {
        await tx`delete from punches where employee_id = ${P.Vikram.id} and external_id like ${`${P.Vikram.employee_number}@${d}%`}`;
        const { processAttendance } = await import("@/server/modules/attendance/process");
        await processAttendance(tx, tenant.id, P.Vikram.id, d);
      });
    }
  }
  ok("ADMS push: serial-registered devices only, on their own company's host; handshake, poll and ATTLOG push; clock offset corrected; resent logs count once");

  // ---------------------------------------------------------------- tenant isolation
  const otherId = randomUUID();
  await admin`insert into tenants (id, subdomain, name) values (${otherId}, ${"smoke-" + otherId.slice(0, 8)}, 'Smoke Co')`;
  try {
    await rolledBack(otherId, async (tx) => {
      assert.equal(await devices.deviceBySerial(tx, "AEXC2230001"), null, "another company can't see the device by serial");
      assert.equal(await leave.requestDetail(tx, randomUUID()), null);
      assert.equal((await tx`select 1 from leave_grants`).length, 0);
      assert.equal((await tx`select 1 from clock_in_trust`).length, 0);
    });
    const foreign: Actor = { ...asha, tenant: { ...tenant, id: otherId } };
    await rolledBack(otherId, async (tx) => {
      await fails(grants.grantLeave(tx, foreign, { employeeId: P.Arjun.id, leaveTypeId: ml, event: "Wedding", days: 1, validFrom: today, validTo: today }), /not found/, "not_found");
      await fails(leave.applyOnBehalf(tx, foreign, P.Arjun.id, { leaveTypeId: cl, from: today, to: today, fromPart: "full", toPart: "full", note: "x" }), /not found/, "not_found");
    });
  } finally {
    await admin`delete from tenants where id = ${otherId}`;
  }
  ok("tenant isolation: grants, trust rows, devices and on-behalf targets never cross tenants");

  // ---------------------------------------------------------------- the shared daily run (what the scheduler calls)
  {
    const lines: string[] = [];
    const r = await runDaily(admin, { tenant: DEMO_SUBDOMAIN, only: ["leave"], log: (l) => lines.push(l) });
    assert.equal(r.locked, true); assert.equal(r.tenants, 1); assert.equal(r.failed, 0);
    assert.ok(lines.some((l) => /leave ✓/.test(l)), "the leave step (accrual, comp-off expiry, grant lapse) ran");
    const [{ locked }] = await admin<{ locked: boolean }[]>`select pg_try_advisory_lock(727001) as locked`;
    assert.equal(locked, true, "the lock is released after the run");
    await admin`select pg_advisory_unlock(727001)`;
  }
  ok("daily run: the scheduler and jobs:daily share one locked, per-tenant run");

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await admin.end(); await sql.end(); });
