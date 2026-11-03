/**
 * Smoke test for projects / timesheets, Learn and Reports against the seeded demo tenant (run `pnpm db:seed` first).
 * Everything runs in rolled-back transactions, so the demo data stays as seeded (stored PDF bytes are cleaned up at the end).
 *   pnpm smoke:workspace
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { withTenant, sql, AppError, type Tx } from "@/server/db";
import * as approvals from "@/server/modules/approvals/service";
import * as psa from "@/server/modules/psa/service";
import { renderInvoicePdf } from "@/server/modules/psa/pdf";
import * as learn from "@/server/modules/learn/service";
import * as reports from "@/server/modules/reports/service";
import { DATASETS } from "@/server/modules/reports/rules";
import { STANDARD_REPORTS } from "@/server/modules/reports/standard";
import { weekStartOf, type GridRow } from "@/server/modules/psa/rules";
import { storage } from "@/server/storage";
import type { Actor } from "@/server/auth/session";
import type { Scope } from "@/server/auth/catalog";
import { addDaysISO, todayIn } from "@/lib/dates";
import { DEMO_SUBDOMAIN } from "./demo";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const rollback = async (tenantId: string, fn: (tx: Tx) => Promise<void>) =>
  withTenant(tenantId, async (tx) => { await fn(tx); throw new Error("rollback"); }).catch((e) => { if (e.message !== "rollback") throw e; });
const blobs: string[] = [];
const track = async (tx: Tx) => { for (const f of await tx<{ storage_key: string }[]>`select storage_key from files where created_at >= now()`) blobs.push(f.storage_key); };
const row = (projectId: string, taskId: string | null, billable: boolean, note: string, minutes: number[]): GridRow => ({ projectId, taskId, billable, note, minutes });

async function main() {
  const [t] = await sql<{ id: string }[]>`select id from tenant_by_subdomain(${DEMO_SUBDOMAIN})`;
  assert.ok(t, "demo tenant exists (run pnpm db:seed)");
  const tenant = { id: t.id, name: "Acme Technologies", status: "trial", subdomain: DEMO_SUBDOMAIN };
  const actor = (first: string, permissions: string[] = [], scopes: Scope[] = [], roles: string[] = []) => withTenant(tenant.id, async (tx) => {
    const [e] = await tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`;
    assert.ok(e, `${first} exists`);
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles, permissions: new Set(permissions), grants: permissions.length ? [{ permissions, scopes }] : [] } as Actor;
  });
  const ALL = ["psa.admin", "psa.billing", "learn.admin", "reports.read", "reports.build"];
  const asha = await actor("Asha", ["*"], [], ["global_admin"]), priya = await actor("Priya", ALL, [], ["hr_admin"]);
  const karan = await actor("Karan", ["psa.billing", "reports.read", "reports.build"], [], ["finance"]);
  const [rohan, arjun, meera, vikram, sneha, imran] = await Promise.all(["Rohan", "Arjun", "Meera", "Vikram", "Sneha", "Imran"].map((n) => actor(n)));
  const [eng] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from departments where name = 'Engineering'`);
  const engScoped = await actor("Priya", ALL, [{ type: "department", ids: [eng.id] }]);          // same permissions, Engineering only
  const engReader = await actor("Karan", ["reports.read", "reports.build"], [{ type: "department", ids: [eng.id] }]);
  const pmOnly = await actor("Rohan", ["psa.admin"]);                                                   // project admin without billing
  const today = todayIn();
  const thisWeek = weekStartOf(today);
  const P = await withTenant(tenant.id, async (tx) => {
    const rows = await tx<{ id: string; code: string }[]>`select id, code from projects`;
    const by = (c: string) => rows.find((r) => r.code === c)!.id;
    const task = async (code: string, name: string) => (await tx<{ id: string }[]>`select id from project_tasks where project_id = ${by(code)} and name = ${name}`)[0].id;
    return { store: by("NWS"), retainer: by("GXS"), revamp: by("GXW"), internal: by("INT"), api: await task("NWS", "Catalogue API"), ui: await task("NWS", "Checkout UI"), meet: await task("NWS", "Stand-ups and planning"), inc: await task("GXS", "Incidents") };
  });
  const notes = async (tx: Tx, who: Actor, kind: string) => (await tx<{ n: number }[]>`select count(*)::int as n from notifications where user_id = ${who.userId} and kind = ${kind}`)[0].n;

  // ======================================================================= PSA
  await rollback(tenant.id, async (tx) => {
    const input = { name: "Initech", gstin: null, currency: "INR", address: {} };
    await assert.rejects(psa.saveClient(tx, arjun, null, input), /access|admins/);
    await assert.rejects(psa.saveClient(tx, engScoped, null, input), /whole company/, "a department-scoped project admin can't set up company-wide clients");
    await assert.rejects(psa.saveClient(tx, karan, null, input), /whole company/, "billing alone can't add clients");
    const c = await psa.saveClient(tx, priya, null, input);
    await assert.rejects(psa.saveClient(tx, priya, null, { ...input, name: "initech" }), /already exists/);
    await assert.rejects(psa.saveClient(tx, priya, c.id, { ...input, gstin: "BAD" }), /GSTIN/);
    await assert.rejects(psa.saveProject(tx, priya, null, { name: "X", code: "NWS", clientId: c.id, billingModel: "time_and_materials", retainerPaise: null, currency: "INR", startDate: null, endDate: null, description: null, approverIds: [], budgetMinutes: null }), /already uses this code/);
    await assert.rejects(psa.saveProject(tx, priya, null, { name: "X", code: "XX1", clientId: null, billingModel: "time_and_materials", retainerPaise: null, currency: "INR", startDate: null, endDate: null, description: null, approverIds: [], budgetMinutes: null }), /need a client/);
    await assert.rejects(psa.saveProject(tx, priya, null, { name: "X", code: "XX1", clientId: randomUUID(), billingModel: "time_and_materials", retainerPaise: null, currency: "INR", startDate: null, endDate: null, description: null, approverIds: [], budgetMinutes: null }), /client doesn't exist/);
    await assert.rejects(psa.saveProject(tx, priya, null, { name: "X", code: "XX1", clientId: c.id, billingModel: "time_and_materials", retainerPaise: null, currency: "INR", startDate: null, endDate: null, description: null, approverIds: [randomUUID()], budgetMinutes: null }), /don't exist/);
    const p = await psa.saveProject(tx, priya, null, { name: "Initech portal", code: "xx1", clientId: c.id, billingModel: "retainer", retainerPaise: 100000, currency: "INR", startDate: null, endDate: null, description: null, approverIds: [rohan.employeeId], budgetMinutes: null });
    await psa.saveMember(tx, priya, p.id, { employeeId: sneha.employeeId, role: "Lead", billRatePaise: 200000, allocationPct: 50 });
    await assert.rejects(psa.saveMember(tx, priya, p.id, { employeeId: sneha.employeeId, role: null, billRatePaise: -1, allocationPct: null }), /bill rate/);
    await assert.rejects(psa.saveMember(tx, arjun, p.id, { employeeId: sneha.employeeId, role: null, billRatePaise: null, allocationPct: null }), /whole company/);
    await psa.saveTask(tx, priya, p.id, null, { name: "Setup", isBillable: true, phase: "Phase 1", startDate: null, endDate: null });
    await assert.rejects(psa.deleteClient(tx, priya, c.id), /has projects/);
    await assert.rejects(psa.removeMember(tx, priya, P.store, arjun.employeeId), /logged time/);
    await assert.rejects(psa.deleteTask(tx, priya, P.store, P.api), /logged/);
    const d = await psa.projectDetail(tx, priya, p.id);
    assert.equal(d!.project.code, "XX1"); assert.equal(d!.members.length, 1); assert.equal(d!.tasks.length, 1); assert.deepEqual(d!.project.approvers.map((a) => a.id), [rohan.employeeId]);
    assert.equal(await psa.projectDetail(tx, imran, p.id), null, "non-members don't see the project");
    assert.ok((await psa.listProjects(tx, arjun)).every((x) => x.mine || x.approver), "members see only their projects");
    await assert.rejects(psa.listClients(tx, arjun), /access|admins/);
    await assert.rejects(psa.savePolicy(tx, engScoped, { ...(await psa.policy(tx)), max_minutes_per_day: 600 }), /whole company/);
    await assert.rejects(psa.savePolicy(tx, priya, { ...(await psa.policy(tx)), min_minutes_per_day: 900, max_minutes_per_day: 600 }), /above the daily limit/);
  });
  ok("setup: clients, projects, members, tasks and the policy need an unscoped psa.admin; names/codes unique; ids resolved in the tenant; in-use rows protected");

  // ---------- timesheet: save, validate, submit, approve / send back, withdraw, lock ----------
  await rollback(tenant.id, async (tx) => {
    const week = addDaysISO(thisWeek, -28);
    await assert.rejects(psa.saveWeek(tx, arjun, addDaysISO(week, 1), [], today), /Monday/);
    await assert.rejects(psa.saveWeek(tx, arjun, week, [row(P.revamp, null, true, "", [60, 0, 0, 0, 0, 0, 0])], today), /not on one of these projects/, "only projects you're on");
    await assert.rejects(psa.saveWeek(tx, arjun, week, [row(P.store, P.inc, true, "", [60, 0, 0, 0, 0, 0, 0])], today), /task isn't on this project/);
    await assert.rejects(psa.saveWeek(tx, arjun, week, [row(P.store, P.api, true, "", [700, 0, 0, 0, 0, 0, 0]), row(P.store, P.ui, true, "", [100, 0, 0, 0, 0, 0, 0])], today), /daily limit/);
    await assert.rejects(psa.saveWeek(tx, arjun, thisWeek, [row(P.store, P.api, true, "", [0, 0, 0, 0, 0, 0, 60])], today), /hasn't happened/);
    await psa.saveWeek(tx, arjun, week, [row(P.store, P.api, true, "API", [480, 480, 480, 480, 480, 0, 0]), row(P.internal, null, true, "", [60, 0, 0, 0, 0, 0, 0])], today);
    let v = await psa.myWeek(tx, arjun, week, today);
    assert.equal(v.status, "draft"); assert.equal(v.rows.length, 2);
    assert.equal(v.rows.find((r) => r.projectId === P.internal)!.billable, false, "non-billable projects force billable off");
    assert.deepEqual(v.actions, { edit: true, submit: true, withdraw: false, reopen: false });
    await assert.rejects(psa.submitWeek(tx, arjun, week, [], today), /Log some hours/);
    const beforeRohan = await notes(tx, rohan, "approval.pending");
    const s = await psa.submitWeek(tx, arjun, week, v.rows, today);
    assert.equal(s.status, "submitted");
    assert.equal(await notes(tx, rohan, "approval.pending"), beforeRohan + 1, "the project approver is asked");
    v = await psa.myWeek(tx, arjun, week, today);
    assert.equal(v.status, "submitted"); assert.deepEqual(v.steps.map((x) => [x.approver, x.status]), [["Rohan Mehta", "pending"]]);
    await assert.rejects(psa.saveWeek(tx, arjun, week, v.rows, today), /Withdraw the submission/);
    // nobody approves their own; Arjun's manager isn't in the chain (project approver wins); Rohan can
    const steps = await tx<{ id: string }[]>`select s.id from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_type = 'timesheet' and r.entity_id = ${v.timesheetId} and s.status = 'pending'`;
    await assert.rejects(approvals.decide(tx, arjun, steps[0].id, "approved"), /already handled|isn't waiting/);
    const det = await psa.timesheetDetail(tx, rohan, v.timesheetId!);
    assert.equal(det!.can.decide, steps[0].id); assert.equal(det!.rows.length, 2); assert.equal(det!.total_minutes, 2460);
    assert.equal((await psa.timesheetDetail(tx, arjun, v.timesheetId!))!.can.decide, null, "owner can't decide");
    assert.equal(await psa.timesheetDetail(tx, imran, v.timesheetId!), null, "colleagues can't read it");
    assert.ok((await psa.approvalQueue(tx, rohan)).some((q) => q.id === v.timesheetId && q.step_id === steps[0].id));
    await approvals.decide(tx, rohan, steps[0].id, "rejected", "Split the internal time by task");
    v = await psa.myWeek(tx, arjun, week, today);
    assert.equal(v.status, "rejected"); assert.equal(v.comment, "Split the internal time by task"); assert.equal(v.actions.edit, true);
    // fix and resubmit: a fresh chain, then approve
    const s2 = await psa.submitWeek(tx, arjun, week, v.rows, today);
    const st2 = await tx<{ id: string }[]>`select s.id from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_type = 'timesheet' and r.entity_id = ${s2.id} and s.status = 'pending'`;
    assert.equal(st2.length, 1);
    await psa.withdrawWeek(tx, arjun, week);
    assert.equal((await psa.myWeek(tx, arjun, week, today)).status, "draft");
    await assert.rejects(psa.withdrawWeek(tx, arjun, week), /isn't waiting/);
    const s3 = await psa.submitWeek(tx, arjun, week, v.rows, today);
    const st3 = await tx<{ id: string }[]>`select s.id from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_type = 'timesheet' and r.entity_id = ${s3.id} and s.status = 'pending'`;
    const r = await approvals.decide(tx, rohan, st3[0].id, "approved", "ok");
    assert.equal(r.final, "approved");
    v = await psa.myWeek(tx, arjun, week, today);
    assert.equal(v.status, "approved"); assert.equal(v.actions.edit, false);
    await assert.rejects(approvals.decide(tx, rohan, st3[0].id, "approved"), /already handled/, "deciding twice is refused");
    // admins can reopen an approved, un-invoiced week; the owner / scoped admin can't
    await assert.rejects(psa.reopenTimesheet(tx, arjun, s3.id, "x"), /whole company/);
    await assert.rejects(psa.reopenTimesheet(tx, engScoped, s3.id, "x"), /whole company/);
    await psa.reopenTimesheet(tx, priya, s3.id, "Please recheck Friday");
    v = await psa.myWeek(tx, arjun, week, today);
    assert.equal(v.status, "draft"); assert.equal(v.comment, "Please recheck Friday");
    // locking: 45-day policy; a week 10 weeks back can't be touched
    const old = addDaysISO(thisWeek, -70);
    await assert.rejects(psa.saveWeek(tx, arjun, old, [row(P.store, P.api, true, "", [60, 0, 0, 0, 0, 0, 0])], today), /locked/);
    assert.equal((await psa.myWeek(tx, arjun, old, today)).locked, true);
    // manager fallback when the policy says so / no project approvers
    await tx`update timesheet_policies set approver = 'manager'`;
    const mgr = await psa.submitWeek(tx, meera, week, [row(P.store, P.ui, true, "", [60, 0, 0, 0, 0, 0, 0])], today);
    const mstep = await tx<{ approver_employee_id: string }[]>`select s.approver_employee_id from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_id = ${mgr.id} and s.status = 'pending'`;
    assert.deepEqual(mstep.map((x) => x.approver_employee_id), [rohan.employeeId], "manager approves when the policy says manager");
    await tx`update timesheet_policies set approver = 'project', cadence = 'daily', min_minutes_per_day = 480`;
    await assert.rejects(psa.submitWeek(tx, vikram, week, [row(P.store, P.ui, true, "", [480, 240, 480, 480, 480, 0, 0])], today), /daily minimum/);
    // the founder submits with nobody above: auto-approved
    await tx`update projects set approver_employee_ids = '{}' where id = ${P.retainer}`;
    await tx`update timesheet_policies set cadence = 'weekly', min_minutes_per_day = 0`;
    await psa.saveMember(tx, priya, P.retainer, { employeeId: asha.employeeId, role: null, billRatePaise: null, allocationPct: null });
    const auto = await psa.submitWeek(tx, asha, week, [row(P.retainer, P.inc, true, "", [60, 0, 0, 0, 0, 0, 0])], today);
    assert.equal(auto.status, "approved");
  });
  ok("timesheet: grid rules (membership, task, daily cap, future days), submit → project approver (manager fallback), self-approval impossible, send back with comment, withdraw, resubmit, approve, admin reopen, locked weeks, auto-approve with nobody to ask");

  // ---------- invoices ----------
  await rollback(tenant.id, async (tx) => {
    const w1 = addDaysISO(thisWeek, -21), w2 = addDaysISO(thisWeek, -14);
    await assert.rejects(psa.invoiceCandidate(tx, pmOnly, P.store, w2, addDaysISO(w2, 6)), /billing access/, "psa.admin without billing can't invoice");
    await assert.rejects(psa.invoiceCandidate(tx, karan, P.internal, w2, addDaysISO(w2, 6)), /no client|isn't billable/);
    const c1 = await psa.invoiceCandidate(tx, karan, P.store, w1, addDaysISO(w1, 6));
    assert.equal(c1.preview.lines.length, 0, "the seeded invoice already took week one's hours");
    const c2 = await psa.invoiceCandidate(tx, karan, P.store, w2, addDaysISO(w2, 6));
    assert.deepEqual(c2.preview.lines.map((l) => [l.description, l.amount_paise]), [["Arjun Rao · 36 h", 9000000], ["Meera Iyer · 26 h", 6500000]]);
    assert.equal(c2.preview.tax, 2790000); assert.deepEqual(c2.preview.missingRates, []);
    const inv = await psa.createInvoice(tx, karan, { projectId: P.store, from: w2, to: addDaysISO(w2, 6), taxRateBp: 1800, milestoneIds: [], notes: null, dueInDays: 15 });
    assert.equal(inv.number, "INV-0003");
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from time_entries where invoice_id = ${inv.id}`;
    assert.equal(n, 10, "approved billable entries of the period are tied to the invoice");
    await assert.rejects(psa.createInvoice(tx, karan, { projectId: P.store, from: w2, to: addDaysISO(w2, 6), taxRateBp: 1800, milestoneIds: [], notes: null, dueInDays: 15 }), /nothing to invoice/, "no double billing");
    const ts = await tx<{ id: string }[]>`select distinct t.id from timesheets t join time_entries e on e.timesheet_id = t.id where e.invoice_id = ${inv.id}`;
    await assert.rejects(psa.reopenTimesheet(tx, priya, ts[0].id, "x"), /on an invoice/);
    await assert.rejects(psa.setInvoiceStatus(tx, karan, inv.id, "paid"), /can't be marked/);
    await assert.rejects(psa.setInvoiceStatus(tx, pmOnly, inv.id, "sent"), /billing access/);
    await psa.setInvoiceStatus(tx, karan, inv.id, "sent");
    const d = await psa.invoiceDetail(tx, karan, inv.id);
    assert.equal(d!.status, "sent"); assert.equal(Number(d!.subtotal_paise), 15500000);
    const pdf = await renderInvoicePdf(d!);
    assert.equal(new TextDecoder().decode(pdf.subarray(0, 5)), "%PDF-");
    await psa.setInvoiceStatus(tx, karan, inv.id, "void");
    const [{ m }] = await tx<{ m: number }[]>`select count(*)::int as m from time_entries where invoice_id = ${inv.id}`;
    assert.equal(m, 0, "voiding releases the hours");
    assert.equal((await psa.invoiceCandidate(tx, karan, P.store, w2, addDaysISO(w2, 6))).preview.lines.length, 2);
    // retainer and milestones
    const ret = await psa.invoiceCandidate(tx, karan, P.retainer, today.slice(0, 8) + "01", today);
    assert.equal(ret.preview.subtotal, 15000000);
    const fx = await psa.invoiceCandidate(tx, karan, P.revamp, w1, today);
    assert.equal(fx.preview.lines.length, 0, "the done milestone is already invoiced; planned ones aren't billable yet");
    assert.equal(await psa.invoiceDetail(tx, arjun, inv.id), null);
    await assert.rejects(psa.listInvoices(tx, arjun), /billing/);
  });
  ok("invoices: billing-only, T&M lines per person × rate with GST, hours tied once, void releases them, retainer and milestone candidates, numbered from the counter, PDF renders");

  // ======================================================================= Learn
  await rollback(tenant.id, async (tx) => {
    await assert.rejects(learn.saveCourse(tx, arjun, null, { title: "X", description: null, certificate: true, estimatedMinutes: null }), /learning admins/);
    await assert.rejects(learn.saveCourse(tx, engScoped, null, { title: "X", description: null, certificate: true, estimatedMinutes: null }), /whole company/);
    const c = await learn.saveCourse(tx, priya, null, { title: "Fire safety", description: null, certificate: true, estimatedMinutes: 10 });
    await assert.rejects(learn.setCourseStatus(tx, priya, c.id, "published"), /at least one module/);
    await assert.rejects(learn.saveModule(tx, priya, c.id, null, { title: "V", kind: "video", content: { url: "https://example.com/x" }, file: null }), /YouTube|Vimeo/);
    await assert.rejects(learn.saveModule(tx, priya, c.id, null, { title: "D", kind: "document", content: {}, file: null }), /Upload the document/);
    await assert.rejects(learn.saveModule(tx, priya, c.id, null, { title: "D", kind: "document", content: {}, file: { name: "x.svg", bytes: new TextEncoder().encode("<svg/>") } }), /isn't allowed|type/);
    await assert.rejects(learn.saveModule(tx, priya, c.id, null, { title: "V", kind: "video", content: {}, file: { name: "x.mp4", bytes: new Uint8Array(20) } }), /mp4|link/);
    const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
    const doc = await learn.saveModule(tx, priya, c.id, null, { title: "Evacuation map", kind: "document", content: { note: "Read before the drill" }, file: { name: "map.pdf", bytes: pdf } });
    await track(tx);
    await learn.saveModule(tx, priya, c.id, null, { title: "Read me", kind: "text", content: { html: "<p>Walk, don't run.<script>x()</script></p>" }, file: null });
    const quiz = await learn.saveModule(tx, priya, c.id, null, { title: "Quiz", kind: "quiz", file: null, content: { pass_pct: 100, questions: [{ text: "Exit via?", options: ["Lift", "Stairs"], correct: 1 }, { text: "Assembly point?", options: ["Car park", "Lobby"], correct: 0 }] } });
    const [stored] = await tx<{ content: { html: string } }[]>`select content from course_modules where course_id = ${c.id} and kind = 'text'`;
    assert.equal(stored.content.html, "<p>Walk, don't run.</p>", "readings are sanitised");
    const a = await learn.courseAdmin(tx, priya, c.id);
    assert.deepEqual(a!.modules.map((m) => m.position), [1, 2, 3]);
    await learn.moveModule(tx, priya, c.id, quiz.id, -1);
    assert.deepEqual((await learn.courseAdmin(tx, priya, c.id))!.modules.map((m) => m.title), ["Evacuation map", "Quiz", "Read me"]);
    await learn.moveModule(tx, priya, c.id, quiz.id, 1);
    // nobody sees a draft; files are closed
    assert.equal(await learn.player(tx, arjun, c.id), null);
    const [f] = await tx<{ file_id: string }[]>`select file_id from course_modules where id = ${doc.id}`;
    assert.equal(await learn.learnFileFor(tx, arjun, f.file_id), null, "not enrolled: no file");
    assert.ok(await learn.learnFileFor(tx, priya, f.file_id), "admins can open module files");
    // assignment rules: validated, applied on publish, idempotent
    await assert.rejects(learn.saveAssignment(tx, priya, c.id, null, { name: "", rule: { kind: "people", ids: [] }, dueInDays: 7, reminderDaysBefore: null, isActive: true }), /who this assignment/);
    await assert.rejects(learn.saveAssignment(tx, priya, c.id, null, { name: "", rule: { kind: "departments", ids: [randomUUID()] }, dueInDays: 7, reminderDaysBefore: null, isActive: true }), /no longer exist/);
    await assert.rejects(learn.saveAssignment(tx, priya, c.id, null, { name: "", rule: { kind: "everyone" }, dueInDays: null, reminderDaysBefore: 2, isActive: true }), /need a due date/);
    const asg = await learn.saveAssignment(tx, priya, c.id, null, { name: "Engineering", rule: { kind: "departments", ids: [eng.id] }, dueInDays: 7, reminderDaysBefore: 2, isActive: true });
    assert.equal(asg.enrolled, 0, "draft courses don't enrol yet");
    const before = await notes(tx, arjun, "learn.assigned");
    await learn.setCourseStatus(tx, priya, c.id, "published");
    const enrolled = await tx<{ employee_id: string; due_date: string }[]>`select employee_id, due_date::text from enrollments where course_id = ${c.id}`;
    assert.equal(enrolled.length, 4, "the four engineers are enrolled on publish");
    assert.equal(enrolled[0].due_date, addDaysISO(today, 7));
    assert.equal(await notes(tx, arjun, "learn.assigned"), before + 1);
    assert.equal(await learn.applyAssignments(tx, tenant.id, today), 0, "re-applying rules enrols nobody twice");
    assert.equal(await learn.enrollPeople(tx, priya, c.id, [sneha.employeeId, arjun.employeeId], 3), 1, "manual enrolment skips people already in");
    await assert.rejects(learn.enrollPeople(tx, priya, c.id, [randomUUID()], null), /don't exist/);
    // learner: player hides the answer key; quiz must be passed; completion issues a certificate
    const pl = await learn.player(tx, arjun, c.id);
    assert.equal(pl!.modules.length, 3); assert.equal(pl!.next_module_id, pl!.modules[0].id);
    assert.ok(pl!.modules[2].quiz && !("correct" in pl!.modules[2].quiz.questions[0]), "learners never see the answer key");
    assert.ok(await learn.learnFileFor(tx, arjun, f.file_id), "enrolled: module file opens");
    assert.equal(await learn.learnFileFor(tx, imran, f.file_id), null, "not enrolled (Sales): closed");
    await assert.rejects(learn.completeModule(tx, arjun, c.id, quiz.id), /Pass the quiz/);
    await assert.rejects(learn.completeModule(tx, imran, c.id, doc.id), /not enrolled/);
    let r = await learn.completeModule(tx, arjun, c.id, doc.id);
    assert.equal(r.percent, 33.33);
    r = await learn.completeModule(tx, arjun, c.id, doc.id);
    assert.equal(r.percent, 33.33, "completing twice doesn't double count");
    await learn.completeModule(tx, arjun, c.id, pl!.modules[1].id);
    const fail = await learn.submitQuiz(tx, arjun, c.id, quiz.id, [1, 1]);
    assert.deepEqual([fail.score, fail.passed, fail.completed], [1, false, false]);
    const pass = await learn.submitQuiz(tx, arjun, c.id, quiz.id, [1, 0]);
    assert.deepEqual([pass.score, pass.passed, pass.completed, pass.percent], [2, true, true, 100]);
    await track(tx);
    const [e] = await tx<{ completed_at: Date | null; certificate_file_id: string | null; certificate_code: string | null }[]>`select completed_at, certificate_file_id, certificate_code from enrollments where course_id = ${c.id} and employee_id = ${arjun.employeeId}`;
    assert.ok(e.completed_at && e.certificate_file_id && e.certificate_code, "completion sets the time, a certificate PDF and a code");
    const cert = await learn.learnFileFor(tx, arjun, e.certificate_file_id!);
    assert.ok(cert && cert.mime === "application/pdf");
    const bytes = await storage().get(cert!.storage_key);
    assert.equal(new TextDecoder().decode(bytes!.subarray(0, 5)), "%PDF-");
    assert.equal(await learn.learnFileFor(tx, meera, e.certificate_file_id!), null, "colleagues can't open someone's certificate");
    assert.ok(await learn.learnFileFor(tx, engReader, e.certificate_file_id!), "a scoped report reader in the same department can");
    const my = await learn.myCourses(tx, arjun, today);
    assert.equal(my.find((m) => m.course_id === c.id)!.state, "completed");
    const [attempts] = await tx<{ n: number }[]>`select count(*)::int as n from quiz_attempts where module_id = ${quiz.id}`;
    assert.equal(attempts.n, 2);
    // removing a module recomputes in-progress people, not completed ones
    await learn.deleteModule(tx, priya, c.id, pl!.modules[1].id);
    const [after] = await tx<{ percent: string }[]>`select percent::text from enrollments where course_id = ${c.id} and employee_id = ${meera.employeeId}`;
    assert.equal(Number(after.percent), 0);
    await assert.rejects(learn.deleteCourse(tx, priya, c.id), /enrolled/);
    // reminders: due in 2 days from 7-day due with 2-day lead → not yet; overdue person → once per day
    await tx`update enrollments set reminded_on = null where reminded_on = ${today}`;   // pnpm jobs:daily may already have reminded people today
    assert.equal(await learn.sendReminders(tx, tenant, today), 3, "Divya and Sneha are overdue on the conduct course (seed); Sneha's manual fire-safety enrolment is due in 3 days");
    assert.equal(await learn.sendReminders(tx, tenant, today), 0, "same day: no second reminder");
    assert.equal(await learn.sendReminders(tx, tenant, addDaysISO(today, 1)), 3, "next day: again");
    const mails = await tx<{ n: number }[]>`select count(*)::int as n from outbound_emails where kind = 'learn.reminder' and created_at >= now()`;
    assert.equal(mails[0].n, 6);
    assert.equal(await learn.sendReminders(tx, tenant, addDaysISO(today, 6)), 6, "two days before the Engineering due date the engineers still working on it join in");
    // reports: scoped
    const all = await learn.completionReport(tx, priya, {}, today);
    assert.ok(all.byCourse.find((x) => x.course === "Fire safety")!.enrolled === 5);
    const scoped = await learn.completionReport(tx, engReader, {}, today);
    assert.ok(scoped.learners.every((l) => ["Rohan Mehta", "Arjun Rao", "Meera Iyer", "Vikram Joshi"].includes(l.employee)), "a department-scoped reader only sees their people");
    assert.ok(all.overdue.some((o) => o.employee === "Divya Pillai"));
    await assert.rejects(learn.completionReport(tx, arjun, {}, today), /learning admins/);
  });
  ok("learn: authoring is unscoped learn.admin; module validation and sanitising; rules enrol on publish and stay idempotent; players never see answer keys; quiz pass → completion → certificate PDF with private access; reminders once a day; reports scoped");

  // ======================================================================= Reports
  await rollback(tenant.id, async (tx) => {
    await assert.rejects(reports.runStandard(tx, arjun, "employee_master", {}), /report access/);
    assert.ok(!reports.library(engReader).some((r) => r.key === "payroll_runs"), "company-wide reports need an unscoped grant");
    assert.ok(reports.library(priya).some((r) => r.key === "payroll_runs"));
    for (const r of STANDARD_REPORTS) {
      const out = await reports.runStandard(tx, priya, r.key, { from: addDaysISO(today, -60), to: today });
      assert.ok(out.headers.length > 0 && Array.isArray(out.rows), `${r.key} runs`);
      for (const h of out.headers) assert.ok(out.rows.every((row) => h.key in row), `${r.key}: column ${h.key} present`);
    }
    for (const ds of DATASETS) {   // every whitelisted dataset's SQL runs with all its columns (other packages' tables included)
      const out = await reports.preview(tx, priya, ds.key, { columns: ds.columns.map((c) => c.key) });
      assert.ok(Array.isArray(out.rows) && out.headers.length === ds.columns.length, `${ds.key} dataset previews`);
    }
    const master = await reports.runStandard(tx, priya, "employee_master", { status: "all" });
    assert.equal(master.rows.length, (await tx<{ n: number }[]>`select count(*)::int as n from employees`)[0].n, "unscoped readers see everyone, including people who left");
    const scoped = await reports.runStandard(tx, engReader, "employee_master", { status: "all" });
    const engNames = (await tx<{ display_name: string }[]>`select display_name from employees where department_id = ${eng.id} order by 1`).map((r) => r.display_name);
    assert.deepEqual(scoped.rows.map((r) => r.name).sort(), engNames, "scoped readers get their departments only");
    const late = await reports.runStandard(tx, priya, "attendance_late", { from: addDaysISO(today, -30), to: today });
    assert.ok(late.rows.every((r) => Number(r.late_minutes) > 0));
    const ts = await reports.runStandard(tx, priya, "timesheets", { from: addDaysISO(today, -30), to: today });
    assert.ok(ts.rows.some((r) => r.project === "Northwind Storefront" && Number(r.approved_hours) > 0));
    const csv = await reports.exportStandard(tx, engReader, "employee_master", { status: "all" }, "csv");
    const text = new TextDecoder().decode(csv.bytes);
    assert.ok(text.includes("Arjun Rao") && !text.includes("Karan Singh"));
    const xlsx = await reports.exportStandard(tx, priya, "leave_balances", {}, "xlsx");
    assert.equal(xlsx.bytes[0], 0x50, "xlsx is a zip"); assert.ok(xlsx.name.endsWith(".xlsx"));
    const [aud] = await tx<{ n: number }[]>`select count(*)::int as n from audit_logs where entity_type = 'report' and action = 'export' and created_at >= now()`;
    assert.equal(aud.n, 2, "every export is audited");
    // builder: whitelisted datasets, parameterised filters, scoping, sharing, ownership
    await assert.rejects(reports.preview(tx, engReader, "employees", { columns: ["name"] }).then(() => reports.preview(tx, arjun, "employees", { columns: ["name"] })), /report-building/);
    await assert.rejects(reports.preview(tx, priya, "pg_tables", { columns: ["name"] }), /Pick a dataset/);
    await assert.rejects(reports.preview(tx, priya, "employees", { columns: ["name"], filters: [{ col: "name", op: "eq; drop table employees", value: "x" }] }), /comparison/);
    const pv = await reports.preview(tx, priya, "employees", { columns: ["name", "department"], filters: [{ col: "name", op: "contains", value: "' or 1=1 --" }] });
    assert.equal(pv.rows.length, 0, "injection text is just text");
    const grouped = await reports.preview(tx, engReader, "time_entries", { groupBy: "project", aggregates: [{ fn: "sum", col: "hours" }], filters: [{ col: "timesheet_status", op: "eq", value: "approved" }], sort: { col: "sum_hours", dir: "desc" } });
    assert.ok(grouped.rows.length >= 1 && Number(grouped.rows[0].sum_hours) > 0);
    const exp = await reports.preview(tx, priya, "expense_claims", { columns: ["name", "total"], filters: [{ col: "total", op: "gte", value: 1 }] });
    assert.ok(exp.rows.every((r) => Number(r.total) >= 100));
    const saved = await reports.saveReport(tx, karan, null, { name: "Eng people", dataset: "employees", definition: { columns: ["name", "department"], filters: [{ col: "department", op: "eq", value: "Engineering" }] }, sharedRoles: ["hr_admin"] });
    await assert.rejects(reports.saveReport(tx, karan, null, { name: "x", dataset: "employees", definition: { columns: ["name"] }, sharedRoles: ["nope"] }), /doesn't exist/);
    assert.ok((await reports.listSaved(tx, priya)).some((s) => s.id === saved.id && !s.mine), "shared with hr_admin: Priya sees it");
    await assert.rejects(reports.listSaved(tx, rohan), /report access/, "people without report access see nothing");
    assert.ok(!(await reports.listSaved(tx, { ...rohan, permissions: new Set(["reports.read"]), grants: [{ permissions: ["reports.read"], scopes: [] }] })).some((s) => s.id === saved.id), "readers outside the shared roles don't see it");
    await assert.rejects(reports.saveReport(tx, priya, saved.id, { name: "mine now", dataset: "employees", definition: { columns: ["name"] }, sharedRoles: [] }), /isn't yours/);
    await assert.rejects(reports.deleteReport(tx, priya, saved.id), /isn't yours/);
    await assert.rejects(reports.runSaved(tx, rohan, saved.id), /report access|not found/);
    const ran = await reports.runSaved(tx, priya, saved.id);
    assert.equal(ran.rows.length, engNames.length);
    const ranScoped = await reports.runSaved(tx, { ...engReader, roles: ["hr_admin"] }, saved.id);
    assert.equal(ranScoped.rows.length, engNames.length, "a shared report still applies the reader's own scope");
    // schedule + delivery job
    await assert.rejects(reports.setSchedule(tx, priya, saved.id, { frequency: "daily", hour: 9, recipients: [asha.employeeId] }), /isn't yours/);
    await assert.rejects(reports.setSchedule(tx, karan, saved.id, { frequency: "daily", hour: 9, recipients: [] }), /at least one person/);
    await assert.rejects(reports.setSchedule(tx, karan, saved.id, { frequency: "daily", hour: 9, recipients: [randomUUID()] }), /erp account/);
    const now = new Date("2026-11-03T04:00:00Z");
    const sch = await reports.setSchedule(tx, karan, saved.id, { frequency: "daily", hour: 9, recipients: [asha.employeeId, rohan.employeeId], format: "csv" }, now);
    assert.equal(sch!.next_run_at.toISOString(), "2026-11-04T03:30:00.000Z");
    const later = new Date("2026-11-04T04:00:00Z");
    const sent = await reports.deliverDue(tx, tenant, later);
    assert.ok(sent >= 1);
    await track(tx);
    const [d] = await tx<{ id: string; row_count: number; next_run_at: Date }[]>`select d.id, d.row_count, s.next_run_at from report_deliveries d join saved_reports s on s.id = d.saved_report_id where d.saved_report_id = ${saved.id}`;
    assert.equal(d.row_count, engNames.length); assert.equal(d.next_run_at.toISOString(), "2026-11-05T03:30:00.000Z");
    assert.equal(await reports.deliverDue(tx, tenant, later), 0, "running the job again sends nothing new");
    assert.ok(await reports.deliveryFileFor(tx, rohan, d.id), "a recipient opens the file");
    assert.ok(await reports.deliveryFileFor(tx, karan, d.id), "so does the owner");
    assert.equal(await reports.deliveryFileFor(tx, priya, d.id), null, "nobody else, even with the report shared");
    const [mail] = await tx<{ n: number }[]>`select count(*)::int as n from outbound_emails where kind = 'report.scheduled' and created_at >= now()`;
    assert.equal(mail.n, 2);
    assert.equal(await notes(tx, rohan, "report.delivered"), 1);
    await reports.setSchedule(tx, karan, saved.id, null);
    assert.equal((await reports.savedReport(tx, karan, saved.id))!.schedule, null);
    // seeded schedule: delivering on its due time stops the schedule if the owner lost access
    const [seeded] = await tx<{ id: string; next_run_at: Date }[]>`select id, next_run_at from saved_reports where name like 'Expense claims above%'`;
    await tx`update roles set permissions = '{}' where key = 'finance'`;
    await reports.deliverDue(tx, tenant, new Date(seeded.next_run_at.getTime() + 60_000));
    const [stopped] = await tx<{ next_run_at: Date | null }[]>`select next_run_at from saved_reports where id = ${seeded.id}`;
    assert.equal(stopped.next_run_at, null, "owner without builder access any more: schedule stops instead of running with stale rights");
  });
  ok("reports: library and every standard report run scoped; CSV/XLSX exports audited; builder refuses unknown datasets/ops and parameterises values; saved reports shared by role but owned; schedules deliver once per due time to recipients only");

  // ======================================================================= tenant isolation
  const otherId = randomUUID();
  await admin`insert into tenants (id, subdomain, name) values (${otherId}, ${"smoke-" + otherId.slice(0, 8)}, 'Smoke Co')`;
  try {
    const [c] = await withTenant(otherId, (tx) => tx<{ n: string }[]>`
      select concat_ws('/', (select count(*) from clients), (select count(*) from projects), (select count(*) from project_members), (select count(*) from project_tasks), (select count(*) from project_milestones),
        (select count(*) from timesheets), (select count(*) from time_entries), (select count(*) from psa_invoices), (select count(*) from timesheet_policies),
        (select count(*) from courses), (select count(*) from course_modules), (select count(*) from course_assignments), (select count(*) from enrollments), (select count(*) from quiz_attempts),
        (select count(*) from saved_reports), (select count(*) from report_deliveries)) as n`);
    assert.equal(c.n, "0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0");
    const outsider = { ...asha, tenant: { ...tenant, id: otherId } } as Actor;
    const [ts] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from timesheets where status = 'submitted' limit 1`);
    const [inv] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from psa_invoices limit 1`);
    const [course] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from courses where status = 'published' limit 1`);
    const [rep] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from saved_reports limit 1`);
    assert.equal(await withTenant(otherId, (tx) => psa.timesheetDetail(tx, outsider, ts.id)), null);
    assert.equal(await withTenant(otherId, (tx) => psa.invoiceDetail(tx, outsider, inv.id)), null);
    assert.equal(await withTenant(otherId, (tx) => psa.projectDetail(tx, outsider, P.store)), null);
    assert.equal(await withTenant(otherId, (tx) => learn.player(tx, outsider, course.id)), null);
    assert.equal(await withTenant(otherId, (tx) => learn.courseAdmin(tx, outsider, course.id)), null);
    assert.equal(await withTenant(otherId, (tx) => reports.savedReport(tx, outsider, rep.id)), null);
    await assert.rejects(withTenant(otherId, (tx) => psa.setInvoiceStatus(tx, outsider, inv.id, "void")), /not found/);
    await assert.rejects(withTenant(otherId, (tx) => psa.reopenTimesheet(tx, outsider, ts.id, "x")), /approved weeks/);
    await assert.rejects(withTenant(otherId, (tx) => learn.setCourseStatus(tx, outsider, course.id, "archived")), /not found/);
    await assert.rejects(withTenant(otherId, (tx) => tx`insert into clients (tenant_id, name) values (${tenant.id}, 'sneaky')`), /row-level security/);
    await assert.rejects(withTenant(otherId, (tx) => tx`insert into timesheet_policies (tenant_id) values (${tenant.id})`), /row-level security/);
    const u = await withTenant(otherId, (tx) => tx`update enrollments set completed_at = now()`);
    assert.equal(u.count, 0);
    assert.deepEqual(await withTenant(otherId, (tx) => reports.visibleEmployeeIds(tx, outsider)), []);
  } finally {
    await admin`delete from tenants where id = ${otherId}`;
  }
  ok("another tenant sees none of Acme's projects, timesheets, invoices, courses, enrolments or reports and can't read, change or insert into them");

  // every workspace route handler checks the session first; nothing here is on the public allow-list
  const { readFileSync } = await import("node:fs");
  const proxy = readFileSync(new URL("../src/proxy.ts", import.meta.url), "utf8");
  assert.ok(!/psa|learn|reports|timesheet/.test(proxy), "no workspace path is public in src/proxy.ts");
  for (const f of ["../src/app/(app)/learn/files/[id]/route.ts", "../src/app/(app)/reports/export/route.ts", "../src/app/(app)/reports/deliveries/[id]/route.ts", "../src/app/(app)/psa/billing/[id]/pdf/route.ts"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.ok(src.includes("getActor()") && src.includes("401"), `${f} requires a session`);
  }
  ok("public-route safety: no workspace path is public; every file / export route refuses anonymous requests");

  for (const k of blobs) await storage().remove(k).catch(() => {});
  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await admin.end(); await sql.end(); }).catch(async (e) => {
  for (const k of blobs) await storage().remove(k).catch(() => {});
  console.error("\nFAILED:", e instanceof AppError ? `${e.code}: ${e.message}` : e); await admin.end(); await sql.end(); process.exit(1);
});
