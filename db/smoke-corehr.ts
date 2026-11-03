/**
 * Smoke test for core HR + approvals settings + the daily scheduler against the seeded demo tenant (run `pnpm db:seed`
 * first): permissions and scopes (company-wide settings need an unscoped grant, nobody acts on themselves), approval
 * conditions / delegation / timers / bulk decisions, custom fields, profile sections and identity encryption, the
 * add-employee wizard, probation, job changes, rehire, Excel bulk update, directory + org chart, the ID-card public route,
 * the scheduler's lock and idempotency, and tenant isolation. Everything runs in rolled-back transactions.
 *   pnpm smoke:corehr
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import ExcelJS from "exceljs";
import { NextRequest } from "next/server";
import { withTenant, sql, AppError, type Tx } from "@/server/db";
import * as leave from "@/server/modules/leave/service";
import * as appr from "@/server/modules/corehr/approvals-admin";
import * as fields from "@/server/modules/corehr/custom-fields";
import * as sections from "@/server/modules/corehr/profile-sections";
import * as people from "@/server/modules/corehr/people";
import * as life from "@/server/modules/corehr/lifecycle";
import * as bulk from "@/server/modules/corehr/bulk-update";
import { runTenant } from "@/server/modules/corehr/scheduler";
import { idCardToken, verifyIdCardToken } from "@/server/modules/corehr/id-token";
import { changeJob } from "@/server/modules/employees/profile";
import { proxy } from "@/proxy";
import { addDaysISO, todayIn, weekday } from "@/lib/dates";
import type { Actor } from "@/server/auth/session";
import type { Scope } from "@/server/auth/catalog";
import { DEMO_SUBDOMAIN } from "./demo";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const rollback = async (tenantId: string, fn: (tx: Tx) => Promise<void>) =>
  withTenant(tenantId, async (tx) => { await fn(tx); throw new Error("rollback"); }).catch((e) => { if (e.message !== "rollback") throw e; });
const fails = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: unknown) => e instanceof AppError && re.test(e.message));
const sp = <T,>(tx: Tx, fn: (t: Tx) => Promise<T>) => tx.savepoint((s) => fn(s as unknown as Tx));

async function main() {
  const [t] = await sql<{ id: string }[]>`select id from tenant_by_subdomain(${DEMO_SUBDOMAIN})`;
  assert.ok(t, "demo tenant exists (run pnpm db:seed)");
  const tenant = { id: t.id, name: "Acme Technologies", status: "trial", subdomain: DEMO_SUBDOMAIN };
  const staff = await withTenant(tenant.id, (tx) => tx<{ id: string; user_id: string; display_name: string; first_name: string; department_id: string }[]>`select id, user_id, display_name, first_name, department_id from employees`);
  const actor = (first: string, permissions: string[] = [], scopes: Scope[] = []): Actor => {
    const e = staff.find((x) => x.first_name === first)!;
    assert.ok(e, `${first} exists`);
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(permissions), grants: permissions.length ? [{ permissions, scopes }] : [] };
  };
  const id = (first: string) => staff.find((x) => x.first_name === first)!.id;
  const [eng] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from departments where name = 'Engineering'`);
  const [sales] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from departments where name = 'Sales'`);
  const HR = ["employees.read", "employees.write", "settings.org", "settings.approvals", "leave.admin", "attendance.admin"];
  const asha = actor("Asha", ["*"]), priya = actor("Priya", HR);
  const engHr = actor("Karan", HR, [{ type: "department", ids: [eng.id] }]);   // scoped HR: Engineering only
  const rohan = actor("Rohan"), arjun = actor("Arjun"), meera = actor("Meera"), sneha = actor("Sneha"), karan = actor("Karan"), vikram = actor("Vikram");
  const today = todayIn();
  let workday = addDaysISO(today, 40); while (["sat", "sun"].includes(weekday(workday))) workday = addDaysISO(workday, 1);   // clear of seeded leave
  const [cl] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from leave_types where code = 'CL'`);
  const stepFor = async (tx: Tx, entityId: string) => (await tx<{ id: string; approver: string; status: string; delegated_from: string | null }[]>`
    select s.id, s.approver_employee_id as approver, s.status, s.delegated_from from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_id = ${entityId} and s.status = 'pending'`)[0];
  const applyLeave = (tx: Tx, who: Actor, from = workday) => leave.apply(tx, who, { leaveTypeId: cl.id, from, to: from, fromPart: "full", toPart: "full" });

  // ---------------------------------------------------------------- permissions: unscoped company settings, no self-service
  await rollback(tenant.id, async (tx) => {
    const wf = { entityType: "leave", name: "x", conditions: [], levels: [{ approver: "manager" as const }], autoApproveAfterDays: null, escalation: null, priority: 0, isActive: true };
    await fails(sp(tx, (s) => appr.saveWorkflow(s, engHr, null, wf)), /access/);
    await fails(sp(tx, (s) => appr.saveWorkflow(s, arjun, null, wf)), /access/);
    await fails(sp(tx, (s) => appr.listWorkflows(s, engHr)), /access/);
    const def = { label: "Shoe size", section: "Other", type: "number", required: false, viewRoles: [], editRoles: [] };
    await fails(sp(tx, (s) => fields.saveDef(s, engHr, null, def)), /access/);
    await fails(sp(tx, (s) => life.saveGroupType(s, engHr, null, "Guild")), /access/);
    await fails(sp(tx, (s) => life.saveProbationPolicy(s, arjun, null, { name: "p", durationDays: 10, autoConfirm: false })), /access/);
    await fails(sp(tx, (s) => people.directoryExport(s, arjun, {})), /access/);
    const scoped = await people.directoryExport(tx, engHr, {});
    const engNames = staff.filter((x) => x.department_id === eng.id).map((x) => x.display_name).sort();
    assert.deepEqual(scoped.rows.map((r) => r[1]).sort(), engNames, "scoped HR exports only their department");
    // nobody verifies their own ID, confirms their own probation, or bulk-updates themselves
    const mine = await sections.saveIdentity(tx, priya, priya.employeeId, { kind: "pan", number: "AAAPN1111A" });
    await fails(sp(tx, (s) => sections.verifyIdentity(s, priya, mine.id, true)), /your own/);
    await tx`update employees set probation_status = 'in_probation', probation_end_date = ${today} where id = ${priya.employeeId}`;
    await fails(sp(tx, (s) => life.bulkProbation(s, priya, { employeeIds: [priya.employeeId], action: "confirm" })), /your own/);
    assert.equal((await life.probationList(tx, priya)).some((r) => r.id === priya.employeeId), false, "your own probation isn't on your list");
  });
  ok("permissions: approval/field/group settings need an unscoped grant; employees can't export; scoped export; no self-verify, self-confirm");

  // ---------------------------------------------------------------- approval workflows: conditions pick the chain
  await rollback(tenant.id, async (tx) => {
    await fails(sp(tx, (s) => appr.saveWorkflow(s, asha, null, { entityType: "leave", name: "bad", conditions: [{ field: "department", values: [randomUUID()] }], levels: [], autoApproveAfterDays: null, escalation: null, priority: 0, isActive: true })), /no longer exist/);
    await fails(sp(tx, (s) => appr.saveWorkflow(s, asha, null, { entityType: "leave", name: "bad", conditions: [], levels: [{ approver: "employee", id: randomUUID() }], autoApproveAfterDays: null, escalation: null, priority: 0, isActive: true })), /works here/);
    await fails(sp(tx, (s) => appr.saveWorkflow(s, asha, null, { entityType: "nope", name: "bad", conditions: [], levels: [], autoApproveAfterDays: null, escalation: null, priority: 0, isActive: true })), /what this workflow/);
    await fails(sp(tx, (s) => appr.saveWorkflow(s, asha, null, { entityType: "leave", name: "bad", conditions: [], levels: [{ approver: "manager" }], autoApproveAfterDays: 2, escalation: { afterDays: 3, to: { approver: "manager" } }, priority: 0, isActive: true })), /before auto-approval/);
    // the seeded leave plan has no own chain for CL; a Sales-only workflow sends Sneha's leave to HR, not her manager
    await tx`update leave_plan_rules set approval = '{}' where leave_type_id = ${cl.id}`;
    await appr.saveWorkflow(tx, asha, null, { entityType: "leave", name: "Sales: HR approves", conditions: [{ field: "department", values: [sales.id] }], levels: [{ approver: "role", role: "hr_admin" }], autoApproveAfterDays: null, escalation: null, priority: 50, isActive: true });
    const s1 = await applyLeave(tx, sneha);
    assert.equal((await stepFor(tx, s1.id)).approver, id("Priya"), "Sales → HR admin");
    const a1 = await applyLeave(tx, arjun);
    assert.equal((await stepFor(tx, a1.id)).approver, id("Rohan"), "everyone else → company default (manager)");
    const [wf] = await tx<{ workflow_id: string | null }[]>`select workflow_id from approval_requests where entity_id = ${s1.id}`;
    assert.ok(wf.workflow_id, "the request records which workflow it used");
  });
  ok("workflows: ids resolved in the tenant, timers validated, conditions route Sales leave to HR while others keep the default chain");

  // ---------------------------------------------------------------- delegation, relieved and on-leave approvers
  await rollback(tenant.id, async (tx) => {
    await tx`update leave_plan_rules set approval = '{}' where leave_type_id = ${cl.id}`;
    const before = await applyLeave(tx, arjun);
    await fails(sp(tx, (s) => appr.saveDelegation(s, arjun, { delegatorId: id("Rohan"), delegateId: id("Meera"), from: today, to: null })), /your own/);
    await fails(sp(tx, (s) => appr.saveDelegation(s, rohan, { delegatorId: id("Rohan"), delegateId: id("Rohan"), from: today, to: null })), /someone else/);
    const d = await appr.saveDelegation(tx, rohan, { delegatorId: id("Rohan"), delegateId: id("Meera"), from: today, to: addDaysISO(today, 3) });
    assert.ok(d.moved >= 1, "waiting requests move to the delegate at once");
    const moved = await stepFor(tx, before.id);
    assert.equal(moved.approver, id("Meera")); assert.equal(moved.delegated_from, id("Rohan"));
    await fails(sp(tx, (s) => appr.saveDelegation(s, rohan, { delegatorId: id("Rohan"), delegateId: id("Vikram"), from: addDaysISO(today, 1), to: addDaysISO(today, 2) })), /already a hand-over/);
    const after = await applyLeave(tx, vikram);
    assert.equal((await stepFor(tx, after.id)).approver, id("Meera"), "new requests go to the delegate");
    const own = await applyLeave(tx, meera);
    assert.equal((await stepFor(tx, own.id)).approver, id("Rohan"), "the delegate never gets her own request");
    await fails(sp(tx, (s) => appr.cancelDelegation(s, arjun, d.id)), /your own/);
    await appr.cancelDelegation(tx, rohan, d.id);
    // Rohan on approved leave today → his waiting steps go to his manager (Asha); relieved works the same way
    const again = await applyLeave(tx, arjun, addDaysISO(workday, 7));
    await tx`insert into leave_requests (tenant_id, employee_id, leave_type_id, from_date, to_date, days, status, applied_by) values (${tenant.id}, ${id("Rohan")}, ${cl.id}, ${today}, ${today}, 1, 'approved', ${rohan.userId})`;
    const r = await appr.reassignPending(tx, tenant.id, { date: today });
    assert.ok(r.moved >= 1);
    assert.equal((await stepFor(tx, again.id)).approver, id("Asha"));
    assert.equal((await appr.reassignPending(tx, tenant.id, { date: today })).moved, 0, "idempotent");
    await tx`update employees set status = 'relieved' where id = ${id("Meera")}`;
    await appr.reassignPending(tx, tenant.id, { date: today });
    assert.notEqual((await stepFor(tx, after.id)).approver, id("Meera"), "a relieved approver's steps move on");
  });
  ok("delegation: hand-over moves waiting and new requests (never to the requester), no overlaps, owner-only cancel; on-leave and relieved approvers reassigned once");

  // ---------------------------------------------------------------- timers + bulk decisions + digest
  await rollback(tenant.id, async (tx) => {
    await tx`update leave_plan_rules set approval = '{}' where leave_type_id = ${cl.id}`;
    await appr.saveWorkflow(tx, asha, null, { entityType: "leave", name: "Timed", conditions: [], levels: [{ approver: "manager" }], autoApproveAfterDays: 3, escalation: { afterDays: 1, to: { approver: "role", role: "hr_admin" } }, priority: 90, isActive: true });
    const r = await applyLeave(tx, arjun);
    const now = new Date();
    await tx`update approval_requests set created_at = now() - interval '36 hours' where entity_id = ${r.id}`;
    assert.equal((await appr.runApprovalTimers(tx, tenant.id, now)).escalated, 1);
    assert.equal((await stepFor(tx, r.id)).approver, id("Priya"), "escalated to HR");
    assert.equal((await appr.runApprovalTimers(tx, tenant.id, now)).escalated, 0, "escalates once");
    await tx`update approval_requests set created_at = now() - interval '4 days' where entity_id = ${r.id}`;
    assert.equal((await appr.runApprovalTimers(tx, tenant.id, now)).approved, 1);
    const [q] = await tx<{ status: string }[]>`select status from leave_requests where id = ${r.id}`;
    assert.equal(q.status, "approved", "auto-approval runs the leave effects");
    assert.equal((await appr.runApprovalTimers(tx, tenant.id, now)).approved, 0);
    const [au] = await tx<{ n: number }[]>`select count(*)::int as n from audit_logs where action = 'approval.auto_approved'`;
    assert.ok(au.n >= 1);
    // bulk: Rohan decides two of his own; a step that isn't his fails alone; declining needs a reason
    const x1 = await applyLeave(tx, meera), x2 = await applyLeave(tx, vikram), x3 = await applyLeave(tx, sneha);
    const ids = [(await stepFor(tx, x1.id)).id, (await stepFor(tx, x2.id)).id, (await stepFor(tx, x3.id)).id];
    await fails(sp(tx, (s) => appr.bulkDecide(s, rohan, ids, "rejected")), /comment/);
    const b = await appr.bulkDecide(tx, rohan, ids, "approved");
    assert.equal(b.done, 2); assert.equal(b.failed.length, 1);
    assert.equal((await tx<{ status: string }[]>`select status from leave_requests where id = ${x1.id}`)[0].status, "approved");
    assert.equal((await tx<{ status: string }[]>`select status from leave_requests where id = ${x3.id}`)[0].status, "pending", "Sneha's request isn't Rohan's to decide");
    const dg = await appr.approverDigest(tx, tenant.id);
    assert.ok(dg.sent >= 1);
    const [mail] = await tx<{ n: number }[]>`select count(*)::int as n from outbound_emails where kind = 'approval_digest' and status = 'queued'`;
    assert.equal(mail.n, dg.sent, "one digest per approver with something waiting");
  });
  ok("timers: escalate once after N days, auto-approve after M days (effects applied, audited); bulk approve skips others' steps; digest per approver");

  // ---------------------------------------------------------------- custom fields
  await rollback(tenant.id, async (tx) => {
    const d = await fields.saveDef(tx, asha, null, { label: "Shirt size", section: "Other details", type: "select", options: ["S", "M"], required: false, viewRoles: [], editRoles: ["employee"] });
    assert.notEqual(d.key, "t_shirt_size");
    await fails(sp(tx, (s) => fields.savePersonFields(s, arjun, arjun.employeeId, { [d.key!]: "M" })), /isn't available/);   // still a draft
    await fields.setDefStatus(tx, asha, d.id, "published");
    await fails(sp(tx, (s) => fields.saveDef(s, asha, d.id, { label: "Shirt size", section: "Other details", type: "text", required: false, viewRoles: [], editRoles: [] })), /keeps its type/);
    await fails(sp(tx, (s) => fields.deleteDef(s, asha, d.id)), /Only draft/);
    await fails(sp(tx, (s) => fields.savePersonFields(s, arjun, arjun.employeeId, { [d.key!]: "XXL" })), /must be one of/);
    assert.equal((await fields.savePersonFields(tx, arjun, arjun.employeeId, { [d.key!]: "m" })).changed, 1);
    const [{ custom }] = await tx<{ custom: Record<string, unknown> }[]>`select custom from employees where id = ${arjun.employeeId}`;
    assert.equal(custom[d.key!], "M", "options are stored in their defined spelling");
    const defs = await fields.listDefs(tx, { published: true });
    const cost = defs.find((x) => x.label === "Cost centre")!;
    await fails(sp(tx, (s) => fields.savePersonFields(s, arjun, arjun.employeeId, { [cost.key]: "X" })), /can't change/);
    await fails(sp(tx, (s) => fields.savePersonFields(s, karan, arjun.employeeId, { [d.key!]: "S" })), /can't edit/);
    assert.deepEqual(await fields.personFields(tx, karan, arjun.employeeId), [], "colleagues see no custom fields");
    const mgrView = await fields.personFields(tx, rohan, arjun.employeeId);
    assert.ok(mgrView.some((f) => f.label === "Cost centre") && !mgrView.some((f) => f.label === "Emergency contact number"), "managers see what's shared with managers");
    // a required field makes the wizard (and import) insist on it
    const req = await fields.saveDef(tx, asha, null, { label: "Employee category", section: "Other details", type: "text", required: true, viewRoles: [], editRoles: [] });
    await fields.setDefStatus(tx, asha, req.id, "published");
    await fails(sp(tx, (s) => people.addEmployee(s, priya, { firstName: "Req", workEmail: "req@acme.test", joiningDate: today })), /Employee category is required/);
    await fails(sp(tx, (s) => fields.setDefStatus(s, asha, req.id, "draft")), /can't be moved/);
  });
  ok("custom fields: draft → published → archived, type fixed once live, options validated, edit roles enforced, colleagues see none, required in the wizard");

  // ---------------------------------------------------------------- profile sections + identity encryption
  await rollback(tenant.id, async (tx) => {
    assert.equal(await sections.profileSections(tx, karan, arjun.employeeId), null, "colleagues see none of it");
    const mgr = await sections.profileSections(tx, rohan, arjun.employeeId);
    assert.ok(mgr && mgr.relations.length >= 1 && mgr.identities === null && !mgr.canEdit, "managers see family, never ID numbers, can't edit");
    await fails(sp(tx, (s) => sections.saveSectionRow(s, rohan, arjun.employeeId, "education", null, { degree: "MBA" })), /can't edit/);
    await fails(sp(tx, (s) => sections.saveSectionRow(s, arjun, arjun.employeeId, "experience", null, { company: "X", startDate: "2020-01-01", endDate: "2019-01-01" })), /before the start/);
    await fails(sp(tx, (s) => sections.saveIdentity(s, arjun, arjun.employeeId, { kind: "pan", number: "12345" })), /ABCDE1234F/);
    await fails(sp(tx, (s) => sections.saveIdentity(s, arjun, arjun.employeeId, { kind: "aadhaar", number: "234123412345" })), /check digit/);
    await fails(sp(tx, (s) => sections.saveIdentity(s, vikram, vikram.employeeId, { kind: "pan", number: "abcpr 1234 k" })), /already has this PAN/);
    const [row] = await tx<{ number_enc: Uint8Array; number_last4: string }[]>`select number_enc, number_last4 from employee_identities where employee_id = ${arjun.employeeId} and kind = 'pan'`;
    assert.ok(!Buffer.from(row.number_enc).toString("latin1").includes("ABCPR1234K"), "stored encrypted"); assert.equal(row.number_last4, "234K");
    const mine = (await sections.profileSections(tx, arjun, arjun.employeeId))!.identities!.find((i) => i.kind === "pan")!;
    assert.equal(mine.masked, "XXXXXX234K");
    await fails(sp(tx, (s) => sections.revealIdentity(s, arjun, mine.id)), /Only HR/);
    const [salesId] = await tx<{ id: string }[]>`select i.id from employee_identities i where i.employee_id = ${meera.employeeId}`;
    await fails(sp(tx, (s) => sections.revealIdentity(s, actor("Karan", HR, [{ type: "department", ids: [sales.id] }]), salesId.id)), /Only HR/);
    assert.equal((await sections.revealIdentity(tx, priya, mine.id)).number, "ABCPR1234K");
    const [rev] = await tx<{ n: number }[]>`select count(*)::int as n from audit_logs where action = 'identity.reveal' and entity_id = ${arjun.employeeId}`;
    assert.equal(rev.n, 1, "every reveal is audited");
    // copying a ciphertext onto someone else's row doesn't decrypt (bound to tenant + person + kind)
    await tx`delete from employee_identities where employee_id = ${vikram.employeeId} and kind = 'pan'`;   // the payroll seed gives everyone a PAN
    await tx`insert into employee_identities (tenant_id, employee_id, kind, number_enc, number_last4) values (${tenant.id}, ${vikram.employeeId}, 'pan', ${row.number_enc}, '234K')`;
    const [stolen] = await tx<{ id: string }[]>`select id from employee_identities where employee_id = ${vikram.employeeId} and kind = 'pan'`;
    await assert.rejects(sp(tx, (s) => sections.revealIdentity(s, priya, stolen.id)));
    await sections.verifyIdentity(tx, priya, mine.id, true);
    await fails(sp(tx, (s) => sections.saveIdentity(s, arjun, arjun.employeeId, { kind: "pan", number: "ABCPR1234L" })), /verified/);
    await fails(sp(tx, (s) => sections.deleteIdentity(s, arjun, mine.id)), /only be removed by HR/);
    await sections.saveIdentity(tx, priya, arjun.employeeId, { kind: "pan", number: "ABCPR1234L" });
    assert.equal((await sections.profileSections(tx, arjun, arjun.employeeId))!.identities!.find((i) => i.kind === "pan")!.verified, false, "a changed number needs verifying again");
  });
  ok("profile sections: self + HR edit, managers read without IDs, colleagues nothing; PAN/Aadhaar validated, encrypted, masked, unique; HR-only audited reveal; verified IDs locked");

  // ---------------------------------------------------------------- add-employee wizard
  const otherId = randomUUID();
  await admin`insert into tenants (id, subdomain, name) values (${otherId}, ${"smoke-" + otherId.slice(0, 8)}, 'Smoke Co')`;
  try {
    const [foreignDept] = await withTenant(otherId, (tx) => tx<{ id: string }[]>`insert into departments (tenant_id, name) values (${otherId}, 'Foreign') returning id`);
    await rollback(tenant.id, async (tx) => {
      const [night] = await tx<{ id: string }[]>`select id from shifts where code = 'NIGHT'`;
      const [std] = await tx<{ id: string; duration_days: number }[]>`select id, duration_days from probation_policies where not auto_confirm limit 1`;
      const shirt = (await fields.listDefs(tx, { published: true })).find((d) => d.label === "T-shirt size")!;
      await fails(sp(tx, (s) => people.addEmployee(s, priya, { firstName: "Zed", workEmail: "zed@acme.test", joiningDate: today, departmentId: foreignDept.id })), /doesn't exist/);
      await fails(sp(tx, (s) => people.addEmployee(s, engHr, { firstName: "Zed", workEmail: "zed@acme.test", joiningDate: today, departmentId: sales.id })), /departments and locations you manage/);
      await fails(sp(tx, (s) => people.addEmployee(s, priya, { firstName: "Zed", workEmail: "zed@acme.test", joiningDate: today, compensation: { structureId: randomUUID(), ctcPaise: 100 } })), /payroll access/);
      await fails(sp(tx, (s) => people.addEmployee(s, priya, { firstName: "Zed", workEmail: "zed@acme.test", joiningDate: today, managerId: id("Nikhil") })), /manager who works here/);
      const z = await people.addEmployee(tx, engHr, {
        firstName: "Zed", lastName: "Kapoor", workEmail: "zed@acme.test", joiningDate: today, departmentId: eng.id, managerId: id("Rohan"), l2ManagerId: id("Asha"),
        workerType: "intern", shiftId: night.id, probationPolicyId: std.id, custom: { [shirt.key]: "L" },
      });
      const [e] = await tx<{ probation_end_date: string; probation_status: string; worker_type: string; custom: Record<string, unknown>; l2_manager_id: string }[]>`
        select probation_end_date::text, probation_status, worker_type, custom, l2_manager_id from employees where id = ${z.employeeId}`;
      assert.equal(e.probation_end_date, addDaysISO(today, std.duration_days)); assert.equal(e.probation_status, "in_probation");
      assert.equal(e.worker_type, "intern"); assert.equal(e.custom[shirt.key], "L"); assert.equal(e.l2_manager_id, id("Asha"));
      const [sa] = await tx<{ shift_id: string }[]>`select shift_id from shift_assignments where employee_id = ${z.employeeId}`;
      assert.equal(sa.shift_id, night.id, "the chosen shift, not the default");
      const [bal] = await tx<{ n: number }[]>`select count(*)::int as n from leave_ledger where employee_id = ${z.employeeId}`;
      assert.ok(bal.n > 0, "opening leave credited");
      // with payroll access the salary starts on the joining date
      const [st] = await tx<{ id: string }[]>`select id from salary_structures limit 1`;
      const pay = actor("Priya", [...HR, "payroll.admin"]);
      const y = await people.addEmployee(tx, pay, { firstName: "Yash", workEmail: "yash@acme.test", joiningDate: today, compensation: { structureId: st.id, ctcPaise: 60000000 } });
      const [sal] = await tx<{ effective_from: string; ctc_paise: string }[]>`select effective_from::text, ctc_paise::text from employee_salaries where employee_id = ${y.employeeId}`;
      assert.equal(sal.effective_from, today); assert.equal(sal.ctc_paise, "60000000");
    });
    ok("wizard: foreign ids refused, scope enforced, compensation needs payroll access; job, policies, probation end, custom fields, shift, balances and salary saved together");

    // ---------------------------------------------------------------- tenant isolation (same other tenant)
    await rollback(otherId, async (tx) => {
      const [c] = await tx<{ n: string }[]>`select concat_ws('/', (select count(*) from approval_delegations), (select count(*) from scheduler_runs), (select count(*) from custom_field_defs),
        (select count(*) from employee_identities), (select count(*) from employee_relations), (select count(*) from groups), (select count(*) from approval_workflows), (select count(*) from probation_policies)) as n`;
      assert.equal(c.n, "0/0/0/0/0/0/0/0");
      await assert.rejects(sp(tx, (s) => s`insert into approval_delegations (tenant_id, delegator_employee_id, delegate_employee_id, from_date) values (${tenant.id}, ${id("Rohan")}, ${id("Meera")}, ${today})`), /row-level security/);
      await assert.rejects(sp(tx, (s) => s`insert into scheduler_runs (tenant_id, job, run_date, status) values (${tenant.id}, 'x', ${today}, 'ok')`), /row-level security/);
      const outsider = { ...asha, tenant: { ...tenant, id: otherId } } as Actor;
      assert.equal(await sections.profileSections(tx, outsider, arjun.employeeId).catch(() => null), null);
      assert.equal((await people.orgChildren(tx, null)).length, 0);
      const u = await tx`update employee_identities set verified_at = now() where employee_id = ${arjun.employeeId}`;
      assert.equal(u.count, 0);
      await fails(sp(tx, (s) => appr.saveDelegation(s, outsider, { delegatorId: outsider.employeeId, delegateId: id("Meera"), from: today, to: null })), /work here/);
    });
    ok("another tenant sees none of Acme's delegations, scheduler runs, fields, IDs, family, groups, workflows or policies and can't write into them");

    // ---------------------------------------------------------------- ID card + public route
    await rollback(tenant.id, async (tx) => {
      const card = await people.idCard(tx, arjun, arjun.employeeId);
      assert.ok(card && card.qrSvg.startsWith("<svg") && card.verifyUrl.includes("/verify/id/"));
      assert.equal(await people.idCard(tx, karan, arjun.employeeId), null, "colleagues can't open someone's card");
      const token = card.verifyUrl.split("/verify/id/")[1];
      const secret = people.verifySecret();
      assert.equal(verifyIdCardToken(secret, tenant.id, token), arjun.employeeId);
      assert.equal(verifyIdCardToken(secret, otherId, token), null, "a token never resolves in another company");
      assert.equal(verifyIdCardToken(secret, tenant.id, token.slice(0, -2) + "xx"), null, "tampered token refused");
      assert.equal(verifyIdCardToken(secret, tenant.id, idCardToken("other-secret", tenant.id, arjun.employeeId)), null);
      assert.equal(await withTenant(otherId, (o) => people.verifiedCard(o, arjun.employeeId)), null, "the public lookup runs under the subdomain's tenant only");
      const pub = await people.verifiedCard(tx, arjun.employeeId);
      assert.deepEqual(Object.keys(pub!).sort(), ["company", "designation", "display_name", "employee_number", "status"], "no contact details on the public page");
    });
    const root = process.env.ROOT_DOMAIN ?? "localhost:3100";
    const req = (path: string) => proxy(new NextRequest(new URL(`http://acme.${root}${path}`), { headers: { host: `acme.${root}` } }));
    assert.equal(req("/verify/id/abc.def").headers.get("location"), null, "the verify page is public");
    assert.match(req("/org/tree").headers.get("location") ?? "", /\/login/, "app pages still need a session");
    assert.match(req("/org/employees/export").headers.get("location") ?? "", /\/login/);
    ok("ID card: QR token bound to tenant + person (tamper/other company refused), colleagues can't open cards, public page minimal; proxy opens only /verify/id/");
  } finally {
    await admin`delete from tenants where id = ${otherId}`;
  }

  // ---------------------------------------------------------------- probation, job changes, rehire
  await rollback(tenant.id, async (tx) => {
    const fatima = id("Fatima");
    assert.ok((await life.probationList(tx, karan)).some((r) => r.id === fatima), "Fatima's manager sees her");
    assert.equal((await life.probationList(tx, arjun)).length, 0);
    await fails(sp(tx, (s) => life.bulkProbation(s, arjun, { employeeIds: [fatima], action: "confirm" })), /can't update/);
    await fails(sp(tx, (s) => life.bulkProbation(s, karan, { employeeIds: [fatima, id("Rohan")], action: "extend", extendDays: 30 })), /can't update|isn't on probation/);
    const before = (await tx<{ d: string }[]>`select probation_end_date::text as d from employees where id = ${fatima}`)[0].d;
    await life.bulkProbation(tx, karan, { employeeIds: [fatima], action: "extend", extendDays: 30 });
    const [ext] = await tx<{ d: string; s: string }[]>`select probation_end_date::text as d, probation_status as s from employees where id = ${fatima}`;
    assert.equal(ext.d, addDaysISO(before, 30)); assert.equal(ext.s, "extended");
    await life.bulkProbation(tx, priya, { employeeIds: [fatima], action: "confirm" });
    assert.equal((await tx<{ s: string }[]>`select probation_status as s from employees where id = ${fatima}`)[0].s, "confirmed");
    // auto-confirm: Aditya's auto-confirm policy ended two days ago → confirmed once, on the end date
    // (put him back on probation first: pnpm jobs:daily may already have confirmed him on this database)
    await tx`update employees set probation_status = 'in_probation', probation_end_date = ${addDaysISO(today, -2)} where id = ${id("Aditya")}`;
    await tx`delete from timeline_events where employee_id = ${id("Aditya")} and kind = 'probation_confirmed'`;
    const r1 = await life.autoConfirmProbation(tx, tenant.id, today);
    assert.ok(r1.confirmed >= 1);
    assert.equal((await life.autoConfirmProbation(tx, tenant.id, today)).confirmed, 0, "idempotent");
    const [ad] = await tx<{ kind: string; effective_date: string }[]>`select kind, effective_date::text from timeline_events where employee_id = ${id("Aditya")} and kind = 'probation_confirmed'`;
    assert.equal(ad.effective_date, addDaysISO(today, -2));
    // job changes: a future change is applied by the daily job once its date arrives, exactly once
    const [des] = await tx<{ id: string }[]>`select id from designations where title = 'HR Manager'`;
    const jc = await changeJob(tx, asha, arjun.employeeId, { kind: "promotion", effectiveDate: addDaysISO(today, 5), changes: { designation_id: des.id } });
    assert.equal((await life.applyDueJobChanges(tx, tenant.id, today)).applied, 0);
    assert.equal((await life.applyDueJobChanges(tx, tenant.id, addDaysISO(today, 5))).applied, 1);
    assert.equal((await life.applyDueJobChanges(tx, tenant.id, addDaysISO(today, 5))).applied, 0, "idempotent");
    assert.equal((await tx<{ d: string }[]>`select designation_id as d from employees where id = ${arjun.employeeId}`)[0].d, des.id);
    const jc2 = await changeJob(tx, asha, meera.employeeId, { kind: "promotion", effectiveDate: addDaysISO(today, 5), changes: { designation_id: des.id } });
    await tx`update employees set status = 'relieved' where id = ${meera.employeeId}`;
    assert.equal((await life.applyDueJobChanges(tx, tenant.id, addDaysISO(today, 6))).cancelled, 1, "changes for someone who left are cancelled");
    assert.equal((await tx<{ s: string }[]>`select status as s from job_changes where id = ${jc2.id}`)[0].s, "cancelled");
    void jc;
  });
  ok("probation: managers + scoped HR act on their people, extend/confirm, auto-confirm once on the end date; job changes applied once on the date, cancelled for leavers");

  await rollback(tenant.id, async (tx) => {
    const nikhil = id("Nikhil");
    await fails(sp(tx, (s) => people.rehire(s, arjun, nikhil, { mode: "reactivate", joiningDate: today })), /Only HR/);
    await fails(sp(tx, (s) => people.rehire(s, priya, id("Arjun"), { mode: "reactivate", joiningDate: today })), /hasn't left/);
    await fails(sp(tx, (s) => people.rehire(s, priya, nikhil, { mode: "reactivate", joiningDate: addDaysISO(today, -30) })), /after their last day/);
    await tx`update exit_requests set ok_to_rehire = false where employee_id = ${nikhil}`;
    await fails(sp(tx, (s) => people.rehire(s, priya, nikhil, { mode: "reactivate", joiningDate: today })), /not OK to rehire/);
    await fails(sp(tx, (s) => people.rehire(s, priya, nikhil, { mode: "new_record", joiningDate: today, workEmail: "rohan@acme.test", overrideNotRehirable: true })), /already uses this work email/);
    const n = await people.rehire(tx, priya, nikhil, { mode: "new_record", joiningDate: today, workEmail: "nikhil.menon@acme.test", overrideNotRehirable: true });
    const [ne] = await tx<{ rehired_from_employee_id: string; status: string; first_name: string }[]>`select rehired_from_employee_id, status, first_name from employees where id = ${n.employeeId}`;
    assert.equal(ne.rehired_from_employee_id, nikhil); assert.equal(ne.status, "active"); assert.equal(ne.first_name, "Nikhil");
    assert.equal((await tx<{ s: string }[]>`select status as s from employees where id = ${nikhil}`)[0].s, "relieved", "the old record stays as history");
  });
  await rollback(tenant.id, async (tx) => {
    const nikhil = id("Nikhil");
    await people.rehire(tx, priya, nikhil, { mode: "reactivate", joiningDate: today, departmentId: eng.id });
    const [e] = await tx<{ status: string; exit_date: string | null; joining_date: string; department_id: string; u: string }[]>`
      select e.status, e.exit_date::text, e.joining_date::text, e.department_id, u.status as u from employees e join users u on u.id = e.user_id where e.id = ${nikhil}`;
    assert.equal(e.status, "active"); assert.equal(e.exit_date, null); assert.equal(e.joining_date, today); assert.equal(e.department_id, eng.id);
    assert.notEqual(e.u, "disabled", "sign-in re-enabled");
    const [tl] = await tx<{ data: { previousJoining: string } }[]>`select data from timeline_events where employee_id = ${nikhil} and kind = 'rehired'`;
    assert.ok(tl.data.previousJoining < today, "earlier employment kept on the timeline");
    const [open] = await tx<{ n: number }[]>`select count(*)::int as n from shift_assignments where employee_id = ${nikhil} and upper_inf(period)`;
    assert.equal(open.n, 1);
  });
  ok("rehire: HR in scope only, relieved people only, after the last day, 'not OK to rehire' needs an override; new record linked to the old one, or reactivate with history");

  // ---------------------------------------------------------------- Excel bulk update
  await rollback(tenant.id, async (tx) => {
    await fails(sp(tx, (s) => bulk.buildUpdateTemplate(s, arjun)), /access/);
    const tpl = await bulk.buildUpdateTemplate(tx, engHr);
    const [arjunNo] = await tx<{ n: string }[]>`select employee_number as n from employees where id = ${arjun.employeeId}`;
    const [snehaNo] = await tx<{ n: string }[]>`select employee_number as n from employees where id = ${sneha.employeeId}`;
    /** The downloaded template, optionally edited, as upload bytes. */
    const file = async (edit?: (ws: ExcelJS.Worksheet, col: (h: string) => number) => void) => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(tpl.buffer.slice(tpl.byteOffset, tpl.byteOffset + tpl.byteLength) as ArrayBuffer);
      const ws = wb.getWorksheet("People")!;
      const header = ws.getRow(1).values as string[];
      edit?.(ws, (h) => header.findIndex((x) => x === h));
      const b = new Uint8Array(await wb.xlsx.writeBuffer());
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    };
    const numbers: string[] = [];
    { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(tpl.buffer.slice(tpl.byteOffset, tpl.byteOffset + tpl.byteLength) as ArrayBuffer); wb.getWorksheet("People")!.eachRow((r, n) => { if (n > 1) numbers.push(String(r.getCell(1).value)); }); }
    assert.ok(numbers.includes(arjunNo.n) && !numbers.includes(snehaNo.n), "the template has only people in scope");
    const p0 = await bulk.previewUpdate(tx, engHr, await file());
    assert.ok(p0.valid); assert.equal(p0.changed, 0, "an unchanged file changes nothing");
    const editArjun = (ws: ExcelJS.Worksheet, col: (h: string) => number) => ws.eachRow((r, n) => {
      if (n > 1 && String(r.getCell(1).value) === arjunNo.n) { r.getCell(col("Mobile")).value = "+91 90000 00001"; r.getCell(col("Worker type")).value = "Contract"; r.getCell(col("T-shirt size")).value = "XL"; }
    });
    const good = await file(editArjun);
    const p1 = await bulk.previewUpdate(tx, engHr, good);
    assert.ok(p1.valid, JSON.stringify(p1.rows.filter((r) => r.errors.length)));
    assert.equal(p1.changed, 1);
    assert.deepEqual(p1.rows.find((r) => r.changes.length)!.changes.map((c) => c.label).sort(), ["Mobile", "T-shirt size", "Worker type"]);
    const badBytes = await file((ws, col) => {
      editArjun(ws, col);
      const extra = ws.addRow([]); extra.getCell(1).value = snehaNo.n; extra.getCell(col("Mobile")).value = "+91 90000 00002";
      const dupe = ws.addRow([]); dupe.getCell(1).value = arjunNo.n; dupe.getCell(col("Mobile")).value = "+91 90000 00003";
    });
    const p2 = await bulk.previewUpdate(tx, engHr, badBytes);
    assert.equal(p2.valid, false);
    assert.ok(p2.rows.some((r) => r.errors.some((e) => /outside the people you manage/.test(e))) && p2.rows.some((r) => r.errors.some((e) => /more than once/.test(e))));
    await fails(sp(tx, (s) => bulk.commitUpdate(s, engHr, badBytes)), /Some rows have problems/);
    const toBytes = async () => good;
    const r = await bulk.commitUpdate(tx, engHr, await toBytes());
    assert.equal(r.updated, 1);
    const [e] = await tx<{ mobile: string; worker_type: string; custom: Record<string, unknown> }[]>`select mobile, worker_type, custom from employees where id = ${arjun.employeeId}`;
    assert.equal(e.mobile, "+91 90000 00001"); assert.equal(e.worker_type, "contract"); assert.equal(Object.values(e.custom).includes("XL"), true);
    const [jc] = await tx<{ n: number }[]>`select count(*)::int as n from job_changes where employee_id = ${arjun.employeeId} and status = 'applied' and changes->>'note' = 'Bulk update from Excel'`;
    assert.equal(jc.n, 1, "job fields go through a dated job change");
    assert.equal((await bulk.previewUpdate(tx, engHr, await toBytes())).changed, 0, "re-uploading the same file changes nothing");
  });
  ok("bulk update: template in scope only, blank = unchanged, diff preview, out-of-scope and duplicate rows refused, all-or-nothing, job fields via job changes, re-upload no-op");

  // ---------------------------------------------------------------- directory + org chart
  await rollback(tenant.id, async (tx) => {
    const all = await people.directory(tx, arjun, {});
    assert.ok(all.every((r) => r.status !== "relieved"));
    assert.ok(all.filter((r) => r.id !== arjun.employeeId).every((r) => r.mobile === null), "colleagues don't see mobiles");
    assert.equal((await people.directory(tx, arjun, { status: "relieved" })).length, 0, "employees can't list people who left");
    assert.ok((await people.directory(tx, priya, { status: "relieved" })).some((r) => r.id === id("Nikhil")));
    const engOnly = await people.directory(tx, arjun, { departmentIds: [eng.id] });
    assert.ok(engOnly.length >= 4 && engOnly.every((r) => r.department_id === eng.id));
    assert.equal((await people.directory(tx, arjun, { departmentIds: [randomUUID()] })).length, 0);
    const f = people.filtersFrom({ department: "nope", status: "weird", from: "2020-13-45x", to: "2026-01-01" });
    assert.equal(f.departmentIds, undefined); assert.equal(f.status, "current"); assert.equal(f.joinedFrom, null); assert.equal(f.joinedTo, "2026-01-01");
    const roots = await people.orgChildren(tx, null);
    assert.deepEqual(roots.map((r) => r.name), ["Asha Verma"]);
    assert.equal(roots[0].reports >= 4, true);
    assert.deepEqual((await people.orgChain(tx, arjun.employeeId)).map((c) => c.name.split(" ")[0]), ["Asha", "Rohan", "Arjun"]);
    assert.deepEqual((await people.orgChildren(tx, rohan.employeeId)).map((c) => c.name.split(" ")[0]).sort(), ["Arjun", "Meera", "Vikram"]);
    const pol = await people.assignedPolicies(tx, rohan, arjun.employeeId);
    assert.ok(pol && (pol as Record<string, unknown>).leave_plan && pol.groups.some((g) => g.name === "Apollo"));
    assert.equal(await people.assignedPolicies(tx, karan, arjun.employeeId), null);
    const time = await people.timeTab(tx, rohan, arjun.employeeId);
    assert.ok(time && time.balances.length > 0 && time.summary.present >= 0);
    assert.equal(await people.timeTab(tx, karan, arjun.employeeId), null, "colleagues don't see the Time tab");
    assert.ok(await people.timeTab(tx, actor("Karan", ["attendance.admin"], [{ type: "department", ids: [eng.id] }]), arjun.employeeId), "scoped attendance admins do");
  });
  ok("directory: filters resolved in the tenant, leavers and mobiles only for HR; org chart roots/chain/children; Job tab policies + groups; Time tab access");

  // ---------------------------------------------------------------- scheduler: idempotent per day, lock
  const runDate = "2001-01-01";
  try {
    const r1 = await runTenant(tenant.id, { today: runDate, now: new Date(), only: ["approval_timers", "engage"] });
    assert.deepEqual(r1.map((r) => r.status), ["ok", "ok"]);
    const r2 = await runTenant(tenant.id, { today: runDate, now: new Date(), only: ["approval_timers", "engage"] });
    assert.deepEqual(r2.map((r) => `${r.key}:${r.status}`), ["approval_timers:skipped", "engage:ok"], "once-a-day steps don't repeat; cheap ones do");
    const r3 = await runTenant(tenant.id, { today: runDate, now: new Date(), only: ["approval_timers"], force: true });
    assert.equal(r3[0].status, "ok");
    const [rows] = await withTenant(tenant.id, (tx) => tx<{ n: number }[]>`select count(*)::int as n from scheduler_runs where run_date = ${runDate}`);
    assert.equal(rows.n, 2, "one row per job and day");
    // a second daily run while one holds the lock does nothing
    await admin`select pg_advisory_lock(727001)`;
    try {
      const out = execFileSync("pnpm", ["-s", "jobs:daily", "--", "--only", "engage", "--date", runDate], { cwd: process.cwd(), encoding: "utf8", env: process.env });
      assert.match(out, /Another daily run is still going/);
    } finally {
      await admin`select pg_advisory_unlock(727001)`;
    }
  } finally {
    await admin`delete from scheduler_runs where run_date = ${runDate}`;
  }
  ok("scheduler: once-a-day steps recorded and skipped on re-run (force re-runs), cheap steps always run, a concurrent run backs off on the advisory lock");

  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await admin.end(); await sql.end(); }).catch(async (e) => {
  console.error("\nFAILED:", e instanceof AppError ? `${e.code}: ${e.message}` : e); await admin.end(); await sql.end(); process.exit(1);
});
