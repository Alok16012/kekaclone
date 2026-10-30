/**
 * Smoke test for exits + documents against the seeded demo tenant (run `pnpm db:seed` first).
 * Everything runs in rolled-back transactions, so the demo data stays as seeded (stored file bytes are cleaned up at the end).
 *   pnpm smoke:exitdocs
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { withTenant, sql, AppError, type Tx } from "@/server/db";
import * as approvals from "@/server/modules/approvals/service";
import * as exits from "@/server/modules/exits/service";
import * as leave from "@/server/modules/leave/service";
import * as docs from "@/server/modules/documents/service";
import * as letters from "@/server/modules/documents/letters";
import { renderLetterPdf } from "@/server/modules/documents/pdf";
import { storage } from "@/server/storage";
import { addDaysISO, todayIn } from "@/lib/dates";
import type { Actor } from "@/server/auth/session";
import type { Scope } from "@/server/auth/catalog";
import { DEMO_SUBDOMAIN } from "./demo";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const rollback = async (tenantId: string, fn: (tx: Tx) => Promise<void>) =>
  withTenant(tenantId, async (tx) => { await fn(tx); throw new Error("rollback"); }).catch((e) => { if (e.message !== "rollback") throw e; });
const blobs: string[] = [];
const track = async (tx: Tx) => { for (const f of await tx<{ storage_key: string }[]>`select storage_key from files where created_at >= now()`) blobs.push(f.storage_key); };

async function main() {
  const [t] = await sql<{ id: string }[]>`select id from tenant_by_subdomain(${DEMO_SUBDOMAIN})`;
  assert.ok(t, "demo tenant exists (run pnpm db:seed)");
  const tenant = { id: t.id, name: "Acme Technologies", status: "trial", subdomain: DEMO_SUBDOMAIN };
  const actor = (first: string, permissions: string[] = [], scopes: Scope[] = []) => withTenant(tenant.id, async (tx) => {
    const [e] = await tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`;
    assert.ok(e, `${first} exists`);
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(permissions), grants: permissions.length ? [{ permissions, scopes }] : [] } as Actor;
  });
  const HR = ["employees.read", "employees.write", "exits.manage", "documents.manage", "approvals.override", "settings.org"];
  const asha = await actor("Asha", ["*"]), priya = await actor("Priya", HR), rohan = await actor("Rohan"), arjun = await actor("Arjun"), meera = await actor("Meera");
  const sneha = await actor("Sneha"), divya = await actor("Divya"), imran = await actor("Imran");
  const today = todayIn();
  const [sales] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from departments where name = 'Sales'`);
  const salesHr = await actor("Karan", ["exits.manage", "documents.manage"], [{ type: "department", ids: [sales.id] }]);

  // ---------- defaults ----------
  await rollback(tenant.id, async (tx) => {
    const count = async () => (await tx<{ n: string }[]>`select (select count(*) from notice_period_policies)::text || '/' || (select count(*) from exit_reasons) || '/' || (select count(*) from task_template_items) as n`)[0].n;
    const before = await count();
    await exits.ensureExitDefaults(tx, tenant.id); await exits.ensureExitDefaults(tx, tenant.id);
    await letters.ensureLetterDefaults(tx, tenant.id); await letters.ensureLetterDefaults(tx, tenant.id);
    assert.equal(await count(), before, "defaults are idempotent");
    const pols = await exits.listNoticePolicies(tx);
    assert.deepEqual(pols.map((p) => p.days), [30, 60, 90]);
    assert.equal(pols.filter((p) => p.is_default).length, 1);
    assert.equal((await letters.listTemplates(tx)).filter((x) => x.kind === "relieving" || x.kind === "experience").length, 2);
  });
  ok("defaults: notice periods 30/60/90 (one default), reasons, exit checklist and letters; re-running adds nothing");

  // ---------- notice period + LWD ----------
  await rollback(tenant.id, async (tx) => {
    const n = await exits.noticeFor(tx, arjun.employeeId, today);
    assert.equal(n.days, 60); assert.equal(n.lastWorkingDate, addDaysISO(today, 60));
    const k = await exits.noticeFor(tx, (await actor("Karan")).employeeId, today);
    assert.equal(k.days, 30, "no policy → company default");
    await tx`update employees set probation_status = 'in_probation', probation_end_date = ${addDaysISO(today, 30)} where id = ${arjun.employeeId}`;
    assert.equal((await exits.noticeFor(tx, arjun.employeeId, today)).days, 30, "probation notice of the 60-day policy");
    await assert.rejects(exits.noticePreview(tx, meera, arjun.employeeId, today), /can't manage exits/);
    // settings: one default at a time; default and in-use policies can't be deleted
    const [p90] = await tx<{ id: string }[]>`select id from notice_period_policies where days = 90`;
    await exits.saveNoticePolicy(tx, priya, p90.id, { name: "90 days", days: 90, probationDays: 30, isDefault: true });
    const defaults = await tx<{ days: number }[]>`select days from notice_period_policies where is_default`;
    assert.deepEqual(defaults.map((d) => d.days), [90]);
    await assert.rejects(exits.deleteNoticePolicy(tx, priya, p90.id), /default/);
    const [p60] = await tx<{ id: string }[]>`select id from notice_period_policies where days = 60`;
    await assert.rejects(exits.deleteNoticePolicy(tx, priya, p60.id), /still on this notice period/);
    await assert.rejects(exits.saveNoticePolicy(tx, priya, null, { name: "60 days", days: 45, probationDays: null, isDefault: false }), /already exists/);
    await assert.rejects(exits.saveNoticePolicy(tx, arjun, null, { name: "x", days: 1, probationDays: null, isDefault: false }), /access/);
  });
  ok("notice: personal policy (60 days), company default (30), probation notice, one default at a time, protected deletes, HR-only");

  // ---------- resign → withdraw → resign → manager → HR → in progress ----------
  await rollback(tenant.id, async (tx) => {
    const [reason] = await tx<{ id: string }[]>`select id from exit_reasons where name = 'Better opportunity'`;
    await assert.rejects(exits.resign(tx, arjun, { comments: "" }), /Tell us why/);
    await assert.rejects(tx.savepoint((sp) => exits.resign(sp as Tx, arjun, { reasonId: reason.id, lastWorkingDate: addDaysISO(today, -1) })), /can't be before the resignation/);
    const r1 = await exits.resign(tx, arjun, { reasonId: reason.id });
    assert.equal(r1.status, "under_review"); assert.equal(r1.lastWorkingDate, addDaysISO(today, 60));
    await assert.rejects(tx.savepoint((sp) => exits.resign(sp as Tx, arjun, { reasonId: reason.id })), /already an exit in progress/);
    await assert.rejects(exits.withdraw(tx, meera, r1.id), /not found/);
    await exits.withdraw(tx, arjun, r1.id);
    await assert.rejects(exits.withdraw(tx, arjun, r1.id), /closed/);
    const [cancelled] = await tx<{ status: string }[]>`select status from approval_requests where entity_type = 'exit' and entity_id = ${r1.id}`;
    assert.equal(cancelled.status, "cancelled");

    const r2 = await exits.resign(tx, arjun, { reasonId: reason.id, lastWorkingDate: addDaysISO(today, 45), comments: "Moving on" });
    const [{ notice_waived_days }] = await tx<{ notice_waived_days: number }[]>`select notice_waived_days from exit_requests where id = ${r2.id}`;
    assert.equal(notice_waived_days, 15, "asked for 15 days less than the notice");
    assert.equal((await approvals.inbox(tx, priya)).some((i) => i.entity_id === r2.id), false, "HR isn't asked before the manager");
    const step1 = (await approvals.inbox(tx, rohan)).find((i) => i.entity_id === r2.id);
    assert.ok(step1, "the manager is asked first");
    await assert.rejects(approvals.decide(tx, meera, step1.step_id, "approved"), /isn't waiting for you/);
    await approvals.decide(tx, rohan, step1.step_id, "approved");
    assert.equal((await tx<{ status: string }[]>`select status from exit_requests where id = ${r2.id}`)[0].status, "under_review");
    const step2 = (await approvals.inbox(tx, priya)).find((i) => i.entity_id === r2.id);
    assert.ok(step2, "then HR");
    await approvals.decide(tx, priya, step2.step_id, "approved", "All the best");
    const [x] = await tx<{ status: string; emp: string; exit_date: string }[]>`
      select x.status, e.status as emp, e.exit_date::text from exit_requests x join employees e on e.id = x.employee_id where x.id = ${r2.id}`;
    assert.deepEqual(x, { status: "in_progress", emp: "notice", exit_date: addDaysISO(today, 45) });
    const tasks = await tx<{ title: string; who: string; due: string }[]>`
      select t.title, a.first_name as who, t.due_date::text as due from tasks t join exit_requests x on x.process_id = t.process_id join employees a on a.id = t.assignee_employee_id
      where x.id = ${r2.id} order by t.title`;
    assert.deepEqual(tasks.map((k) => `${k.title}:${k.who}`), ["Final settlement:Priya", "Knowledge transfer:Rohan", "Return company assets:Arjun", "Revoke IT access:Asha"]);
    assert.equal(tasks.find((k) => k.title === "Knowledge transfer")!.due, addDaysISO(today, 42));
    await assert.rejects(exits.withdraw(tx, arjun, r2.id), /already accepted/);
    const [n] = await tx<{ c: number }[]>`select count(*)::int as c from notifications where user_id = ${arjun.userId} and kind = 'request.approved'`;
    assert.ok(n.c >= 1, "Arjun hears the result");
    // detail visibility
    assert.ok(await exits.exitDetail(tx, arjun, r2.id), "the person sees their exit");
    assert.ok(await exits.exitDetail(tx, rohan, r2.id), "the manager sees it");
    assert.equal(await exits.exitDetail(tx, meera, r2.id), null, "a colleague doesn't");
    const d = await exits.exitDetail(tx, priya, r2.id);
    assert.equal(d?.can.manage, true); assert.equal(d?.can.complete, false);
  });
  ok("resign: reason needed, no past last day, one open exit, only the person withdraws, waived days recorded");
  ok("approval: manager first then HR (engine entity 'exit'); accepted → serving notice, checklist owners self/manager/admin/HR with due dates");

  // ---------- HR initiate, scope, checklist, complete, relieve job, cancel, decline ----------
  await rollback(tenant.id, async (tx) => {
    await assert.rejects(exits.initiateExit(tx, arjun, { employeeId: meera.employeeId, kind: "company_action", resignationDate: today }), /can't manage exits/);
    await assert.rejects(exits.initiateExit(tx, salesHr, { employeeId: meera.employeeId, kind: "company_action", resignationDate: today }), /can't manage exits/);
    await assert.rejects(exits.initiateExit(tx, priya, { employeeId: priya.employeeId, kind: "resignation", resignationDate: today }), /resign from your profile/);
    await assert.rejects(exits.initiateExit(tx, priya, { employeeId: meera.employeeId, kind: "resignation", resignationDate: today, lastWorkingDate: addDaysISO(today, -3) }), /can't be before/);
    await assert.rejects(tx.savepoint((sp) => exits.initiateExit(sp as Tx, priya, { employeeId: divya.employeeId, kind: "resignation", resignationDate: today })), /already an exit/);
    const s = await exits.initiateExit(tx, salesHr, { employeeId: sneha.employeeId, kind: "company_action", resignationDate: today, lastWorkingDate: addDaysISO(today, 10), okToRehire: false });
    const scoped = await exits.board(tx, salesHr);
    assert.deepEqual([...scoped.review, ...scoped.progress].map((r) => r.name).sort(), ["Imran Khan", "Sneha Kulkarni"], "scoped HR sees Sales exits only");
    const full = await exits.board(tx, priya);
    assert.ok(full.progress.some((r) => r.name === "Divya Pillai") && full.exited.some((r) => r.name === "Nikhil Menon"));
    assert.equal((await exits.board(tx, arjun)).progress.length, 0);
    assert.deepEqual(Object.values(await exits.board(tx, asha)).map((x) => x.length), Object.values(full).map((x) => x.length), "global admin sees everything");

    // checklist permissions
    const [own] = await tx<{ id: string }[]>`select t.id from tasks t join exit_requests x on x.process_id = t.process_id where x.id = ${s.id} and t.assignee_employee_id = ${sneha.employeeId}`;
    await assert.rejects(exits.setTaskStatus(tx, meera, own.id, "done"), /Only the task owner/);
    await assert.rejects(exits.setTaskStatus(tx, sneha, own.id, "skipped"), /Only HR/);
    await exits.setTaskStatus(tx, sneha, own.id, "done");
    await exits.setTaskStatus(tx, priya, own.id, "open");

    // can't complete before the last day; the job relieves the day after it, once
    await assert.rejects(exits.completeExit(tx, priya, s.id), /from the last working day/);
    await tx`insert into sessions (tenant_id, user_id, token_hash, expires_at) values (${tenant.id}, ${sneha.userId}, ${"smoke-" + randomUUID()}, now() + interval '1 day')`;
    // an open leave request after the last day sits in the manager's inbox until Sneha is relieved
    const [cl] = await tx<{ id: string }[]>`select id from leave_types where code = 'CL'`;
    let later = addDaysISO(today, 15);
    while ([0, 6].includes(new Date(later + "T00:00:00Z").getUTCDay())) later = addDaysISO(later, 1);
    const lr = await leave.apply(tx, sneha, { leaveTypeId: cl.id, from: later, to: later, fromPart: "full", toPart: "full" });
    assert.equal(lr.status, "pending");
    assert.equal(await exits.processDueExits(tx, addDaysISO(today, 10)), 0, "not on the last working day itself");
    assert.equal(await exits.processDueExits(tx, addDaysISO(today, 11)), 1, "only Sneha (Divya leaves later)");
    assert.equal(await exits.processDueExits(tx, addDaysISO(today, 11)), 0, "running again changes nothing");
    const [after] = await tx<{ x: string; e: string; u: string; sessions: number; p: string }[]>`
      select x.status as x, e.status as e, u.status as u, (select count(*)::int from sessions where user_id = u.id) as sessions, p.status as p
      from exit_requests x join employees e on e.id = x.employee_id join users u on u.id = e.user_id join lifecycle_processes p on p.id = x.process_id where x.id = ${s.id}`;
    assert.deepEqual(after, { x: "exited", e: "relieved", u: "disabled", sessions: 0, p: "completed" });
    const [lq] = await tx<{ q: string; a: string }[]>`
      select q.status as q, a.status as a from leave_requests q join approval_requests a on a.entity_type = 'leave' and a.entity_id = q.id where q.id = ${lr.id}`;
    assert.deepEqual(lq, { q: "cancelled", a: "cancelled" }, "relieving withdraws the person's pending requests");
    const [{ waiting }] = await tx<{ waiting: number }[]>`
      select count(*)::int as waiting from approval_steps s join approval_requests a on a.id = s.request_id where a.requester_employee_id = ${sneha.employeeId} and s.status = 'pending'`;
    assert.equal(waiting, 0, "nothing of theirs is left in an inbox");
    // the session lookup used by every page no longer finds them
    const [{ live }] = await tx<{ live: number }[]>`select count(*)::int as live from users u join employees e on e.user_id = u.id and e.status <> 'relieved' where u.id = ${sneha.userId} and u.status = 'active'`;
    assert.equal(live, 0);
    await assert.rejects(exits.cancelExit(tx, priya, s.id), /already exited/);
  });
  ok("initiate: HR only, scoped HR only in scope, not for yourself, valid dates, one open exit per person; scoped board");
  ok("checklist: owner or HR ticks, only HR skips; complete not before the last day");
  ok("relieve job: day after the last working day → exited, relieved, login disabled, sessions ended, open requests withdrawn; idempotent");

  await rollback(tenant.id, async (tx) => {
    const [dx] = await tx<{ id: string; process_id: string }[]>`select id, process_id from exit_requests where employee_id = ${divya.employeeId} and status = 'in_progress'`;
    await exits.updateExit(tx, priya, dx.id, { lastWorkingDate: addDaysISO(today, 5) });
    assert.equal((await tx<{ d: string }[]>`select exit_date::text as d from employees where id = ${divya.employeeId}`)[0].d, addDaysISO(today, 5));
    await assert.rejects(exits.updateExit(tx, arjun, dx.id, { lastWorkingDate: addDaysISO(today, 5) }), /can't manage/);
    await exits.cancelExit(tx, priya, dx.id);
    const [c] = await tx<{ x: string; e: string; open: number; exit_date: string | null }[]>`
      select x.status as x, e.status as e, e.exit_date::text, (select count(*)::int from tasks where process_id = ${dx.process_id} and status = 'open') as open
      from exit_requests x join employees e on e.id = x.employee_id where x.id = ${dx.id}`;
    assert.deepEqual(c, { x: "withdrawn", e: "active", open: 0, exit_date: null });
    // HR declines Imran's pending resignation from the board
    const [ix] = await tx<{ id: string }[]>`select id from exit_requests where employee_id = ${imran.employeeId} and status = 'under_review'`;
    await assert.rejects(exits.hrDecide(tx, arjun, ix.id, "rejected"), /can't manage/);
    await exits.hrDecide(tx, priya, ix.id, "rejected", "Let's talk first");
    const [ir] = await tx<{ x: string; r: string; open: number }[]>`
      select x.status as x, r.status as r, (select count(*)::int from approval_steps s where s.request_id = r.id and s.status in ('pending','waiting')) as open
      from exit_requests x join approval_requests r on r.entity_type = 'exit' and r.entity_id = x.id where x.id = ${ix.id}`;
    assert.deepEqual(ir, { x: "rejected", r: "rejected", open: 0 });
    assert.equal((await approvals.inbox(tx, sneha)).some((i) => i.entity_id === ix.id), false, "the manager's inbox item is gone");
    await assert.rejects(exits.hrDecide(tx, priya, ix.id, "approved"), /closed/);
  });
  ok("HR edits the last day, cancels an exit (person active again, open tasks skipped), declines a resignation (inbox cleared)");

  // review fix: HR can't push their own resignation through, edit it, cancel it or tick their own checklist as HR
  await rollback(tenant.id, async (tx) => {
    const [reason] = await tx<{ id: string }[]>`select id from exit_reasons limit 1`;
    const r = await exits.resign(tx, priya, { reasonId: reason.id });
    if (r.status === "under_review") {
      await assert.rejects(exits.hrDecide(tx, priya, r.id, "approved"), /your own exit/);
      const d = await exits.exitDetail(tx, priya, r.id);
      assert.ok(d && !d.can.manage && !d.can.decide, "no HR controls on your own exit");
    }
    await assert.rejects(exits.updateExit(tx, priya, r.id, { lastWorkingDate: addDaysISO(today, 1) }), /your own exit/);
    await assert.rejects(exits.cancelExit(tx, priya, r.id), /your own exit/);
    await assert.rejects(exits.completeExit(tx, priya, r.id), /your own exit/);
  });
  ok("own exit: HR can't accept, edit, cancel or complete their own resignation");

  // review fix: company-wide documents, letter templates and exit settings need an unscoped grant
  await rollback(tenant.id, async (tx) => {
    const forbidden = /access/;
    await assert.rejects(docs.saveFolder(tx, salesHr, null, { name: "Scoped", access: { type: "org" } }), forbidden);
    const [cp] = await tx<{ id: string }[]>`select id from document_folders where name = 'Company policies'`;
    await assert.rejects(docs.uploadDocument(tx, salesHr, { folderId: cp.id, title: "x", requiresAck: false, blockUntilAck: false, file: { name: "a.pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) } }), forbidden);
    const [doc] = await tx<{ id: string }[]>`select id from org_documents limit 1`;
    await assert.rejects(docs.tracking(tx, salesHr, doc.id), forbidden);
    await assert.rejects(docs.deleteDocument(tx, salesHr, doc.id), forbidden);
    await assert.rejects(letters.saveTemplate(tx, salesHr, null, { name: "Scoped letter", kind: "relieving", body: "<p>Hi</p>" }), forbidden);
    assert.equal(docs.canManageDocs(salesHr), false);
    assert.equal(docs.canManageDocs(priya), true);
    await assert.rejects(exits.saveNoticePolicy(tx, salesHr, null, { name: "Scoped", days: 10, probationDays: null, isDefault: true }), forbidden);
    const [p30] = await tx<{ id: string }[]>`select id from notice_period_policies where days = 30`;
    await assert.rejects(exits.assignNoticePolicy(tx, salesHr, p30.id, [arjun.employeeId]), forbidden);
    // they still see only the folders their own placement allows
    const own = await actor("Karan");
    assert.deepEqual((await docs.libraryFor(tx, salesHr)).map((f) => f.name).sort(), (await docs.libraryFor(tx, own)).map((f) => f.name).sort());
  });
  ok("scoped HR: can't manage company folders, documents, tracking, letter templates or notice periods");

  // ---------- documents ----------
  const pdf = await renderLetterPdf({ html: "<p>Smoke</p>", title: "Smoke", company: "Acme", footer: "smoke" });
  await rollback(tenant.id, async (tx) => {
    const names = async (a: Actor) => (await docs.libraryFor(tx, a)).map((f) => f.name).sort();
    assert.deepEqual(await names(arjun), ["Company policies", "Forms"]);
    assert.deepEqual(await names(sneha), ["Company policies", "Forms", "Sales playbook"]);
    assert.deepEqual(await names(priya), ["Company policies", "Forms", "Sales playbook"]);
    const lib = await docs.libraryFor(tx, priya);
    const leavePolicy = lib.flatMap((f) => f.docs).find((d) => d.title === "Leave and holiday policy")!;
    const salesDoc = lib.flatMap((f) => f.docs).find((d) => d.title === "Customer data handling")!;
    assert.equal(leavePolicy.audience, 13 - 1, "everyone who hasn't left (Nikhil has)");
    assert.equal((await docs.libraryFor(tx, arjun)).flatMap((f) => f.docs).some((d) => d.audience != null), false, "employees don't get tracking numbers");

    // the gate: Sneha is blocked by the Sales document, Arjun only has a non-blocking one
    assert.deepEqual((await docs.pendingAcks(tx, sneha)).map((d) => [d.title, d.blocking]), [["Customer data handling", true], ["Leave and holiday policy", false]]);
    assert.deepEqual((await docs.pendingAcks(tx, arjun)).map((d) => d.blocking), [false]);
    await assert.rejects(docs.acknowledge(tx, arjun, salesDoc.id), /not found/);
    await docs.acknowledge(tx, sneha, salesDoc.id);
    const [first] = await tx<{ at: Date }[]>`select acknowledged_at as at from document_acks where document_id = ${salesDoc.id} and employee_id = ${sneha.employeeId}`;
    await docs.acknowledge(tx, sneha, salesDoc.id);
    const [second] = await tx<{ at: Date }[]>`select acknowledged_at as at from document_acks where document_id = ${salesDoc.id} and employee_id = ${sneha.employeeId}`;
    assert.equal(second.at.getTime(), first.at.getTime(), "acknowledging twice keeps the first time");
    assert.equal((await docs.pendingAcks(tx, sneha)).filter((d) => d.blocking).length, 0, "gate lifts");
    const codeOfConduct = lib.flatMap((f) => f.docs).find((d) => d.title === "Code of conduct")!;
    await assert.rejects(docs.acknowledge(tx, arjun, codeOfConduct.id), /doesn't need/);

    // file access: viewing records "viewed"; other folders and other people's files are invisible
    assert.equal(await docs.fileFor(tx, arjun, salesDoc.file_id), null);
    assert.ok(await docs.fileFor(tx, arjun, leavePolicy.file_id));
    const tr = await docs.tracking(tx, priya, leavePolicy.id);
    assert.ok(tr.rows.find((r) => r.employee_id === arjun.employeeId)?.viewed_at, "Arjun's view is tracked");
    await assert.rejects(docs.tracking(tx, arjun, leavePolicy.id), /access/);

    // uploads: HR only, type + signature + size checked, stored
    const [folder] = await tx<{ id: string }[]>`select id from document_folders where name = 'Forms'`;
    const up = (a: Actor, name: string, bytes: Uint8Array) => docs.uploadDocument(tx, a, { folderId: folder.id, title: "", requiresAck: false, blockUntilAck: true, file: { name, bytes } });
    await assert.rejects(up(arjun, "a.pdf", pdf), /access/);
    await assert.rejects(up(priya, "run.exe", new Uint8Array([0x4d, 0x5a, 1, 2])), /isn't allowed/);
    await assert.rejects(up(priya, "fake.pdf", new TextEncoder().encode("<html><script>")), /real \.pdf/);
    await assert.rejects(up(priya, "big.pdf", new Uint8Array(5 * 1024 * 1024 + 1).fill(0x25)), /larger than 5 MB/);
    const u = await up(priya, "Travel form.pdf", pdf);
    await track(tx);
    const [row] = await tx<{ title: string; requires_ack: boolean; mime: string; storage_key: string }[]>`
      select d.title, d.requires_ack, f.mime, f.storage_key from org_documents d join files f on f.id = d.file_id where d.id = ${u.id}`;
    assert.deepEqual([row.title, row.requires_ack, row.mime], ["Travel form", true, "application/pdf"], "title from file name; blocking implies acknowledgement");
    assert.deepEqual(await storage().get(row.storage_key), pdf);
    const del = await docs.deleteDocument(tx, priya, u.id);
    assert.equal(del.storageKey, row.storage_key);

    // folders: access must name departments; duplicates refused; non-empty can't be deleted
    await assert.rejects(docs.saveFolder(tx, priya, null, { name: "X", access: { type: "departments", ids: [] } }), /Pick at least one/);
    await assert.rejects(docs.saveFolder(tx, priya, null, { name: "forms", access: { type: "org" } }), /already exists/);
    await assert.rejects(docs.saveFolder(tx, priya, null, { name: "Y", access: { type: "departments", ids: [randomUUID()] } }), /no longer exist/);
    const [cp] = await tx<{ id: string }[]>`select id from document_folders where name = 'Company policies'`;
    await assert.rejects(docs.deleteFolder(tx, priya, cp.id), /Move or delete/);
    await assert.rejects(docs.saveFolder(tx, arjun, null, { name: "Mine", access: { type: "org" } }), /access/);
  });
  ok("folders: everyone vs department access; HR sees all and gets view/acknowledge counts, employees don't");
  ok("acknowledgement: blocking documents gate only their audience, idempotent, lifts once acknowledged; views tracked on open");
  ok("uploads: HR only; extension, file signature and 5 MB limit enforced; stored bytes round-trip; folder rules");

  // ---------- letters + person documents ----------
  await rollback(tenant.id, async (tx) => {
    await assert.rejects(letters.saveTemplate(tx, priya, null, { name: "Bad", kind: "other", body: "<p>{{employee.salary}}</p>" }), /Unknown placeholder/);
    await assert.rejects(letters.saveTemplate(tx, arjun, null, { name: "Mine", kind: "other", body: "<p>x</p>" }), /access/);
    await assert.rejects(tx.savepoint((sp) => letters.saveTemplate(sp as Tx, priya, null, { name: "Relieving letter", kind: "relieving", body: "<p>x</p>" })), /already exists/);
    const { id } = await letters.saveTemplate(tx, priya, null, { name: "Smoke letter", kind: "other", body: '<p onclick="x()">Hi {{employee.name}}<script>alert(1)</script> {{employee.last_working_date}}</p>' });
    const [saved] = await tx<{ body_html: string }[]>`select body_html from letter_templates where id = ${id}`;
    assert.equal(saved.body_html, "<p>Hi {{employee.name}} {{employee.last_working_date}}</p>", "sanitised on save");
    const pv = await letters.previewLetter(tx, priya, id, meera.employeeId);
    assert.equal(pv.html, "<p>Hi Meera Iyer [Last working day]</p>"); assert.deepEqual(pv.missing, ["employee.last_working_date"]);
    await assert.rejects(letters.generateLetter(tx, arjun, id, meera.employeeId), /can't issue letters/);
    await assert.rejects(letters.generateLetter(tx, salesHr, id, meera.employeeId), /can't issue letters/);
    const [rel] = await tx<{ id: string }[]>`select id from letter_templates where kind = 'relieving'`;
    const g = await letters.generateLetter(tx, priya, rel.id, divya.employeeId);
    await track(tx);
    assert.deepEqual(g.missing, []);
    const [f] = await tx<{ storage_key: string; mime: string }[]>`select storage_key, mime from files where id = ${g.fileId}`;
    const bytes = await storage().get(f.storage_key);
    assert.equal(new TextDecoder().decode(bytes!.slice(0, 5)), "%PDF-"); assert.equal(f.mime, "application/pdf");
    // the Documents tab: the person and HR see it, colleagues don't
    const mine = await docs.personDocuments(tx, divya, divya.employeeId);
    assert.ok(mine?.docs.some((d) => d.category === "letter" && d.doc_type === "Relieving letter"));
    assert.equal(mine?.canManage, false);
    assert.equal(await docs.personDocuments(tx, arjun, divya.employeeId), null);
    assert.ok(await docs.fileFor(tx, divya, g.fileId)); assert.equal(await docs.fileFor(tx, arjun, g.fileId), null);
    // personal uploads: self → pending (deletable by self), letters can't be deleted
    const pd = await docs.uploadPersonDocument(tx, arjun, arjun.employeeId, { category: "identity", docType: "PAN card", file: { name: "pan.pdf", bytes: pdf } });
    await track(tx);
    await assert.rejects(docs.uploadPersonDocument(tx, meera, arjun.employeeId, { category: "identity", docType: "x", file: { name: "x.pdf", bytes: pdf } }), /can't add/);
    await assert.rejects(docs.deletePersonDocument(tx, meera, pd.id), /can't delete/);
    await docs.deletePersonDocument(tx, arjun, pd.id);
    await assert.rejects(docs.deletePersonDocument(tx, priya, g.documentId), /kept on record/);
  });
  ok("letter templates: unknown fields refused, HTML sanitised on save, merge escapes values and lists missing fields");
  ok("issue letter: HR in scope only; PDF stored and added to the person's Documents tab; only the person and HR can open it");
  ok("personal documents: self uploads are pending and deletable by self, colleagues can't add or delete, letters are kept");

  // ---------- tenant isolation ----------
  const otherId = randomUUID();
  await admin`insert into tenants (id, subdomain, name) values (${otherId}, ${"smoke-" + otherId.slice(0, 8)}, 'Smoke Co')`;
  try {
    const [c] = await withTenant(otherId, (tx) => tx<{ n: string }[]>`
      select concat_ws('/', (select count(*) from exit_requests), (select count(*) from notice_period_policies), (select count(*) from document_folders),
        (select count(*) from org_documents), (select count(*) from document_acks), (select count(*) from files), (select count(*) from letter_templates),
        (select count(*) from generated_letters), (select count(*) from employee_documents), (select count(*) from tasks)) as n`);
    assert.equal(c.n, "0/0/0/0/0/0/0/0/0/0");
    const [divyaExit] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from exit_requests where employee_id = ${divya.employeeId} and status = 'in_progress'`);
    await assert.rejects(withTenant(otherId, (tx) => tx`insert into document_folders (tenant_id, name) values (${tenant.id}, 'sneaky')`), /row-level security/);
    const outsider = { ...priya, tenant: { ...tenant, id: otherId } } as Actor;
    assert.equal(await withTenant(otherId, (tx) => exits.exitDetail(tx, outsider, divyaExit.id)), null);
    const [anyFile] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from files limit 1`);
    assert.equal(await withTenant(otherId, (tx) => docs.fileFor(tx, outsider, anyFile.id)), null);
    const r = await withTenant(otherId, (tx) => tx`update exit_requests set status = 'exited' where id = ${divyaExit.id}`);
    assert.equal(r.count, 0);
    ok("another tenant sees none of Acme's exits, folders, documents, files or letters and can't write into them");
  } finally {
    await admin`delete from tenants where id = ${otherId}`;
  }

  for (const k of blobs) await storage().remove(k).catch(() => {});
  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await admin.end(); await sql.end(); }).catch(async (e) => {
  for (const k of blobs) await storage().remove(k).catch(() => {});
  console.error("\nFAILED:", e instanceof AppError ? `${e.code}: ${e.message}` : e); await admin.end(); await sql.end(); process.exit(1);
});
