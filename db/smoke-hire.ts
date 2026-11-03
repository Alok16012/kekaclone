/**
 * Smoke test for hiring against the seeded demo tenant (run `pnpm db:seed` first). Everything runs in rolled-back
 * transactions, so the demo data stays as seeded (stored file bytes are cleaned up at the end).
 *   pnpm smoke:hire
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { withTenant, sql, AppError, type Tx } from "@/server/db";
import { sha256 } from "@/server/auth/password";
import * as approvals from "@/server/modules/approvals/service";
import * as access from "@/server/modules/hire/access";
import * as setup from "@/server/modules/hire/setup";
import * as jobs from "@/server/modules/hire/jobs";
import * as cands from "@/server/modules/hire/candidates";
import * as iv from "@/server/modules/hire/interviews";
import * as offers from "@/server/modules/hire/offers";
import * as pub from "@/server/modules/hire/public";
import * as internal from "@/server/modules/hire/internal";
import * as reports from "@/server/modules/hire/reports";
import { rateLimitIn } from "@/server/modules/hire/ratelimit";
import { findToken, issueToken } from "@/server/modules/hire/tokens";
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
const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const HOUR = 3600_000;

async function main() {
  const [t] = await sql<{ id: string }[]>`select id from tenant_by_subdomain(${DEMO_SUBDOMAIN})`;
  assert.ok(t, "demo tenant exists (run pnpm db:seed)");
  const tenant = { id: t.id, name: "Acme Technologies", status: "trial", subdomain: DEMO_SUBDOMAIN };
  const actor = (first: string, permissions: string[] = [], scopes: Scope[] = []) => withTenant(tenant.id, async (tx) => {
    const [e] = await tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`;
    assert.ok(e, `${first} exists`);
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(permissions), grants: permissions.length ? [{ permissions, scopes }] : [] } as Actor;
  });
  const HR = ["employees.read", "employees.write", "hire.admin", "exits.manage"];
  const asha = await actor("Asha", ["*"]), priya = await actor("Priya", HR), aditya = await actor("Aditya", ["hire.recruit"]);
  const [rohan, arjun, meera, vikram, , imran, karan, fatima] = await Promise.all(["Rohan", "Arjun", "Meera", "Vikram", "Sneha", "Imran", "Karan", "Fatima"].map((n) => actor(n)));
  const [eng] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from departments where name = 'Engineering'`);
  const engHireAdmin = await actor("Karan", ["hire.admin"], [{ type: "department", ids: [eng.id] }]);   // hiring admin for Engineering only
  const q1 = async <T>(q: Promise<T[]>) => (await q)[0];
  const J = await withTenant(tenant.id, async (tx) => ({
    backend: (await q1(tx<{ id: string }[]>`select id from jobs where title = 'Backend Engineer'`)).id,
    ae: (await q1(tx<{ id: string }[]>`select id from jobs where title = 'Account Executive'`)).id,
    csm: (await q1(tx<{ id: string }[]>`select id from jobs where title = 'Customer Success Manager'`)).id,
    designer: (await q1(tx<{ id: string }[]>`select id from jobs where title = 'Product Designer'`)).id,
  }));
  const appOf = (tx: Tx, email: string, jobId: string) => q1(tx<{ id: string; candidate_id: string; status: string; stage_id: string }[]>`
    select a.id, a.candidate_id, a.status, a.stage_id from applications a join candidates c on c.id = a.candidate_id where c.email = ${email} and a.job_id = ${jobId}`);
  const stageId = (tx: Tx, name: string) => q1(tx<{ id: string }[]>`select s.id from hiring_stages s join hiring_flows f on f.id = s.flow_id where f.is_default and s.name = ${name}`).then((r) => r.id);
  const offerTpl = await withTenant(tenant.id, (tx) => q1(tx<{ id: string }[]>`select id from letter_templates where kind = 'offer' limit 1`)).then((r) => r.id);
  const offerInput = (ctc = 15_00_000_00) => ({ templateId: offerTpl, designationId: null, ctcPaise: ctc, joiningDate: addDaysISO(todayIn(), 20), expiresOn: addDaysISO(todayIn(), 5), note: null });

  // ---------- seed + defaults ----------
  await rollback(tenant.id, async (tx) => {
    const before = await tx<{ n: string }[]>`select concat_ws('/', (select count(*) from hiring_flows), (select count(*) from hiring_stages), (select count(*) from scorecards), (select count(*) from email_templates), (select count(*) from jd_templates), (select count(*) from letter_templates where kind = 'offer'), (select count(*) from career_sites), (select count(*) from roles where key = 'recruiter')) as n`;
    await setup.ensureHireDefaults(tx, tenant.id); await setup.ensureHireDefaults(tx, tenant.id);
    const after = await tx<{ n: string }[]>`select concat_ws('/', (select count(*) from hiring_flows), (select count(*) from hiring_stages), (select count(*) from scorecards), (select count(*) from email_templates), (select count(*) from jd_templates), (select count(*) from letter_templates where kind = 'offer'), (select count(*) from career_sites), (select count(*) from roles where key = 'recruiter')) as n`;
    assert.equal(after[0].n, before[0].n, "defaults are idempotent");
    assert.equal(before[0].n, "1/7/1/6/2/1/1/1");
    const list = await jobs.listJobs(tx, aditya);
    const be = list.find((j) => j.id === J.backend)!;
    assert.equal(be.status, "open");
    assert.ok(be.counts.offer >= 2 && be.counts.interview >= 2, "seeded pipeline has candidates across groups");
    const docs = await tx`select 1 from letter_templates where kind = 'offer'`;
    assert.ok(docs.length);
  });
  ok("seed: default flow, scorecard, templates, careers page and Recruiter role exist once; defaults idempotent; pipeline spread across stages");

  // ---------- settings: unscoped hire.admin only ----------
  await rollback(tenant.id, async (tx) => {
    const flows = await setup.listFlows(tx);
    const std = flows[0];
    const stages = std.stages.map((s) => ({ id: s.id, name: s.name, group: s.stage_group }));
    await assert.rejects(setup.saveFlow(tx, aditya, std.id, { name: std.name, isDefault: true, stages }), /hiring admins/);
    await assert.rejects(setup.saveFlow(tx, engHireAdmin, std.id, { name: std.name, isDefault: true, stages }), /hiring admins/, "a department-scoped hiring admin can't change company-wide settings");
    await assert.rejects(setup.saveScorecard(tx, arjun, null, { name: "x", ratingScaleId: randomUUID(), overallRating: false, sections: [] }), /hiring admins/);
    await assert.rejects(setup.saveEmailTemplate(tx, engHireAdmin, "rejection", { subject: "x", body: "y" }), /hiring admins/);
    await assert.rejects(setup.saveApprovalChain(tx, aditya, "offer", []), /hiring admins/);
    // stages with candidates can't be removed or change group; renames are fine
    const busy = std.stages.find((s) => s.in_use && s.stage_group === "interview")!;
    await assert.rejects(setup.saveFlow(tx, priya, std.id, { name: std.name, isDefault: true, stages: stages.filter((s) => s.id !== busy.id) }), /still has candidates/);
    await assert.rejects(setup.saveFlow(tx, priya, std.id, { name: std.name, isDefault: true, stages: stages.map((s) => s.id === busy.id ? { ...s, group: "screening" } : s) }), /out of order|can't change/);
    await setup.saveFlow(tx, priya, std.id, { name: std.name, isDefault: true, stages: stages.map((s) => s.id === busy.id ? { ...s, name: "Tech interview" } : s) });
    assert.equal((await tx<{ name: string }[]>`select name from hiring_stages where id = ${busy.id}`)[0].name, "Tech interview");
    // a new flow; unknown placeholders in email templates refused; approval chain resolves people inside the tenant
    const f = await setup.saveFlow(tx, priya, null, { name: "Fast track", isDefault: false, stages: [{ name: "Applied", group: "sourced" }, { name: "Call", group: "interview", onEnterEmailKey: "stage_update" }, { name: "Hired", group: "hired" }, { name: "Rejected", group: "rejected" }] });
    await assert.rejects(setup.saveFlow(tx, priya, null, { name: "fast track", isDefault: false, stages: [{ name: "A", group: "sourced" }, { name: "H", group: "hired" }, { name: "R", group: "rejected" }] }), /already exists/);
    await assert.rejects(setup.deleteFlow(tx, priya, std.id), /Jobs use this flow/);
    await setup.deleteFlow(tx, priya, f.id);
    await assert.rejects(setup.saveEmailTemplate(tx, priya, "rejection", { subject: "Hi {{candidate.salary}}", body: "x" }), /Unknown placeholder/);
    await assert.rejects(setup.saveApprovalChain(tx, priya, "offer", [{ approver: "employee", id: randomUUID() }]), /Pick a person/);
    await assert.rejects(setup.saveOfferTemplate(tx, priya, null, { name: "Bad", html: "<p>{{employee.salary}}</p>" }), /Unknown placeholder/);
  });
  ok("settings: only hiring admins for the whole company (recruiters, panelists and scoped admins refused); stages in use protected; names unique; placeholders and approvers checked");

  // ---------- job visibility and acting ----------
  await rollback(tenant.id, async (tx) => {
    const seen = async (a: Actor) => (await jobs.listJobs(tx, a)).map((j) => j.id).sort();
    assert.deepEqual(await seen(arjun), [J.backend].sort(), "a panelist sees only their job");
    assert.deepEqual(await seen(imran), [J.ae], "Imran is on the Account Executive panel only");
    assert.deepEqual(await seen(karan), [], "people outside hiring see no jobs");
    assert.deepEqual(await seen(engHireAdmin), [J.backend, J.designer].sort(), "a scoped hiring admin sees jobs in their department");
    assert.equal((await seen(priya)).length, 4);
    await assert.rejects(jobs.pipeline(tx, karan, J.backend), /not found/);
    await assert.rejects(jobs.pipeline(tx, imran, J.backend), /not found/);
    const p = await jobs.pipeline(tx, arjun, J.backend);
    assert.equal(p.access.act, false);
    const kabir = await appOf(tx, "kabir.shah@example.com", J.backend);
    await assert.rejects(cands.moveApplication(tx, arjun, kabir.id, await stageId(tx, "Offer")), /recruiters, hiring managers/, "panelists can't move candidates");
    const card = p.cards.find((c) => c.id === kabir.id)!;
    assert.equal(card.rating, 4, "pipeline card shows the average of submitted scorecards");
    assert.equal(card.ratings, 2);
    await assert.rejects(jobs.saveJob(tx, karan, null, { title: "x", departmentId: null, locationId: null, descriptionHtml: "", openings: 1, targetDate: null, jobType: "full_time", experienceMin: null, experienceMax: null, salaryMinPaise: null, salaryMaxPaise: null, showSalary: false, hiringFlowId: randomUUID(), reapplyAfterDays: null, team: [], publish: { careerSite: false, internal: false, referrals: false } }), /Only recruiters/);
    await assert.rejects(jobs.setJobStatus(tx, arjun, J.backend, "close"), /recruiters, hiring managers/);
    await assert.rejects(jobs.setJobStatus(tx, aditya, J.backend, "publish"), /current state/);
    const flow = (await setup.listFlows(tx))[0].id;
    await assert.rejects(jobs.saveJob(tx, aditya, J.backend, { title: "Backend Engineer", departmentId: eng.id, locationId: null, descriptionHtml: "<p>x</p>", openings: 2, targetDate: null, jobType: "full_time", experienceMin: 5, experienceMax: 3, salaryMinPaise: null, salaryMaxPaise: null, showSalary: false, hiringFlowId: flow, reapplyAfterDays: 30, team: [], publish: { careerSite: true, internal: true, referrals: true } }), /least/);
    await assert.rejects(jobs.saveJob(tx, aditya, null, { title: "Ghost team", departmentId: null, locationId: null, descriptionHtml: "", openings: 1, targetDate: null, jobType: "full_time", experienceMin: null, experienceMax: null, salaryMinPaise: null, salaryMaxPaise: null, showSalary: false, hiringFlowId: flow, reapplyAfterDays: null, team: [{ employeeId: randomUUID(), role: "panelist" }], publish: { careerSite: false, internal: false, referrals: false } }), /left or doesn't exist/);
    const j = await jobs.saveJob(tx, aditya, null, { title: "Data Analyst", departmentId: null, locationId: null, descriptionHtml: "<script>x</script><p>Numbers</p>", openings: 1, targetDate: null, jobType: "full_time", experienceMin: null, experienceMax: null, salaryMinPaise: null, salaryMaxPaise: null, showSalary: false, hiringFlowId: flow, reapplyAfterDays: null, team: [], publish: { careerSite: true, internal: false, referrals: false } });
    const full = await jobs.getJob(tx, aditya, j.id);
    assert.equal(full.description_html, "<p>Numbers</p>", "job descriptions are sanitised");
    assert.deepEqual(full.team.map((m) => [m.employee_id, m.role]), [[aditya.employeeId, "recruiter"]], "the creator joins as recruiter");
  });
  ok("jobs: hiring-team scoping (panelists see their job only, outsiders nothing, scoped admins their department); panelists can't act; job state machine; checks on ranges, team and HTML");

  // ---------- pipeline moves, bulk, reject, restore ----------
  await rollback(tenant.id, async (tx) => {
    const neha = await appOf(tx, "neha.gupta@example.com", J.backend), ravi = await appOf(tx, "ravi.kumar@example.com", J.backend);
    const screening = await stageId(tx, "Screening");
    await assert.rejects(cands.moveApplication(tx, aditya, neha.id, await stageId(tx, "Hired")), /converted/);
    await assert.rejects(cands.moveApplication(tx, aditya, neha.id, await stageId(tx, "Not selected")), /Use Reject/);
    const [otherFlowStage] = await tx<{ id: string }[]>`insert into hiring_flows (tenant_id, name) values (${tenant.id}, 'Other') returning id`;
    const [os] = await tx<{ id: string }[]>`insert into hiring_stages (tenant_id, flow_id, name, stage_group, position) values (${tenant.id}, ${otherFlowStage.id}, 'X', 'screening', 0) returning id`;
    await assert.rejects(cands.moveApplication(tx, aditya, neha.id, os.id), /isn't part of this job/);
    const r = await cands.bulkMove(tx, aditya, [neha.id, ravi.id, randomUUID()], await stageId(tx, "Technical round"));
    assert.equal(r.moved, 2); assert.equal(r.failed.length, 1);
    const ev = await tx<{ data: { from_group: string; to_group: string } }[]>`select data from application_events where application_id = ${neha.id} and kind = 'stage_change' order by created_at desc limit 1`;
    assert.deepEqual([ev[0].data.from_group, ev[0].data.to_group], ["sourced", "interview"]);
    // automation: a stage with an on-enter email queues it
    await tx`update hiring_stages set on_enter_email_key = 'stage_update' where id = ${screening}`;
    const before = (await tx`select 1 from outbound_emails where to_email = 'ravi.kumar@example.com'`).length;
    await cands.moveApplication(tx, aditya, ravi.id, screening);
    assert.equal((await tx`select 1 from outbound_emails where to_email = 'ravi.kumar@example.com'`).length, before + 1, "on-enter automation emails the candidate");
    // reject in bulk with a reason, then restore to where they were
    await assert.rejects(cands.rejectApplications(tx, aditya, [neha.id], "  ", { sendEmail: false }), /reason/);
    const rj = await cands.rejectApplications(tx, aditya, [neha.id, ravi.id], "Position filled", { sendEmail: true });
    assert.equal(rj.rejected, 2);
    const again = await cands.rejectApplications(tx, aditya, [neha.id], "Position filled", { sendEmail: true });
    assert.equal(again.rejected, 0, "rejecting twice does nothing");
    const [n2] = await tx<{ status: string; reject_reason: string; group: string }[]>`select a.status, a.reject_reason, s.stage_group as group from applications a join hiring_stages s on s.id = a.stage_id where a.id = ${neha.id}`;
    assert.deepEqual(n2, { status: "rejected", reject_reason: "Position filled", group: "rejected" });
    assert.equal((await tx`select 1 from interviews where application_id = ${ravi.id} and status in ('scheduled','awaiting_candidate')`).length, 0, "open interviews are cancelled on rejection");
    await cands.restoreApplication(tx, aditya, neha.id);
    const [n3] = await tx<{ status: string; name: string }[]>`select a.status, s.name from applications a join hiring_stages s on s.id = a.stage_id where a.id = ${neha.id}`;
    assert.deepEqual(n3, { status: "active", name: "Technical round" });
    await assert.rejects(cands.restoreApplication(tx, aditya, neha.id), /Only rejected/);
  });
  ok("pipeline: moves stay in the job's flow, never into Hired/Rejected by hand; bulk moves report failures; automation emails; reject (reason, email, interviews cancelled) is idempotent; restore returns to the last stage");

  // ---------- candidates: duplicates, import, notes, access ----------
  await rollback(tenant.id, async (tx) => {
    const base = { firstName: "Asha", lastName: "Clone", email: "NEHA.GUPTA@example.com", mobile: null, gender: null, currentCompany: null, currentTitle: null, experienceMonths: null, source: "manual", tags: [], custom: {} };
    await assert.rejects(cands.createCandidate(tx, aditya, base), /already in your candidates with this email/);
    await assert.rejects(cands.createCandidate(tx, aditya, { ...base, email: "new.person@example.com", mobile: "+91 98450 98450" }), /with this mobile/, "same mobile in another format is a duplicate");
    const r = await cands.createCandidate(tx, aditya, { ...base, email: "vivek.nair@example.com" }, { jobId: J.backend, useExisting: true });
    assert.equal(r.existing, true, "an existing candidate is added to the job instead of duplicated");
    await assert.rejects(cands.createCandidate(tx, arjun, { ...base, email: "x1@example.com" }), /Only recruiters/);
    await assert.rejects(cands.createCandidate(tx, arjun, { ...base, email: "x1@example.com" }, { jobId: J.backend }), /recruiters, hiring managers/);
    await assert.rejects(cands.createCandidate(tx, aditya, { ...base, email: "x2@example.com", resumeExt: 1 } as never, { resume: { name: "cv.exe", bytes: pdf } }), /PDF, Word/);
    await assert.rejects(cands.createCandidate(tx, aditya, { ...base, email: "x2@example.com" }, { resume: { name: "cv.pdf", bytes: new TextEncoder().encode("MZ not a pdf") } }), /doesn't look like/);
    const created = await cands.createCandidate(tx, aditya, { ...base, firstName: "Om", email: "om@example.com", tags: ["Java", "java "] }, { resume: { name: "cv.pdf", bytes: pdf } });
    await track(tx);
    const [c] = await tx<{ tags: string[]; resume_file_id: string | null }[]>`select tags, resume_file_id from candidates where id = ${created.candidateId}`;
    assert.deepEqual(c.tags, ["java"]); assert.ok(c.resume_file_id);
    // the resume opens for recruiters, not for people outside hiring
    assert.ok(await cands.hireFileFor(tx, aditya, c.resume_file_id!));
    assert.equal(await cands.hireFileFor(tx, karan, c.resume_file_id!), null);
    // database search and visibility
    const all = await cands.listCandidates(tx, priya, { q: "kabir" });
    assert.deepEqual(all.rows.map((x) => x.name), ["Kabir Shah"]);
    const arjunSees = (await cands.listCandidates(tx, arjun)).rows.map((x) => x.email);
    assert.ok(arjunSees.includes("kabir.shah@example.com") && !arjunSees.includes("rahul.verma@example.com") && !arjunSees.includes("om@example.com"), "panelists see their job's candidates only, not the talent pool");
    assert.equal((await cands.listCandidates(tx, karan)).rows.length, 0);
    // notes: private ones only for the author
    const kabir = await appOf(tx, "kabir.shah@example.com", J.backend);
    await cands.addNote(tx, arjun, kabir.candidate_id, { body: "Private thought", isPrivate: true });
    const forRohan = await cands.candidateProfile(tx, rohan, kabir.candidate_id);
    assert.ok(!forRohan.notes.some((n) => n.body === "Private thought"));
    assert.ok((await cands.candidateProfile(tx, arjun, kabir.candidate_id)).notes.some((n) => n.body === "Private thought"));
    await assert.rejects(cands.deleteNote(tx, rohan, (await tx<{ id: string }[]>`select id from candidate_notes where body = 'Private thought'`)[0].id), /your own notes/);
    await assert.rejects(cands.candidateProfile(tx, karan, kabir.candidate_id), /not found/);
    await assert.rejects(cands.addNote(tx, imran, kabir.candidate_id, { body: "x", isPrivate: false }), /not found/);
  });
  ok("candidates: duplicate email or mobile caught (or reused onto a job), resume type and signature checked, tags cleaned, files and profiles only for people who can see the candidate, private notes stay private");

  // ---------- internal applicants never act on themselves ----------
  await rollback(tenant.id, async (tx) => {
    const fatimaApp = await appOf(tx, "fatima@acme.test", J.csm);
    assert.ok(fatimaApp, "Fatima applied internally");
    const fatimaAdmin = { ...fatima, permissions: new Set(["hire.admin"]), grants: [{ permissions: ["hire.admin"], scopes: [] }] } as Actor;
    assert.deepEqual(await access.candidateAccess(tx, fatimaAdmin, fatimaApp.candidate_id), { see: false, act: false });
    assert.ok(!(await cands.listCandidates(tx, fatimaAdmin)).rows.some((r) => r.id === fatimaApp.candidate_id));
    await assert.rejects(cands.moveApplication(tx, fatimaAdmin, fatimaApp.id, await stageId(tx, "Screening")), /your own application/);
    await assert.rejects(offers.createOffer(tx, fatimaAdmin, fatimaApp.id, offerInput()), /your own application/);
    assert.ok(!(await jobs.pipeline(tx, fatimaAdmin, J.csm)).cards.some((c) => c.id === fatimaApp.id), "their card is hidden on the board");
    await assert.rejects(iv.scheduleInterview(tx, aditya, fatimaApp.id, { title: "x", mode: "phone", scheduling: "fixed", start: new Date(Date.now() + 48 * HOUR).toISOString(), end: new Date(Date.now() + 49 * HOUR).toISOString(), panel: [fatima.employeeId], scorecardId: null, notifyCandidate: false }), /themselves/);
    await assert.rejects(internal.applyInternal(tx, fatima, J.csm, null), /already applied/);
    await assert.rejects(internal.applyInternal(tx, aditya, J.csm, null), /hiring team/);
    await assert.rejects(internal.applyInternal(tx, karan, J.ae, null), /isn't open to internal/);
    const mine = await internal.internalJobs(tx, fatima);
    assert.equal(mine.mine[0].progress, "In sourced");
  });
  ok("internal applicants: never see, move, interview or make offers on their own application, even as hiring admins; can't apply twice or to jobs they hire for");

  // ---------- referrals ----------
  await rollback(tenant.id, async (tx) => {
    const cv = { name: "cv.pdf", bytes: pdf };
    await assert.rejects(internal.refer(tx, arjun, J.backend, { firstName: "A", lastName: null, email: "arjun@acme.test", mobile: null, note: null, resume: cv }), /refer yourself/);
    await assert.rejects(internal.refer(tx, arjun, J.backend, { firstName: "M", lastName: null, email: "meera@acme.test", mobile: null, note: null, resume: cv }), /already works here/);
    await assert.rejects(internal.refer(tx, arjun, J.backend, { firstName: "K", lastName: null, email: "kabir.shah@example.com", mobile: null, note: null, resume: cv }), /already being considered/);
    await assert.rejects(internal.refer(tx, arjun, J.csm, { firstName: "K", lastName: null, email: "k@example.com", mobile: null, note: null, resume: cv }), /isn't taking referrals/);
    await internal.refer(tx, arjun, J.backend, { firstName: "Leela", lastName: "Rao", email: "leela@example.com", mobile: null, note: "Great engineer", resume: cv });
    await track(tx);
    const mine = await internal.internalJobs(tx, arjun);
    assert.equal(mine.referrals[0].candidate, "Leela Rao");
    assert.equal(mine.referrals[0].progress, "In sourced", "referrers see the stage group only");
    const vikramRefs = await internal.internalJobs(tx, vikram);
    assert.equal(vikramRefs.referrals.length, 1);
  });
  ok("referrals: no self-referral, no colleagues, no duplicates in process, only jobs open to referrals; referrers see progress only");

  // ---------- public careers page and apply ----------
  await rollback(tenant.id, async (tx) => {
    const home = await pub.careersHome(tx);
    assert.deepEqual(home.jobs.map((j) => j.title).sort(), ["Account Executive", "Backend Engineer"], "only open jobs published to the careers page");
    assert.equal(home.jobs.find((j) => j.title === "Account Executive")!.salary_min_paise, null, "hidden salaries stay hidden");
    assert.equal(await pub.careersJob(tx, J.csm), null, "internal-only jobs aren't public");
    assert.equal(await pub.careersJob(tx, J.designer), null, "drafts aren't public");
    const input = { jobId: J.backend, firstName: "Ira", lastName: "Sen", email: "ira.sen@example.com", mobile: "", currentCompany: "", currentTitle: "", experienceYears: "3", consent: true, resume: { name: "cv.pdf", bytes: pdf } };
    await assert.rejects(pub.applyPublic(tx, tenant, { ...input, consent: false }), /agree/);
    await assert.rejects(pub.applyPublic(tx, tenant, { ...input, resume: null }), /resume/);
    await assert.rejects(pub.applyPublic(tx, tenant, { ...input, jobId: J.csm }), /isn't open/);
    assert.deepEqual(await pub.applyPublic(tx, tenant, { ...input, website: "spam" }), { ok: true });
    assert.equal((await tx`select 1 from candidates where email = 'ira.sen@example.com'`).length, 0, "the honeypot stores nothing");
    await pub.applyPublic(tx, tenant, input);
    await track(tx);
    await assert.rejects(pub.applyPublic(tx, tenant, { ...input, email: "IRA.SEN@example.com" }), /already applied/);
    const [iraBefore] = await tx<{ resume_file_id: string; current_company: string | null }[]>`select resume_file_id, current_company from candidates where email = 'ira.sen@example.com'`;
    await pub.applyPublic(tx, tenant, { ...input, jobId: J.ae, email: "ira.sen@example.com", currentCompany: "Impostor Ltd", resume: { name: "cv2.pdf", bytes: pdf } });
    assert.equal((await tx`select 1 from candidates where email = 'ira.sen@example.com'`).length, 1, "one candidate for both applications");
    const [iraAfter] = await tx<{ resume_file_id: string; current_company: string | null }[]>`select resume_file_id, current_company from candidates where email = 'ira.sen@example.com'`;
    assert.deepEqual(iraAfter, iraBefore, "an unverified public form never rewrites a candidate who is mid-process");
    const [aeEvent] = await tx<{ data: { resume_file_id?: string } }[]>`select ev.data from application_events ev join applications a on a.id = ev.application_id join candidates c on c.id = a.candidate_id
      where a.job_id = ${J.ae} and c.email = 'ira.sen@example.com' and ev.kind = 'applied' order by ev.created_at desc limit 1`;
    assert.ok(aeEvent.data.resume_file_id && aeEvent.data.resume_file_id !== iraBefore.resume_file_id, "the new resume stays on the application's timeline");
    await assert.rejects(pub.applyPublic(tx, tenant, { ...input, email: "fatima@acme.test" }), /internal jobs page/, "an employee's record can't be applied with from the public form");
    const ira = await appOf(tx, "ira.sen@example.com", J.backend);
    assert.ok((await tx`select 1 from outbound_emails where to_email = 'ira.sen@example.com'`).length >= 2, "applicants get a confirmation email");
    // cooldown: rejected 10 days ago, job waits 90 days → refused; 100 days ago → reopened
    await cands.rejectApplications(tx, aditya, [ira.id], "Not enough experience", { sendEmail: false });
    await tx`update applications set closed_at = now() - interval '10 days' where id = ${ira.id}`;
    await assert.rejects(pub.applyPublic(tx, tenant, input), /apply again from/);
    await tx`update applications set closed_at = now() - interval '100 days' where id = ${ira.id}`;
    await pub.applyPublic(tx, tenant, input);
    assert.equal((await appOf(tx, "ira.sen@example.com", J.backend)).status, "active");
    // no cooldown configured → can't reapply
    await tx`update jobs set allow_reapply_after_days = null where id = ${J.backend}`;
    await cands.rejectApplications(tx, aditya, [ira.id], "Not enough experience", { sendEmail: false });
    await tx`update applications set closed_at = now() - interval '400 days' where id = ${ira.id}`;
    await assert.rejects(pub.applyPublic(tx, tenant, input), /already applied/);
    // rate limit: 10 per hour per bucket
    for (let i = 0; i < 10; i++) await rateLimitIn(tx, tenant.id, "apply:ip:1.2.3.4", 10, 60);
    await assert.rejects(rateLimitIn(tx, tenant.id, "apply:ip:1.2.3.4", 10, 60), /Too many/);
    await rateLimitIn(tx, tenant.id, "apply:ip:5.6.7.8", 10, 60);
  });
  ok("careers: only open, published jobs and public fields; consent, resume and honeypot checks; same email = same candidate; duplicate and reapply cooldown enforced; applies are rate-limited");

  // ---------- interviews, self-scheduling, scorecards ----------
  await rollback(tenant.id, async (tx) => {
    const neha = await appOf(tx, "neha.gupta@example.com", J.backend);
    const [ananyaIv] = await tx<{ id: string; starts_at: Date; ends_at: Date }[]>`select i.id, i.starts_at, i.ends_at from interviews i join applications a on a.id = i.application_id join candidates c on c.id = a.candidate_id where c.email = 'ananya.iyer@example.com'`;
    const base = { title: "Tech", mode: "online", scheduling: "fixed" as const, start: ananyaIv.starts_at.toISOString(), end: ananyaIv.ends_at.toISOString(), meetingUrl: "https://meet.example.com/x", panel: [arjun.employeeId], scorecardId: null, notifyCandidate: true };
    await assert.rejects(iv.scheduleInterview(tx, aditya, neha.id, base), /Arjun Rao already has an interview/);
    await assert.rejects(iv.scheduleInterview(tx, aditya, neha.id, { ...base, meetingUrl: "javascript:alert(1)", allowConflict: true }), /https/);
    await assert.rejects(iv.scheduleInterview(tx, arjun, neha.id, { ...base, allowConflict: true }), /recruiters, hiring managers/);
    await assert.rejects(iv.scheduleInterview(tx, aditya, neha.id, { ...base, panel: [randomUUID()] }), /left or doesn't exist/);
    const fixed = await iv.scheduleInterview(tx, aditya, neha.id, { ...base, allowConflict: true });
    assert.equal((await tx`select 1 from hire_tokens where interview_id = ${fixed.interviewId} and kind = 'scorecard'`).length, 1, "each panelist gets a feedback link");
    assert.equal(fixed.calendarConfigured, false);
    const ics = await iv.interviewIcs(tx, aditya, fixed.interviewId);
    assert.ok(ics?.includes("BEGIN:VEVENT") && ics.includes("Neha Gupta"));
    assert.equal(await iv.interviewIcs(tx, karan, fixed.interviewId), null);
    // self-scheduling by token
    const now = new Date();
    const slots = [1, 2].map((d) => ({ start: new Date(now.getTime() + (48 + d) * HOUR).toISOString(), end: new Date(now.getTime() + (48 + d) * HOUR + 30 * 60_000).toISOString() }));
    const self = await iv.scheduleInterview(tx, aditya, neha.id, { title: "Screen", mode: "phone", scheduling: "self_schedule", slots, panel: [meera.employeeId], scorecardId: null, notifyCandidate: true });
    const token = await issueToken(tx, { tenantId: tenant.id, kind: "self_schedule", interviewId: self.interviewId, candidateId: neha.candidate_id, days: 14 });
    assert.equal((await tx`select 1 from hire_tokens where interview_id = ${self.interviewId} and kind = 'self_schedule' and expires_at > now()`).length, 1, "a new link replaces the old one");
    const view = await iv.selfScheduleView(tx, token);
    assert.equal(view!.slots.length, 2); assert.equal(view!.first_name, "Neha");
    await assert.rejects(iv.pickSlot(tx, tenant, token, 7), /Pick one/);
    const picked = await iv.pickSlot(tx, tenant, token, 1);
    assert.ok(picked.when.includes("IST"));
    const [s] = await tx<{ status: string; starts_at: Date }[]>`select status, starts_at from interviews where id = ${self.interviewId}`;
    assert.equal(s.status, "scheduled"); assert.equal(s.starts_at.toISOString(), new Date(slots[1].start).toISOString());
    await assert.rejects(iv.pickSlot(tx, tenant, token, 0), /expired or a time was already picked/, "a slot can be picked once");
    assert.equal(await iv.selfScheduleView(tx, "x".repeat(43)), null);
    assert.equal((await iv.selfScheduleView(tx, token))!.picked !== null, true, "the page shows the booked time afterwards");
    // scorecards: panelists only, once each, by app or link
    await assert.rejects(iv.submitScorecard(tx, rohan, fixed.interviewId, { ratings: {}, overall: null, recommendation: "yes", comments: null }), /not found/);
    await assert.rejects(iv.submitScorecard(tx, arjun, fixed.interviewId, { ratings: { problem_solving: 4 }, overall: null, recommendation: "yes", comments: null }), /Rate/);
    const r = await iv.submitScorecard(tx, arjun, fixed.interviewId, { ratings: { problem_solving: 4, domain: 3, communication: 4, ownership: 5 }, overall: null, recommendation: "yes", comments: "ok" });
    assert.equal(r.overall, 4);
    await assert.rejects(iv.submitScorecard(tx, arjun, fixed.interviewId, { ratings: { problem_solving: 1, domain: 1, communication: 1, ownership: 1 }, overall: null, recommendation: "no", comments: null }), /already sent/);
    const sc = await issueToken(tx, { tenantId: tenant.id, kind: "scorecard", interviewId: self.interviewId, employeeId: meera.employeeId, days: 10 });
    const form = await iv.scorecardByToken(tx, sc);
    assert.equal(form!.candidate, "Neha Gupta"); assert.equal(form!.submitted, false);
    await iv.submitScorecardByToken(tx, tenant.id, sc, { ratings: { problem_solving: 5, domain: 5, communication: 5, ownership: 5 }, overall: null, recommendation: "strong_yes", comments: null });
    await assert.rejects(iv.submitScorecardByToken(tx, tenant.id, sc, { ratings: { problem_solving: 5, domain: 5, communication: 5, ownership: 5 }, overall: null, recommendation: "strong_yes", comments: null }), /expired/, "a used feedback link stops working");
    assert.equal(await iv.scorecardByToken(tx, "nope-nope-nope-nope-nope"), null);
    const p = await jobs.pipeline(tx, aditya, J.backend);
    assert.equal(p.cards.find((c) => c.id === neha.id)!.rating, 4.5);
    await iv.setInterviewStatus(tx, aditya, fixed.interviewId, "no_show");
    await assert.rejects(iv.setInterviewStatus(tx, aditya, fixed.interviewId, "cancelled"), /can't change/);
  });
  ok("interviews: panel conflicts caught, safe meeting links, calendar file for the team only; self-schedule link books one slot once; scorecards only from panelists, once each (in app or by link), averages update");

  // ---------- requisitions ----------
  await rollback(tenant.id, async (tx) => {
    const input = { title: "QA Engineer", openings: 1, jobType: "full_time", departmentId: eng.id, locationId: null, salaryMinPaise: null, salaryMaxPaise: null, targetDate: null, description: null, qualification: null, experienceMin: null, experienceMax: null, backfillForId: null };
    await assert.rejects(jobs.saveRequisition(tx, arjun, null, input), /Only managers and recruiters/);
    await assert.rejects(jobs.saveRequisition(tx, rohan, null, { ...input, departmentId: randomUUID() }), /Pick a department/);
    await assert.rejects(jobs.saveRequisition(tx, rohan, null, { ...input, backfillForId: rohan.employeeId }), /yourself/);
    const r = await jobs.saveRequisition(tx, rohan, null, input);
    await assert.rejects(jobs.convertRequisition(tx, aditya, r.id), /Only approved/);
    await jobs.submitRequisition(tx, rohan, r.id);
    await assert.rejects(jobs.saveRequisition(tx, rohan, r.id, input), /already sent/);
    const steps = await tx<{ approver_employee_id: string; status: string }[]>`select s.approver_employee_id, s.status from approval_steps s join approval_requests q on q.id = s.request_id where q.entity_id = ${r.id} order by s.level`;
    assert.deepEqual(steps.map((s) => s.approver_employee_id), [asha.employeeId, priya.employeeId], "manager, then HR");
    assert.ok(!steps.some((s) => s.approver_employee_id === rohan.employeeId), "nobody approves their own requisition");
    assert.ok((await approvals.inbox(tx, asha)).some((i) => i.entity_id === r.id));
    const s1 = await q1(tx<{ id: string }[]>`select s.id from approval_steps s join approval_requests q on q.id = s.request_id where q.entity_id = ${r.id} and s.status = 'pending'`);
    await assert.rejects(approvals.decide(tx, rohan, s1.id, "approved"), /isn't waiting for you/);
    await approvals.decide(tx, asha, s1.id, "approved");
    const s2 = await q1(tx<{ id: string }[]>`select s.id from approval_steps s join approval_requests q on q.id = s.request_id where q.entity_id = ${r.id} and s.status = 'pending'`);
    await approvals.decide(tx, priya, s2.id, "approved");
    await jobs.onRequisitionDecided(tx, null, r.id, "rejected");
    assert.equal((await q1(tx<{ status: string }[]>`select status from requisitions where id = ${r.id}`)).status, "approved", "a repeat decision does nothing");
    await assert.rejects(jobs.convertRequisition(tx, rohan, r.id), /Only recruiters/);
    const c = await jobs.convertRequisition(tx, aditya, r.id);
    await assert.rejects(jobs.convertRequisition(tx, aditya, r.id), /already created/);
    const job = await jobs.getJob(tx, aditya, c.jobId);
    assert.equal(job.status, "draft"); assert.equal(job.requisition_id, r.id);
    assert.deepEqual(job.team.map((m) => m.role).sort(), ["hiring_manager", "recruiter"], "the requester joins as hiring manager");
    // visibility: the raiser sees their own; others don't
    assert.ok((await jobs.listRequisitions(tx, rohan)).every((x) => x.raised_by_id === rohan.employeeId));
    await assert.rejects(jobs.requisitionDetail(tx, arjun, r.id), /not found/);
    const bf = await jobs.backfillCandidates(tx);
    assert.ok(!bf.some((b) => b.name.startsWith("Divya")), "Divya already has a backfill requisition");
  });
  ok("requisitions: managers and recruiters raise; locked once sent; manager → HR chain with no self-approval; decisions idempotent; recruiters convert approved ones once (requester becomes hiring manager); backfills tracked");

  // ---------- offers, approval, portal, signing ----------
  await rollback(tenant.id, async (tx) => {
    const kabir = await appOf(tx, "kabir.shah@example.com", J.backend);
    await assert.rejects(offers.createOffer(tx, arjun, kabir.id, offerInput()), /recruiters, hiring managers/);
    await assert.rejects(offers.createOffer(tx, aditya, kabir.id, { ...offerInput(), joiningDate: "2000-01-01" }), /joining date/);
    await assert.rejects(offers.createOffer(tx, aditya, kabir.id, { ...offerInput(), templateId: randomUUID() }), /template/);
    const o = await offers.createOffer(tx, aditya, kabir.id, offerInput());
    await assert.rejects(offers.createOffer(tx, aditya, kabir.id, offerInput()), /already has an offer/);
    await assert.rejects(offers.releaseOffer(tx, aditya, o.id), /needs approval/);
    const pv = await offers.previewOffer(tx, rohan, o.id);
    assert.ok(pv.html.includes("Kabir") && pv.html.includes("15,00,000"));
    await offers.submitOffer(tx, aditya, o.id);
    const steps = await tx<{ id: string; approver_employee_id: string; status: string }[]>`select s.id, s.approver_employee_id, s.status from approval_steps s join approval_requests q on q.id = s.request_id where q.entity_id = ${o.id} order by s.level`;
    assert.deepEqual(steps.map((s) => s.approver_employee_id), [rohan.employeeId, priya.employeeId], "hiring manager, then HR");
    await assert.rejects(offers.updateOffer(tx, aditya, o.id, offerInput(1)), /already sent for approval/);
    await approvals.decide(tx, rohan, steps[0].id, "approved");
    await assert.rejects(offers.releaseOffer(tx, aditya, o.id), /needs approval/);
    await approvals.decide(tx, priya, steps[1].id, "approved");
    await offers.onOfferDecided(tx, null, o.id, "rejected");   // repeat: nothing changes
    const rel = await offers.releaseOffer(tx, aditya, o.id);
    await track(tx);
    await assert.rejects(offers.releaseOffer(tx, aditya, o.id), /needs approval|current state/);
    const token = rel.link.split("/p/portal/")[1];
    assert.ok(await findToken(tx, "portal", token));
    const view = await offers.portalView(tx, token);
    assert.equal(view!.offer!.status, "released"); assert.equal(view!.name, "Kabir Shah"); assert.ok(view!.docs.length >= 4);
    assert.ok((await offers.portalFile(tx, token, "offer")), "the candidate can open their letter");
    assert.equal(await offers.portalView(tx, "x".repeat(43)), null);
    // sign: typed name + emailed code; wrong codes are counted
    const r0 = await offers.acceptOffer(tx, token, { typedName: "Kabir Shah", code: "000000", ip: null });
    assert.deepEqual(r0, { ok: false, error: "Ask for a new code first.", field: "code" });
    const sent = await offers.requestSignCode(tx, token);
    assert.equal(sent.sentTo, "ka•••@example.com");
    const mail = await q1(tx<{ subject: string }[]>`select subject from outbound_emails where to_email = 'kabir.shah@example.com' and kind = 'hire.sign_code' order by created_at desc limit 1`);
    const code = mail.subject.match(/(\d{6})$/)![1];
    assert.equal((await offers.acceptOffer(tx, token, { typedName: "Someone Else", code, ip: null })).ok, false);
    const bad = await offers.acceptOffer(tx, token, { typedName: "kabir  shah", code: code === "111111" ? "222222" : "111111", ip: null });
    assert.match((bad as { error: string }).error, /4 tries left/);
    assert.equal((await q1(tx<{ otp_attempts: number }[]>`select otp_attempts from offers where id = ${o.id}`)).otp_attempts, 1);
    assert.deepEqual(await offers.acceptOffer(tx, token, { typedName: "kabir  shah", code, ip: "10.0.0.1" }), { ok: true });
    await track(tx);
    const [acc] = await tx<{ status: string; signed_name: string; letter_status: string }[]>`select o.status, o.signed_name, g.status as letter_status from offers o join generated_letters g on g.id = o.letter_id where o.id = ${o.id}`;
    assert.deepEqual(acc, { status: "accepted", signed_name: "kabir  shah", letter_status: "signed" });
    assert.equal((await offers.acceptOffer(tx, token, { typedName: "Kabir Shah", code, ip: null })).ok, false, "can't accept twice");
    await assert.rejects(offers.declineOffer(tx, token, "x"), /no offer waiting/);
    await assert.rejects(offers.reviseOffer(tx, aditya, o.id, offerInput()), /current state/, "accepted offers are final");
    // documents: upload in the portal, review by the team (with a reason to reject), tasks
    const docs = await tx<{ id: string }[]>`select r.id from document_requests r where r.candidate_id = ${kabir.candidate_id} order by r.created_at`;
    await assert.rejects(offers.portalUpload(tx, token, docs[0].id, { name: "x.svg", bytes: pdf }), /PDF, PNG or JPG/);
    await offers.portalUpload(tx, token, docs[0].id, { name: "pan.pdf", bytes: pdf });
    await offers.portalUpload(tx, token, docs[1].id, { name: "aadhaar.pdf", bytes: pdf });
    await track(tx);
    await assert.rejects(offers.portalUpload(tx, token, randomUUID(), { name: "x.pdf", bytes: pdf }), /not found/);
    await assert.rejects(offers.reviewDocument(tx, priya, docs[1].id, "rejected", ""), /what to fix/);
    await assert.rejects(offers.reviewDocument(tx, karan, docs[0].id, "approved", null), /not found/);
    await offers.reviewDocument(tx, priya, docs[0].id, "approved", null);
    await offers.reviewDocument(tx, aditya, docs[1].id, "rejected", "Blurry, please upload again");
    await assert.rejects(offers.reviewDocument(tx, priya, docs[0].id, "approved", null), /Only uploaded/);
    const tasks = (await offers.portalView(tx, token))!.tasks;
    await offers.portalTask(tx, token, tasks[0].id, true);
    await assert.rejects(offers.portalTask(tx, token, randomUUID(), true), /not found/);
    // convert: HR / hiring admins only; once
    const conv = { workEmail: "kabir@acme.test", employeeNumber: null, departmentId: eng.id, designationId: null, locationId: null, managerId: rohan.employeeId, joiningDate: addDaysISO(todayIn(), 20) };
    await assert.rejects(offers.convertToEmployee(tx, aditya, kabir.id, conv), /Only HR or hiring admins/, "recruiters without HR rights can't add employees");
    await assert.rejects(offers.convertToEmployee(tx, arjun, kabir.id, conv), /recruiters, hiring managers/);
    await assert.rejects(offers.convertToEmployee(tx, priya, kabir.id, { ...conv, workEmail: "arjun@acme.test" }), /already uses this work email/);
    const e = await offers.convertToEmployee(tx, priya, kabir.id, conv);
    assert.equal(e.internal, false);
    await assert.rejects(offers.convertToEmployee(tx, priya, kabir.id, conv), /already an employee/);
    const [emp] = await tx<{ display_name: string; manager_id: string; docs: number }[]>`select display_name, manager_id, (select count(*)::int from employee_documents d where d.employee_id = e.id) as docs from employees e where e.id = ${e.employeeId}`;
    assert.deepEqual(emp, { display_name: "Kabir Shah", manager_id: rohan.employeeId, docs: 2 }, "signed offer letter + the approved document move to the profile");
    const [a] = await tx<{ status: string; group: string }[]>`select a.status, s.stage_group as group from applications a join hiring_stages s on s.id = a.stage_id where a.id = ${kabir.id}`;
    assert.deepEqual(a, { status: "hired", group: "hired" });
  });
  ok("offers: drafted by the job's team; one live offer; hiring manager → HR approval before release; letter rendered, portal link; typed name + emailed code (wrong codes counted, can't accept twice); documents reviewed; converted once by HR into an employee with documents");

  await rollback(tenant.id, async (tx) => {
    const zoya = await appOf(tx, "zoya.ahmed@example.com", J.backend);
    const [o] = await tx<{ id: string }[]>`select id from offers where application_id = ${zoya.id} and status = 'released'`;
    const v2 = await offers.reviseOffer(tx, aditya, o.id, offerInput(22_00_000_00));
    assert.equal(v2.version, 2);
    assert.equal((await q1(tx<{ status: string }[]>`select status from offers where id = ${o.id}`)).status, "revised");
    await offers.withdrawOffer(tx, aditya, v2.id, "Role re-scoped");
    await assert.rejects(offers.withdrawOffer(tx, aditya, v2.id, null), /current state/);
    // decline path on a fresh offer
    const v3 = await offers.createOffer(tx, aditya, zoya.id, offerInput());
    await tx`insert into approval_requests (tenant_id, entity_type, entity_id, requester_employee_id, summary, status) values (${tenant.id}, 'offer', ${v3.id}, ${aditya.employeeId}, 'x', 'approved')`;
    const rel = await offers.releaseOffer(tx, aditya, v3.id);
    await track(tx);
    const token = rel.link.split("/p/portal/")[1];
    await offers.declineOffer(tx, token, "Accepted another offer");
    assert.equal((await q1(tx<{ status: string; decline_reason: string }[]>`select status, decline_reason from offers where id = ${v3.id}`)).decline_reason, "Accepted another offer");
    await assert.rejects(offers.convertToEmployee(tx, priya, zoya.id, { workEmail: "zoya@acme.test", employeeNumber: null, departmentId: null, designationId: null, locationId: null, managerId: null, joiningDate: todayIn() }), /accept an offer first/);
    // expiry job: released offers past their date expire, once
    await tx`update offers set status = 'released', expires_on = ${addDaysISO(todayIn(), -1)} where id = ${v3.id}`;
    const due = (await tx`select 1 from offers where status = 'released' and expires_on < ${todayIn()}`).length;
    assert.ok(due >= 1);
    assert.equal(await offers.expireOffers(tx), due);
    assert.equal(await offers.expireOffers(tx), 0, "running the job again changes nothing");
    const rep = await reports.hiringReport(tx, priya, { from: "2000-01-01", to: "2999-12-31" });
    assert.ok(rep.funnel[0].count >= 10 && rep.offers.declined >= 1 && rep.sources.length >= 4);
    const arjunRep = await reports.hiringReport(tx, arjun, { from: "2000-01-01", to: "2999-12-31" });
    assert.ok(arjunRep.total < rep.total, "reports only cover jobs the person can see");
  });
  ok("offers: revise makes a new version and retires the old; withdraw and decline are final; declined offers can't be converted; expiry job idempotent; analytics scoped to visible jobs");

  // ---------- tenant isolation ----------
  const otherId = randomUUID();
  await admin`insert into tenants (id, subdomain, name) values (${otherId}, ${"smoke-" + otherId.slice(0, 8)}, 'Smoke Co')`;
  try {
    const [c] = await withTenant(otherId, (tx) => tx<{ n: string }[]>`
      select concat_ws('/', (select count(*) from jobs), (select count(*) from candidates), (select count(*) from applications), (select count(*) from interviews), (select count(*) from offers),
        (select count(*) from requisitions), (select count(*) from hire_tokens), (select count(*) from jd_templates), (select count(*) from preboarding_tasks), (select count(*) from hire_rate_limits),
        (select count(*) from scorecard_submissions), (select count(*) from candidate_notes), (select count(*) from referrals), (select count(*) from career_sites)) as n`);
    assert.equal(c.n, "0/0/0/0/0/0/0/0/0/0/0/0/0/0");
    const outsider = { ...asha, tenant: { ...tenant, id: otherId } } as Actor;
    await assert.rejects(withTenant(otherId, (tx) => jobs.pipeline(tx, outsider, J.backend)), /not found/);
    await assert.rejects(withTenant(otherId, (tx) => cands.candidateProfile(tx, outsider, randomUUID())), /not found/);
    assert.equal(await withTenant(otherId, (tx) => pub.careersJob(tx, J.backend)), null, "another tenant's careers page can't show Acme's job");
    assert.deepEqual((await withTenant(otherId, (tx) => pub.careersHome(tx))).jobs, []);
    const tok = await withTenant(tenant.id, async (tx) => {
      const [i] = await tx<{ id: string }[]>`select id from interviews where status = 'awaiting_candidate' limit 1`;
      const token = await issueToken(tx, { tenantId: tenant.id, kind: "self_schedule", interviewId: i.id, days: 1 });
      return token;
    });
    assert.equal(await withTenant(otherId, (tx) => iv.selfScheduleView(tx, tok)), null, "a token from one tenant is useless on another tenant's address");
    assert.ok(await withTenant(tenant.id, (tx) => iv.selfScheduleView(tx, tok)));
    await withTenant(tenant.id, (tx) => tx`delete from hire_tokens where token_hash = ${sha256(tok)}`);
    await assert.rejects(withTenant(otherId, (tx) => tx`insert into jd_templates (tenant_id, name, description_html) values (${tenant.id}, 'sneaky', 'x')`), /row-level security/);
    await assert.rejects(withTenant(otherId, (tx) => tx`insert into hire_tokens (tenant_id, kind, token_hash, candidate_id, expires_at) values (${tenant.id}, 'portal', 'x', ${randomUUID()}, now())`), /row-level security/);
    const u = await withTenant(otherId, (tx) => tx`update jobs set status = 'closed' where id = ${J.backend}`);
    assert.equal(u.count, 0);
  } finally {
    await admin`delete from tenants where id = ${otherId}`;
  }
  ok("another tenant sees none of Acme's jobs, candidates, applications, interviews, offers, requisitions, tokens or careers jobs, can't use Acme's links and can't write into hiring tables");

  for (const k of blobs) await storage().remove(k).catch(() => {});
  console.log(`\n${passed} checks passed`);
}

main()
  .then(async () => { await admin.end(); await sql.end(); })
  .catch(async (e) => { console.error("\nFAILED:", e instanceof AppError ? `${e.code}: ${e.message}` : e); await admin.end(); await sql.end(); process.exit(1); });
