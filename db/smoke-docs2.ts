/**
 * Smoke test for the docs2 package against the seeded demo tenant (run `pnpm db:seed` first): bulk letters + ZIP,
 * erp Sign (OTP, typed and drawn signatures, ordering, decline, cancel), document review and expiry reminders,
 * the editable exit checklist with auto-ticks, the exit survey, people analytics, the sign-in history report,
 * sign-in challenge rules, sign-up with a verified email, setup policies, the login background, and tenant isolation.
 * Everything that can run in a rolled-back transaction does; the bulk batch (own transactions) is cleaned up after.
 *   pnpm smoke:docs2
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { PDFDocument } from "pdf-lib";
import { withTenant, sql, AppError, type Tx } from "@/server/db";
import type { Actor, Tenant } from "@/server/auth/session";
import type { Scope } from "@/server/auth/catalog";
import { storage } from "@/server/storage";
import { addDaysISO, todayIn } from "@/lib/dates";
import * as docs from "@/server/modules/documents/service";
import * as letters from "@/server/modules/documents/letters";
import * as bulk from "@/server/modules/documents/bulk";
import * as esign from "@/server/modules/documents/esign";
import { readZip } from "@/server/modules/documents/zip";
import { expiringDocuments, sendExpiryReminders } from "@/server/modules/documents/expiry";
import * as exits from "@/server/modules/exits/service";
import * as checklist from "@/server/modules/exits/checklist";
import * as survey from "@/server/modules/exits/survey";
import { peopleAnalytics } from "@/server/modules/corehr/analytics";
import { runStandard } from "@/server/modules/reports/service";
import { recentFailures } from "@/server/modules/auth/captcha";
import { answerMatches, challengeRequired, makeChallenge } from "@/server/auth/captcha-rules";
import { assertSubdomainFree, provisionTenant } from "@/server/modules/tenants/provision";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { checkPolicies } from "@/server/modules/setup/rules";
import * as setup from "@/server/modules/setup/service";
import * as branding from "@/server/modules/saas/branding";
import { runTenant } from "@/server/modules/corehr/scheduler";
import { DEMO_PASSWORD, DEMO_SUBDOMAIN } from "./demo";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const rollback = async (tenantId: string, fn: (tx: Tx) => Promise<void>) =>
  withTenant(tenantId, async (tx) => { await fn(tx); throw new Error("rollback"); }).catch((e) => { if (e.message !== "rollback") throw e; });
const blobs: string[] = [];
const track = async (tx: Tx, since: Date) => { for (const f of await tx<{ storage_key: string }[]>`select storage_key from files where created_at >= ${since}`) blobs.push(f.storage_key); };
const PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkMLD4DwABbwE6W/7bFgAAAABJRU5ErkJggg==", "base64"));
const pngDataUrl = (bytes: Uint8Array) => "data:image/png;base64," + Buffer.from(bytes).toString("base64");

async function main() {
  const [t] = await sql<{ id: string; plan: "core" | "plus" | "pro"; status: string }[]>`select id, plan, status from tenant_by_subdomain(${DEMO_SUBDOMAIN})`;
  assert.ok(t, "demo tenant exists (run pnpm db:seed)");
  const tenant: Tenant = { id: t.id, name: "Acme Technologies", status: t.status, subdomain: DEMO_SUBDOMAIN, plan: t.plan };
  const actor = (first: string, permissions: string[] = [], scopes: Scope[] = []) => withTenant(tenant.id, async (tx) => {
    const [e] = await tx<{ id: string; user_id: string; display_name: string; email: string }[]>`select e.id, e.user_id, e.display_name, u.email::text from employees e join users u on u.id = e.user_id where first_name = ${first}`;
    assert.ok(e, `${first} exists`);
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: e.email, title: null, roles: [], permissions: new Set(permissions), grants: permissions.length ? [{ permissions, scopes }] : [] } as Actor;
  });
  const HR = ["employees.read", "employees.write", "exits.manage", "documents.manage", "approvals.override", "settings.org", "reports.read"];
  const asha = await actor("Asha", ["*"]), priya = await actor("Priya", HR), arjun = await actor("Arjun"), meera = await actor("Meera"), rohan = await actor("Rohan");
  const today = todayIn();
  const [sales] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from departments where name = 'Sales'`);
  const [eng] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from departments where name = 'Engineering'`);
  const salesHr = await actor("Karan", ["documents.manage", "employees.write"], [{ type: "department", ids: [sales.id] }]);
  const started = new Date();

  // ---------- bulk letters (own transactions; cleaned up at the end) ----------
  let batchId: string | null = null;
  try {
    const [tpl] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from letter_templates where kind = 'experience' limit 1`);
    await withTenant(tenant.id, async (tx) => {
      await assert.rejects(bulk.createBatch(tx, salesHr, { templateId: tpl.id, filters: { departmentIds: [eng.id] } }), /Nobody matches/);
      await assert.rejects(bulk.listBatches(tx, meera), /access/);
      const people = await bulk.recipients(tx, salesHr, { departmentIds: [sales.id, eng.id] });
      assert.ok(people.length >= 2 && people.every((p) => p.department === "Sales"), "a scoped HR admin only reaches their own people");
    });
    const b = await withTenant(tenant.id, (tx) => bulk.createBatch(tx, priya, { templateId: tpl.id, filters: { departmentIds: [eng.id], status: "working" } }));
    batchId = b.id;
    assert.ok(b.total >= 3);
    const first = await bulk.runBatch(tenant.id, b.id, { budgetMs: 0 });   // zero budget: one chunk, then stop
    assert.ok(first.processed > 0);
    const again = await bulk.runBatch(tenant.id, b.id);
    assert.equal(again.finished, true);
    const third = await bulk.runBatch(tenant.id, b.id);
    assert.deepEqual(third, { processed: 0, finished: true }, "a finished batch is left alone");
    await withTenant(tenant.id, async (tx) => {
      const d = (await bulk.batchDetail(tx, priya, b.id))!;
      assert.equal(d.status, "done"); assert.equal(d.done, b.total); assert.equal(d.failed, 0); assert.ok(d.zip_file_id);
      const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from generated_letters where batch_id = ${b.id}`;
      assert.equal(n, b.total, "every person got exactly one letter");
      const [{ dd }] = await tx<{ dd: number }[]>`select count(*)::int as dd from employee_documents d join generated_letters g on g.file_id = d.file_id where g.batch_id = ${b.id} and d.category = 'letter'`;
      assert.equal(dd, b.total, "and a Documents tab entry");
      const zipFile = (await docs.fileFor(tx, priya, d.zip_file_id!))!;
      const bytes = (await storage().get(zipFile.storage_key))!;
      const entries = readZip(bytes);
      assert.equal(entries.length, b.total);
      assert.ok(entries.every((e) => e.name.endsWith(".pdf") && e.bytes[0] === 0x25), "the ZIP holds one PDF per person");
      assert.equal(await docs.fileFor(tx, meera, d.zip_file_id!), null, "the bundle is not for everyone");
      await track(tx, started);
    });
    ok("bulk letters: filters respect scope, chunked runs resume and finish once, ZIP of PDFs + Documents entries, bundle access");
  } finally {
    if (batchId) await withTenant(tenant.id, async (tx) => {
      const files = await tx<{ id: string }[]>`select file_id as id from generated_letters where batch_id = ${batchId} union select zip_file_id from letter_batches where id = ${batchId} and zip_file_id is not null`;
      await tx`delete from employee_documents where file_id = any(${files.map((f) => f.id)}::uuid[])`;
      await tx`delete from generated_letters where batch_id = ${batchId}`;
      await tx`delete from letter_batches where id = ${batchId}`;
      await tx`delete from files where id = any(${files.map((f) => f.id)}::uuid[])`;
    });
  }

  // ---------- erp Sign ----------
  await rollback(tenant.id, async (tx) => {
    const [tpl] = await tx<{ id: string }[]>`select id from letter_templates where kind = 'experience' limit 1`;
    const g = await letters.generateLetter(tx, priya, tpl.id, arjun.employeeId, { notify: false });
    await assert.rejects(esign.requestSignatures(tx, meera, g.letterId, [{ employeeId: priya.employeeId }]), /can't manage/);
    await assert.rejects(esign.requestSignatures(tx, priya, g.letterId, []), /at least one/);
    const r = await esign.requestSignatures(tx, priya, g.letterId, [{ employeeId: priya.employeeId, title: "HR Manager" }, { email: "auditor@example.com", name: "Dev Patel", title: "Auditor" }], "Please sign today.");
    assert.equal(r.requested, 2);
    await assert.rejects(esign.requestSignatures(tx, priya, g.letterId, [{ employeeId: priya.employeeId }]), /already requested/);
    const [{ status }] = await tx<{ status: string }[]>`select status from generated_letters where id = ${g.letterId}`;
    assert.equal(status, "pending_signature");
    // every email in this transaction shares one created_at, so look the latest one up by recipient (tokens and codes are per signer)
    const tokenOf = async (to: string) => { const ms = await tx<{ html: string }[]>`select html from outbound_emails where kind = 'esign.request' and to_email = ${to} order by created_at`; return /\/sign\/([A-Za-z0-9_-]+)/.exec(ms[ms.length - 1].html)![1]; };
    const codeOf = async (to: string) => { const ms = await tx<{ subject: string }[]>`select subject from outbound_emails where kind = 'esign.code' and to_email = ${to} order by created_at`; return /(\d{6})/.exec(ms[ms.length - 1].subject)![1]; };
    const t1 = await tokenOf(priya.email);
    const v = (await esign.signView(tx, t1))!;
    assert.equal(v.signer.order, 1); assert.equal(v.status, "pending"); assert.equal(v.others[1].status, "waiting"); assert.equal(v.hash.length, 64);
    assert.equal(await esign.signView(tx, "not-a-real-token-at-all-xx"), null);
    assert.deepEqual(await esign.sign(tx, tenant, t1, { code: "000000", method: "typed", typedName: priya.name, ip: null }), { ok: false, error: "Ask for a code first.", field: "code" });
    await esign.requestSignCode(tx, tenant, t1);
    await assert.rejects(esign.requestSignCode(tx, tenant, t1), /moment ago/);
    const c1 = await codeOf(priya.email);
    const wrong = await esign.sign(tx, tenant, t1, { code: "123456", method: "typed", typedName: priya.name, ip: null });
    assert.ok(!wrong.ok && /isn't right/.test(wrong.error));
    const badName = await esign.sign(tx, tenant, t1, { code: c1, method: "typed", typedName: "Someone Else", ip: null });
    assert.ok(!badName.ok && badName.field === "typedName");
    const signed1 = await esign.sign(tx, tenant, t1, { code: c1, method: "typed", typedName: priya.name.toUpperCase(), ip: "10.0.0.1" });
    assert.deepEqual(signed1, { ok: true, done: false });
    assert.equal(await esign.signView(tx, t1), null, "a used link stops working");
    const rows = await esign.signersOf(tx, g.letterId);
    assert.deepEqual(rows.map((x) => x.status), ["signed", "pending"], "the next signer is up");
    const t2 = await tokenOf("auditor@example.com");
    assert.notEqual(t2, t1);
    await esign.requestSignCode(tx, tenant, t2);
    const c2 = await codeOf("auditor@example.com");
    const noDrawing = await esign.sign(tx, tenant, t2, { code: c2, method: "drawn", png: "data:image/png;base64,AAAA", ip: null });
    assert.ok(!noDrawing.ok && noDrawing.field === "png");
    const signed2 = await esign.sign(tx, tenant, t2, { code: c2, method: "drawn", png: pngDataUrl(PNG), ip: "10.0.0.2" });
    assert.deepEqual(signed2, { ok: true, done: true });
    const [l] = await tx<{ status: string; file_id: string; original_file_id: string }[]>`select status, file_id, original_file_id from generated_letters where id = ${g.letterId}`;
    assert.equal(l.status, "signed"); assert.notEqual(l.file_id, l.original_file_id);
    const [doc] = await tx<{ file_id: string; file_name: string }[]>`select d.file_id, f.name as file_name from employee_documents d join files f on f.id = d.file_id where d.id = ${g.documentId}`;
    assert.equal(doc.file_id, l.file_id, "the Documents entry now points at the signed PDF");
    assert.match(doc.file_name, /\(signed\)\.pdf$/);
    const [f] = await tx<{ storage_key: string }[]>`select storage_key from files where id = ${l.file_id}`;
    const [o] = await tx<{ storage_key: string }[]>`select storage_key from files where id = ${l.original_file_id}`;
    const signedPdf = await PDFDocument.load((await storage().get(f.storage_key))!), originalPdf = await PDFDocument.load((await storage().get(o.storage_key))!);
    assert.equal(signedPdf.getPageCount(), originalPdf.getPageCount() + 1, "a signatures page was appended");
    const auditorReq = (await esign.signersOf(tx, g.letterId)).find((x) => x.email === "auditor@example.com")!;
    const [audit] = await tx<{ diff: { method: string; ip: string } }[]>`select diff from audit_logs where entity_type = 'signature_request' and entity_id = ${auditorReq.id} and action = 'esign.sign'`;
    assert.equal(audit.diff.method, "drawn"); assert.equal(audit.diff.ip, "10.0.0.2");
    const status2 = await esign.signStatusByFile(tx, arjun.employeeId);
    assert.deepEqual(status2[l.file_id], { letterId: g.letterId, status: "signed", total: 2, signed: 2, pendingName: null });
    assert.ok((await esign.signatureTracking(tx, priya)).some((x) => x.letter_id === g.letterId && x.signed === 2));
    await assert.rejects(esign.signatureTracking(tx, meera), /access/);
    // decline + cancel on a second letter
    const g2 = await letters.generateLetter(tx, priya, tpl.id, rohan.employeeId, { notify: false });
    await esign.requestSignatures(tx, priya, g2.letterId, [{ employeeId: asha.employeeId }, { employeeId: priya.employeeId }]);
    const t3 = await tokenOf(asha.email);
    await esign.declineSignature(tx, tenant, t3, "Wrong designation on the letter");
    assert.deepEqual((await esign.signersOf(tx, g2.letterId)).map((x) => x.status), ["declined", "declined"]);
    assert.equal((await tx<{ status: string }[]>`select status from generated_letters where id = ${g2.letterId}`)[0].status, "published");
    assert.ok((await tx<{ n: number }[]>`select count(*)::int as n from notifications where user_id = ${priya.userId} and kind = 'esign.declined'`)[0].n >= 1, "the requester hears about the decline");
    await esign.requestSignatures(tx, priya, g2.letterId, [{ employeeId: asha.employeeId }]);
    await esign.cancelSignatures(tx, priya, g2.letterId);
    await assert.rejects(esign.cancelSignatures(tx, priya, g2.letterId), /Nothing is waiting/);
    await track(tx, started);
  });
  ok("erp Sign: ordered signers, emailed links + OTP (wrong code / wrong name / resend throttle), typed and drawn signatures stamped on a new page, status tracking, decline, cancel, access");

  // ---------- document review + expiry reminders ----------
  await rollback(tenant.id, async (tx) => {
    const pdf = Buffer.from("%PDF-1.4\n%demo\n");
    const d = await docs.uploadPersonDocument(tx, arjun, arjun.employeeId, { category: "identity", docType: "Passport", expiryDate: addDaysISO(today, 25), file: { name: "passport.pdf", bytes: new Uint8Array(pdf) } });
    await assert.rejects(docs.uploadPersonDocument(tx, arjun, arjun.employeeId, { category: "identity", docType: "x", expiryDate: "31-12-2030", file: { name: "p.pdf", bytes: new Uint8Array(pdf) } }), /valid expiry/);
    assert.equal((await tx<{ status: string }[]>`select status from employee_documents where id = ${d.id}`)[0].status, "pending");
    assert.ok((await tx<{ n: number }[]>`select count(*)::int as n from notifications where user_id = ${priya.userId} and kind = 'document.review'`)[0].n >= 1, "HR in scope is told about the upload");
    await assert.rejects(docs.reviewPersonDocument(tx, meera, d.id, { status: "verified" }), /can't review/);
    await assert.rejects(docs.reviewPersonDocument(tx, arjun, d.id, { status: "verified" }), /can't review|Someone else/);
    await assert.rejects(docs.reviewPersonDocument(tx, priya, d.id, { status: "rejected" }), /what's wrong/);
    await docs.reviewPersonDocument(tx, priya, d.id, { status: "rejected", comment: "Both sides, please." });
    let row = (await docs.personDocuments(tx, arjun, arjun.employeeId))!.docs.find((x) => x.id === d.id)!;
    assert.equal(row.status, "rejected"); assert.equal(row.review_comment, "Both sides, please.");
    await docs.reviewPersonDocument(tx, priya, d.id, { status: "verified", expiryDate: addDaysISO(today, 20) });
    row = (await docs.personDocuments(tx, arjun, arjun.employeeId))!.docs.find((x) => x.id === d.id)!;
    assert.equal(row.status, "verified"); assert.equal(row.expiry_date, addDaysISO(today, 20)); assert.equal(row.verified_by_name, priya.name);
    const [sg] = await tx<{ n: number }[]>`select count(*)::int as n from notifications where user_id = ${arjun.userId} and kind = 'document.reviewed'`;
    assert.ok(sg.n >= 2, "the person hears about each review");
    // a self upload of someone else's document is refused; HR uploads are verified right away
    await assert.rejects(docs.uploadPersonDocument(tx, meera, arjun.employeeId, { category: "other", docType: "x", file: { name: "p.pdf", bytes: new Uint8Array(pdf) } }), /can't add/);
    // reminders: 30-day window → one reminder; running again sends nothing; inside 7 days → the 7-day one
    const tn = { id: tenant.id, name: tenant.name, subdomain: tenant.subdomain };
    const before = (await tx<{ n: number }[]>`select count(*)::int as n from outbound_emails where kind = 'document.expiry'`)[0].n;
    const r1 = await sendExpiryReminders(tx, tn, today);
    assert.ok(r1.sent >= 1);
    const [rem] = await tx<{ expiry_reminders: Record<string, string> }[]>`select expiry_reminders from employee_documents where id = ${d.id}`;
    assert.ok(rem.expiry_reminders["30"], "the 30-day reminder is recorded on the document");
    const r2 = await sendExpiryReminders(tx, tn, today);
    assert.equal(r2.sent, 0, "idempotent per window");
    const r3 = await sendExpiryReminders(tx, tn, addDaysISO(today, 15));
    assert.ok(r3.sent >= 1);
    const [rem2] = await tx<{ expiry_reminders: Record<string, string> }[]>`select expiry_reminders from employee_documents where id = ${d.id}`;
    assert.ok(rem2.expiry_reminders["7"]);
    assert.ok((await tx<{ n: number }[]>`select count(*)::int as n from outbound_emails where kind = 'document.expiry'`)[0].n > before, "the person gets an email");
    // changing the expiry resets the reminders; the HR list shows it in the right bucket, within scope only
    await docs.reviewPersonDocument(tx, priya, d.id, { status: "verified", expiryDate: addDaysISO(today, 60) });
    assert.deepEqual((await tx<{ expiry_reminders: object }[]>`select expiry_reminders from employee_documents where id = ${d.id}`)[0].expiry_reminders, {});
    const list = await expiringDocuments(tx, priya, today);
    assert.ok(list.some((x) => x.id === d.id && x.bucket === "later"));
    assert.ok(!(await expiringDocuments(tx, salesHr, today)).some((x) => x.id === d.id), "Sales HR doesn't see an engineer's passport");
    await assert.rejects(docs.deletePersonDocument(tx, arjun, d.id), /can't delete/);   // verified: only HR deletes
    await track(tx, started);
  });
  ok("documents: upload with expiry, HR verify / send back with a note (never your own), notifications, 30/7-day reminders once each, expiring list in scope");

  // ---------- exit checklist template + auto-ticks ----------
  await rollback(tenant.id, async (tx) => {
    await assert.rejects(checklist.saveChecklistItem(tx, meera, null, { title: "x", owner: { type: "self" }, dueOffsetDays: 0 }), /access/);
    await assert.rejects(checklist.saveChecklistItem(tx, priya, null, { title: " ", owner: { type: "self" }, dueOffsetDays: 0 }), /title/);
    await assert.rejects(checklist.saveChecklistItem(tx, priya, null, { title: "x", owner: { type: "role", role: "Bad Role!" }, dueOffsetDays: 0 }), /owns/);
    const it = await checklist.saveChecklistItem(tx, priya, null, { title: "Hand over the repo", description: "Transfer ownership", owner: { type: "manager" }, dueOffsetDays: -5 });
    await checklist.moveChecklistItem(tx, priya, it.id, "up");
    let items = await exits.exitChecklist(tx);
    assert.equal(items[items.length - 2].id, it.id, "moved one place up");
    assert.deepEqual(items.filter((x) => x.auto).map((x) => x.auto).sort(), ["access_revoked", "assets_returned", "fnf_finalized"], "the default tasks know how to tick themselves");
    await checklist.saveChecklistItem(tx, priya, it.id, { title: "Hand over the repo", owner: { type: "self" }, dueOffsetDays: -5, auto: "assets_returned" });
    items = await exits.exitChecklist(tx);
    assert.equal(items.find((x) => x.id === it.id)!.auto, "assets_returned");
    await checklist.deleteChecklistItem(tx, priya, it.id);
    await assert.rejects(checklist.deleteChecklistItem(tx, priya, it.id), /not found/);
    const fatima = await actor("Fatima");
    // an exit for Fatima: she has no assets, so "return assets" ticks itself; relieving ticks "revoke access"; a finalised F&F ticks the last one
    const [reason] = await tx<{ id: string }[]>`select id from exit_reasons where name = 'Relocation'`;
    const x = await exits.initiateExit(tx, priya, { employeeId: fatima.employeeId, kind: "resignation", reasonId: reason.id, resignationDate: addDaysISO(today, -40), lastWorkingDate: addDaysISO(today, -1) });
    const tasksOf = async () => tx<{ title: string; status: string; auto_done: boolean | null }[]>`select t.title, t.status, (t.config->>'auto_done')::boolean as auto_done from tasks t join exit_requests x on x.process_id = t.process_id where x.id = ${x.id} order by t.title`;
    assert.ok((await tasksOf()).every((k) => k.status === "open"), "nothing ticked at the start");
    const r1 = await checklist.autoTickExitTasks(tx, { employeeId: fatima.employeeId });
    assert.equal(r1.ticked, 1);
    let ts = await tasksOf();
    assert.equal(ts.find((k) => k.title === "Return company assets")!.status, "done");
    assert.equal(ts.find((k) => k.title === "Return company assets")!.auto_done, true);
    assert.equal(ts.find((k) => k.title === "Revoke IT access")!.status, "open");
    assert.equal((await checklist.autoTickExitTasks(tx, { employeeId: fatima.employeeId })).ticked, 0, "idempotent");
    await exits.completeExit(tx, priya, x.id);
    ts = await tasksOf();
    assert.equal(ts.find((k) => k.title === "Revoke IT access")!.status, "done", "relieving disables sign-in, so the access task ticks");
    assert.equal(ts.find((k) => k.title === "Final settlement")!.status, "open");
    const [pg] = await tx<{ id: string }[]>`select id from pay_groups limit 1`;
    if (pg) {
      await tx`insert into fnf_settlements (tenant_id, exit_request_id, employee_id, status, items) values (${tenant.id}, ${x.id}, ${fatima.employeeId}, 'finalized', '[]')`;
      assert.equal((await checklist.autoTickExitTasks(tx)).ticked, 1);
      assert.equal((await tasksOf()).find((k) => k.title === "Final settlement")!.status, "done");
    }
    // the survey invite went out when the exit started
    const [resp] = await tx<{ id: string }[]>`select id from exit_survey_responses where exit_request_id = ${x.id}`;
    assert.ok(resp, "exit start opens a survey for the leaver");
    assert.ok((await tx<{ n: number }[]>`select count(*)::int as n from outbound_emails where kind = 'exit.survey' and to_email = (select work_email from employees where id = ${fatima.employeeId})`)[0].n >= 1);
    const detail = (await exits.exitDetail(tx, priya, x.id))!;
    assert.equal(detail.survey?.sent, true);
    assert.ok(detail.tasks.some((k) => k.auto && k.autoDone));
  });
  ok("exit checklist: HR edits / reorders / removes template tasks; assets-returned, access-revoked and F&F tasks tick themselves, idempotently; the survey goes out at exit start");

  // ---------- exit survey ----------
  await rollback(tenant.id, async (tx) => {
    await assert.rejects(survey.saveExitQuestion(tx, meera, null, { prompt: "x", type: "text" }), /access/);
    await assert.rejects(survey.saveExitQuestion(tx, priya, null, { prompt: "Pick", type: "choice", options: ["only one"] }), /two choices/);
    const q = await survey.saveExitQuestion(tx, priya, null, { prompt: "Would you join again?", type: "yes_no", required: true });
    await survey.moveExitQuestion(tx, priya, q.id, "up");
    const qs = await survey.listExitQuestions(tx);
    assert.ok(qs.length >= 8);
    const divya = await actor("Divya");
    const mine = (await survey.myExitSurvey(tx, divya))!;
    assert.ok(mine, "Divya (serving notice) has a survey waiting"); assert.equal(mine.submittedAt, null);
    assert.equal(await survey.myExitSurvey(tx, rohan), null, "nobody else does");
    await assert.rejects(survey.submitExitSurvey(tx, divya, {}), /needs an answer/);
    const answers: Record<string, string | number | boolean> = {};
    for (const x of mine.questions) answers[x.id] = x.type === "rating" ? 5 : x.type === "yes_no" ? false : x.type === "choice" ? x.options[1] : "Thanks for everything.";
    await assert.rejects(survey.submitExitSurvey(tx, divya, { ...answers, [mine.questions.find((x) => x.type === "rating")!.id]: 9 }), /1 to 5/);
    const s = await survey.submitExitSurvey(tx, divya, answers);
    assert.ok(s.answered >= 7);
    await assert.rejects(survey.submitExitSurvey(tx, divya, answers), /already sent/);
    assert.ok((await survey.myExitSurvey(tx, divya))!.submittedAt);
    const res = await survey.exitSurveyResults(tx, priya);
    assert.ok(res.answered >= 2 && res.sent >= res.answered, "Nikhil (seed) and Divya answered");
    const yn = res.questions.find((x) => x.id === q.id)!;
    assert.equal(yn.summary.type, "yes_no"); assert.ok(yn.summary.type === "yes_no" && yn.summary.no >= 1);
    assert.ok(res.people.some((p) => p.employee_id === divya.employeeId && p.submitted_at));
    await assert.rejects(survey.exitSurveyResults(tx, meera), /access/);
    // a question with answers is archived, not deleted; it stays in results
    await survey.deleteExitQuestion(tx, priya, q.id);
    assert.ok(!(await survey.listExitQuestions(tx)).some((x) => x.id === q.id));
    assert.ok((await survey.exitSurveyResults(tx, priya)).questions.some((x) => x.id === q.id && x.archived));
    const scopedHr = await actor("Karan", ["exits.manage"], [{ type: "department", ids: [sales.id] }]);
    await assert.rejects(survey.exitSurveyResults(tx, scopedHr), /access/);
  });
  ok("exit survey: HR edits questions, the leaver answers once with validation, results summarise by question and person, answered questions archive, company-wide HR only");

  // ---------- people analytics ----------
  await rollback(tenant.id, async (tx) => {
    const a = await peopleAnalytics(tx, priya, { months: 12 });
    assert.equal(a.months.length, 12); assert.equal(a.scoped, false);
    assert.ok(a.headcount.total >= 12);
    const left = a.months.reduce((n, r) => n + r.left, 0);
    assert.ok(left >= 1, "Nikhil's exit counts in the window");
    assert.ok(a.reasons.some((r) => r.reason === "Better opportunity"));
    assert.ok(a.departments.some((d) => d.name === "Operations" && d.left >= 1));
    assert.ok(a.tenure.current != null && a.tenure.current > 0);
    assert.equal(a.bands.reduce((n, b) => n + b.n, 0), a.headcount.total);
    const scoped = await peopleAnalytics(tx, salesHr, { months: 6 });
    assert.equal(scoped.scoped, true); assert.ok(scoped.headcount.total < a.headcount.total);
    await assert.rejects(peopleAnalytics(tx, meera), /HR and admins/);
    assert.equal((await peopleAnalytics(tx, asha, { months: 99 })).months.length, 36, "window is capped");
  });
  ok("people analytics: monthly joins/exits and attrition, by department and reason, tenure; scoped for scoped HR; refused without people access");

  // ---------- sign-in history report + sign-in challenge ----------
  await rollback(tenant.id, async (tx) => {
    // the success sits a minute in the past: inside one transaction every now() is the same instant
    await tx`insert into login_events (tenant_id, user_id, email, method, success, ip, user_agent, created_at) values (${tenant.id}, ${arjun.userId}, ${arjun.email}, 'password', true, '203.0.113.9', 'smoke', now() - interval '1 minute'),
             (${tenant.id}, null, 'ghost@acme.test', 'password', false, '203.0.113.9', 'smoke', now() - interval '1 minute')`;
    const all = await runStandard(tx, asha, "login_history", { from: today, to: today });
    assert.ok(all.rows.some((r) => r.email === arjun.email && r.success === true && r.ip === "203.0.113.9"));
    assert.ok(all.rows.some((r) => r.email === "ghost@acme.test"), "company-wide readers see attempts against unknown addresses");
    const one = await runStandard(tx, asha, "login_history", { from: today, to: today, person: arjun.employeeId, result: "success" });
    assert.ok(one.rows.length >= 1 && one.rows.every((r) => r.email === arjun.email && r.success));
    const scoped = await runStandard(tx, salesHr.permissions.has("reports.read") ? salesHr : { ...salesHr, permissions: new Set(["reports.read"]), grants: [{ permissions: ["reports.read"], scopes: [{ type: "department", ids: [sales.id] }] }] }, "login_history", { from: today, to: today });
    assert.ok(!scoped.rows.some((r) => r.email === arjun.email || r.email === "ghost@acme.test"), "a Sales-scoped reader sees neither an engineer nor unknown addresses");
    await assert.rejects(runStandard(tx, meera, "login_history", {}), /report access/);
    // challenge after 3 failures within the window, counted since the last success
    assert.equal(await recentFailures(tenant, arjun.email), 0);
    await tx`insert into login_events (tenant_id, user_id, email, method, success) values (${tenant.id}, ${arjun.userId}, ${arjun.email}, 'password', false), (${tenant.id}, ${arjun.userId}, ${arjun.email}, 'password', false)`;
    assert.equal(challengeRequired(2), false);
    await tx`insert into login_events (tenant_id, user_id, email, method, success) values (${tenant.id}, ${arjun.userId}, ${arjun.email}, 'password', false)`;
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from login_events where email = ${arjun.email} and method = 'password' and not success and created_at > now() - interval '15 minutes'
      and created_at > coalesce((select max(created_at) from login_events l2 where l2.email = ${arjun.email} and l2.method = 'password' and l2.success), '-infinity')`;
    assert.equal(n, 3); assert.equal(challengeRequired(n), true);
    let seed = 7;
    const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    for (let i = 0; i < 50; i++) {
      const c = makeChallenge(rnd);
      assert.match(c.question, /^What is .+ (plus|minus|times) .+\?$/); assert.ok(Number.isInteger(c.answer) && c.answer >= 0 && c.answer <= 60);
      assert.equal(answerMatches(String(c.answer), c.answer), true); assert.equal(answerMatches(String(c.answer + 1), c.answer), false);
    }
    assert.equal(answerMatches(" twelve ", 12), true); assert.equal(answerMatches("", 3), false); assert.equal(answerMatches(undefined, 3), false);
  });
  ok("sign-in history report with person / result filters and scope; failed attempts since the last success decide when the arithmetic challenge is required");

  // ---------- sign-up with a verified email, setup policies, roles, login background (throw-away tenant) ----------
  const sub = "smoke-docs2-" + randomUUID().slice(0, 6);
  await assertSubdomainFree(sub);
  await assert.rejects(assertSubdomainFree(DEMO_SUBDOMAIN), /already taken/);
  await assert.rejects(assertSubdomainFree("admin"), /reserved/);
  const hash = await hashPassword(DEMO_PASSWORD);
  const fresh = await provisionTenant({ company: "Smoke Docs2 Pvt Ltd", subdomain: sub, firstName: "Nisha", lastName: "Rao", email: `nisha@${sub}.test`, password: "throwaway-" + randomUUID(), passwordHash: hash, emailVerified: true });
  try {
    await withTenant(fresh.tenantId, async (tx) => {
      const [u] = await tx<{ password_hash: string; email_verified_at: Date | null; status: string }[]>`select password_hash, email_verified_at, status from users where id = ${fresh.userId}`;
      assert.equal(u.password_hash, hash); assert.ok(u.email_verified_at); assert.equal(u.status, "active");
      assert.equal(await verifyPassword(DEMO_PASSWORD, u.password_hash), true, "the password chosen on the form works after verification");
      const roles = await tx<{ key: string }[]>`select key from roles where is_system order by key`;
      assert.deepEqual(roles.map((r) => r.key), ["finance", "global_admin", "hr_admin", "payroll_admin", "recruiter"], "system roles incl. Finance and Recruiter");
      assert.equal((await tx<{ n: number }[]>`select count(*)::int as n from exit_survey_questions`)[0].n, 7, "the standard exit survey is provisioned");
      assert.equal((await tx<{ n: number }[]>`select count(*)::int as n from task_template_items where config ? 'auto'`)[0].n, 3);
    });
    const [e] = await withTenant(fresh.tenantId, (tx) => tx<{ id: string; display_name: string }[]>`select id, display_name from employees where user_id = ${fresh.userId}`);
    const owner: Actor = { tenant: { id: fresh.tenantId, name: "Smoke Docs2 Pvt Ltd", status: "trial", subdomain: sub, plan: "pro" }, userId: fresh.userId, employeeId: e.id, name: e.display_name, email: `nisha@${sub}.test`, title: null, roles: ["global_admin"], permissions: new Set(["*"]), grants: [{ permissions: ["*"], scopes: [] }] };
    await withTenant(fresh.tenantId, async (tx) => {
      // setup wizard: the new steps
      const d = await setup.setupData(tx, owner);
      assert.equal(d.policies.shift?.start, "09:30"); assert.equal(d.policies.weeklyOff?.preset, "sat_sun"); assert.ok(d.policies.payGroup, "payroll is set up, so the pay cycle shows");
      assert.ok(!checkPolicies({ shiftStart: "9:30", shiftEnd: "18:30", weeklyOff: "sun" }).ok);
      assert.ok(!checkPolicies({ shiftStart: "09:30", shiftEnd: "11:00", weeklyOff: "sun" }).ok, "too short");
      assert.ok(!checkPolicies({ shiftStart: "09:30", shiftEnd: "18:30", weeklyOff: "sun", cutoffDay: 40 }).ok);
      await assert.rejects(setup.completeStep(tx, owner, "business_units", "done"), /at least one business unit/);
      await setup.completeStep(tx, owner, "business_units", "skipped");
      await assert.rejects(setup.completeStep(tx, owner, "policies", "done"), /Save this step/);
      const s = await setup.savePolicies(tx, owner, { shiftStart: "10:00", shiftEnd: "19:00", weeklyOff: "alt_sat", cutoffDay: 20 });
      assert.equal(s.steps.policies?.status, "done"); assert.equal(s.steps.business_units?.status, "skipped");
      const [sh] = await tx<{ timings: Record<string, { start: string; end: string }> }[]>`select timings from shifts order by created_at limit 1`;
      assert.deepEqual(sh.timings.mon, { start: "10:00", end: "19:00" }); assert.equal(sh.timings.sat, undefined);
      const [wo] = await tx<{ pattern: Record<string, unknown> }[]>`select pattern from weekly_off_policies order by created_at limit 1`;
      assert.deepEqual(wo.pattern, { sat: ["work", "off", "work", "off", "work"], sun: "off" });
      assert.equal((await tx<{ d: number }[]>`select attendance_cutoff_day as d from pay_groups order by created_at limit 1`)[0].d, 20);
      const listId = await setup.setupHolidayList(tx, owner);
      assert.equal(await setup.setupHolidayList(tx, owner), listId, "one list, reused");
      assert.equal((await setup.setupData(tx, owner)).policies.holidayList?.id, listId);
      // branding: login background with size + byte checks
      await assert.rejects(branding.saveLoginBackground(tx, owner, { name: "x.gif", mime: "image/gif", bytes: PNG }), /PNG, JPEG or WebP/);
      await assert.rejects(branding.saveLoginBackground(tx, owner, { name: "x.png", mime: "image/png", bytes: new Uint8Array(2 * 1024 * 1024 + 1) }), /under 2 MB/);
      await assert.rejects(branding.saveLoginBackground(tx, owner, { name: "x.png", mime: "image/png", bytes: new Uint8Array(200) }), /doesn't look like/);
      const bgId = await branding.saveLoginBackground(tx, owner, { name: "bg.png", mime: "image/png", bytes: PNG });
      const [tn] = await tx<{ branding: { login_bg_file_id?: string } }[]>`select branding from tenants where id = ${fresh.tenantId}`;
      assert.equal(tn.branding.login_bg_file_id, bgId);
      assert.ok(await branding.backgroundFile(tx, tn.branding));
      await branding.removeLoginBackground(tx, owner);
      assert.equal(await branding.backgroundFile(tx, (await tx<{ branding: object }[]>`select branding from tenants where id = ${fresh.tenantId}`)[0].branding), null);
      await track(tx, started);
    });
    // tenant isolation: the new tables and public lookups
    await withTenant(fresh.tenantId, async (tx) => {
      const [c] = await tx<{ n: string }[]>`select concat_ws('/', (select count(*) from letter_batches), (select count(*) from letter_batch_items), (select count(*) from exit_survey_responses), (select count(*) from signature_requests)) as n`;
      assert.equal(c.n, "0/0/0/0");
      await assert.rejects(tx.savepoint((sp) => sp`insert into exit_survey_questions (tenant_id, prompt, type) values (${tenant.id}, 'sneaky', 'text')`), /row-level security/);
      const outsider = { ...priya, tenant: { ...tenant, id: fresh.tenantId } } as Actor;
      assert.equal((await esign.signatureTracking(tx, outsider)).length, 0);
      assert.equal(await survey.myExitSurvey(tx, { ...outsider, employeeId: (await actor("Divya")).employeeId }), null);
      const [req] = await withTenant(tenant.id, (t2) => t2<{ token_hash: string }[]>`select token_hash from signature_requests where token_hash is not null limit 1`);
      if (req) assert.equal((await tx<{ n: number }[]>`select count(*)::int as n from signature_requests where token_hash = ${req.token_hash}`)[0].n, 0, "signing links of another company don't resolve here");
    });
    // the daily scheduler runs the new steps without failing
    const results = await runTenant(fresh.tenantId, { only: ["document_expiry", "letter_batches", "exit_tasks"] });
    assert.deepEqual(results.map((r) => `${r.key}:${r.status}`), ["document_expiry:ok", "letter_batches:ok", "exit_tasks:ok"]);
    ok("sign-up with a verified email keeps the hashed password; system roles + survey + auto-tick defaults are provisioned; setup policies step (shift, weekly off, cut-off, holiday list); login background checks; tenant isolation; daily steps run");
  } finally {
    await admin`delete from tenants where id = ${fresh.tenantId}`;
  }

  for (const k of blobs) await storage().remove(k).catch(() => {});
  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await admin.end(); await sql.end(); }).catch(async (e) => {
  for (const k of blobs) await storage().remove(k).catch(() => {});
  console.error("\nFAILED:", e instanceof AppError ? `${e.code}: ${e.message}` : e); await admin.end(); await sql.end(); process.exit(1);
});
