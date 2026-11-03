/**
 * End-to-end checks for onboarding, surveys and Home extras against the seeded demo tenant (run `pnpm db:seed` first).
 * Every check runs in a rolled-back transaction, so the demo data stays as seeded.
 *   pnpm smoke:onboarding
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { NextRequest } from "next/server";
import { withTenant, sql, type Tx } from "@/server/db";
import * as ob from "@/server/modules/onboarding/service";
import * as sv from "@/server/modules/surveys/service";
import * as home from "@/server/modules/home/service";
import { praiseCertificate } from "@/server/modules/praise/certificate";
import { addDaysISO, todayIn } from "@/lib/dates";
import { proxy } from "@/proxy";
import type { QuestionOptions } from "@/server/modules/surveys/rules";
import type { Actor } from "@/server/auth/session";
import type { Scope } from "@/server/auth/catalog";
import { DEMO_SUBDOMAIN } from "./demo";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const ROLLBACK = "rollback";
async function rolledBack(tenantId: string, fn: (tx: Tx) => Promise<void>) {
  await withTenant(tenantId, async (tx) => { await fn(tx); throw new Error(ROLLBACK); }).catch((e) => { if (e.message !== ROLLBACK) throw e; });
}
/** Expected failures run in a savepoint so the transaction survives them. */
const rejects = (tx: Tx, fn: (sp: Tx) => Promise<unknown>, re: RegExp) => assert.rejects(tx.savepoint((sp) => fn(sp as unknown as Tx)), re);
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

