/**
 * Smoke test for the platform package: audit log (writes, filters, paging, permissions, isolation),
 * first-run setup wizard (state machine, steps, permissions, isolation) and remembered devices.
 * Runs against the seeded demo tenant (pnpm db:seed first); creates a throw-away tenant for setup and removes it.
 *   pnpm smoke:platform
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { withTenant, sql, AppError, type Tx } from "@/server/db";
import { newToken, sha256 } from "@/server/auth/password";
import type { Actor } from "@/server/auth/session";
import * as org from "@/server/modules/settings/org";
import * as roles from "@/server/modules/settings/roles";
import * as profile from "@/server/modules/employees/profile";
import * as leave from "@/server/modules/leave/service";
import * as approvals from "@/server/modules/approvals/service";
import { setMfaMode } from "@/server/modules/settings/security";
import { invite, setPasswordWithToken } from "@/server/modules/auth/flows";
import { createEmployee } from "@/server/modules/employees/service";
import { provisionTenant } from "@/server/modules/tenants/provision";
import { listAudit, listSignIns, auditFilterOptions } from "@/server/modules/audit/service";
import { encodeCursor } from "@/server/modules/audit/rules";
import * as setup from "@/server/modules/setup/service";
import { proratedOpening } from "@/server/modules/leave/rules";
import { checkTrustedDevice, createTrustedDevice } from "@/server/modules/auth/trusted-device";
import { addDaysISO, todayIn, weekday } from "@/lib/dates";
import { DEMO_PASSWORD, DEMO_SUBDOMAIN } from "./demo";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const rollback = (e: Error) => { if (e.message !== "rollback") throw e; };

async function main() {
  const [t] = await sql<{ id: string }[]>`select id from tenant_by_subdomain(${DEMO_SUBDOMAIN})`;
  assert.ok(t, "demo tenant exists (run pnpm db:seed)");
  const tenant = { id: t.id, name: "Acme Technologies", status: "trial", subdomain: DEMO_SUBDOMAIN };
  const actor = (first: string, permissions: string[] = []) => withTenant(tenant.id, async (tx) => {
    const [e] = await tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`;
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(permissions), grants: [{ permissions, scopes: [] }] } as Actor;
  });
  const asha = await actor("Asha", ["*"]), arjun = await actor("Arjun"), rohan = await actor("Rohan"), meera = await actor("Meera");
  const auditor = await actor("Karan", ["settings.audit"]);
  const lastAudit = (tx: Tx, entity: string, action: string) => tx<{ entity_id: string | null; diff: Record<string, unknown> | null; actor_user_id: string | null }[]>`
    select entity_id, diff, actor_user_id from audit_logs where entity_type = ${entity} and action = ${action} order by created_at desc, id desc limit 1`.then((r) => r[0]);

  // ---------- audit log: permissions ----------
  await withTenant(tenant.id, async (tx) => {
    await assert.rejects(listAudit(tx, arjun, {}), /access/);
    await assert.rejects(listSignIns(tx, arjun, {}), /access/);
    await assert.rejects(auditFilterOptions(tx, arjun), /access/);
    const scopedHr = { ...meera, permissions: new Set(["employees.write", "settings.org"]), grants: [{ permissions: ["employees.write", "settings.org"], scopes: [] }] };
    await assert.rejects(listAudit(tx, scopedHr, {}), /access/);
    assert.ok((await listAudit(tx, auditor, {})).items.length > 0);
    assert.ok((await listAudit(tx, asha, {})).items.length > 0);
  });
  ok("audit log: needs settings.audit (or Global admin); employees and other admins are refused");

  // ---------- audit log: every mutation writes a row (rolled back) ----------
  await withTenant(tenant.id, async (tx) => {
    // masters: create / update (old→new) / delete (name kept)
    const { id: deptId } = await org.saveMaster(tx, asha, "departments", null, { name: "Smoke Dept" });
    assert.deepEqual((await lastAudit(tx, "departments", "create")).diff, { name: "Smoke Dept" });
    await org.saveMaster(tx, asha, "departments", deptId, { name: "Smoke Department" });
    const upd = await lastAudit(tx, "departments", "update");
    assert.equal(upd.entity_id, deptId); assert.deepEqual(upd.diff?.name, { old: "Smoke Dept", new: "Smoke Department" });
    const n0 = await tx<{ n: number }[]>`select count(*)::int as n from audit_logs where entity_type = 'departments' and action = 'update'`;
    await org.saveMaster(tx, asha, "departments", deptId, { name: "Smoke Department" });   // no-op save: no row
    const n1 = await tx<{ n: number }[]>`select count(*)::int as n from audit_logs where entity_type = 'departments' and action = 'update'`;
    assert.equal(n1[0].n, n0[0].n);
    const [loc] = await tx<{ id: string }[]>`select id from locations order by created_at limit 1`;
    await org.saveMaster(tx, asha, "locations", loc.id, { name: (await tx<{ name: string }[]>`select name from locations where id = ${loc.id}`)[0].name, stateCode: "KA" });
    assert.deepEqual((await lastAudit(tx, "locations", "update")).diff?.state_code, { old: null, new: "KA" });
    await org.deleteMaster(tx, asha, "departments", deptId);
    assert.deepEqual((await lastAudit(tx, "departments", "delete")).diff, { name: "Smoke Department" });

    // roles: save / assign / unassign / delete
    const { id: roleId } = await roles.saveRole(tx, asha, null, { name: "Smoke Auditors", permissions: ["settings.audit"] });
    assert.equal((await lastAudit(tx, "role", "save")).entity_id, roleId);
    await roles.assign(tx, asha, roleId, arjun.employeeId, []);
    assert.equal((await lastAudit(tx, "role", "assign")).diff?.employeeId, arjun.employeeId);
    const [ra] = await tx<{ id: string }[]>`select id from role_assignments where role_id = ${roleId}`;
    await roles.unassign(tx, asha, ra.id);
    assert.equal((await lastAudit(tx, "role", "unassign")).diff?.employeeId, arjun.employeeId);
    await roles.deleteRole(tx, asha, roleId);
    assert.deepEqual((await lastAudit(tx, "role", "delete")).diff, { name: "Smoke Auditors" });

    // security
    await setMfaMode(tx, asha, "required");
    assert.deepEqual((await lastAudit(tx, "tenant", "security.mfa")).diff, { mode: "required" });

    // profile edit (admin, direct) and request (self, needs approval)
    await profile.updateSection(tx, asha, arjun.employeeId, "contact", { mobile: "9876500000" });
    const pe = await lastAudit(tx, "employee", "update");
    assert.equal(pe.entity_id, arjun.employeeId); assert.equal(pe.actor_user_id, asha.userId);
    await profile.updateSection(tx, arjun, arjun.employeeId, "personal", { blood_group: "B+" });
    const sub = await lastAudit(tx, "profile_change", "submit");
    assert.ok(sub && (sub.diff as { section: string }).section === "personal", "self-service request is logged");

    // job change: immediate (before/after), scheduled, cancelled
    const [eng] = await tx<{ id: string }[]>`select id from departments where name = 'Sales'`;
    await profile.changeJob(tx, asha, meera.employeeId, { kind: "transfer", effectiveDate: todayIn(), changes: { department_id: eng.id } });
    const jc = await lastAudit(tx, "employee", "job_change");
    assert.equal(jc.entity_id, meera.employeeId); assert.deepEqual((jc.diff as { after: unknown }).after, { department_id: eng.id });
    const future = await profile.changeJob(tx, asha, meera.employeeId, { kind: "promotion", effectiveDate: addDaysISO(todayIn(), 30), changes: { band_id: null } });
    assert.equal(future.scheduled, true);
    assert.equal((await lastAudit(tx, "employee", "job_change_scheduled")).entity_id, meera.employeeId);
    await profile.cancelJobChange(tx, asha, future.id);
    assert.equal((await lastAudit(tx, "employee", "job_change_cancelled")).entity_id, meera.employeeId);
    await profile.setProbation(tx, asha, meera.employeeId, { action: "extend", date: addDaysISO(todayIn(), 60) });
    assert.equal((await lastAudit(tx, "employee", "probation")).diff?.action, "extend");

    // employee create + invite (who was invited is recorded)
    const { employeeId } = await createEmployee(tx, tenant.id, { firstName: "Audit", lastName: "Probe", workEmail: "audit.probe@acme.test", joiningDate: todayIn() }, asha.userId);
    assert.equal((await lastAudit(tx, "employee", "create")).entity_id, employeeId);
    await invite(tx, asha, [employeeId]);
    assert.deepEqual((await lastAudit(tx, "user", "invite")).diff, { count: 1, employeeIds: [employeeId] });

    // approvals: a leave decision
    const [cl] = await tx<{ id: string }[]>`select id from leave_types where code = 'CL'`;
    let d = addDaysISO(todayIn(), 50); while (["sat", "sun"].includes(weekday(d))) d = addDaysISO(d, 1);
    const req = await leave.apply(tx, arjun, { leaveTypeId: cl.id, from: d, to: d, fromPart: "full", toPart: "full" });
    const [step] = await tx<{ id: string }[]>`select s.id from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_id = ${req.id} and s.status = 'pending'`;
    await approvals.decide(tx, rohan, step.id, "approved");
    assert.equal((await lastAudit(tx, "leave", "approval.approved")).entity_id, req.id);

    // descriptions read like sentences and name the right things
    const page = await listAudit(tx, asha, {}, null, 40);
    const text = page.items.map((i) => `${i.actor_name} ${i.description}`);
    for (const s of [
      "Asha Verma deleted the department “Smoke Department”",
      "Asha Verma renamed the department “Smoke Dept” to “Smoke Department”",
      "Asha Verma removed the role “Smoke Auditors” from Arjun Rao",
      "Asha Verma set sign-in codes to Required for everyone",
      "Asha Verma updated Arjun Rao’s profile (mobile)",
      "Asha Verma changed Meera Iyer’s job details (department)",
      "Asha Verma added Audit Probe",
      "Asha Verma sent 1 invite",
      "Rohan Mehta approved Arjun Rao’s leave request",
      "Asha Verma extended Meera Iyer’s probation to " + addDaysISO(todayIn(), 60),
    ]) assert.ok(text.includes(s), `missing: ${s}\n${text.join("\n")}`);
    const jcItem = page.items.find((i) => i.action === "job_change")!;
    assert.equal(page.refs[eng.id], "Sales", "uuids inside diffs resolve to names");
    assert.ok(jcItem.when.length > 0);
    throw new Error("rollback");
  }).catch(rollback);
  ok("audit rows for masters (create/update/delete), roles, security, profile edits + requests, job changes, probation, add, invite, approvals; readable sentences");

  // ---------- audit log: filters and cursor paging (rolled back) ----------
  await withTenant(tenant.id, async (tx) => {
    // the app role can't rewrite history
    await assert.rejects(tx.savepoint((sp) => sp`delete from audit_logs`), /permission denied/);
    await assert.rejects(tx.savepoint((sp) => sp`update audit_logs set action = 'x'`), /permission denied/);
    // 120 rows in 2020 (isolated by date); 60 share one timestamp to prove the id tie-breaker
    await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, created_at)
             select ${tenant.id}, ${asha.userId}, 'departments', gen_random_uuid(), 'create', '2020-10-01T10:00:00Z'::timestamptz from generate_series(1, 60)`;
    await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, action, diff, created_at)
             select ${tenant.id}, ${rohan.userId}, 'user', 'invite', jsonb_build_object('count', g), '2020-10-01T10:00:00Z'::timestamptz + make_interval(mins => g) from generate_series(1, 60) g`;
    const in2020 = { from: "2020-01-01", to: "2020-12-31" };
    const seen: string[] = []; let cursor: string | null = null; let pages = 0; let prev = "9999";
    do {
      const p = await listAudit(tx, asha, in2020, cursor, 50);
      for (const i of p.items) { assert.ok(i.at <= prev, "newest first"); prev = i.at; seen.push(i.id); }
      cursor = p.nextCursor; pages++;
    } while (cursor);
    assert.equal(pages, 3); assert.equal(seen.length, 120); assert.equal(new Set(seen).size, 120, "no duplicates across pages");
    assert.equal((await listAudit(tx, asha, in2020, "garbage!", 50)).items[0].id, seen[0], "a bad cursor starts from the top");
    assert.equal((await listAudit(tx, asha, in2020, encodeCursor({ at: "2020-10-01T10:00:00.000000Z", id: "ffffffff-ffff-4fff-bfff-ffffffffffff" }), 500)).items.length, 60, "cursor at a tie still returns the tied rows");
    assert.equal((await listAudit(tx, asha, { ...in2020, actor: rohan.userId }, null, 500)).items.length, 60);
    assert.equal((await listAudit(tx, asha, { ...in2020, entity: "departments" }, null, 500)).items.length, 60);
    assert.equal((await listAudit(tx, asha, { ...in2020, action: "invite", entity: "user" }, null, 500)).items.length, 60);
    // IST date range: 10:00Z..11:00Z = 15:30..16:30 IST on 1 Oct 2020
    assert.equal((await listAudit(tx, asha, { from: "2020-10-01", to: "2020-10-01" }, null, 500)).items.length, 120);
    assert.equal((await listAudit(tx, asha, { from: "2020-10-02", to: "2020-12-31" }, null, 500)).items.length, 0);
    assert.equal((await listAudit(tx, asha, { from: "2020-01-01", to: "2020-09-30" }, null, 500)).items.length, 0);
    await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, action, created_at) values (${tenant.id}, ${asha.userId}, 'user', 'late', '2020-10-01T18:40:00Z')`;   // 00:10 IST on 2 Oct
    assert.equal((await listAudit(tx, asha, { from: "2020-10-02", to: "2020-10-02" }, null, 500)).items.length, 1, "days are IST days");
    const opts = await auditFilterOptions(tx, asha);
    assert.ok(opts.entities.includes("departments") && opts.actions.includes("invite"));
    assert.ok(opts.people.some((p) => p.id === arjun.userId));
    throw new Error("rollback");
  }).catch(rollback);
  ok("audit paging: newest first, 120 rows in 3 pages with ties, no duplicates, bad cursor ignored; filters by person, area, action, IST dates; app can't edit or delete entries");

  // ---------- sign-ins ----------
  await withTenant(tenant.id, async (tx) => {
    const all = await listSignIns(tx, asha, {}, null, 500);
    assert.ok(all.items.some((i) => i.success) && all.items.some((i) => !i.success));
    const failed = await listSignIns(tx, asha, { result: "failure" }, null, 500);
    assert.ok(failed.items.length > 0 && failed.items.every((i) => !i.success));
    const mine = await listSignIns(tx, asha, { actor: arjun.userId }, null, 500);
    assert.ok(mine.items.length > 0 && mine.items.every((i) => i.user_id === arjun.userId));
    assert.ok(all.items.some((i) => i.user_id === null && i.email === "someone@example.com"), "unknown-email attempts are listed");
    const p1 = await listSignIns(tx, asha, {}, null, 5);
    const p2 = await listSignIns(tx, asha, {}, p1.nextCursor, 5);
    assert.ok(p2.items.length > 0 && !p2.items.some((i) => p1.items.some((j) => j.id === i.id)));
  });
  ok("sign-ins tab: success and failure with IP, filter by result and person, unknown emails shown, paging");

  // ---------- trusted device ----------
  const probeEmail = "smoke.device@acme.test";
  await admin`delete from employees where work_email = ${probeEmail}`; await admin`delete from users where email = ${probeEmail}`;
  try {
    const { userId } = await withTenant(tenant.id, (tx) => createEmployee(tx, tenant.id, { firstName: "Device", lastName: "Probe", workEmail: probeEmail, joiningDate: todayIn(), password: DEMO_PASSWORD }, null));
    await admin`update users set status = 'active' where id = ${userId}`;
    const cookie = await withTenant(tenant.id, (tx) => createTrustedDevice(tx, tenant.id, userId));
    assert.equal(await withTenant(tenant.id, (tx) => checkTrustedDevice(tx, userId, cookie)), true);
    assert.equal(await withTenant(tenant.id, (tx) => checkTrustedDevice(tx, arjun.userId, cookie)), false, "bound to the user");
    assert.equal(await withTenant(tenant.id, (tx) => checkTrustedDevice(tx, userId, cookie.slice(0, -2) + "xx")), false, "tampered secret");
    assert.equal(await withTenant(tenant.id, (tx) => checkTrustedDevice(tx, userId, "junk")), false);
    const [{ days }] = await admin<{ days: number }[]>`select round(extract(epoch from expires_at - now()) / 86400)::int as days from auth_tokens where user_id = ${userId} and purpose = 'trusted_device'`;
    assert.equal(days, 30);
    // another tenant can't use it
    const otherId = randomUUID();
    await admin`insert into tenants (id, subdomain, name) values (${otherId}, ${"smoke-" + otherId.slice(0, 8)}, 'Smoke Co')`;
    try { assert.equal(await withTenant(otherId, (tx) => checkTrustedDevice(tx, userId, cookie)), false); } finally { await admin`delete from tenants where id = ${otherId}`; }
    // a password reset forgets remembered devices
    const token = newToken();
    await admin`insert into auth_tokens (tenant_id, user_id, purpose, target, token_hash, expires_at) values (${tenant.id}, ${userId}, 'reset_password', ${probeEmail}, ${sha256(token)}, now() + interval '1 hour')`;
    await setPasswordWithToken(tenant, token, "reset_password", "a fresh monsoon phrase 2026");
    assert.equal(await withTenant(tenant.id, (tx) => checkTrustedDevice(tx, userId, cookie)), false, "revoked on reset");
    // expired tokens don't count
    const c2 = await withTenant(tenant.id, (tx) => createTrustedDevice(tx, tenant.id, userId));
    await admin`update auth_tokens set expires_at = now() - interval '1 minute' where user_id = ${userId} and purpose = 'trusted_device' and consumed_at is null`;
    assert.equal(await withTenant(tenant.id, (tx) => checkTrustedDevice(tx, userId, c2)), false, "expired");
  } finally {
    await admin`delete from outbound_emails where to_email = ${probeEmail}`;
    await admin`delete from employees where work_email = ${probeEmail}`;
    await admin`delete from users where email = ${probeEmail}`;
  }
  ok("remembered device: 30 days, bound to user and tenant, tamper/expiry rejected, revoked on password reset");

  // ---------- setup wizard on a brand-new tenant ----------
  const sub = "smoke-setup-" + randomUUID().slice(0, 6);
  const fresh = await provisionTenant({ company: "Smoke Setup Pvt Ltd", subdomain: sub, firstName: "Nisha", lastName: "Rao", email: `nisha@${sub}.test`, password: DEMO_PASSWORD });
  try {
    const ft = { id: fresh.tenantId, name: "Smoke Setup Pvt Ltd", status: "trial", subdomain: sub };
    const owner = await withTenant(ft.id, async (tx) => {
      const [e] = await tx<{ id: string }[]>`select id from employees where user_id = ${fresh.userId}`;
      return { tenant: ft, userId: fresh.userId, employeeId: e.id, name: "Nisha Rao", email: "", title: null, roles: ["global_admin"], permissions: new Set(["*"]), grants: [{ permissions: ["*"], scopes: [] }] } as Actor;
    });
    const hr = { ...owner, permissions: new Set(["employees.write", "settings.org"]), grants: [{ permissions: ["employees.write", "settings.org"], scopes: [] }] } as Actor;

    await withTenant(ft.id, async (tx) => {
      const s0 = await setup.setupSummary(tx, owner);
      assert.ok(s0 && s0.autoOpen && s0.state.status === "pending" && s0.next === "company", "new tenant: dashboard sends the owner to /setup");
      assert.equal(await setup.setupSummary(tx, hr), null, "only Global admins see the checklist");
      await assert.rejects(setup.setupData(tx, hr), /Global admin/);
      await assert.rejects(setup.saveCompany(tx, hr, { name: "X Ltd" }), /Global admin/);
      await assert.rejects(setup.finishSetup(tx, hr), /Global admin/);
      assert.equal((await lastAudit(tx, "tenant", "create")).actor_user_id, owner.userId, "signup is in the audit log");
    });
    await withTenant(ft.id, async (tx) => {
      await setup.openSetup(tx, owner);
      await setup.openSetup(tx, owner);
      const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from audit_logs where action = 'setup.start'`;
      assert.equal(n, 1, "opening twice is idempotent");
      const s1 = await setup.setupSummary(tx, owner);
      assert.ok(s1 && !s1.autoOpen && s1.state.status === "started", "no redirect once started; checklist stays");
    });
    await withTenant(ft.id, async (tx) => {
      await assert.rejects(setup.saveCompany(tx, owner, { name: "Smoke Setup Pvt Ltd", pan: "ABC123" }), (e: AppError) => e.field === "pan");
      await assert.rejects(setup.saveCompany(tx, owner, { name: "Smoke Setup Pvt Ltd", pincode: "12345" }), (e: AppError) => e.field === "pincode");
    });
    await withTenant(ft.id, async (tx) => {
      await setup.saveCompany(tx, owner, { name: "Smoke Setup Private Limited", pan: "aaacs1234k", tan: "BLRS12345A", line1: "12 MG Road", city: "Bengaluru", state: "KA", pincode: "560001" });
      const [le] = await tx<{ name: string; pan: string; tan: string; address: Record<string, string> }[]>`select name, pan, tan, address from legal_entities`;
      assert.deepEqual(le, { name: "Smoke Setup Private Limited", pan: "AAACS1234K", tan: "BLRS12345A", address: { line1: "12 MG Road", city: "Bengaluru", state: "KA", pincode: "560001" } });
      const a = await lastAudit(tx, "legal_entities", "update");
      assert.deepEqual(a.diff?.pan, { old: null, new: "AAACS1234K" });
      // list steps reuse the settings services
      const d0 = await setup.setupData(tx, owner);
      await org.saveMaster(tx, owner, "locations", d0.locations[0].id, { name: "Head office", stateCode: "KA" });
      await org.saveMaster(tx, owner, "locations", null, { name: "Pune", stateCode: "MH" });
      await setup.completeStep(tx, owner, "locations", "done");
      await setup.completeStep(tx, owner, "departments", "skipped");
      await assert.rejects(setup.completeStep(tx, owner, "company", "done"), /Save this step/);
    });
    // "done" needs at least one entry
    await admin`update employees set designation_id = null where tenant_id = ${ft.id}`;
    await admin`delete from designations where tenant_id = ${ft.id}`;
    await withTenant(ft.id, async (tx) => {
      await assert.rejects(setup.completeStep(tx, owner, "designations", "done"), /at least one designation/);
      await org.saveMaster(tx, owner, "designations", null, { name: "Founder" });
      await setup.completeStep(tx, owner, "designations", "done");
      const s = (await setup.setupSummary(tx, owner))!;
      assert.deepEqual(Object.fromEntries(Object.entries(s.state.steps).map(([k, v]) => [k, v!.status])), { company: "done", locations: "done", departments: "skipped", designations: "done" });
      assert.equal(s.next, "leave"); assert.equal(s.progress.done, 3);
    });
    // leave basics: April year, new quotas; the owner's opening balances follow
    await withTenant(ft.id, async (tx) => {
      await assert.rejects(setup.saveLeaveBasics(tx, owner, { yearStart: "jul", quotas: { CL: 1, SL: 1, EL: 1 } }), (e: AppError) => e.field === "yearStart");
      await assert.rejects(setup.saveLeaveBasics(tx, owner, { yearStart: "apr", quotas: { CL: 100, SL: 1, EL: 1 } }), (e: AppError) => e.field === "CL");
      const r = await setup.saveLeaveBasics(tx, owner, { yearStart: "apr", quotas: { CL: 10, SL: 6, EL: 18 } });
      assert.equal(r.resynced, 1);
      const rules = await tx<{ code: string; q: string }[]>`select t.code, r.yearly_quota::text as q from leave_plan_rules r join leave_types t on t.id = r.leave_type_id where t.code in ('CL','SL','EL') order by t.code`;
      assert.deepEqual(rules.map((x) => [x.code, Number(x.q)]), [["CL", 10], ["EL", 18], ["SL", 6]]);
      const [p] = await tx<{ year_start: string }[]>`select year_start from leave_plans where is_default`;
      assert.equal(p.year_start, "apr");
      const bal = await leave.balances(tx, owner.employeeId);
      const today = todayIn();
      const cycleStart = `${Number(today.slice(5, 7)) >= 4 ? today.slice(0, 4) : Number(today.slice(0, 4)) - 1}-04-01`;
      assert.equal(bal.find((b) => b.code === "CL")!.credited, proratedOpening(10, today > cycleStart ? today : cycleStart, 4));
      const from = today > cycleStart ? today : cycleStart;
      const count = async () => (await tx<{ n: number }[]>`select count(*)::int as n from leave_ledger where employee_id = ${owner.employeeId}`)[0].n;
      const rows = await count();
      assert.equal((await setup.saveLeaveBasics(tx, owner, { yearStart: "apr", quotas: { CL: 10, SL: 6, EL: 18 } })).resynced, 0, "saving the same values changes nothing");
      assert.equal(await count(), rows);
      await setup.saveLeaveBasics(tx, owner, { yearStart: "apr", quotas: { CL: 4, SL: 6, EL: 18 } });
      assert.equal((await leave.balances(tx, owner.employeeId)).find((b) => b.code === "CL")!.credited, proratedOpening(4, from, 4), "lower quota trims via an adjustment");
      await setup.saveLeaveBasics(tx, owner, { yearStart: "jan", quotas: { CL: 10, SL: 6, EL: 18 } });
      const jan = `${today.slice(0, 4)}-01-01`;
      assert.equal((await leave.balances(tx, owner.employeeId)).find((b) => b.code === "CL")!.credited, proratedOpening(10, today > jan ? today : jan, 1), "back to January works too");
      await setup.saveLeaveBasics(tx, owner, { yearStart: "apr", quotas: { CL: 10, SL: 6, EL: 18 } });
      assert.equal((await leave.balances(tx, owner.employeeId)).find((b) => b.code === "CL")!.credited, proratedOpening(10, from, 4));
      assert.ok(await lastAudit(tx, "leave_plan", "update"));
    });
    // once someone has requested leave, the year start is locked (quotas still editable; their balance is kept)
    await withTenant(ft.id, async (tx) => {
      const [cl] = await tx<{ id: string }[]>`select id from leave_types where code = 'CL'`;
      let d = addDaysISO(todayIn(), 3); while (["sat", "sun"].includes(weekday(d))) d = addDaysISO(d, 1);
      await leave.apply(tx, owner, { leaveTypeId: cl.id, from: d, to: d, fromPart: "full", toPart: "full" });
      await assert.rejects(setup.saveLeaveBasics(tx, owner, { yearStart: "jan", quotas: { CL: 10, SL: 6, EL: 18 } }), /can't change now/);
      const before = (await leave.balances(tx, owner.employeeId)).find((b) => b.code === "CL")!.credited;
      const r = await setup.saveLeaveBasics(tx, owner, { yearStart: "apr", quotas: { CL: 12, SL: 6, EL: 18 } });
      assert.ok(r.kept >= 1);
      assert.equal((await leave.balances(tx, owner.employeeId)).find((b) => b.code === "CL")!.credited, before, "people who used leave keep their balance");
      throw new Error("rollback");
    }).catch(rollback);
    // people + invite + finish
    await withTenant(ft.id, async (tx) => {
      await createEmployee(tx, ft.id, { firstName: "Ravi", lastName: "Das", workEmail: `ravi@${sub}.test`, joiningDate: todayIn() }, owner.userId);
      await setup.completeStep(tx, owner, "people", "done");
      const d = await setup.setupData(tx, owner);
      assert.equal(d.people.total, 2); assert.deepEqual(d.people.notInvited.map((p) => p.name), ["Ravi Das"]);
      const r = await setup.inviteEveryone(tx, owner);
      assert.equal(r.sent, 1);
      assert.equal((await setup.setupData(tx, owner)).people.notInvited.length, 0);
      assert.equal((await setup.inviteEveryone(tx, owner)).sent, 0, "inviting again sends nothing new");
      await setup.completeStep(tx, owner, "company", "skipped");
      assert.equal((await setup.setupSummary(tx, owner))!.state.steps.company?.status, "done", "skipping a done step keeps it done");
      await setup.finishSetup(tx, owner);
      await setup.finishSetup(tx, owner);
      const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from audit_logs where action = 'setup.finish'`;
      assert.equal(n, 1);
      assert.equal(await setup.setupSummary(tx, owner), null, "checklist gone once finished");
      await setup.openSetup(tx, owner);
      const [st] = await tx<{ s: string }[]>`select setup_state->>'status' as s from tenants`;
      assert.equal(st.s, "done", "re-opening the wizard doesn't un-finish it");
      const steps = await tx<{ step: string }[]>`select diff->>'step' as step from audit_logs where action = 'setup.step' order by created_at`;
      assert.ok(steps.length >= 6);
    });
    // isolation: the new tenant's setup and audit trail are invisible to Acme and vice versa
    await withTenant(tenant.id, async (tx) => {
      const [{ s }] = await tx<{ s: string }[]>`select setup_state->>'status' as s from tenants`;
      assert.equal(s, "done");
      const acmeItems = await listAudit(tx, asha, {}, null, 500);
      assert.ok(!acmeItems.items.some((i) => i.actor_user_id === owner.userId));
      const [{ c }] = await tx<{ c: number }[]>`select count(*)::int as c from tenants`;
      assert.equal(c, 1, "a tenant sees only itself");
    });
    await withTenant(ft.id, async (tx) => {
      const items = (await listAudit(tx, owner, {}, null, 500)).items;
      assert.ok(items.length > 0 && items.every((i) => i.actor_user_id === owner.userId || i.actor_user_id === null));
      await assert.rejects(tx.savepoint((sp) => sp`insert into audit_logs (tenant_id, entity_type, action) values (${tenant.id}, 'x', 'y')`), /row-level security/);
      await assert.rejects(tx.savepoint((sp) => sp`update tenants set setup_state = '{}' where id = ${tenant.id} returning id`.then((r) => { if (!r.length) throw new Error("row-level security hid it"); })), /row-level security/);
    });
    ok("setup wizard: new tenant auto-opens once, Global admin only, company/locations/designations/leave/people/invite steps, skip & resume, finish is final, isolated per tenant");
  } finally {
    await admin`delete from tenants where id = ${fresh.tenantId}`;
  }

  // the seeded demo company is already set up
  await withTenant(tenant.id, async (tx) => assert.equal(await setup.setupSummary(tx, asha), null));
  ok("demo tenant: setup finished, no checklist or redirect");

  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await admin.end(); await sql.end(); }).catch(async (e) => { console.error("\nFAILED:", e); await admin.end(); await sql.end(); process.exit(1); });
