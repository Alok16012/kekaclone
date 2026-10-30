/**
 * Smoke test for the helpdesk and assets against the seeded demo tenant (run `pnpm db:seed` first).
 * Everything runs in rolled-back transactions, so the demo data stays as seeded (stored attachment bytes are cleaned up at the end).
 *   pnpm smoke:servicedesk
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { withTenant, sql, AppError, type Tx } from "@/server/db";
import * as approvals from "@/server/modules/approvals/service";
import * as hd from "@/server/modules/helpdesk/service";
import * as assets from "@/server/modules/assets/service";
import { storage } from "@/server/storage";
import type { Actor } from "@/server/auth/session";
import type { Scope } from "@/server/auth/catalog";
import { DEMO_SUBDOMAIN } from "./demo";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const rollback = async (tenantId: string, fn: (tx: Tx) => Promise<void>) =>
  withTenant(tenantId, async (tx) => { await fn(tx); throw new Error("rollback"); }).catch((e) => { if (e.message !== "rollback") throw e; });
const blobs: string[] = [];
const track = async (tx: Tx) => { for (const f of await tx<{ storage_key: string }[]>`select storage_key from files where created_at > now() - interval '10 minutes'`) blobs.push(f.storage_key); };
const P = (n: number | string) => BigInt(n);
const HOUR = 3600_000;

const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function main() {
  const [t] = await sql<{ id: string }[]>`select id from tenant_by_subdomain(${DEMO_SUBDOMAIN})`;
  assert.ok(t, "demo tenant exists (run pnpm db:seed)");
  const tenant = { id: t.id, name: "Acme Technologies", status: "trial", subdomain: DEMO_SUBDOMAIN };
  const actor = (first: string, permissions: string[] = [], scopes: Scope[] = []) => withTenant(tenant.id, async (tx) => {
    const [e] = await tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`;
    assert.ok(e, `${first} exists`);
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(permissions), grants: permissions.length ? [{ permissions, scopes }] : [] } as Actor;
  });
  const HR = ["employees.read", "employees.write", "helpdesk.admin", "assets.admin", "exits.manage"];
  const asha = await actor("Asha", ["*"]), priya = await actor("Priya", HR);
  const [rohan, arjun, meera, vikram, sneha, imran, divya, karan, fatima] = await Promise.all(["Rohan", "Arjun", "Meera", "Vikram", "Sneha", "Imran", "Divya", "Karan", "Fatima"].map((n) => actor(n)));
  const [eng] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from departments where name = 'Engineering'`);
  const engAssets = await actor("Karan", ["assets.admin"], [{ type: "department", ids: [eng.id] }]);     // scoped asset admin
  const engHelpdesk = await actor("Karan", ["helpdesk.admin"], [{ type: "department", ids: [eng.id] }]);
  const cats = await withTenant(tenant.id, (tx) => hd.listCategories(tx));
  const IT = cats.find((c) => c.name === "IT support")!, HRQ = cats.find((c) => c.name === "HR questions")!, PAY = cats.find((c) => c.name === "Payroll and reimbursements")!;
  const notes = async (tx: Tx, who: Actor, kind: string) => (await tx<{ n: number }[]>`select count(*)::int as n from notifications where user_id = ${who.userId} and kind = ${kind}`)[0].n;

  // ---------- seed + defaults ----------
  await rollback(tenant.id, async (tx) => {
    assert.deepEqual(cats.map((c) => c.name).sort(), ["HR questions", "IT support", "Payroll and reimbursements"]);
    assert.deepEqual(IT.assignee_employee_ids, [vikram.employeeId]);
    const before = (await hd.listCategories(tx)).length;
    await hd.ensureHelpdeskDefaults(tx, tenant.id); await assets.ensureAssetDefaults(tx, tenant.id); await assets.ensureAssetDefaults(tx, tenant.id);
    assert.equal((await hd.listCategories(tx)).length, before, "defaults are idempotent");
    const nums = await tx<{ number: string }[]>`select number::text from tickets order by number`;
    assert.deepEqual(nums.map((n) => Number(n.number)), nums.map((_, i) => i + 1), "ticket numbers are 1..n from the counter");
    const [c] = await tx<{ value: string }[]>`select value::text from counters where key = 'ticket'`;
    assert.equal(Number(c.value), nums.length);
    const inv = await assets.inventory(tx, priya);
    assert.ok(inv.length >= 16 && inv.some((a) => a.holder_id === divya.employeeId), "inventory seeded, Divya holds a laptop");
  });
  ok("seed: three categories with agents and SLAs, ticket numbers 1..n from counters, inventory with holders; defaults idempotent");

  // ---------- category settings ----------
  await rollback(tenant.id, async (tx) => {
    const input = { name: "Facilities", priority: "low", firstResponseMins: 60, resolutionMins: 480, assigneeIds: [sneha.employeeId], escalateToId: null };
    await assert.rejects(hd.saveCategory(tx, arjun, null, input), /access/);
    await assert.rejects(hd.saveCategory(tx, engHelpdesk, null, input), /access/, "a department-scoped helpdesk admin can't edit company-wide categories");
    const c = await hd.saveCategory(tx, priya, null, input);
    await assert.rejects(hd.saveCategory(tx, priya, null, { ...input, name: "facilities" }), /already exists/);
    await assert.rejects(hd.saveCategory(tx, priya, c.id, { ...input, resolutionMins: 30 }), /before the first response/);
    await assert.rejects(hd.saveCategory(tx, priya, c.id, { ...input, assigneeIds: [randomUUID()] }), /left or don't exist/);
    await assert.rejects(hd.deleteCategory(tx, priya, IT.id), /has tickets/);
    await hd.deleteCategory(tx, priya, c.id);
  });
  ok("categories: helpdesk admin with no scope only (employees and scoped admins refused); names unique; SLA and agent checks; in-use categories kept");

  // ---------- raise: numbering, auto-assign, SLA, attachments ----------
  await rollback(tenant.id, async (tx) => {
    const now = new Date();
    const [{ value: c0 }] = await tx<{ value: string }[]>`select value::text from counters where key = 'ticket'`;
    // payroll has two agents; the seeded open ticket sits with one of them, so the other is less busy
    const busy = (await tx<{ a: string }[]>`select assignee_employee_id as a from tickets where category_id = ${PAY.id} and status <> 'closed'`).map((r) => r.a);
    const fatimaBefore = await notes(tx, fatima, "helpdesk.new"), karanBefore = await notes(tx, karan, "helpdesk.new");
    const r = await hd.raiseTicket(tx, sneha, { categoryId: PAY.id, title: "  Payslip shows wrong bank  ", description: "Last digits are wrong.", files: [{ name: "slip.pdf", bytes: pdf }, { name: "shot.png", bytes: png }] }, now);
    await track(tx);
    assert.equal(r.number, Number(c0) + 1);
    assert.equal(r.ref, `HD-${String(Number(c0) + 1).padStart(4, "0")}`);
    const expected = busy.includes(karan.employeeId) ? fatima : karan;
    assert.equal(r.assigneeId, expected.employeeId, "least busy agent gets it");
    assert.equal((await notes(tx, fatima, "helpdesk.new")) + (await notes(tx, karan, "helpdesk.new")), fatimaBefore + karanBefore + 1);
    const [k] = await tx<{ title: string; priority: string; first_response_due_at: Date; resolution_due_at: Date }[]>`select title, priority, first_response_due_at, resolution_due_at from tickets where id = ${r.id}`;
    assert.equal(k.title, "Payslip shows wrong bank"); assert.equal(k.priority, "medium");
    assert.equal(k.first_response_due_at.getTime() - now.getTime(), 480 * 60_000);
    assert.equal(k.resolution_due_at.getTime() - now.getTime(), 5 * 1440 * 60_000);
    const d = await hd.ticketDetail(tx, sneha, r.id);
    assert.equal(d!.messages[0].files.length, 2);
    assert.ok(await hd.ticketFileFor(tx, sneha, d!.messages[0].files[0].id));
    // no agents → nobody assigned, helpdesk admins told
    await tx`update ticket_categories set assignee_employee_ids = '{}' where id = ${HRQ.id}`;
    const before = await notes(tx, asha, "helpdesk.new");
    const u = await hd.raiseTicket(tx, arjun, { categoryId: HRQ.id, title: "Holiday list", description: "Where is it?", files: [] });
    assert.equal(u.assigneeId, null);
    assert.equal(await notes(tx, asha, "helpdesk.new"), before + 1);
    await assert.rejects(hd.raiseTicket(tx, arjun, { categoryId: IT.id, title: "", description: "x", files: [] }), /subject/);
    await assert.rejects(hd.raiseTicket(tx, arjun, { categoryId: randomUUID(), title: "x", description: "x", files: [] }), /category/);
  });
  await rollback(tenant.id, async (tx) => {
    await assert.rejects(hd.raiseTicket(tx, arjun, { categoryId: IT.id, title: "x", description: "y", files: [{ name: "a.svg", bytes: new TextEncoder().encode("<svg/>") }] }), /isn't allowed/);
    await assert.rejects(hd.raiseTicket(tx, arjun, { categoryId: IT.id, title: "x", description: "y", files: [{ name: "fake.pdf", bytes: new TextEncoder().encode("MZ not a pdf") }] }), /doesn't look like/);
    await assert.rejects(hd.raiseTicket(tx, arjun, { categoryId: IT.id, title: "x", description: "y", files: [{ name: "big.pdf", bytes: new Uint8Array(6 * 1024 * 1024).fill(0x25) }] }), /larger than 5 MB/);
    await assert.rejects(hd.raiseTicket(tx, arjun, { categoryId: IT.id, title: "x", description: "y", files: Array.from({ length: 4 }, (_, i) => ({ name: `${i}.pdf`, bytes: pdf })) }), /at most 3/);
  });
  ok("raise: next number from the counter, least busy agent assigned and notified (admins when no agents), SLA due times, priority from category");
  ok("attachments: type, file signature, 5 MB and 3-file limits enforced; stored files open for the requester");

  // ---------- visibility ----------
  await rollback(tenant.id, async (tx) => {
    const [vpn] = await tx<{ id: string }[]>`select id from tickets where title like 'VPN%'`;
    assert.ok(await hd.ticketDetail(tx, arjun, vpn.id), "requester");
    assert.ok(await hd.ticketDetail(tx, vikram, vpn.id), "category agent");
    assert.ok(await hd.ticketDetail(tx, rohan, vpn.id), "escalation contact");
    assert.ok(await hd.ticketDetail(tx, priya, vpn.id), "helpdesk admin");
    assert.equal(await hd.ticketDetail(tx, meera, vpn.id), null, "colleague");
    assert.equal(await hd.ticketDetail(tx, karan, vpn.id), null, "agent of another category");
    assert.equal(await hd.ticketDetail(tx, engHelpdesk, vpn.id), null, "scoped helpdesk admin isn't an admin for tickets");
    await assert.rejects(hd.reply(tx, meera, vpn.id, { body: "hi", internal: false, files: [] }), /not found/);
    // internal notes: agents see them, the requester never does (nor their files)
    const req = await hd.ticketDetail(tx, arjun, vpn.id), ag = await hd.ticketDetail(tx, vikram, vpn.id);
    assert.ok(ag!.messages.some((m) => m.internal)); assert.ok(!req!.messages.some((m) => m.internal));
    assert.equal(req!.can.internal, false); assert.equal(req!.role, "requester");
    await hd.reply(tx, vikram, vpn.id, { body: "log attached", internal: true, files: [{ name: "log.txt", bytes: new TextEncoder().encode("trace") }] });
    await track(tx);
    const [f] = await tx<{ id: string }[]>`select unnest(file_ids) as id from ticket_messages where ticket_id = ${vpn.id} and is_internal and cardinality(file_ids) > 0`;
    assert.ok(await hd.ticketFileFor(tx, vikram, f.id)); assert.equal(await hd.ticketFileFor(tx, arjun, f.id), null); assert.equal(await hd.ticketFileFor(tx, meera, f.id), null);
    await assert.rejects(hd.reply(tx, arjun, vpn.id, { body: "sneaky", internal: true, files: [] }), /Only agents/);
    // queues: agents see their categories, never their own tickets; my tickets are mine only
    const vq = await hd.queue(tx, vikram);
    assert.ok(vq.length > 0 && vq.every((r) => r.category === "IT support"));
    assert.ok(!(await hd.queue(tx, rohan)).some((r) => r.requester_id === rohan.employeeId), "own reopened ticket isn't in Rohan's escalation queue");
    assert.ok((await hd.queue(tx, priya)).every((r) => r.requester_id !== priya.employeeId));
    assert.ok((await hd.myTickets(tx, arjun)).every((r) => r.requester_id === arjun.employeeId));
    assert.equal(await hd.isAgent(tx, meera), false); assert.equal(await hd.isAgent(tx, vikram), true);
    assert.ok((await hd.queue(tx, priya, { q: "HD-1" })).some((r) => r.number === 1));
  });
  ok("visibility: requester, category agents, escalation contact and company-wide admins only; internal notes and their files hidden from requesters; queues never include your own tickets");

  // ---------- no self-service of agent powers ----------
  await rollback(tenant.id, async (tx) => {
    // Vikram is the only IT agent: his own ticket isn't auto-assigned to him, he can't assign it, add notes or start it
    const r = await hd.raiseTicket(tx, vikram, { categoryId: IT.id, title: "My keyboard", description: "Keys stick.", files: [] });
    assert.equal(r.assigneeId, null);
    const d = await hd.ticketDetail(tx, vikram, r.id);
    assert.equal(d!.role, "requester"); assert.deepEqual(d!.can.actions, ["close"]);
    await assert.rejects(hd.assign(tx, vikram, r.id, vikram.employeeId), /Only agents/);
    await assert.rejects(hd.reply(tx, vikram, r.id, { body: "note", internal: true, files: [] }), /Only agents/);
    await assert.rejects(hd.changeStatus(tx, vikram, r.id, "start"), /can't be done/);
    await assert.rejects(hd.assign(tx, priya, r.id, vikram.employeeId), /person who raised it/);
    // an admin's own ticket: they're just the requester there
    const p = await hd.raiseTicket(tx, priya, { categoryId: HRQ.id, title: "My own question", description: "?", files: [] });
    assert.equal(p.assigneeId, null, "Priya is the HR agent but never gets her own ticket");
    assert.equal((await hd.ticketDetail(tx, priya, p.id))!.role, "requester");
    assert.ok((await hd.ticketDetail(tx, asha, p.id))!.role === "agent");
  });
  ok("no self-service: agents and admins act only as the requester on their own tickets (no auto-assign, assign, internal notes or starting work)");

  // ---------- conversation + state machine ----------
  await rollback(tenant.id, async (tx) => {
    const r = await hd.raiseTicket(tx, meera, { categoryId: IT.id, title: "Wi-Fi", description: "Slow.", files: [] }, new Date(Date.now() - 10 * HOUR));
    await assert.rejects(hd.assign(tx, vikram, r.id, karan.employeeId), /category's agents/);
    await hd.assign(tx, priya, r.id, null);
    assert.equal((await hd.assign(tx, priya, r.id, null)).changed, false, "assign is idempotent");
    await hd.assign(tx, priya, r.id, vikram.employeeId);
    const before = await notes(tx, meera, "helpdesk.reply");
    await hd.reply(tx, vikram, r.id, { body: "Looking", internal: false, files: [] });
    let [k] = await tx<{ status: string; first_responded_at: Date | null }[]>`select status, first_responded_at from tickets where id = ${r.id}`;
    assert.equal(k.status, "in_progress", "first agent reply starts the work"); assert.ok(k.first_responded_at);
    assert.equal(await notes(tx, meera, "helpdesk.reply"), before + 1);
    const first = k.first_responded_at!.getTime();
    await hd.reply(tx, vikram, r.id, { body: "Still looking", internal: false, files: [] });
    [k] = await tx<{ status: string; first_responded_at: Date | null }[]>`select status, first_responded_at from tickets where id = ${r.id}`;
    assert.equal(k.first_responded_at!.getTime(), first, "first response time is kept");
    await assert.rejects(hd.changeStatus(tx, vikram, r.id, "start"), /can't be done/);
    await hd.changeStatus(tx, vikram, r.id, "close");
    await assert.rejects(hd.changeStatus(tx, vikram, r.id, "close"), /already closed/);
    await assert.rejects(hd.reply(tx, meera, r.id, { body: "one more", internal: false, files: [] }), /Reopen/);
    await assert.rejects(hd.assign(tx, vikram, r.id, vikram.employeeId), /Reopen/);
    const reopenAt = new Date();
    await hd.changeStatus(tx, meera, r.id, "reopen", reopenAt);
    const [x] = await tx<{ status: string; closed_at: Date | null; reopened_count: number; resolution_due_at: Date }[]>`select status, closed_at, reopened_count, resolution_due_at from tickets where id = ${r.id}`;
    assert.equal(x.status, "open"); assert.equal(x.closed_at, null); assert.equal(x.reopened_count, 1);
    assert.equal(x.resolution_due_at.getTime(), reopenAt.getTime() + 2 * 1440 * 60_000, "reopening restarts the resolution clock");
    await assert.rejects(hd.changeStatus(tx, meera, r.id, "reopen"), /still open/);
    await hd.changeStatus(tx, meera, r.id, "close");
    const all = await tx<{ action: string }[]>`select action from audit_logs where entity_type = 'ticket' and entity_id = ${r.id} order by created_at`;
    assert.ok(all.some((a) => a.action === "ticket.reopen") && all.some((a) => a.action === "ticket.assign"));
  });
  ok("conversation: first agent reply sets first response once and moves Open → In progress; Close, Reopen (requester), no double close, no replies on closed tickets; audited");

  // ---------- SLA on read + escalation ----------
  await rollback(tenant.id, async (tx) => {
    const now = new Date();
    const breachedQ = await hd.queue(tx, priya, { breached: true }, now);
    assert.ok(breachedQ.some((r) => r.title.startsWith("Travel reimbursement")), "Imran's ticket is past its targets");
    assert.ok(breachedQ.every((r) => r.sla.breached));
    const fresh = await hd.raiseTicket(tx, arjun, { categoryId: IT.id, title: "Printer", description: "Jammed.", files: [] }, new Date(now.getTime() - 3.5 * HOUR));
    const row = (await hd.queue(tx, vikram, {}, now)).find((r) => r.id === fresh.id)!;
    assert.equal(row.sla.first, "due_soon"); assert.equal(row.sla.breached, false);
    assert.equal((await hd.queue(tx, vikram, {}, new Date(now.getTime() + HOUR))).find((r) => r.id === fresh.id)!.sla.first, "breached", "computed on read");
    // escalation: once per target, to the escalation contact + assignee; closed tickets never
    await tx`update tickets set first_response_escalated_at = null, resolution_escalated_at = null`;
    const rohanBefore = await notes(tx, rohan, "helpdesk.sla_breach");
    const later = new Date(now.getTime() + 2 * HOUR);
    const n1 = await hd.escalateBreaches(tx, tenant.id, later);
    assert.ok(n1 >= 2);
    assert.ok((await notes(tx, rohan, "helpdesk.sla_breach")) > rohanBefore, "IT escalates to Rohan");
    assert.equal(await hd.escalateBreaches(tx, tenant.id, later), 0, "re-running sends nothing");
    const [e] = await tx<{ first_response_escalated_at: Date | null }[]>`select first_response_escalated_at from tickets where id = ${fresh.id}`;
    assert.ok(e.first_response_escalated_at);
    const closedBreached = await hd.raiseTicket(tx, arjun, { categoryId: IT.id, title: "Old", description: "x", files: [] }, new Date(now.getTime() - 10 * 24 * HOUR));
    await hd.changeStatus(tx, vikram, closedBreached.id, "close");
    assert.equal(await hd.escalateBreaches(tx, tenant.id, later), 0, "closed tickets don't escalate");
    // the resolution target escalates separately later
    const res = await hd.escalateBreaches(tx, tenant.id, new Date(now.getTime() + 3 * 24 * HOUR));
    assert.ok(res >= 1);
  });
  ok("SLA: flags computed on read (due soon → missed as time passes), breached filter; escalation once per target to escalation contact and assignee, idempotent, never for closed tickets");

  // ---------- assets: inventory permissions ----------
  await rollback(tenant.id, async (tx) => {
    const [laptop] = await tx<{ id: string }[]>`select id from asset_types where name = 'Laptop'`;
    const input = { typeId: laptop.id, tag: "lap-9001", name: "Test laptop", condition: "new", costPaise: P(5000000) };
    await assert.rejects(assets.saveAsset(tx, arjun, null, input), /access/);
    await assert.rejects(assets.saveAsset(tx, engAssets, null, input), /access/, "scoped asset admin can't edit the inventory");
    await assert.rejects(assets.saveAssetCategory(tx, engAssets, null, "Furniture"), /access/);
    await assert.rejects(assets.inventory(tx, arjun), /access/);
    assert.ok((await assets.inventory(tx, engAssets)).length > 0, "scoped admin may look");
    const a = await assets.saveAsset(tx, priya, null, input);
    const [row] = await tx<{ tag: string; cost_paise: string }[]>`select tag, cost_paise::text from assets where id = ${a.id}`;
    assert.equal(row.tag, "LAP-9001"); assert.equal(row.cost_paise, "5000000");
    await assert.rejects(assets.saveAsset(tx, priya, null, { ...input, tag: "LAP-9001" }), /already has this tag/);
    await assert.rejects(assets.saveAsset(tx, priya, null, { ...input, tag: "x" }), /tag/);
    await assert.rejects(assets.saveAsset(tx, priya, a.id, { ...input, status: "assigned" }), /handing them over/);
    const [held] = await tx<{ id: string; type_id: string; tag: string; name: string; condition: string }[]>`select id, type_id, tag, name, condition from assets where tag = 'LAP-0004'`;
    await assert.rejects(assets.saveAsset(tx, priya, held.id, { typeId: held.type_id, tag: held.tag, name: held.name, condition: held.condition, status: "retired" }), /Take it back first/);
    await assert.rejects(assets.deleteAsset(tx, priya, held.id), /retired/);
    await assets.deleteAsset(tx, priya, a.id);
    await assert.rejects(assets.deleteAssetType(tx, priya, laptop.id), /can't be deleted/);
  });
  ok("inventory: employees can't see it; scoped asset admins can look but only a company-wide admin edits; tags unique and normalised; cost stored as paise; held assets can't be retired or deleted");

  // ---------- assign / acknowledge ----------
  await rollback(tenant.id, async (tx) => {
    const tagId = async (tag: string) => (await tx<{ id: string }[]>`select id from assets where tag = ${tag}`)[0].id;
    const mon2 = await tagId("MON-0002"), hds2 = await tagId("HDS-0002"), mon3 = await tagId("MON-0003"), lap4 = await tagId("LAP-0004");
    await assert.rejects(assets.assignAssets(tx, priya, { assetIds: [mon2], employeeId: priya.employeeId }), /your own/, "no self hand-over");
    await assert.rejects(assets.assignAssets(tx, engAssets, { assetIds: [mon2], employeeId: sneha.employeeId }), /access/, "scoped admin: out of scope");
    await assert.rejects(assets.assignAssets(tx, arjun, { assetIds: [mon2], employeeId: meera.employeeId }), /access/);
    await assert.rejects(assets.assignAssets(tx, priya, { assetIds: [lap4], employeeId: meera.employeeId }), /already with someone/);
    await assert.rejects(assets.assignAssets(tx, priya, { assetIds: [mon3], employeeId: meera.employeeId }), /in repair/);
    const before = await notes(tx, meera, "assets.assigned");
    const r = await assets.assignAssets(tx, engAssets, { assetIds: [mon2, hds2], employeeId: meera.employeeId, notes: "with cable" });   // Meera is in Engineering
    assert.equal(r.assignmentIds.length, 2);
    assert.equal(await notes(tx, meera, "assets.assigned"), before + 1, "one notification for the bulk hand-over");
    const [s] = await tx<{ status: string }[]>`select status from assets where id = ${mon2}`;
    assert.equal(s.status, "assigned");
    // single holder enforced by the database too
    await assert.rejects(tx.savepoint((sp) => sp`insert into asset_assignments (tenant_id, asset_id, employee_id) values (${tenant.id}, ${mon2}, ${arjun.employeeId})`), /duplicate key/);
    // acknowledgement: holder only, idempotent
    await assert.rejects(assets.acknowledgeAssignment(tx, arjun, r.assignmentIds[0]), /not found/);
    const a1 = await assets.acknowledgeAssignment(tx, meera, r.assignmentIds[0], new Date("2026-01-01T10:00:00Z"));
    const a2 = await assets.acknowledgeAssignment(tx, meera, r.assignmentIds[0], new Date("2026-02-01T10:00:00Z"));
    assert.equal(a1.acknowledged_at.getTime(), a2.acknowledged_at.getTime(), "first acknowledgement kept");
  });
  ok("hand over: never to yourself, scoped admins only within scope, only available usable assets, bulk with one notification; single holder also enforced by the unique index");
  ok("acknowledgement: only the holder, idempotent (first time kept)");

  // ---------- return + recovery money ----------
  await rollback(tenant.id, async (tx) => {
    const open = async (who: Actor) => assets.openAssignmentsFor(tx, who.employeeId);
    const [divLap, divId] = await open(divya).then((o) => [o.find((x) => x.tag === "LAP-0004")!, o.find((x) => x.tag === "ID-0004")!]);
    const priyaLap = (await open(priya)).find((x) => x.tag === "LAP-0005")!;
    await assert.rejects(assets.returnAssets(tx, priya, [{ assignmentId: priyaLap.id, condition: "good", recoveryPaise: P(0) }]), /your own/, "HR can't take back their own");
    await assert.rejects(assets.returnAssets(tx, priya, [{ assignmentId: divLap.id, condition: "good", recoveryPaise: P(100) }]), /only applies/);
    await assert.rejects(assets.returnAssets(tx, priya, [{ assignmentId: divLap.id, condition: "damaged", recoveryPaise: P(7200001) }]), /more than the asset's cost \(₹72,000.00\)/);
    await assert.rejects(assets.returnAssets(tx, priya, [{ assignmentId: divLap.id, condition: "damaged", recoveryPaise: P(-1) }]), /negative/);
    await assert.rejects(assets.returnAssets(tx, engAssets, [{ assignmentId: divLap.id, condition: "good", recoveryPaise: P(0) }]), /access/, "Divya isn't in Engineering");
    const before = await assets.assetRecoveryFor(tx, divya.employeeId);
    const r = await assets.returnAssets(tx, priya, [
      { assignmentId: divLap.id, condition: "damaged", recoveryPaise: P(350050), notes: "Dent" },
      { assignmentId: divId.id, condition: "lost", recoveryPaise: P(25000) },
    ]);
    assert.equal(r.recoveryPaise, P(375050));
    const after = await assets.assetRecoveryFor(tx, divya.employeeId);
    assert.equal(after.totalPaise - before.totalPaise, P(375050), "exact paise for the settlement");
    const st = await tx<{ tag: string; status: string; condition: string }[]>`select tag, status, condition from assets where tag in ('LAP-0004','ID-0004') order by tag`;
    assert.deepEqual(st.map((x) => `${x.tag}:${x.status}:${x.condition}`), ["ID-0004:retired:lost", "LAP-0004:in_repair:damaged"]);
    await assert.rejects(assets.returnAssets(tx, priya, [{ assignmentId: divLap.id, condition: "good", recoveryPaise: P(0) }]), /already taken back/);
    assert.equal((await open(divya)).length, 0);
    assert.ok((await notes(tx, divya, "assets.recovery")) >= 2);
    // seeded: Vikram's damaged hinge, ₹2,500
    assert.equal((await assets.assetRecoveryFor(tx, vikram.employeeId)).totalPaise, P(250000));
  });
  ok("take back: condition decides the asset's next status (damaged → repair, lost → retired); recovery only for damaged/lost, never negative or above cost, summed exactly in paise; no double return; not your own");

  // ---------- requests via approvals ----------
  await rollback(tenant.id, async (tx) => {
    const [mon] = await tx<{ id: string }[]>`select id from asset_types where name = 'Monitor'`;
    const [card] = await tx<{ id: string }[]>`select id from asset_types where name = 'ID card'`;
    await assert.rejects(assets.requestAsset(tx, imran, { typeId: mon.id, kind: "new" }), /already have an open request/, "seeded pending request");
    await assert.rejects(assets.requestAsset(tx, arjun, { typeId: card.id, kind: "new" }), /can't be requested/);
    await assert.rejects(assets.requestAsset(tx, arjun, { typeId: mon.id, kind: "replacement", reason: " " }), /what's wrong/);
    const q = await assets.requestAsset(tx, arjun, { typeId: mon.id, kind: "new", reason: "Second screen" });
    assert.equal(q.status, "pending");
    const [step] = await tx<{ id: string; approver_employee_id: string }[]>`select s.id, s.approver_employee_id from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_id = ${q.id} and s.status = 'pending'`;
    assert.equal(step.approver_employee_id, rohan.employeeId, "manager approves");
    await assert.rejects(approvals.decide(tx, arjun, step.id, "approved"), /isn't waiting for you/, "requester can't approve");
    const prBefore = await notes(tx, priya, "assets.request_approved");
    await approvals.decide(tx, rohan, step.id, "approved");
    const [s1] = await tx<{ status: string }[]>`select status from asset_requests where id = ${q.id}`;
    assert.equal(s1.status, "approved");
    assert.equal(await notes(tx, priya, "assets.request_approved"), prBefore + 1, "asset admins told to hand over");
    assert.ok((await assets.requestsQueue(tx, priya)).some((r) => r.id === q.id && r.status === "approved"));
    assert.ok(!(await assets.requestsQueue(tx, engAssets)).some((r) => r.employee_id === imran.employeeId), "scoped admin only sees their people's requests");
    // fulfil: the asset must be of the requested type
    const [hds] = await tx<{ id: string }[]>`select id from assets where tag = 'HDS-0002'`;
    const [mon2] = await tx<{ id: string }[]>`select id from assets where tag = 'MON-0002'`;
    await assert.rejects(assets.assignAssets(tx, priya, { assetIds: [hds.id], employeeId: arjun.employeeId, requestId: q.id }), /different type/);
    await assets.assignAssets(tx, priya, { assetIds: [mon2.id], employeeId: arjun.employeeId, requestId: q.id });
    const [s2] = await tx<{ status: string }[]>`select status from asset_requests where id = ${q.id}`;
    assert.equal(s2.status, "fulfilled");
    const [link] = await tx<{ request_id: string }[]>`select request_id from asset_assignments where asset_id = ${mon2.id} and returned_at is null`;
    assert.equal(link.request_id, q.id);
    await assert.rejects(assets.cancelRequest(tx, arjun, q.id), /can't be cancelled/);
    // cancel a pending one: the approval step goes away
    const [imranReq] = await tx<{ id: string }[]>`select id from asset_requests where employee_id = ${imran.employeeId} and status = 'pending'`;
    await assert.rejects(assets.cancelRequest(tx, arjun, imranReq.id), /can't be cancelled/, "only your own");
    await assets.cancelRequest(tx, imran, imranReq.id);
    const [ar] = await tx<{ status: string }[]>`select status from approval_requests where entity_type = 'asset_request' and entity_id = ${imranReq.id}`;
    assert.equal(ar.status, "cancelled");
    // Meera's approved headset: close without handing over (not by Meera herself)
    const [mq] = await tx<{ id: string }[]>`select id from asset_requests where employee_id = ${meera.employeeId} and status = 'approved'`;
    await assets.declineApprovedRequest(tx, priya, mq.id, "Out of stock");
    await assert.rejects(assets.declineApprovedRequest(tx, priya, mq.id), /isn't waiting/);
    // the Inbox detail: requester, approver, admins only
    assert.ok(await assets.requestDetail(tx, arjun, q.id)); assert.ok(await assets.requestDetail(tx, rohan, q.id));
    assert.equal(await assets.requestDetail(tx, meera, q.id), null);
  });
  ok("requests: one open per type, requestable types only, manager approves via the Inbox (not the requester), admins notified, fulfilled only with an asset of that type, cancel and close");

  // ---------- profile tab + exit checklist ----------
  await rollback(tenant.id, async (tx) => {
    const mine = await assets.personAssets(tx, divya, divya.employeeId);
    assert.ok(mine!.isSelf && !mine!.canManage && mine!.open.some((a) => a.tag === "LAP-0004"));
    assert.equal((await assets.personAssets(tx, priya, divya.employeeId))!.canManage, true);
    assert.ok(await assets.personAssets(tx, (await actor("Priya")), divya.employeeId), "Divya's manager (Priya) sees them");
    assert.equal(await assets.personAssets(tx, arjun, divya.employeeId), null, "colleagues don't");
    assert.equal((await assets.personAssets(tx, divya, divya.employeeId))!.canManage, false, "can't manage your own");
    const ex = await assets.exitAssets(tx, priya, divya.employeeId);
    assert.deepEqual(ex!.open.map((a) => a.tag).sort(), ["ID-0004", "LAP-0004"]);
    assert.equal(await assets.exitAssets(tx, imran, divya.employeeId), null);
  });
  ok("profile Assets tab and exit checklist: the person, their manager and HR in scope see open assets; colleagues don't");

  // ---------- tenant isolation ----------
  const otherId = randomUUID();
  await admin`insert into tenants (id, subdomain, name) values (${otherId}, ${"smoke-" + otherId.slice(0, 8)}, 'Smoke Co')`;
  try {
    const [c] = await withTenant(otherId, (tx) => tx<{ n: string }[]>`
      select concat_ws('/', (select count(*) from tickets), (select count(*) from ticket_categories), (select count(*) from ticket_messages), (select count(*) from assets),
        (select count(*) from asset_assignments), (select count(*) from asset_requests), (select count(*) from asset_types), (select count(*) from counters)) as n`);
    assert.equal(c.n, "0/0/0/0/0/0/0/0");
    const outsider = { ...asha, tenant: { ...tenant, id: otherId } } as Actor;
    const [vpn] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from tickets where title like 'VPN%'`);
    assert.equal(await withTenant(otherId, (tx) => hd.ticketDetail(tx, outsider, vpn.id)), null);
    assert.deepEqual(await withTenant(otherId, (tx) => hd.queue(tx, outsider)), []);
    await assert.rejects(withTenant(otherId, (tx) => hd.reply(tx, outsider, vpn.id, { body: "x", internal: false, files: [] })), /not found/);
    await assert.rejects(withTenant(otherId, (tx) => tx`insert into ticket_categories (tenant_id, name) values (${tenant.id}, 'sneaky')`), /row-level security/);
    const [lap] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from assets where tag = 'LAP-0007'`);
    const u = await withTenant(otherId, (tx) => tx`update assets set status = 'retired' where id = ${lap.id}`);
    assert.equal(u.count, 0);
    await assert.rejects(withTenant(otherId, (tx) => assets.assignAssets(tx, outsider, { assetIds: [lap.id], employeeId: arjun.employeeId })), /not found/);
  } finally {
    await admin`delete from tenants where id = ${otherId}`;
  }
  ok("another tenant sees none of Acme's tickets, categories, messages, assets, assignments or requests and can't read or write them");

  for (const k of blobs) await storage().remove(k).catch(() => {});
  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await admin.end(); await sql.end(); }).catch(async (e) => {
  for (const k of blobs) await storage().remove(k).catch(() => {});
  console.error("\nFAILED:", e instanceof AppError ? `${e.code}: ${e.message}` : e); await admin.end(); await sql.end(); process.exit(1);
});