async function main() {
  const [t] = await sql<{ id: string }[]>`select id from tenant_by_subdomain(${DEMO_SUBDOMAIN})`;
  assert.ok(t, "demo tenant exists (run pnpm db:seed)");
  const tenant = { id: t.id, name: "Acme Technologies", status: "trial", subdomain: DEMO_SUBDOMAIN };
  const today = todayIn();
  /** Actor with the roles they really have, or with given permissions / scopes. */
  const actor = (first: string, override?: { permissions: string[]; scopes?: Scope[] }) => withTenant(tenant.id, async (tx): Promise<Actor> => {
    const [e] = await tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`;
    const roles = override ? [{ key: "x", permissions: override.permissions, scopes: override.scopes ?? [] }]
      : await tx<{ key: string; permissions: string[]; scopes: Scope[] }[]>`select r.key, r.permissions, ra.scopes from role_assignments ra join roles r on r.id = ra.role_id where ra.employee_id = ${e.id}`;
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: roles.map((r) => r.key),
      permissions: new Set(roles.flatMap((r) => r.permissions)), grants: roles.map((r) => ({ permissions: r.permissions, scopes: r.scopes ?? [] })) };
  });
  const ids = await withTenant(tenant.id, async (tx) => {
    const d = await tx<{ id: string; name: string }[]>`select id, name from departments`;
    const e = await tx<{ id: string; first_name: string }[]>`select id, first_name from employees`;
    return { eng: d.find((x) => x.name === "Engineering")!.id, sales: d.find((x) => x.name === "Sales")!.id, emp: (n: string) => e.find((x) => x.first_name === n)!.id };
  });
  const [asha, priya, arjun, meera, vikram, kavya, rahul, aditya, sneha] = await Promise.all(["Asha", "Priya", "Arjun", "Meera", "Vikram", "Kavya", "Rahul", "Aditya", "Sneha"].map((n) => actor(n)));
  const engHr = await actor("Karan", { permissions: ["onboarding.manage", "surveys.manage", "settings.org"], scopes: [{ type: "department", ids: [ids.eng] }] });

  // ---------------------------------------------------------------- seed sanity
  await withTenant(tenant.id, async (tx) => {
    assert.ok(priya.permissions.has("onboarding.manage") && priya.permissions.has("surveys.manage"), "HR admins run onboarding and surveys");
    const rows = await ob.newJoiners(tx, priya, today);
    const by = (n: string) => rows.find((r) => r.name.startsWith(n))!;
    assert.equal(by("Kavya").status, "preboarding"); assert.equal(by("Kavya").process_status, "in_progress"); assert.equal(by("Kavya").template, "Engineering onboarding");
    assert.equal(by("Neha").process_id, null, "Neha's onboarding isn't started"); assert.equal(by("Neha").suggested, "Standard onboarding");
    assert.equal(by("Rahul").done, 3); assert.ok(by("Rahul").overdue >= 1, "Rahul has an overdue task");
    assert.equal((await ob.newJoiners(tx, arjun, today)).length, 0, "employees see no joiners");
  });
  ok("seed: joiners (preboarding, in progress with overdue, not started), auto-matched templates, HR has the new permissions");

  // ---------------------------------------------------------------- templates: company-wide, unscoped only
  await rolledBack(tenant.id, async (tx) => {
    await rejects(tx, (sp) => ob.saveTemplate(sp, arjun, null, { name: "Mine", criteria: {} }), /don't have access/);
    await rejects(tx, (sp) => ob.saveTemplate(sp, engHr, null, { name: "Scoped", criteria: {} }), /don't have access/);
    await rejects(tx, (sp) => ob.saveTemplate(sp, priya, null, { name: "Bad", criteria: { department_ids: [randomUUID()] } }), /no longer exist/);
    const tpl = await ob.saveTemplate(tx, priya, null, { name: "Sales onboarding", criteria: { department_ids: [ids.sales] } });
    await rejects(tx, (sp) => ob.saveItem(sp, priya, tpl.id, null, { title: "Approve myself", type: "approval", owner: { type: "self" }, dueOffsetDays: 0 }), /can't approve/);
    await rejects(tx, (sp) => ob.saveItem(sp, priya, tpl.id, null, { title: "Docs", type: "document_upload", owner: { type: "manager" }, dueOffsetDays: 0, config: { docType: "PAN", category: "identity" } }), /Only the new joiner/);
    await rejects(tx, (sp) => ob.saveItem(sp, priya, tpl.id, null, { title: "Ghost", type: "simple", owner: { type: "employee", id: randomUUID() }, dueOffsetDays: 0 }), /works here/);
    const a = await ob.saveItem(tx, priya, tpl.id, null, { title: "Intro call", type: "simple", owner: { type: "manager" }, dueOffsetDays: 1 });
    const b = await ob.saveItem(tx, priya, tpl.id, null, { title: "CRM access", type: "simple", owner: { type: "role", role: "global_admin" }, dueOffsetDays: -1 });
    await ob.moveItem(tx, priya, b.id, "up");
    const list = (await ob.listTemplates(tx)).find((x) => x.id === tpl.id)!;
    assert.deepEqual(list.items.map((i) => i.id), [b.id, a.id]);
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from audit_logs where entity_type = 'task_template' and entity_id = ${tpl.id}`;
    assert.ok(n >= 3, "template changes are audited");
  });
  ok("templates: only unscoped onboarding admins edit; criteria ids checked; owners and types validated; reorder; audited");

  // ---------------------------------------------------------------- starting: scope, self, auto-match, idempotent
  await rolledBack(tenant.id, async (tx) => {
    const neha = ids.emp("Neha");
    await rejects(tx, (sp) => ob.initiateOnboarding(sp, arjun, neha, null), /don't have access/);
    await rejects(tx, (sp) => ob.initiateOnboarding(sp, engHr, neha, null), /don't have access/);   // Neha is in Finance
    await rejects(tx, (sp) => ob.initiateOnboarding(sp, priya, priya.employeeId, null), /Someone else in HR/);
    const r = await ob.initiateOnboarding(tx, priya, neha, null);
    assert.equal(r.created, true);
    const [p] = await tx<{ template: string }[]>`select t.name as template from lifecycle_processes p join task_templates t on t.id = p.template_id where p.id = ${r.processId}`;
    assert.equal(p.template, "Standard onboarding", "Finance joiner gets the general checklist");
    const again = await ob.startOnboarding(tx, neha);
    assert.deepEqual([again.created, again.processId], [false, r.processId], "starting twice returns the same onboarding");
    await rejects(tx, (sp) => ob.initiateOnboarding(sp, priya, neha, null), /already started/);
    const tasks = await tx<{ title: string; due: string; who: string | null }[]>`
      select t.title, t.due_date::text as due, a.first_name as who from tasks t left join employees a on a.id = t.assignee_employee_id where t.process_id = ${r.processId}`;
    const [{ j }] = await tx<{ j: string }[]>`select joining_date::text as j from employees where id = ${neha}`;
    const laptop = tasks.find((x) => x.title === "Set up laptop and accounts")!;
    assert.equal(laptop.due, addDaysISO(j, -1)); assert.equal(laptop.who, "Asha");
    assert.equal(tasks.find((x) => x.title === "Plan the first week")!.who, "Fatima", "manager task goes to the manager");
    assert.equal(tasks.find((x) => x.title === "Confirm documents are in order")!.who, "Priya");
    const [{ notes }] = await tx<{ notes: number }[]>`select count(*)::int as notes from notifications n join employees e on e.user_id = n.user_id where e.first_name = 'Fatima' and n.kind = 'onboarding.task'`;
    assert.ok(notes >= 1, "owners are told");
    // the Engineering checklist: Kavya's buddy is Meera, manager Vikram
    const k = await tx<{ title: string; who: string }[]>`select t.title, a.first_name as who from tasks t join lifecycle_processes p on p.id = t.process_id join employees a on a.id = t.assignee_employee_id where p.employee_id = ${kavya.employeeId}`;
    assert.equal(k.find((x) => x.title === "Be their buddy for the first month")!.who, "Meera");
    assert.equal(k.find((x) => x.title === "Set up the development environment")!.who, "Vikram");
    // a scoped admin runs their own department's joiners
    await tx`update lifecycle_processes set status = 'cancelled' where employee_id = ${kavya.employeeId}`;
    assert.equal((await ob.initiateOnboarding(tx, engHr, kavya.employeeId, null)).created, true, "Engineering HR starts Engineering joiners");
  });
  ok("start: per-person scope, nobody runs their own, most specific template, owners + due dates from joining, idempotent, owners notified");

  // ---------------------------------------------------------------- doing tasks: owners only, by type, completion
  await rolledBack(tenant.id, async (tx) => {
    const [p] = await tx<{ id: string }[]>`select id from lifecycle_processes where employee_id = ${kavya.employeeId} and status = 'in_progress'`;
    const task = async (title: string) => (await tx<{ id: string }[]>`select id from tasks where process_id = ${p.id} and title = ${title}`)[0].id;
    const buddy = await task("Be their buddy for the first month");
    await rejects(tx, (sp) => ob.completeTask(sp, arjun, buddy, { kind: "done" }), /Only the task's owner/);
    await rejects(tx, (sp) => ob.completeTask(sp, priya, buddy, { kind: "done" }), /Only the task's owner/);
    await ob.completeTask(tx, meera, buddy, { kind: "done" });
    await rejects(tx, (sp) => ob.completeTask(sp, meera, buddy, { kind: "done" }), /already closed/);
    // joiner's own: profile detail through the profile change flow, document upload, acknowledgement
    const email = await task("Share your personal email");
    await rejects(tx, (sp) => ob.completeTask(sp, kavya, email, { kind: "acknowledge" }), /different way/);
    await ob.completeTask(tx, kavya, email, { kind: "field", value: "kavya.new@example.com" });
    const [pcr] = await tx<{ n: number }[]>`select count(*)::int as n from profile_change_requests where employee_id = ${kavya.employeeId} and status = 'pending'`;
    assert.equal(pcr.n, 1, "the joiner's own detail goes to HR for approval");
    const pan = await task("Upload your PAN card");
    await ob.uploadForTask(tx, kavya, pan, { name: "pan.pdf", bytes: PDF });
    const [doc] = await tx<{ status: string; doc_type: string }[]>`select status, doc_type from employee_documents where employee_id = ${kavya.employeeId} order by created_at desc limit 1`;
    assert.deepEqual([doc.status, doc.doc_type], ["pending", "PAN card"]);
    await ob.completeTask(tx, kavya, await task("Read the engineering handbook"), { kind: "acknowledge" });
    // approval: owner decides; declining needs a reason and tells HR; nobody approves their own
    const appr = await task("Approve probation goals");
    await rejects(tx, (sp) => ob.reassignTask(sp, priya, appr, kavya.employeeId), /can't approve their own/);
    await rejects(tx, (sp) => ob.completeTask(sp, priya, appr, { kind: "decide", decision: "declined" }), /Say why/);
    await ob.completeTask(tx, priya, appr, { kind: "decide", decision: "approved" });
    // HR: skip / reopen / reassign; not on your own onboarding
    const laptop = await task("Order laptop and accounts");
    await rejects(tx, (sp) => ob.setTaskState(sp, arjun, laptop, "skipped"), /don't have access/);
    await ob.reassignTask(tx, priya, laptop, aditya.employeeId);
    await ob.setTaskState(tx, priya, laptop, "skipped");
    await ob.setTaskState(tx, priya, laptop, "open");
    await ob.completeTask(tx, aditya, laptop, { kind: "done" });
    const r = await ob.completeTask(tx, vikram, await task("Set up the development environment"), { kind: "done" });
    assert.equal(r.completed, true, "the last task closes the onboarding");
    const [st] = await tx<{ status: string }[]>`select status from lifecycle_processes where id = ${p.id}`;
    assert.equal(st.status, "completed");
    await rejects(tx, (sp) => ob.setTaskState(sp, priya, laptop, "open"), /closed/);
    const mine = await ob.myTasks(tx, meera, today);
    assert.ok(mine.done.some((x) => x.id === buddy), "My tasks shows what the owner closed");
  });
  ok("tasks: owners only, each type its own way (profile change, document, acknowledgement, approval with reason), HR skip/reopen/reassign, auto-complete");

  await rolledBack(tenant.id, async (tx) => {
    // HR can't change their own onboarding; joiners can't decide approvals on themselves
    const [p] = await tx<{ id: string }[]>`select id from lifecycle_processes where employee_id = ${rahul.employeeId} and status = 'in_progress'`;
    const [appr] = await tx<{ id: string }[]>`select id from tasks where process_id = ${p.id} and type = 'approval'`;
    await tx`update tasks set assignee_employee_id = ${rahul.employeeId} where id = ${appr.id}`;   // even if someone forced it
    await rejects(tx, (sp) => ob.completeTask(sp, rahul, appr.id, { kind: "decide", decision: "approved" }), /own onboarding/);
    const view = await ob.processDetail(tx, arjun, p.id, today);
    assert.equal(view, null, "unrelated colleagues can't see someone's onboarding");
    const own = await ob.myOnboarding(tx, rahul, rahul.employeeId, today);
    assert.ok(own && own.tasks.every((x) => x.assignee?.id === rahul.employeeId), "the joiner's checklist is only their own tasks");
    const mgr = await ob.processDetail(tx, aditya, p.id, today);
    assert.ok(mgr && !mgr.can.manage && mgr.tasks.length === 6, "the manager sees everything but can't manage");
  });
  ok("no self-service: no approving your own onboarding; colleagues can't see it; the joiner sees only their tasks; managers read-only");

  // ---------------------------------------------------------------- joiner portal: token, tenant-bound, own tasks only
  const otherId = randomUUID();
  await admin`insert into tenants (id, subdomain, name) values (${otherId}, ${"smoke-" + otherId.slice(0, 8)}, 'Smoke Co')`;
  try {
    let token = "";
    await rolledBack(tenant.id, async (tx) => {
      const [p] = await tx<{ id: string }[]>`select id from lifecycle_processes where employee_id = ${kavya.employeeId} and status = 'in_progress'`;
      await rejects(tx, (sp) => ob.sendPortalLink(sp, arjun, p.id, { email: false }), /don't have access/);
      const link = await ob.sendPortalLink(tx, priya, p.id, { email: true });
      assert.equal(link.emailedTo, "kavya.nair@example.com");
      token = link.url.split("/join/")[1];
      const [{ stored }] = await tx<{ stored: string }[]>`select portal_token_hash as stored from lifecycle_processes where id = ${p.id}`;
      assert.notEqual(stored, token, "only a hash of the token is stored");
      const v = await ob.portalView(tx, tenant, token, today);
      assert.ok(v && v.tasks.length === 3 && v.tasks.every((x) => x.can.complete), "the portal shows the joiner's own tasks");
      assert.equal(await ob.portalView(tx, tenant, token.slice(0, -2) + "xx", today), null, "a wrong token shows nothing");
      // the other company can't resolve it (RLS), even with the right token
      assert.equal(await withTenant(otherId, (o) => ob.portalView(o, { ...tenant, id: otherId }, token, today)), null);
      const [mgrTask] = await tx<{ id: string }[]>`select id from tasks where process_id = ${p.id} and title = 'Set up the development environment'`;
      await rejects(tx, (sp) => ob.portalComplete(sp, tenant, token, mgrTask.id, { kind: "done" }), /not found/);
      const ack = v!.tasks.find((x) => x.type === "acknowledge")!;
      await ob.portalComplete(tx, tenant, token, ack.id, { kind: "acknowledge" });
      await rejects(tx, (sp) => ob.portalComplete(sp, tenant, token, ack.id, { kind: "acknowledge" }), /already closed/);
      const pan = v!.tasks.find((x) => x.type === "document_upload")!;
      await ob.portalComplete(tx, tenant, token, pan.id, { kind: "upload", file: { name: "pan.pdf", bytes: PDF } });
      // a new link replaces the old one; cancelling ends it
      const second = await ob.sendPortalLink(tx, priya, p.id, { email: false });
      assert.equal(await ob.portalView(tx, tenant, token, today), null, "the old link stops working");
      await ob.cancelOnboarding(tx, priya, p.id);
      assert.equal(await ob.portalView(tx, tenant, second.url.split("/join/")[1], today), null, "cancelled onboarding: link dead");
    });
    // public route: /join is allowed without a session, app pages are not
    const host = `acme.${process.env.ROOT_DOMAIN ?? "localhost:3100"}`;
    const res = (path: string) => proxy(new NextRequest(`http://${host}${path}`, { headers: { host } }));
    assert.equal(res("/join/" + token).headers.get("location"), null, "the portal is public (no redirect to sign-in)");
    assert.match(res("/org/onboarding").headers.get("location") ?? "", /\/login/, "app pages still need a session");
    assert.match(res("/joiners").headers.get("location") ?? "", /\/login/, "only /join/… is public");
    // tenant isolation of the new tables
    const counts = await withTenant(otherId, (o) => o<{ n: number }[]>`
      select (select count(*) from tasks) + (select count(*) from task_templates) + (select count(*) from lifecycle_processes) + (select count(*) from surveys)
        + (select count(*) from survey_responses) + (select count(*) from survey_participations) + (select count(*) from quick_links) as n`);
    assert.equal(Number(counts[0].n), 0, "another company sees none of these rows");
    await assert.rejects(withTenant(otherId, (o) => o`insert into quick_links (tenant_id, label, url) values (${tenant.id}, 'x', 'https://x.in')`), /row-level security/);
  } finally {
    await admin`delete from tenants where id = ${otherId}`;
  }
  ok("joiner portal: hashed token, emailed to personal email, own tasks only, replaced/cancelled links die, public route only /join, tenant isolation");

  // ---------------------------------------------------------------- surveys: build, launch, take
  await rolledBack(tenant.id, async (tx) => {
    await rejects(tx, (sp) => sv.createFromStarter(sp, arjun, "blank"), /don't have access/);
    await rejects(tx, (sp) => sv.createFromStarter(sp, engHr, "blank"), /don't have access/);
    const { id } = await sv.saveSurvey(tx, priya, null, { title: "Smoke survey", anonymous: false, minResponses: 5, audience: { type: "departments", ids: [ids.eng] }, startOn: null, endOn: null, recurrence: "none" }, today);
    await rejects(tx, (sp) => sv.launchSurvey(sp, priya, id, today), /at least one question/);
    const types = [
      { type: "short_text", prompt: "Name a tool" }, { type: "long_text", prompt: "Tell us more" }, { type: "dropdown", prompt: "Pick", options: { choices: ["A", "B"] } },
      { type: "single", prompt: "One", options: { choices: ["X", "Y"] } }, { type: "multi", prompt: "Many", options: { choices: ["P", "Q", "R"] } }, { type: "yes_no", prompt: "Yes?" },
      { type: "nps", prompt: "Recommend?" }, { type: "opinion_scale", prompt: "Agree?", options: { max: 7 } }, { type: "rating", prompt: "Stars?", options: { max: 5 } }, { type: "date", prompt: "When?" },
    ] as const;
    for (const q of types) await sv.saveQuestion(tx, priya, id, null, { type: q.type, prompt: q.prompt, required: q.type !== "long_text", options: "options" in q ? (q.options as QuestionOptions) : null });
    await sv.launchSurvey(tx, priya, id, today);
    await rejects(tx, (sp) => sv.saveQuestion(sp, priya, id, null, { type: "yes_no", prompt: "Late", required: true }), /can't change once/);
    await rejects(tx, (sp) => sv.saveSurvey(sp, priya, id, { title: "x", anonymous: true, minResponses: 5, audience: { type: "org" }, startOn: null, endOn: null, recurrence: "none" }, today), /can't change once/);
    const qs = await tx<{ id: string; type: string }[]>`select id, type from survey_questions where survey_id = ${id} order by position`;
    const ans = (over: Record<string, unknown> = {}) => Object.fromEntries(qs.map((q) => [q.id, (over[q.type] ?? ({ short_text: "Git", long_text: "", dropdown: "A", single: "Y", multi: ["R", "P"], yes_no: "yes", nps: 9, opinion_scale: 6, rating: 4, date: today } as Record<string, unknown>)[q.type]) as never]));
    await rejects(tx, (sp) => sv.submitResponse(sp, sneha, id, ans()), /isn't for you/);   // Sales isn't in the audience
    await rejects(tx, (sp) => sv.submitResponse(sp, arjun, id, ans({ nps: 11 })), /0 to 10/);
    await rejects(tx, (sp) => sv.submitResponse(sp, arjun, id, ans({ single: "Z" })), /options/);
    await sv.submitResponse(tx, arjun, id, ans());
    await rejects(tx, (sp) => sv.submitResponse(sp, arjun, id, ans()), /already answered/);
    const [row] = await tx<{ employee_id: string | null; answers: Record<string, unknown> }[]>`select employee_id, answers from survey_responses where survey_id = ${id}`;
    assert.equal(row.employee_id, arjun.employeeId, "named survey keeps the name");
    assert.deepEqual(row.answers[qs.find((q) => q.type === "multi")!.id], ["P", "R"]);
    const res = await sv.results(tx, priya, id, {});
    assert.ok(res && !res.hidden && res.responses === 1 && res.enps?.score === 100);
    await rejects(tx, (sp) => sv.results(sp, arjun, id, {}), /don't have access/);
    const csv = await sv.exportCsv(tx, priya, id);
    assert.match(csv.csv, /Arjun/); assert.equal(csv.csv.trim().split("\r\n").length, 2);
    assert.equal((await sv.mySurveys(tx, arjun)).find((s) => s.id === id)?.answered, true);
    await sv.closeSurvey(tx, priya, id);
    await rejects(tx, (sp) => sv.submitResponse(sp, meera, id, ans()), /isn't open/);
  });
  ok("surveys: unscoped admins only; all 10 question types validated; audience enforced; one answer per person; questions lock when live; named results + CSV");

  // ---------------------------------------------------------------- anonymity + threshold
  await rolledBack(tenant.id, async (tx) => {
    const [pulse] = await tx<{ id: string }[]>`select id from surveys where title = 'Monthly pulse'`;
    const [{ named }] = await tx<{ named: number }[]>`select count(*)::int as named from survey_responses where survey_id = ${pulse.id} and employee_id is not null`;
    assert.equal(named, 0, "anonymous answers carry no person");
    const [{ odd }] = await tx<{ odd: number }[]>`select count(*)::int as odd from survey_responses where survey_id = ${pulse.id} and created_at <> date_trunc('day', created_at)`;
    assert.equal(odd, 0, "and only a day-level time, so they can't be matched to participation");
    const all = await sv.results(tx, priya, pulse.id, {});
    assert.ok(all && !all.hidden && all.responses === 6 && all.participated === 6);
    assert.equal(all.enps?.score, 33, "eNPS from the seeded scores (3 promoters, 2 passive, 1 detractor)");
    const eng = await sv.results(tx, priya, pulse.id, { departmentId: ids.eng });
    assert.ok(eng && eng.hidden && eng.responses === 0 && eng.questions.every((q) => q.summary === null), "a filtered group under 5 stays hidden");
    // a fresh anonymous survey with 2 answers: hidden, and the export is refused
    const { id } = await sv.saveSurvey(tx, priya, null, { title: "Tiny", anonymous: true, minResponses: 3, audience: { type: "org" }, startOn: null, endOn: null, recurrence: "none" }, today);
    const q = await sv.saveQuestion(tx, priya, id, null, { type: "yes_no", prompt: "OK?", required: true });
    await sv.launchSurvey(tx, priya, id, today);
    for (const a of [arjun, meera]) await sv.submitResponse(tx, a, id, { [q.id]: "yes" });
    assert.equal((await sv.results(tx, priya, id, {}))!.hidden, true);
    await rejects(tx, (sp) => sv.exportCsv(sp, priya, id), /at least 3/);
    await sv.submitResponse(tx, vikram, id, { [q.id]: "no" });
    const csv = await sv.exportCsv(tx, priya, id);
    assert.doesNotMatch(csv.csv, /Arjun|Meera|Vikram/, "anonymous export has no names");
    await rejects(tx, (sp) => sv.saveSurvey(sp, priya, id, { title: "Tiny", anonymous: true, minResponses: 1, audience: { type: "org" }, startOn: null, endOn: null, recurrence: "none" }, today), /between 3 and 50/);
  });
  ok("anonymous: no person and day-only time on answers, groups under the threshold hidden (filters too), export refused below it and nameless above");

  // ---------------------------------------------------------------- schedule + pulse rounds (job)
  await rolledBack(tenant.id, async (tx) => {
    const [check] = await tx<{ id: string; schedule: { startOn: string } }[]>`select id, schedule from surveys where title = 'First month check-in'`;
    assert.equal((await sv.processDueSurveys(tx, addDaysISO(check.schedule.startOn, -1))).launched, 0, "not before its start date");
    assert.equal((await sv.processDueSurveys(tx, check.schedule.startOn)).launched, 1, "opens on its start date");
    assert.equal((await sv.processDueSurveys(tx, check.schedule.startOn)).launched, 0, "running again does nothing");
    const [pulse] = await tx<{ id: string }[]>`select id from surveys where title = 'Monthly pulse'`;
    const next = addDaysISO(today, 31);
    const r = await sv.processDueSurveys(tx, next);
    assert.equal(r.rounds, 1, "a month later the pulse starts round 2");
    assert.equal((await sv.processDueSurveys(tx, next)).rounds, 0, "once");
    const mine = (await sv.mySurveys(tx, arjun)).find((s) => s.id === pulse.id)!;
    assert.deepEqual([mine.round, mine.answered], [2, false], "everyone answers again in the new round");
    const qs = await tx<{ id: string }[]>`select id from survey_questions where survey_id = ${pulse.id} and required order by position`;
    await sv.submitResponse(tx, arjun, pulse.id, Object.fromEntries(qs.map((q, i) => [q.id, i === 0 ? 10 : 4])));
    const res = await sv.results(tx, priya, pulse.id, { round: 1 });
    assert.equal(res!.responses, 6, "round 1 results stay as they were");
    assert.equal(res!.trend.length, 2);
    await tx`update surveys set schedule = schedule || ${tx.json({ endOn: next })} where id = ${pulse.id}`;
    assert.equal((await sv.processDueSurveys(tx, addDaysISO(next, 1))).closed, 1, "closes after its end date");
  });
  ok("schedule: opens on the start date, monthly pulse rounds (re-answer each round, per-round results), closes after the end date, idempotent");

  // ---------------------------------------------------------------- Home extras
  await rolledBack(tenant.id, async (tx) => {
    await rejects(tx, (sp) => home.saveQuickLink(sp, arjun, null, { label: "Mine", url: "https://x.example" }), /don't have access/);
    await rejects(tx, (sp) => home.saveQuickLink(sp, engHr, null, { label: "Scoped", url: "https://x.example" }), /don't have access/);
    await rejects(tx, (sp) => home.saveQuickLink(sp, priya, null, { label: "Bad", url: "javascript:alert(1)" }), /web links/);
    const have = (await home.quickLinks(tx)).length;
    for (let i = have; i < 18; i++) await home.saveQuickLink(tx, priya, null, { label: `Link ${i}`, url: `https://l${i}.example` });
    await rejects(tx, (sp) => home.saveQuickLink(sp, priya, null, { label: "One too many", url: "https://x.example" }), /up to 18/);
    const links = await home.quickLinks(tx);
    await home.moveQuickLink(tx, priya, links[1].id, "up");
    assert.equal((await home.quickLinks(tx))[0].id, links[1].id);
    const remote = await home.remoteToday(tx, today);
    assert.deepEqual(remote.map((p) => p.kind).sort(), ["on_duty", "wfh"]);
    assert.ok(remote.some((p) => p.name.startsWith("Imran")) && remote.some((p) => p.name.startsWith("Aditya")));
    // praise certificate: for a recipient of a visible praise; nothing for someone who wasn't praised
    const [pr] = await tx<{ post_id: string; employee_id: string }[]>`select post_id, employee_id from praise_recipients limit 1`;
    const cert = await praiseCertificate(tx, arjun, pr.post_id, pr.employee_id);
    assert.ok(cert && new TextDecoder().decode(cert.bytes.slice(0, 5)) === "%PDF-");
    assert.equal(await praiseCertificate(tx, arjun, pr.post_id, asha.employeeId === pr.employee_id ? meera.employeeId : asha.employeeId), null);
    assert.equal(await praiseCertificate(tx, arjun, randomUUID(), pr.employee_id), null);
  });
  ok("home: quick links unscoped settings admins only, http(s) only, max 18, ordered; remote today from approved WFH/on duty; praise certificate PDF");

  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await admin.end(); await sql.end(); }).catch(async (e) => { console.error("FAILED:", e); await admin.end(); await sql.end(); process.exit(1); });
