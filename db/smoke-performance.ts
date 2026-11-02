/**
 * Smoke test for performance (goals, feedback, 1:1s, reviews, calibration, PIPs) and compensation against the seeded demo tenant
 * (run `pnpm db:seed` first). Everything runs in rolled-back transactions, so the demo data stays as seeded.
 *   pnpm smoke:performance
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import ExcelJS from "exceljs";
import { NextRequest } from "next/server";
import { withTenant, sql, AppError, type Tx } from "@/server/db";
import * as approvals from "@/server/modules/approvals/service";
import * as settings from "@/server/modules/performance/settings";
import * as goals from "@/server/modules/performance/goals";
import * as fb from "@/server/modules/performance/feedback";
import * as one from "@/server/modules/performance/one-on-ones";
import * as rv from "@/server/modules/performance/reviews";
import * as pip from "@/server/modules/performance/pip";
import * as comp from "@/server/modules/performance/compensation";
import { storage } from "@/server/storage";
import { proxy } from "@/proxy";
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
const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

async function main() {
  const [t] = await sql<{ id: string }[]>`select id from tenant_by_subdomain(${DEMO_SUBDOMAIN})`;
  assert.ok(t, "demo tenant exists (run pnpm db:seed)");
  const tenant = { id: t.id, name: "Acme Technologies", status: "trial", subdomain: DEMO_SUBDOMAIN };
  const actor = (first: string, permissions: string[] = [], scopes: Scope[] = []) => withTenant(tenant.id, async (tx) => {
    const [e] = await tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`;
    assert.ok(e, `${first} exists`);
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(permissions), grants: permissions.length ? [{ permissions, scopes }] : [] } as Actor;
  });
  const asha = await actor("Asha", ["*"]);
  const priya = await actor("Priya", ["employees.read", "employees.write", "performance.admin"]);
  const [rohan, arjun, meera, vikram, sneha, imran, karan, fatima, divya] = await Promise.all(["Rohan", "Arjun", "Meera", "Vikram", "Sneha", "Imran", "Karan", "Fatima", "Divya"].map((n) => actor(n)));
  const [eng] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from departments where name = 'Engineering'`);
  const engPerf = await actor("Karan", ["performance.admin"], [{ type: "department", ids: [eng.id] }]);   // scoped performance admin
  const compAdmin = await actor("Priya", ["compensation.admin", "payroll.admin"]);
  const scopedComp = await actor("Karan", ["compensation.admin"], [{ type: "department", ids: [eng.id] }]);
  const cycleId = (name: string) => withTenant(tenant.id, async (tx) => (await tx<{ id: string }[]>`select id from review_cycles where name like ${name + "%"}`)[0].id);
  const year = Number(todayIn().slice(0, 4));
  const h1 = await cycleId(`H1 ${year}`), q3 = await cycleId(`Q3 ${year}`), nj = await cycleId("90-day");
  const today = todayIn();
  const notes = async (tx: Tx, who: Actor, kind: string) => (await tx<{ n: number }[]>`select count(*)::int as n from notifications where user_id = ${who.userId} and kind = ${kind}`)[0].n;

  // ---------- seed ----------
  await rollback(tenant.id, async (tx) => {
    const cs = await rv.listCycles(tx, priya);
    assert.equal(cs.find((c) => c.id === h1)!.status, "published");
    assert.equal(cs.find((c) => c.id === q3)!.status, "live");
    assert.equal(cs.find((c) => c.id === nj)!.status, "live");
    const [growth] = await tx<{ id: string; progress: string }[]>`select id, progress from objectives where title like 'Grow annual%'`;
    assert.equal(Number(growth.progress), 40, "company goal progress = weighted KRs (both 40% of the way)");
    const meetings = await one.listMeetings(tx, arjun);
    const next = meetings.find((m) => m.status === "scheduled" && m.with_name.startsWith("Rohan"))!;
    assert.equal(next.open_actions, 1, "the unfinished action item moved to the next weekly 1:1");
    const s = await settings.getSettings(tx);
    assert.equal(s.points.length, 5); assert.equal(s.bands.length, 5);
    const before = (await settings.listCompetencies(tx)).length;
    await settings.ensurePerformanceDefaults(tx, tenant.id);
    assert.equal((await settings.listCompetencies(tx)).length, before, "defaults are idempotent");
  });
  ok("seed: published H1, live Q3 and automatic cycles; company OKR rolls up from weighted key results; 1:1 action item carried forward; defaults idempotent");

  // ---------- settings + library: unscoped admins only ----------
  await rollback(tenant.id, async (tx) => {
    const cur = await settings.getSettings(tx);
    const input = { goalMode: "kra" as const, ratingScaleId: cur.ratingScaleId, bands: cur.bands, idealDistribution: cur.idealDistribution, rounding: "half" as const,
      reviewerWeights: { self: 0, manager: 80, peer: 20, skip_level: 0 }, checkinReminder: "biweekly" as const, krWeightsMustTotal: true };
    await assert.rejects(settings.saveSettings(tx, arjun, input), /performance admins/);
    await assert.rejects(settings.saveSettings(tx, engPerf, input), /performance admins/, "scoped admin can't change company settings");
    await assert.rejects(settings.saveSettings(tx, priya, { ...input, reviewerWeights: { self: 10, manager: 80, peer: 20, skip_level: 0 } }), /add up to 100/);
    await assert.rejects(settings.saveSettings(tx, priya, { ...input, idealDistribution: [{ label: cur.bands[0].label, pct: 50 }] }), /add up to 50/);
    await assert.rejects(settings.saveSettings(tx, priya, { ...input, points: [{ value: 1, label: "a" }, { value: 2, label: "b" }] }), /already been submitted/, "scale points locked once used");
    await settings.saveSettings(tx, priya, input);
    assert.equal((await settings.getSettings(tx)).goalMode, "kra");
    await assert.rejects(settings.saveCompetency(tx, engPerf, null, { kind: "skill", name: "Go" }), /performance admins/);
    await assert.rejects(settings.saveCompetency(tx, priya, null, { kind: "skill", name: "react" }), /already/);
    const c = await settings.saveCompetency(tx, priya, null, { kind: "skill", name: "Go", levels: [{ level: 1, description: "Reads it" }] });
    await settings.setMySkill(tx, arjun, c.id, 2);
    await settings.setMySkill(tx, arjun, c.id, 3);
    assert.equal((await settings.skillsOf(tx, arjun.employeeId)).find((s) => s.name === "Go")!.proficiency, 3);
    const [core] = await tx<{ id: string }[]>`select id from competencies where kind = 'core_value' limit 1`;
    await assert.rejects(settings.setMySkill(tx, arjun, core.id, 3), /company's list/, "only library skills on a profile");
    await assert.rejects(settings.setMySkill(tx, arjun, c.id, 7), /1 to 5/);
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from audit_logs where entity_type in ('performance_settings','competency','employee_skill') and created_at >= now()`;
    assert.ok(n >= 4, "settings, library and skills changes are audited");
  });
  ok("settings & skills library: unscoped performance admin only, weights/curve/scale checks, own skills from the library, all audited");

  // ---------- goals ----------
  await rollback(tenant.id, async (tx) => {
    const period = (await goals.currentPeriod(tx))!.id;
    await assert.rejects(goals.createObjective(tx, arjun, { level: "company", title: "Take over the world" }), /performance admins/);
    await assert.rejects(goals.createObjective(tx, arjun, { level: "individual", ownerId: meera.employeeId, title: "Do Meera's work" }), /people who report to you/);
    await assert.rejects(goals.createObjective(tx, engPerf, { level: "department", departmentId: (await tx<{ id: string }[]>`select id from departments where name = 'Sales'`)[0].id, title: "Sales goal" }), /performance admins/, "scoped admin limited to their department");
    await goals.createObjective(tx, engPerf, { level: "department", departmentId: eng.id, title: "Engineering hygiene" });
    await assert.rejects(goals.createObjective(tx, arjun, { level: "individual", title: "Two KRs", keyResults: [{ title: "a b", metric: "number", target: 1, weight: 50 }, { title: "c d", metric: "number", target: 1, weight: 30 }] }), /add up to 80/);
    const [r1] = await tx<{ id: string; progress: string }[]>`select id, progress from objectives where title = 'Release the app on both stores'`;
    const [appO] = await tx<{ id: string; progress: string }[]>`select id, progress from objectives where title like 'Ship the mobile app%'`;
    const [growth] = await tx<{ id: string; progress: string }[]>`select id, progress from objectives where title like 'Grow annual%'`;
    const [a1] = await tx<{ id: string; progress: string }[]>`select id, progress from objectives where title = 'Build offline sync for the app'`;
    // a child goal aligned under an objective with no KRs moves it; the parent of that one is driven by its own KRs
    const g = await goals.createObjective(tx, rohan, { level: "individual", ownerId: vikram.employeeId, periodId: period, parentId: appO.id, title: "Release pipeline", weight: 50, keyResults: [{ title: "Pipelines green", metric: "percent", start: 0, target: 100, current: 0, weight: 100 }] });
    const [kr] = await tx<{ id: string }[]>`select id from key_results where objective_id = ${g.id}`;
    const before = Number((await tx<{ progress: string }[]>`select progress from objectives where id = ${appO.id}`)[0].progress);
    await assert.rejects(goals.checkIn(tx, meera, g.id, { status: "on_track", keyResults: [{ id: kr.id, current: 50 }] }), /can't check in/, "a peer can't check in on someone's goal");
    await assert.rejects(goals.checkIn(tx, vikram, g.id, { status: "on_track", keyResults: [{ id: (await tx<{ id: string }[]>`select id from key_results limit 1 offset 3`)[0].id, current: 1 }] }), /another goal/);
    const before1 = await notes(tx, vikram, "goal.check_in");
    await goals.checkIn(tx, rohan, g.id, { status: "on_track", comment: "Halfway", keyResults: [{ id: kr.id, current: 100 }] }, [{ name: "plan.pdf", bytes: pdf }]);
    for (const f of await tx<{ storage_key: string }[]>`select storage_key from files where created_at >= now()`) blobs.push(f.storage_key);
    assert.equal(await notes(tx, vikram, "goal.check_in"), before1 + 1, "owner told about a manager's check-in");
    const after = Number((await tx<{ progress: string }[]>`select progress from objectives where id = ${appO.id}`)[0].progress);
    assert.ok(after > before, "department goal rolled up from the new aligned child");
    assert.equal(Number((await tx<{ progress: string }[]>`select progress from objectives where id = ${growth.id}`)[0].progress), Number(growth.progress), "company goal keeps its own KR-driven progress");
    // alignment loops and level rules
    await assert.rejects(goals.updateObjective(tx, rohan, r1.id, { title: "Release the app on both stores", parentId: a1.id, keyResults: [] }), /align to itself/);
    await assert.rejects(goals.updateObjective(tx, asha, appO.id, { title: "Ship", parentId: g.id, keyResults: [] }), /own level or above/);
    // private goals: owner and managers only
    const [priv] = await tx<{ id: string }[]>`select id from objectives where visibility = 'private' and owner_employee_id = ${arjun.employeeId}`;
    assert.ok(!(await goals.listGoals(tx, meera, "all", null)).some((x) => x.id === priv.id), "a peer doesn't see a private goal");
    assert.ok((await goals.listGoals(tx, rohan, "team", null)).some((x) => x.id === priv.id), "the manager does");
    assert.equal(await goals.goalDetail(tx, meera, priv.id), null);
    // the check-in file opens for those who see the goal
    const d = await goals.goalDetail(tx, meera, g.id);
    const fileId = d!.checkIns.find((c) => c.files.length)!.files[0].id;
    assert.ok(await goals.checkInFile(tx, meera, fileId));
    const ins = await goals.insights(tx, rohan, null);
    assert.ok(ins.people.some((p) => p.name.startsWith("Meera") && p.overdue === 1), "Meera's start-up goal is past due");
    assert.equal(ins.isAdmin, false);
    await goals.setClosed(tx, rohan, g.id, true);
    await assert.rejects(goals.checkIn(tx, vikram, g.id, { status: "on_track", progress: 10 }), /closed/);
    await goals.deleteObjective(tx, vikram, g.id);
  });
  ok("goals: levels need the right admin (scoped admins only their department), managers set goals for reports, KR weights total 100");
  ok("goals: check-ins roll progress up the alignment chain, owner notified, attachments readable by viewers; loops and downward alignment refused; private goals hidden from peers");

  // ---------- feedback ----------
  await rollback(tenant.id, async (tx) => {
    await assert.rejects(fb.giveFeedback(tx, arjun, { toId: arjun.employeeId, body: "Great job me", visibility: "public" }), /yourself/);
    const f = await fb.giveFeedback(tx, arjun, { toId: meera.employeeId, body: "Thanks for the review help", visibility: "private" });
    assert.equal(await fb.canRead(tx, meera, f.id), true);
    assert.equal(await fb.canRead(tx, vikram, f.id), false, "private feedback: only giver and receiver");
    assert.equal(await fb.canRead(tx, rohan, f.id), false, "not even the manager");
    await assert.rejects(fb.addNote(tx, arjun, { aboutId: meera.employeeId, body: "peer note" }), /your team/);
    const n = await fb.addNote(tx, rohan, { aboutId: meera.employeeId, body: "note" });
    assert.equal(await fb.canRead(tx, meera, n.id), false, "a note is never visible to its subject");
    assert.equal(await fb.canRead(tx, asha, n.id), true, "the manager's manager can read it");
    assert.equal(await fb.canRead(tx, vikram, n.id), false);
    await assert.rejects(fb.feedbackAbout(tx, meera, meera.employeeId), /your team/);
    const about = await fb.feedbackAbout(tx, rohan, meera.employeeId);
    assert.ok(about.some((x) => x.kind === "internal_note") && !about.some((x) => x.id === f.id));
    await assert.rejects(fb.requestFeedback(tx, arjun, { askIds: [vikram.employeeId], aboutId: meera.employeeId, question: "About Meera?" }), /your team/);
    await assert.rejects(fb.requestFeedback(tx, rohan, { askIds: [meera.employeeId], aboutId: meera.employeeId, question: "About yourself?" }), /about themselves/);
    const r = await fb.requestFeedback(tx, rohan, { askIds: [arjun.employeeId, arjun.employeeId], aboutId: vikram.employeeId, question: "How is Vikram doing?" });
    assert.equal(r.created, 1);
    assert.equal((await fb.requestFeedback(tx, rohan, { askIds: [arjun.employeeId], aboutId: vikram.employeeId, question: "Again?" })).created, 0, "asking again while open does nothing");
    const [req] = await tx<{ id: string }[]>`select id from feedback_items where kind = 'request' and to_employee_id = ${arjun.employeeId} and about_employee_id = ${vikram.employeeId} and status = 'pending'`;
    await assert.rejects(fb.respondToRequest(tx, meera, req.id, { body: "Not mine to answer" }), /isn't yours/);
    const ans = await fb.respondToRequest(tx, arjun, req.id, { body: "Solid and helpful", visibility: "private" });
    await assert.rejects(fb.respondToRequest(tx, arjun, req.id, { body: "Twice now" }), /already answered/);
    const [v] = await tx<{ visibility: string }[]>`select visibility from feedback_items where id = ${ans.id}`;
    assert.equal(v.visibility, "manager", "answers to a manager's request stay readable by the manager");
    assert.equal(await fb.canRead(tx, rohan, ans.id), true);
    const sum = await fb.feedbackSummary(tx, engPerf, addDaysISO(today, -30), today);
    assert.ok(sum.people.every((p) => ["Rohan", "Arjun", "Meera", "Vikram"].some((x) => p.name.startsWith(x))), "scoped admin's summary covers only their department");
    await assert.rejects(fb.feedbackSummary(tx, arjun, today, today), /access/);
    const mine = await fb.myFeedback(tx, arjun);
    assert.ok(mine.received.length >= 1 && mine.given.length >= 1);
  });
  ok("feedback: never to yourself; private stays between two people; manager notes hidden from the subject; requests answered once by the person asked; summary scoped");

  // ---------- 1:1s ----------
  await rollback(tenant.id, async (tx) => {
    await assert.rejects(one.scheduleOneOnOne(tx, arjun, { attendeeId: arjun.employeeId, startsAt: new Date().toISOString(), durationMins: 30, recurrence: null }), /other than yourself/);
    const m = await one.scheduleOneOnOne(tx, karan, { attendeeId: fatima.employeeId, startsAt: new Date(Date.now() + 86400e3).toISOString(), durationMins: 30, recurrence: "biweekly", agenda: ["Month-end close"] });
    assert.equal(await one.meetingDetail(tx, arjun, m.id), null, "outsiders can't open a 1:1");
    await assert.rejects(one.addItem(tx, arjun, m.id, { kind: "agenda", body: "sneaky" }), /not found/);
    await one.addItem(tx, karan, m.id, { kind: "private_note", body: "Fatima wants to move to FP&A" });
    await assert.rejects(one.addItem(tx, karan, m.id, { kind: "action_item", body: "x", assigneeId: arjun.employeeId }), /one of the two/);
    await one.addItem(tx, fatima, m.id, { kind: "action_item", body: "Share the reconciliation", assigneeId: fatima.employeeId });
    const seen = await one.meetingDetail(tx, fatima, m.id);
    assert.ok(!seen!.items.some((i) => i.kind === "private_note"), "private notes stay with their author");
    assert.equal((await one.meetingDetail(tx, karan, m.id))!.items.filter((i) => i.kind === "private_note").length, 1);
    await assert.rejects(one.reschedule(tx, fatima, m.id, new Date().toISOString(), 30), /organiser/);
    const c1 = await one.completeMeeting(tx, fatima, m.id);
    const c2 = await one.completeMeeting(tx, karan, m.id);
    assert.ok(c1.nextId); assert.equal(c2.nextId, null, "completing twice is a no-op");
    const next = await one.meetingDetail(tx, karan, c1.nextId!);
    assert.equal(next!.items.filter((i) => i.kind === "action_item" && i.carried).length, 1, "open action item carried to the next meeting");
    assert.equal(new Date(next!.startsAt).getTime() - Date.now() > 14 * 86400e3, true, "biweekly: next is two weeks later");
    await one.cancelMeeting(tx, karan, c1.nextId!, true);
    assert.equal((await tx<{ n: number }[]>`select count(*)::int as n from one_on_ones where organizer_employee_id = ${karan.employeeId} and status = 'scheduled'`)[0].n, 0, "ending the series cancels what's left");
  });
  ok("1:1s: only the two people can see or add; private notes per author; action items go to a participant and carry forward; complete is idempotent; recurrence and end-series");

  // ---------- reviews: launch, peers, fill, progress, nudges ----------
  await rollback(tenant.id, async (tx) => {
    const [form] = await tx<{ id: string }[]>`select id from review_forms limit 1`;
    const per = (await goals.currentPeriod(tx))!;
    const input = { name: "Smoke cycle", kind: "standard" as const, periodStart: per.starts_on, periodEnd: per.ends_on, formId: form.id,
      timelines: { self_due: addDaysISO(today, -1), manager_due: addDaysISO(today, 5) },
      reviewers: { self: true, manager: true, skip_level: true, peer: { enabled: true, min: 0, max: 1, nominated_by: "employee" as const, needs_approval: true } },
      employeeFilter: { department_ids: [eng.id] } };
    await assert.rejects(rv.createCycle(tx, engPerf, input), /performance admins/, "scoped admin can't create cycles");
    await assert.rejects(rv.createCycle(tx, priya, { ...input, timelines: { self_due: "2026-12-10", manager_due: "2026-12-01" } }), /can't be before/);
    await assert.rejects(rv.saveForm(tx, priya, form.id, { name: "Standard review", sections: [{ id: "q", type: "questions", title: "Q", weight: 0, items: [{ id: "a", text: "a", rated: true }] }] }), /already used/);
    const c = await rv.createCycle(tx, priya, input);
    await assert.rejects(rv.createCycle(tx, priya, input), /already a cycle/);
    const prev = await rv.previewParticipants(tx, priya, input.employeeFilter);
    assert.deepEqual(prev.map((p) => p.name.split(" ")[0]).sort(), ["Arjun", "Meera", "Rohan", "Vikram"]);
    const l = await rv.launchCycle(tx, priya, c.id);
    assert.equal(l.added, 4);
    await assert.rejects(rv.launchCycle(tx, priya, c.id), /already been launched/);
    const types = await tx<{ type: string; n: number }[]>`select reviewer_type as type, count(*)::int as n from review_assignments where cycle_id = ${c.id} group by 1 order by 1`;
    assert.deepEqual(types.map((r) => ({ ...r })), [{ type: "manager", n: 4 }, { type: "self", n: 4 }, { type: "skip_level", n: 3 }], "Rohan's skip-level is nobody (Asha has no manager)");
    // peers: reviewee proposes, manager approves, never the reviewee
    await assert.rejects(rv.nominatePeers(tx, arjun, c.id, arjun.employeeId, [meera.employeeId, vikram.employeeId]), /at most 1/);
    await assert.rejects(rv.nominatePeers(tx, arjun, c.id, arjun.employeeId, [arjun.employeeId]), /own peer/);
    await assert.rejects(rv.nominatePeers(tx, meera, c.id, arjun.employeeId, [vikram.employeeId]), /can't pick/);
    const nom = await rv.nominatePeers(tx, arjun, c.id, arjun.employeeId, [meera.employeeId]);
    assert.equal(nom.nomination, "proposed");
    const [pa] = await tx<{ id: string }[]>`select id from review_assignments where cycle_id = ${c.id} and reviewer_type = 'peer'`;
    await assert.rejects(rv.decideNomination(tx, arjun, pa.id, true), /Your manager/);
    await assert.rejects(rv.decideNomination(tx, meera, pa.id, true), /Only their manager/);
    assert.equal((await rv.myReviews(tx, meera)).toWrite.some((r) => r.id === pa.id), false, "a proposed peer isn't asked yet");
    await rv.decideNomination(tx, rohan, pa.id, true);
    await assert.rejects(rv.decideNomination(tx, rohan, pa.id, true), /already decided/);
    assert.ok((await rv.myReviews(tx, meera)).toWrite.some((r) => r.id === pa.id));
    // filling
    const [self] = await tx<{ id: string }[]>`select id from review_assignments where cycle_id = ${c.id} and reviewer_type = 'self' and reviewee_employee_id = ${arjun.employeeId}`;
    const [mgr] = await tx<{ id: string }[]>`select id from review_assignments where cycle_id = ${c.id} and reviewer_type = 'manager' and reviewee_employee_id = ${arjun.employeeId}`;
    assert.equal(await rv.reviewDetail(tx, meera, self.id), null, "others can't open someone's self review");
    assert.equal(await rv.reviewDetail(tx, rohan, self.id), null, "the manager can't read it before it's submitted");
    await assert.rejects(rv.saveDraft(tx, rohan, self.id, {}), /not found/);
    const d = (await rv.reviewDetail(tx, arjun, self.id))!;
    assert.ok(d.sections.find((s) => s.type === "goals")!.items.length >= 2, "goals section lists the person's goals in the period");
    const all = (score: number) => Object.fromEntries(d.sections.flatMap((s) => s.items.map((i) => [`${s.id}:${i.id}`, i.rated ? { rating: score } : { comment: "ok" }])));
    await rv.saveDraft(tx, arjun, self.id, { ...all(4), "bogus:key": { rating: 5 } });
    await assert.rejects(rv.submitReview(tx, arjun, self.id, { [Object.keys(all(4))[0]]: { rating: 4 } }), /Answer everything/);
    await assert.rejects(rv.submitReview(tx, arjun, self.id, { ...all(4), [Object.keys(all(4))[0]]: { rating: 9 } }), /from the scale/);
    const before = await notes(tx, rohan, "review.self_done");
    const s = await rv.submitReview(tx, arjun, self.id, all(4));
    assert.equal(s.rating, 4);
    assert.equal(await notes(tx, rohan, "review.self_done"), before + 1);
    await assert.rejects(rv.submitReview(tx, arjun, self.id, all(4)), /already submitted/);
    const md = (await rv.reviewDetail(tx, rohan, mgr.id))!;
    assert.ok(md.selfAnswers, "the manager sees the self review alongside");
    await rv.submitReview(tx, rohan, mgr.id, Object.fromEntries(md.sections.flatMap((s) => s.items.map((i) => [`${s.id}:${i.id}`, i.rated ? { rating: 3 } : { comment: "good" }]))));
    assert.ok(await rv.reviewDetail(tx, asha, self.id), "a manager higher up can read submitted reviews");
    const [o] = await tx<{ computed_rating: string }[]>`select computed_rating from review_outcomes where cycle_id = ${c.id} and employee_id = ${arjun.employeeId}`;
    assert.equal(Number(o.computed_rating), 3, "default weights: the manager's rating counts");
    // progress + nudges (once a day)
    const pg = await rv.cycleProgress(tx, priya, c.id);
    const selfStage = pg.stages.find((x) => x.type === "self")!;
    assert.equal(selfStage.total, 4); assert.equal(selfStage.submitted, 1); assert.equal(selfStage.overdue, 3);
    assert.ok((await rv.cycleProgress(tx, engPerf, c.id)).people.length === 4);
    await assert.rejects(rv.nudge(tx, engPerf, c.id), /performance admins/);
    const n1 = await rv.nudge(tx, priya, c.id, "self");
    assert.equal(n1.sent, 3);
    assert.equal((await rv.nudge(tx, priya, c.id, "self")).sent, 0, "nudging twice the same day sends nothing new");
    await rv.declineReview(tx, meera, pa.id);
    await assert.rejects(rv.declineReview(tx, rohan, mgr.id), /already submitted/);
    await assert.rejects(rv.deleteCycle(tx, priya, c.id), /Only draft/);
  });
  ok("review cycles: unscoped admins create and launch; filters map people; self, manager, skip-level reviews created; launch once");
  ok("peers: reviewee nominates within limits, the manager (never the reviewee) approves, only approved peers are asked; peer can decline");
  ok("review forms: drafts, unknown answers dropped, ratings from the scale, all items required to submit, submit once, manager sees self review, outcome computed");
  ok("cycle progress per stage with overdue counts (scoped admins see their people), nudges once a day");

  // ---------- calibration, import, publish ----------
  await rollback(tenant.id, async (tx) => {
    await assert.rejects(rv.advanceCycle(tx, engPerf, q3, "calibration"), /performance admins/);
    await rv.advanceCycle(tx, priya, q3, "calibration");
    await assert.rejects(rv.submitReview(tx, vikram, (await tx<{ id: string }[]>`select id from review_assignments where cycle_id = ${q3} and reviewer_employee_id = ${vikram.employeeId} and reviewer_type = 'self'`)[0].id, {}), /closed for reviews/);
    const cal = await rv.calibration(tx, engPerf, q3);
    assert.ok(cal.people.every((p) => ["Rohan", "Arjun", "Meera", "Vikram"].some((x) => p.name.startsWith(x))), "scoped admin calibrates only their department");
    const arjunO = cal.people.find((p) => p.name.startsWith("Arjun"))!;
    const snehaO = (await rv.calibration(tx, priya, q3)).people.find((p) => p.name.startsWith("Sneha"))!;
    await assert.rejects(rv.setFinalRating(tx, engPerf, snehaO.outcomeId, { finalRating: 4, potential: 2, note: "x" }), /don't calibrate/);
    await assert.rejects(rv.setFinalRating(tx, priya, arjunO.outcomeId, { finalRating: 4.5, potential: 3 }), /Add a note/);
    await assert.rejects(rv.setFinalRating(tx, priya, arjunO.outcomeId, { finalRating: 9, potential: 3, note: "x" }), /go from 1 to 5/);
    const pri = await rv.calibration(tx, priya, q3);
    const self = pri.people.find((p) => p.self);
    assert.equal(self, undefined, "Priya isn't in the Q3 cycle");
    const rohanAsAdmin = await actor("Rohan", ["performance.admin"]);
    const rohanO = pri.people.find((p) => p.name.startsWith("Rohan"))!;
    await assert.rejects(rv.setFinalRating(tx, rohanAsAdmin, rohanO.outcomeId, { finalRating: 5, potential: 3, note: "me" }), /your own rating/);
    await rv.setFinalRating(tx, priya, arjunO.outcomeId, { finalRating: 4.5, potential: 3, note: "Shipped the hardest part of the app." });
    const after = await rv.calibration(tx, priya, q3);
    const a = after.people.find((p) => p.name.startsWith("Arjun"))!;
    assert.equal(a.final, 4.5); assert.equal(a.band, "Outstanding"); assert.deepEqual(a.box, { perf: 3, potential: 3 });
    assert.equal(after.post.total, after.people.filter((p) => p.effective != null).length);
    // import: template round-trip, all-or-nothing
    const tpl = await rv.calibrationTemplate(tx, priya, q3);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(tpl as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Calibration")!;
    ws.eachRow((r, n) => { if (n > 1 && String(r.getCell(2).value).startsWith("Meera")) { r.getCell(4).value = 3.5; r.getCell(5).value = 2; r.getCell(6).value = "Strong second half"; } });
    const good = await wb.xlsx.writeBuffer();
    ws.addRow(["NOPE-1", "Ghost", null, 3, 1, "x"]);
    const badFile = await wb.xlsx.writeBuffer();
    const bad = await rv.importCalibration(tx, priya, q3, badFile as ArrayBuffer);
    assert.equal(bad.applied, 0); assert.match(bad.errors[0], /isn't in this cycle/);
    assert.equal((await rv.calibration(tx, priya, q3)).people.find((p) => p.name.startsWith("Meera"))!.final, null, "nothing applied when a row is wrong");
    const res = await rv.importCalibration(tx, priya, q3, good as ArrayBuffer);
    assert.equal(res.errors.length, 0);
    assert.equal((await rv.calibration(tx, priya, q3)).people.find((p) => p.name.startsWith("Meera"))!.final, 3.5);
    // publish: selected first, then everyone; idempotent
    await assert.rejects(rv.publishResults(tx, engPerf, q3, null), /performance admins/);
    const before = await notes(tx, arjun, "review.published");
    const p1 = await rv.publishResults(tx, priya, q3, [arjun.employeeId]);
    assert.equal(p1.released, 1); assert.ok(p1.remaining > 0);
    assert.equal(await notes(tx, arjun, "review.published"), before + 1);
    assert.equal((await rv.listCycles(tx, priya)).find((c) => c.id === q3)!.status, "calibration", "partly published stays in calibration");
    const mine = await rv.myResults(tx, arjun);
    assert.equal(mine.find((r) => r.cycleId === q3)!.rating, 4.5);
    assert.ok(!(await rv.myResults(tx, meera)).some((r) => r.cycleId === q3), "Meera's isn't released yet");
    await rv.publishResults(tx, priya, q3, null);
    assert.equal((await rv.publishResults(tx, priya, q3, null)).released, 0);
    assert.equal((await rv.listCycles(tx, priya)).find((c) => c.id === q3)!.status, "published");
    await assert.rejects(rv.setFinalRating(tx, priya, arjunO.outcomeId, { finalRating: 3, potential: 1, note: "late" }), /only while the cycle is in calibration/);
    const h1res = await rv.myResults(tx, imran);
    assert.equal(h1res.find((r) => r.cycleId === h1)!.rating, 2.5, "H1 calibrated rating published");
    assert.ok(h1res[0].comments.every((c) => !c.from.includes("Imran")), "comments don't name peers");
    await rv.advanceCycle(tx, priya, q3, "closed");
  });
  ok("calibration: scoped admins see and change only their people, never their own rating, notes required for changes, bands and 9-box follow");
  ok("calibration import: template round-trip, every row checked first (all or nothing); publish selected then all, idempotent, employees told; closed after");

  // ---------- automatic + aggregate cycles ----------
  await rollback(tenant.id, async (tx) => {
    const d0 = await rv.runAutoCycles(tx, tenant.id, today);
    const [p] = await tx<{ id: string }[]>`select id from employees where first_name = 'Divya'`;
    await tx`update employees set joining_date = ${addDaysISO(today, -95)} where id = ${p.id}`;
    const d1 = await rv.runAutoCycles(tx, tenant.id, today);
    assert.equal(d1 - d0 >= 1, true, "a person 95 days in joins the 90-day cycle");
    assert.equal(await rv.runAutoCycles(tx, tenant.id, today), 0, "running again adds nobody");
    const [o] = await tx`select 1 from review_assignments where cycle_id = ${nj} and reviewee_employee_id = ${p.id} and reviewer_type = 'self'`;
    assert.ok(o);
    const agg = await rv.createCycle(tx, priya, { name: "Year aggregate", kind: "aggregate", periodStart: `${year}-01-01`, periodEnd: `${year}-12-31`, timelines: {},
      reviewers: { self: false, manager: false, skip_level: false, peer: { enabled: false, min: 0, max: 1, nominated_by: "employee", needs_approval: false } }, sourceCycleIds: [h1] });
    const r = await rv.launchCycle(tx, priya, agg.id);
    assert.equal(r.added, 11);
    const [x] = await tx<{ computed_rating: string }[]>`select computed_rating from review_outcomes where cycle_id = ${agg.id} and employee_id = ${imran.employeeId}`;
    assert.equal(Number(x.computed_rating), 2.5, "aggregate takes calibrated (final) ratings");
    await assert.rejects(rv.createCycle(tx, priya, { name: "Bad aggregate", kind: "aggregate", periodStart: `${year}-01-01`, periodEnd: `${year}-12-31`, timelines: {},
      reviewers: { self: false, manager: false, skip_level: false, peer: { enabled: false, min: 0, max: 1, nominated_by: "employee", needs_approval: false } }, sourceCycleIds: [agg.id] }), /standard cycles/);
  });
  ok("automatic new-joiner cycle adds people on their day (job is idempotent); aggregate cycle combines calibrated ratings");

  // ---------- PIP ----------
  await rollback(tenant.id, async (tx) => {
    await assert.rejects(pip.createPip(tx, arjun, { employeeId: meera.employeeId, reason: "Not my team at all", goals: [{ title: "Do things" }], startsOn: today, endsOn: addDaysISO(today, 30) }), /your team/);
    await assert.rejects(pip.createPip(tx, priya, { employeeId: priya.employeeId, reason: "Self improvement plan", goals: [{ title: "Do things" }], startsOn: today, endsOn: addDaysISO(today, 30) }), /yourself/);
    await assert.rejects(pip.createPip(tx, sneha, { employeeId: imran.employeeId, reason: "A second open plan", goals: [{ title: "Do things" }], startsOn: today, endsOn: addDaysISO(today, 30) }), /already has an open plan/);
    const p = await pip.createPip(tx, rohan, { employeeId: meera.employeeId, reason: "Start-up time goal slipped twice", goals: [{ title: "Hit 1.5 s cold start", measure: "p50 on test devices" }], startsOn: today, endsOn: addDaysISO(today, 30) });
    assert.equal(await pip.pipDetail(tx, vikram, p.id), null, "peers can't see a PIP");
    const d = (await pip.pipDetail(tx, meera, p.id))!;
    assert.equal(d.canManage, false);
    await pip.pipCheckIn(tx, meera, p.id, { status: "on_track", note: "Image decoding fixed" });
    await assert.rejects(pip.setPipGoal(tx, meera, p.id, d.goals[0].id, true), /manager or HR/, "the person can't mark their own goals met");
    await assert.rejects(pip.closePip(tx, meera, p.id, "passed", "I passed"), /manager or HR/);
    await pip.setPipGoal(tx, rohan, p.id, d.goals[0].id, true);
    await assert.rejects(pip.extendPip(tx, rohan, p.id, today, "x"), /Pick a date after/);
    await pip.extendPip(tx, rohan, p.id, addDaysISO(today, 45), "Holiday break");
    await assert.rejects(pip.closePip(tx, rohan, p.id, "passed", " "), /outcome note/);
    await pip.closePip(tx, rohan, p.id, "passed", "Goal met and holding.");
    await assert.rejects(pip.closePip(tx, rohan, p.id, "failed", "again"), /already closed/);
    await assert.rejects(pip.pipCheckIn(tx, meera, p.id, { status: "on_track", note: "late" }), /closed/);
    assert.ok((await pip.listPips(tx, asha)).some((x) => x.id === p.id), "the manager's manager sees it");
    assert.ok(!(await pip.listPips(tx, vikram)).some((x) => x.id === p.id));
  });
  ok("PIP: managers / covering admins only, never yourself, one open plan; person checks in but can't mark goals or close; extend then close with a note");

  // ---------- compensation ----------
  await rollback(tenant.id, async (tx) => {
    const matrix = [
      { rating_min: 1, rating_max: 2.99, increment_pct_min: 0, increment_pct_max: 5 },
      { rating_min: 3, rating_max: 3.99, increment_pct_min: 5, increment_pct_max: 10, increment_pct_default: 8 },
      { rating_min: 4, rating_max: 5, increment_pct_min: 10, increment_pct_max: 20, increment_pct_default: 12 },
    ];
    // Priya holds compensation.admin company-wide (a role), so she is the admin approver
    const [role] = await tx<{ id: string }[]>`insert into roles (tenant_id, key, name, permissions) values (${tenant.id}, 'comp_smoke', 'Comp smoke', ${["compensation.admin"]}) returning id`;
    await tx`insert into role_assignments (tenant_id, role_id, employee_id) values (${tenant.id}, ${role.id}, ${priya.employeeId})`;
    // a paid month for the Monthly pay group, so a back-dated raise must carry arrears
    const [pg] = await tx<{ id: string }[]>`select id from pay_groups limit 1`;
    const month = `${today.slice(0, 7)}-01`;
    const eff = addDaysISO(month, -61).slice(0, 7) + "-01";
    await tx`insert into payroll_runs (tenant_id, pay_group_id, period_month, status) values (${tenant.id}, ${pg.id}, ${addDaysISO(month, -31).slice(0, 7) + "-01"}, 'finalized')`;
    const input = { name: "Smoke increments", reviewCycleId: h1, effectiveFrom: eff, budgetPaise: 10_00_000_00, matrix };
    await assert.rejects(comp.createCompCycle(tx, scopedComp, input), /compensation admins/, "scoped comp admin can't create cycles");
    await assert.rejects(comp.createCompCycle(tx, arjun, input), /compensation admins/);
    await assert.rejects(comp.createCompCycle(tx, compAdmin, { ...input, matrix: [...matrix, { rating_min: 4.5, rating_max: 5, increment_pct_min: 1, increment_pct_max: 2 }] }), /overlap/);
    const c = await comp.createCompCycle(tx, compAdmin, input);
    const o1 = await comp.openRecommendations(tx, compAdmin, c.id);
    assert.ok(o1.added >= 10);
    assert.equal((await comp.openRecommendations(tx, compAdmin, c.id)).added, 0, "opening again adds nobody");
    const det = (await comp.compCycleDetail(tx, rohan, c.id))!;
    assert.deepEqual(det.rows.map((r) => r.name.split(" ")[0]).sort(), ["Arjun", "Meera", "Vikram"], "a manager sees only their direct reports");
    assert.equal(await comp.compCycleDetail(tx, arjun, c.id), null, "people without reports don't see the cycle");
    const arj = det.rows.find((r) => r.name.startsWith("Arjun"))!;
    assert.equal(arj.rating, 4); assert.equal(arj.increment_bp, 1200, "suggested from the matrix default");
    const [rohanP] = await tx<{ id: string }[]>`select id from comp_proposals where cycle_id = ${c.id} and employee_id = ${rohan.employeeId}`;
    const rohanAdmin = await actor("Rohan", ["compensation.admin"]);
    await assert.rejects(comp.recommend(tx, rohanAdmin, rohanP.id, { incrementBp: 2000 }), /your own/, "nobody recommends their own raise");
    await assert.rejects(comp.recommend(tx, meera, arj.id, { incrementBp: 1000 }), /don't recommend/);
    await assert.rejects(comp.recommend(tx, rohan, arj.id, { incrementBp: 2500 }), /between 10% and 20%/);
    await comp.recommend(tx, rohan, arj.id, { incrementBp: 2000, note: "Stretch" });
    for (const r of det.rows.filter((x) => x.id !== arj.id)) await comp.recommend(tx, rohan, r.id, { incrementBp: r.range ? Math.round(r.range[1] * 100) : 0 });
    // over the team's share of budget → refused; trimmed → sent
    await tx`update comp_cycles set budget_paise = 1_00_000_00 where id = ${c.id}`;
    await assert.rejects(comp.submitRecommendations(tx, rohan, c.id), /share of the budget/);
    await tx`update comp_cycles set budget_paise = 50_00_000_00 where id = ${c.id}`;
    const sent = await comp.submitRecommendations(tx, rohan, c.id);
    assert.equal(sent.sent, 3);
    await assert.rejects(comp.submitRecommendations(tx, rohan, c.id), /nothing new/);
    // approvals: Rohan's manager (Asha) then a comp admin (Priya), never Arjun or Rohan
    const [req] = await tx<{ id: string }[]>`select id from approval_requests where entity_type = 'comp_proposal' and entity_id = ${arj.id}`;
    const steps = await tx<{ approver_employee_id: string; status: string; id: string }[]>`select id, approver_employee_id, status from approval_steps where request_id = ${req.id} order by level`;
    assert.deepEqual(steps.map((s) => s.approver_employee_id), [asha.employeeId, priya.employeeId]);
    assert.ok(await comp.proposalDetail(tx, asha, arj.id));
    assert.equal(await comp.proposalDetail(tx, arjun, arj.id), null, "the person can't open their own proposal");
    await approvals.decide(tx, asha, steps[0].id, "approved");
    const [s2] = await tx<{ id: string }[]>`select id from approval_steps where request_id = ${req.id} and level = 2`;
    await approvals.decide(tx, priya, s2.id, "approved");
    const all = await tx<{ id: string; employee_id: string }[]>`select id, employee_id from comp_proposals where cycle_id = ${c.id} and status = 'submitted'`;
    for (const p of all) {
      const pending = await tx<{ id: string; approver_employee_id: string }[]>`select s.id, s.approver_employee_id from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_type = 'comp_proposal' and r.entity_id = ${p.id} and s.status = 'pending'`;
      for (const st of pending) await approvals.decide(tx, st.approver_employee_id === asha.employeeId ? asha : priya, st.id, p.employee_id === meera.employeeId ? "rejected" : "approved");
      const more = await tx<{ id: string; approver_employee_id: string }[]>`select s.id, s.approver_employee_id from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_type = 'comp_proposal' and r.entity_id = ${p.id} and s.status = 'pending'`;
      for (const st of more) await approvals.decide(tx, st.approver_employee_id === asha.employeeId ? asha : priya, st.id, "approved");
    }
    const [meeraP] = await tx<{ id: string; status: string }[]>`select id, status from comp_proposals where cycle_id = ${c.id} and employee_id = ${meera.employeeId}`;
    assert.equal(meeraP.status, "rejected");
    await comp.recommend(tx, rohan, meeraP.id, { incrementBp: 500 });   // revise after rejection
    await comp.submitRecommendations(tx, rohan, c.id);
    const mp = await tx<{ id: string; approver_employee_id: string }[]>`select s.id, s.approver_employee_id from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_type = 'comp_proposal' and r.entity_id = ${meeraP.id} and s.status = 'pending'`;
    await approvals.decide(tx, asha, mp[0].id, "approved");
    const mp2 = await tx<{ id: string }[]>`select s.id from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_type = 'comp_proposal' and r.entity_id = ${meeraP.id} and s.status = 'pending'`;
    await approvals.decide(tx, priya, mp2[0].id, "approved");
    // the rest: compensation admin recommends, then closes
    const view = (await comp.compCycleDetail(tx, compAdmin, c.id))!;
    for (const o of view.rows.filter((r) => r.status === "draft")) await comp.recommend(tx, compAdmin, o.id, { incrementBp: o.range ? Math.round(o.range[0] * 100) : 0 });
    await tx`update comp_proposals set increment_bp = 0, proposed_ctc_paise = current_ctc_paise where cycle_id = ${c.id} and status = 'draft'`;   // left at 0%: no revision
    await assert.rejects(comp.applyCycle(tx, compAdmin, c.id), /Approve the cycle/);
    await comp.closeRecommendations(tx, compAdmin, c.id);
    await comp.markApproved(tx, compAdmin, c.id);
    const res = await comp.applyCycle(tx, compAdmin, c.id);
    assert.equal(res.applied, 3, "Arjun, Meera and Vikram get revisions");
    assert.equal(res.arrears, 3, "a start date in a paid month carries arrears");
    const [sal] = await tx<{ ctc_paise: bigint; reason: string; arrears_from_month: string; effective_from: string }[]>`
      select s.ctc_paise, s.reason, s.arrears_from_month::text, s.effective_from::text from comp_proposals p join employee_salaries s on s.id = p.salary_id where p.id = ${arj.id}`;
    assert.equal(Number(sal.ctc_paise), Math.round(1_380_000_00 * 1.2 / 100) * 100);
    assert.equal(sal.reason, "revision"); assert.equal(sal.effective_from, eff); assert.ok(sal.arrears_from_month);
    const again = await comp.applyCycle(tx, compAdmin, c.id);
    assert.equal(again.applied, 0, "applying again changes nothing");
    assert.equal((await comp.listCompCycles(tx, compAdmin)).find((x) => x.id === c.id)!.status, "applied");
  });
  ok("compensation: unscoped admins create cycles; matrix suggests % from ratings; managers see and recommend only their reports, never themselves, within range and budget");
  ok("compensation approvals: manager's manager then a comp admin (never the person/recommender), rejected ones revised and resent; apply → payroll revisions with arrears, idempotent");

  // ---------- public routes ----------
  for (const path of ["/me/performance", "/performance", "/performance/cycles/x", "/compensation", "/me/performance/files/x"]) {
    const host = `acme.${process.env.ROOT_DOMAIN ?? "localhost:3100"}`;
    const res = proxy(new NextRequest(`http://${host}${path}`, { headers: { host } }));
    assert.equal(res.status, 307, `${path} needs a session`);
    assert.match(res.headers.get("location") ?? "", /\/login/);
  }
  ok("no performance or compensation page is public: without a session every path goes to sign-in");

  // ---------- tenant isolation ----------
  const otherId = randomUUID();
  await admin`insert into tenants (id, subdomain, name) values (${otherId}, ${"smoke-" + otherId.slice(0, 8)}, 'Smoke Co')`;
  try {
    const [c] = await withTenant(otherId, (tx) => tx<{ n: string }[]>`
      select concat_ws('/', (select count(*) from objectives), (select count(*) from key_results), (select count(*) from check_ins), (select count(*) from feedback_items),
        (select count(*) from one_on_ones), (select count(*) from one_on_one_items), (select count(*) from review_cycles), (select count(*) from review_assignments),
        (select count(*) from review_outcomes), (select count(*) from review_forms), (select count(*) from competencies), (select count(*) from employee_skills),
        (select count(*) from performance_settings), (select count(*) from pips), (select count(*) from pip_check_ins), (select count(*) from comp_cycles), (select count(*) from comp_proposals),
        (select count(*) from performance_periods), (select count(*) from rating_scales)) as n`);
    assert.equal(c.n, Array(19).fill(0).join("/"));
    const outsider = { ...asha, tenant: { ...tenant, id: otherId } } as Actor;
    const [goal] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from objectives limit 1`);
    assert.equal(await withTenant(otherId, (tx) => goals.goalDetail(tx, outsider, goal.id)), null);
    await assert.rejects(withTenant(otherId, (tx) => goals.checkIn(tx, outsider, goal.id, { status: "on_track", progress: 5 })), /not found/);
    await assert.rejects(withTenant(otherId, (tx) => rv.launchCycle(tx, outsider, q3)), /not found/);
    await assert.rejects(withTenant(otherId, (tx) => tx`insert into objectives (tenant_id, level, title) values (${tenant.id}, 'company', 'x')`), /row-level security/);
    assert.deepEqual(await withTenant(otherId, (tx) => rv.listCycles(tx, outsider)), []);
  } finally {
    await admin`delete from tenants where id = ${otherId}`;
  }
  ok("another tenant sees none of Acme's goals, feedback, 1:1s, reviews, PIPs or compensation, and can't read or write them");

  for (const k of blobs) await storage().remove(k).catch(() => {});
  void divya;
  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await admin.end(); await sql.end(); }).catch(async (e) => {
  for (const k of blobs) await storage().remove(k).catch(() => {});
  console.error("\nFAILED:", e instanceof AppError ? `${e.code}: ${e.message}` : e); await admin.end(); await sql.end(); process.exit(1);
});
