/**
 * End-to-end smoke test of the M0 core loop against the seeded demo tenant (run `pnpm db:seed` first).
 * Exercises the same services the screens call: login, clock-in, apply leave, manager approves, balance drops,
 * cancel returns days, overlap is blocked, and another tenant can't see any of it.
 *   pnpm smoke
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { withTenant, sql, AppError } from "@/server/db";
import { verifyPassword } from "@/server/auth/password";
import * as leave from "@/server/modules/leave/service";
import * as approvals from "@/server/modules/approvals/service";
import * as attendance from "@/server/modules/attendance/service";
import * as profile from "@/server/modules/employees/profile";
import * as roles from "@/server/modules/settings/roles";
import * as org from "@/server/modules/settings/org";
import ExcelJS from "exceljs";
import { buildTemplate, commitImport, previewImport } from "@/server/modules/employees/import";
import { addDaysISO, todayIn, weekday } from "@/lib/dates";
import type { Actor } from "@/server/auth/session";
import { DEMO_PASSWORD, DEMO_SUBDOMAIN } from "./demo";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };

async function main() {
  const [t] = await sql<{ id: string }[]>`select id from tenant_by_subdomain(${DEMO_SUBDOMAIN})`;
  assert.ok(t, "demo tenant exists (run pnpm db:seed)");
  const tenant = { id: t.id, name: "Acme Technologies", status: "trial", subdomain: DEMO_SUBDOMAIN };
  const actor = (first: string) => withTenant(tenant.id, async (tx) => {
    const [e] = await tx<{ id: string; user_id: string; display_name: string; password_hash: string }[]>`
      select e.id, e.user_id, e.display_name, u.password_hash from employees e join users u on u.id = e.user_id where e.first_name = ${first}`;
    return { e, a: { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set<string>(), grants: [] } as Actor };
  });

  const arjun = await actor("Arjun"), rohan = await actor("Rohan"), meera = await actor("Meera");
  assert.equal(await verifyPassword(DEMO_PASSWORD, arjun.e.password_hash), true);
  assert.equal(await verifyPassword("wrong-password", arjun.e.password_hash), false);
  ok("password check accepts the right password and rejects a wrong one");

  // clock in / out
  await withTenant(tenant.id, async (tx) => {
    const before = await attendance.today(tx, arjun.a.employeeId);
    const first = before.clockedIn ? "out" : "in";
    await attendance.punch(tx, arjun.a, { ip: null, expect: first });
    await assert.rejects(attendance.punch(tx, arjun.a, { ip: null, expect: first }), AppError);
    const after = await attendance.today(tx, arjun.a.employeeId);
    assert.equal(after.clockedIn, first === "in");
    await attendance.punch(tx, arjun.a, { ip: null, expect: first === "in" ? "out" : "in" });
    throw new Error("rollback");     // keep the demo data clean
  }).catch((e) => { if (e.message !== "rollback") throw e; });
  ok("clock in, double clock-in refused, clock out");

  // apply → approve → balance → cancel
  let d = addDaysISO(todayIn(), 30); while (["sat", "sun"].includes(weekday(d))) d = addDaysISO(d, 1);
  const casual = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from leave_types where code = 'CL'`).then((r) => r[0].id);
  const bal = (who: typeof arjun) => withTenant(tenant.id, (tx) => leave.balances(tx, who.a.employeeId)).then((b) => b.find((x) => x.id === casual)!);
  const b0 = await bal(arjun);
  const req = await withTenant(tenant.id, (tx) => leave.apply(tx, arjun.a, { leaveTypeId: casual, from: d, to: d, fromPart: "full", toPart: "full", note: "smoke" }));
  assert.equal(req.status, "pending");
  const b1 = await bal(arjun);
  assert.equal(b1.available, b0.available - 1); assert.equal(b1.pending, b0.pending + 1);
  ok(`Arjun applies 1 day casual leave → pending, available ${b0.available} → ${b1.available}`);

  await assert.rejects(withTenant(tenant.id, (tx) => leave.apply(tx, arjun.a, { leaveTypeId: casual, from: d, to: d, fromPart: "first", toPart: "first" })), /already have leave/);
  ok("overlapping request on the same day is refused by the database");

  const inboxMeera = await withTenant(tenant.id, (tx) => approvals.inbox(tx, meera.a));
  assert.equal(inboxMeera.some((i) => i.entity_id === req.id), false);
  const inboxRohan = await withTenant(tenant.id, (tx) => approvals.inbox(tx, rohan.a));
  const item = inboxRohan.find((i) => i.entity_id === req.id);
  assert.ok(item, "request is in Rohan's inbox");
  ok("request lands in the manager's (Rohan's) inbox and nobody else's");

  await assert.rejects(withTenant(tenant.id, (tx) => approvals.decide(tx, meera.a, item.step_id, "approved")), /isn't waiting for you/);
  ok("someone who isn't the approver can't approve it");

  await withTenant(tenant.id, (tx) => approvals.decide(tx, rohan.a, item.step_id, "approved", "Enjoy"));
  await assert.rejects(withTenant(tenant.id, (tx) => approvals.decide(tx, rohan.a, item.step_id, "approved")), /already handled/);
  const b2 = await bal(arjun);
  assert.equal(b2.used, b0.used + 1); assert.equal(b2.pending, b0.pending); assert.equal(b2.available, b0.available - 1);
  const [n] = await withTenant(tenant.id, (tx) => tx<{ c: number }[]>`select count(*)::int as c from notifications where user_id = ${arjun.a.userId} and kind = 'request.approved'`);
  assert.ok(n.c >= 1);
  ok(`Rohan approves → ledger debit, used ${b0.used} → ${b2.used}, double-approve refused, Arjun notified`);

  await withTenant(tenant.id, (tx) => leave.cancel(tx, arjun.a, req.id));
  const b3 = await bal(arjun);
  assert.equal(b3.available, b0.available); assert.equal(b3.credited, b0.credited); assert.equal(b3.used, b0.used);
  ok("Arjun cancels the approved future leave → days return to the balance");
  // leave the demo data as we found it (owner connection; the app role can't delete ledger rows)
  await admin`delete from leave_ledger where ref_id = ${req.id}`;
  await admin`delete from approval_requests where entity_id = ${req.id}`;
  await admin`delete from notifications where tenant_id = ${tenant.id} and body like ${"%smoke%"} or (tenant_id = ${tenant.id} and created_at > now() - interval '1 minute' and kind like 'request.%')`;
  await admin`delete from leave_requests where id = ${req.id}`;

  // M1: job changes and profile edits (run in a rolled-back transaction so the demo data stays as seeded)
  const priya = await actor("Priya");
  priya.a.permissions = new Set(["employees.read", "employees.write", "approvals.override"]);
  priya.a.grants = [{ permissions: [...priya.a.permissions], scopes: [] }];
  await withTenant(tenant.id, async (tx) => {
    await assert.rejects(profile.changeJob(tx, priya.a, rohan.a.employeeId, { kind: "manager_change", effectiveDate: todayIn(), changes: { manager_id: arjun.a.employeeId } }), /reporting loop/);
    await assert.rejects(profile.changeJob(tx, arjun.a, meera.a.employeeId, { kind: "manager_change", effectiveDate: todayIn(), changes: { manager_id: arjun.a.employeeId } }), /Only HR/);
    const future = addDaysISO(todayIn(), 10);
    const r1 = await profile.changeJob(tx, priya.a, meera.a.employeeId, { kind: "manager_change", effectiveDate: future, changes: { manager_id: arjun.a.employeeId } });
    assert.equal(r1.scheduled, true);
    const [m1] = await tx<{ manager_id: string }[]>`select manager_id from employees where id = ${meera.a.employeeId}`;
    assert.equal(m1.manager_id, rohan.a.employeeId);
    const r2 = await profile.changeJob(tx, priya.a, meera.a.employeeId, { kind: "manager_change", effectiveDate: todayIn(), changes: { manager_id: arjun.a.employeeId } });
    assert.equal(r2.scheduled, false);
    const [m2] = await tx<{ manager_id: string }[]>`select manager_id from employees where id = ${meera.a.employeeId}`;
    assert.equal(m2.manager_id, arjun.a.employeeId);
    // employee edits contact details → goes to HR; 'about' applies directly
    const c = await profile.updateSection(tx, arjun.a, arjun.a.employeeId, "contact", { mobile: "+91 98765 43210" });
    assert.equal(c.applied, false);
    const ab = await profile.updateSection(tx, arjun.a, arjun.a.employeeId, "about", { bio: { summary: "Builds the payroll engine" } });
    assert.equal(ab.applied, true);
    await assert.rejects(profile.updateSection(tx, meera.a, arjun.a.employeeId, "about", { bio: { summary: "x" } }), /can't edit/);
    const seen = await profile.getProfile(tx, meera.a, rohan.a.employeeId);
    assert.equal(seen?.employee.personal, undefined, "colleague doesn't see personal details");
    throw new Error("rollback");
  }).catch((e) => { if (e.message !== "rollback") throw e; });
  ok("job change: reporting loop refused, non-HR refused, future date scheduled, today applied");
  ok("profile: employee's contact edit goes to HR, 'about' saves directly, colleagues can't edit or see personal details");

  // M1: scoped roles + company structure (rolled back)
  const asha = await actor("Asha");
  asha.a.permissions = new Set(["*"]); asha.a.grants = [{ permissions: ["*"], scopes: [] }];
  await withTenant(tenant.id, async (tx) => {
    const [eng] = await tx<{ id: string }[]>`select id from departments where name = 'Engineering'`;
    const { id: roleId } = await roles.saveRole(tx, asha.a, null, { name: "Engineering HR", permissions: ["employees.write", "bogus.permission"] });
    const [saved] = await tx<{ permissions: string[] }[]>`select permissions from roles where id = ${roleId}`;
    assert.deepEqual(saved.permissions, ["employees.write"], "unknown permissions are dropped");
    await roles.assign(tx, asha.a, roleId, meera.a.employeeId, [{ type: "department", ids: [eng.id] }]);
    const meeraScoped = { ...meera.a, permissions: new Set(["employees.write"]), grants: [{ permissions: ["employees.write"], scopes: [{ type: "department" as const, ids: [eng.id] }] }] };
    const karan = await actor("Karan");
    assert.equal(await profile.accessTo(tx, meeraScoped, arjun.a.employeeId), "admin");
    assert.notEqual(await profile.accessTo(tx, meeraScoped, karan.a.employeeId), "admin");
    await assert.rejects(roles.saveRole(tx, meera.a, null, { name: "x", permissions: [] }), /access/);
    const [ga] = await tx<{ id: string }[]>`select a.id from role_assignments a join roles r on r.id = a.role_id where r.key = 'global_admin'`;
    await assert.rejects(roles.unassign(tx, asha.a, ga.id), /at least one Global admin/);
    // company structure
    await assert.rejects(org.deleteMaster(tx, asha.a, "departments", eng.id), /still assigned/);
    // a failed statement aborts the transaction, so check the duplicate inside a savepoint
    await assert.rejects(tx.savepoint((sp) => org.saveMaster(sp as typeof tx, asha.a, "departments", null, { name: "Engineering" })), /already exists/);
    const { id: platform } = await org.saveMaster(tx, asha.a, "departments", null, { name: "Platform", parentId: eng.id });
    await assert.rejects(org.saveMaster(tx, asha.a, "departments", eng.id, { name: "Engineering", parentId: platform }), /inside this department/);
    throw new Error("rollback");
  }).catch((e) => { if (e.message !== "rollback") throw e; });
  ok("scoped role: Engineering HR can manage Engineering people only; unknown permissions dropped; last Global admin protected");
  ok("company structure: in-use department can't be deleted, duplicate names refused, no parent loops");

  // M1: bulk import from the real template (rolled back)
  await withTenant(tenant.id, async (tx) => {
    const tpl = await buildTemplate(tx, asha.a);
    const fill = async (rows: (string | Date)[][]) => {
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load(new Uint8Array(tpl).buffer);
      const ws = wb.getWorksheet("People")!;
      ws.spliceRows(2, 1);   // drop the example row
      rows.forEach((r) => ws.addRow(r));
      return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
    };
    // columns: first, last, email, mobile, number, joining, gender, department, designation, location, manager email
    const broken = await fill([
      ["Neha", "Gupta", "neha@acme.test", "", "", "2026-11-02", "Female", "Engineering", "Software Engineer", "Head office", "rohan@acme.test"],
      ["", "NoName", "not-an-email", "", "EMP-0001", "31-02-2026", "", "Marketing", "", "", ""],
    ]);
    const p1 = await previewImport(tx, asha.a, broken);
    assert.equal(p1.valid, false); assert.equal(p1.ok, 1); assert.equal(p1.results.find((r) => r.rowNumber === 3)!.errors.length, 5);
    await assert.rejects(commitImport(tx, asha.a, broken), /Some rows have problems/);
    const good = await fill([
      ["Kabir", "Das", "kabir@acme.test", "", "", new Date(Date.UTC(2026, 10, 2)), "Male", "Engineering", "Software Engineer", "Head office", "lead@acme.test"],
      ["Lata", "Menon", "lead@acme.test", "", "ENG-LEAD-1", "02-11-2026", "", "Engineering", "Software Engineer", "Head office", "rohan@acme.test"],
    ]);
    const p2 = await previewImport(tx, asha.a, good);
    assert.equal(p2.valid, true, JSON.stringify(p2.results));
    await assert.rejects(previewImport(tx, arjun.a, good), /access/);
    const r = await commitImport(tx, asha.a, good);
    assert.equal(r.created, 2);
    const [k] = await tx<{ mgr: string; doj: string; n: string }[]>`
      select m.work_email as mgr, e.joining_date::text as doj, (select count(*) from leave_ledger l where l.employee_id = e.id)::text as n
      from employees e join employees m on m.id = e.manager_id where e.work_email = 'kabir@acme.test'`;
    assert.deepEqual(k, { mgr: "lead@acme.test", doj: "2026-11-02", n: "3" });
    throw new Error("rollback");
  }).catch((e) => { if (e.message !== "rollback") throw e; });
  ok("bulk import: template round-trip, row errors reported (5 on one row), all-or-nothing, in-file manager linked, balances created");

  // tenant isolation: a second tenant sees nothing of Acme
  const otherId = randomUUID();
  await admin`insert into tenants (id, subdomain, name) values (${otherId}, ${"smoke-" + otherId.slice(0, 8)}, 'Smoke Co')`;
  try {
    const [c] = await withTenant(otherId, (tx) => tx<{ e: number; l: number }[]>`select (select count(*)::int from employees) as e, (select count(*)::int from leave_requests) as l`);
    assert.deepEqual(c, { e: 0, l: 0 });
    await assert.rejects(withTenant(otherId, (tx) => tx`insert into employees (tenant_id, employee_number, first_name, display_name, work_email, joining_date) values (${tenant.id}, 'X', 'x', 'x', 'x@x.in', '2026-01-01')`), /row-level security/);
    ok("another tenant sees 0 of Acme's employees/requests and can't write into Acme");
  } finally {
    await admin`delete from tenants where id = ${otherId}`;
  }
  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await admin.end(); await sql.end(); }).catch(async (e) => { console.error("\nFAILED:", e); await admin.end(); await sql.end(); process.exit(1); });
