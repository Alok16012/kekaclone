/**
 * Smoke test for the hiring and helpdesk assistants, candidate privacy, interview reminders, the leaver hook on
 * requisitions and joiner-portal offer signing, against the seeded demo tenant (run `pnpm db:seed` first).
 * Almost everything runs in rolled-back transactions; the retention sweep (which commits by design) works on a
 * throwaway candidate and puts the settings back. No outside service is called: the AI provider is a fake.
 *   pnpm smoke:hp2
 */
import assert from "node:assert/strict";
import postgres from "postgres";
import { withTenant, sql, AppError, type Tx } from "@/server/db";
import { sha256 } from "@/server/auth/password";
import type { Actor } from "@/server/auth/session";
import type { Scope } from "@/server/auth/catalog";
import { ClaudeProvider, LlmError, setLlmForTesting, type LlmProvider } from "@/server/modules/assist/provider";
import * as ai from "@/server/modules/hire/assist";
import * as privacy from "@/server/modules/hire/privacy";
import * as hd from "@/server/modules/helpdesk/assist";
import { closeLeaverRequisitions } from "@/server/modules/hire/leaver";
import { sendInterviewReminders } from "@/server/modules/hire/reminders";
import { issueToken, findToken } from "@/server/modules/hire/tokens";
import * as offerSign from "@/server/modules/onboarding/offer-sign";
import { STEPS } from "@/server/modules/corehr/scheduler";
import { storage } from "@/server/storage";
import { DEMO_SUBDOMAIN } from "./demo";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const rollback = async (tenantId: string, fn: (tx: Tx) => Promise<void>) =>
  withTenant(tenantId, async (tx) => { await fn(tx); throw new Error("rollback"); }).catch((e) => { if (e.message !== "rollback") throw e; });
const code = (e: unknown) => (e instanceof AppError ? e.code : String(e));
const rejectsWith = async (p: Promise<unknown>, c: string) => { try { await p; assert.fail(`expected ${c}`); } catch (e) { assert.equal(code(e), c, String(e)); } };
/** No access: either refused or (the module's usual answer for things you can't see) not found. */
const denied = async (p: Promise<unknown>) => { try { await p; assert.fail("expected no access"); } catch (e) { assert.ok(["forbidden", "not_found"].includes(code(e)), String(e)); } };
const blobs: string[] = [];

/** A fake provider: records what it was sent and answers with `reply` (or throws it). */
function fake(reply: unknown | ((prompt: string) => unknown)) {
  const calls: { system: string; prompt: string }[] = [];
  const p: LlmProvider = {
    name: "Claude", model: "claude-sonnet-5",
    async json<T>(req: { system: string; prompt: string }) {
      calls.push({ system: req.system, prompt: req.prompt });
      const r = typeof reply === "function" ? (reply as (p: string) => unknown)(req.prompt) : reply;
      if (r instanceof Error) throw r;
      return r as T;
    },
  };
  return { p, calls };
}

async function main() {
  const [t] = await sql<{ id: string }[]>`select id from tenant_by_subdomain(${DEMO_SUBDOMAIN})`;
  assert.ok(t, "demo tenant exists (run pnpm db:seed)");
  const tenant = { id: t.id, name: "Acme Technologies", status: "trial", subdomain: DEMO_SUBDOMAIN };
  const actor = (first: string, permissions: string[] = [], scopes: Scope[] = []) => withTenant(tenant.id, async (tx) => {
    const [e] = await tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`;
    assert.ok(e, `${first} exists`);
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(permissions), grants: permissions.length ? [{ permissions, scopes }] : [] } as Actor;
  });
  const priya = await actor("Priya", ["employees.read", "employees.write", "hire.admin", "exits.manage"]);
  const aditya = await actor("Aditya", ["hire.recruit"]);
  const [rohan, imran, sneha, fatima] = await Promise.all(["Rohan", "Imran", "Sneha", "Fatima"].map((n) => actor(n)));
  const [eng] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from departments where name = 'Engineering'`);
  const scopedAdmin = await actor("Karan", ["hire.admin"], [{ type: "department", ids: [eng.id] }]);
  const q1 = async <T>(q: Promise<T[]>) => (await q)[0];
  const backend = await withTenant(tenant.id, (tx) => q1(tx<{ id: string }[]>`select id from jobs where title = 'Backend Engineer'`)).then((r) => r.id);
  const appOf = (tx: Tx, email: string) => q1(tx<{ id: string; candidate_id: string; status: string; stage_id: string }[]>`
    select a.id, a.candidate_id, a.status, a.stage_id from applications a join candidates c on c.id = a.candidate_id where c.email = ${email} order by a.created_at limit 1`);

  // ---------- provider ----------
  {
    let sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;
    const okFetch = (async (url: string, init: RequestInit) => {
      sent = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ content: [{ type: "text", text: '{"a":1}' }], stop_reason: "end_turn" }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await new ClaudeProvider("k-test", undefined, okFetch).json<{ a: number }>({ system: "s", prompt: "p", schema: { type: "object", properties: {}, required: [], additionalProperties: false } });
    assert.deepEqual(r, { a: 1 });
    const s = sent!;
    assert.equal(s.url, "https://api.anthropic.com/v1/messages");
    assert.equal(s.headers["x-api-key"], "k-test");
    assert.equal(s.headers["anthropic-version"], "2023-06-01");
    assert.equal(s.body.model, "claude-sonnet-5");
    assert.ok((s.body.output_config as { format: { type: string } }).format.type === "json_schema", "asks for structured JSON");
    const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const schema = { type: "object" as const, properties: {}, required: [], additionalProperties: false as const };
    await assert.rejects(new ClaudeProvider("k", undefined, answer(401, { error: { message: "bad key" } })).json({ system: "", prompt: "", schema }), (e) => e instanceof LlmError && e.kind === "http");
    await assert.rejects(new ClaudeProvider("k", undefined, answer(200, { content: [], stop_reason: "refusal" })).json({ system: "", prompt: "", schema }), (e) => e instanceof LlmError && e.kind === "refusal");
    await assert.rejects(new ClaudeProvider("k", undefined, answer(200, { content: [{ type: "text", text: "not json" }], stop_reason: "end_turn" })).json({ system: "", prompt: "", schema }), (e) => e instanceof LlmError && e.kind === "parse");
    setLlmForTesting(null);
    assert.equal(await withTenant(tenant.id, (tx) => ai.assistantState(tx)).then((s) => s.active), false, "no key: not configured");
  }
  ok("provider: Messages API shape (model, key, version, JSON schema output); http / refusal / bad JSON become LlmError; no key = not configured");

  // ---------- JD drafting ----------
  {
    const input: ai.JdInput = { title: "Data Engineer", skills: ["Python", "Airflow", "python"], departmentId: eng.id, locationId: null, experienceMin: 3, experienceMax: 6, jobType: "full_time", notes: null };
    await rejectsWith(withTenant(tenant.id, (tx) => ai.jdContext(tx, rohan, input)), "forbidden");
    await rejectsWith(withTenant(tenant.id, (tx) => ai.jdContext(tx, aditya, { ...input, title: " " })), "invalid");
    const ctx = await withTenant(tenant.id, (tx) => ai.jdContext(tx, aditya, input));
    assert.ok(ctx.brief.skills.includes("Airflow") && ctx.brief.skills.length <= 3);
    assert.equal(ctx.brief.department, "Engineering");
    setLlmForTesting(null);
    const outline = await ai.draftJd(ctx.brief, true);
    assert.equal(outline.method, "outline");
    assert.match(outline.html, /Data Engineer/);
    assert.match(outline.html, /Airflow/);
    assert.match(outline.notice ?? "", /isn't set up/);
    const f = fake({ about: "Build <script>alert(1)</script> pipelines.", responsibilities: ["Own ETL"], requirements: ["3+ years of Python"], nice_to_have: [], why_join: "Good team." });
    setLlmForTesting(f.p);
    const d = await ai.draftJd(ctx.brief, true);
    assert.equal(d.method, "ai");
    assert.ok(!/<script/i.test(d.html), "model text is escaped, never trusted as HTML");
    assert.match(d.html, /Own ETL/);
    assert.match(f.calls[0].prompt, /Data Engineer/);
    assert.match(f.calls[0].system, /Never mention age, gender/);
    const off = await ai.draftJd(ctx.brief, false);
    assert.equal(off.method, "outline", "company switched AI off: outline");
    assert.equal(f.calls.length, 1, "no call when switched off");
    setLlmForTesting(fake(new LlmError("The AI service took too long to answer.", "timeout")).p);
    const fb = await ai.draftJd(ctx.brief, true);
    assert.equal(fb.method, "outline");
    assert.match(fb.notice ?? "", /too long/);
    await rollback(tenant.id, async (tx) => {
      await ai.recordJdDraft(tx, aditya, ctx.brief, d);
      const [a] = await tx`select 1 from audit_logs where action = 'job.jd_draft' and actor_user_id = ${aditya.userId}`;
      assert.ok(a, "audited");
    });
  }
  ok("JD drafting: recruiters only; outline fallback without a key, when AI is off, and on errors; AI text is escaped; prompt forbids protected traits; audited");

  // ---------- resume scoring ----------
  await rollback(tenant.id, async (tx) => {
    setLlmForTesting(null);
    const neha = await appOf(tx, "neha.gupta@example.com");
    await denied(ai.scoreContext(tx, fatima, neha.id));
    const c = await ai.scoreContext(tx, aditya, neha.id);
    const r = await ai.computeScore(c);
    assert.equal(r.method, "keywords");
    assert.ok(r.matched.includes("java") && r.matched.includes("postgresql"), "keyword overlap finds the skills");
    assert.ok(r.missing.includes("kubernetes"));
    await ai.saveScore(tx, aditya, c, r);
    await ai.saveScore(tx, aditya, c, r);
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from resume_scores where application_id = ${neha.id}`;
    assert.equal(n, 1, "rescoring replaces the score");
    const after = await appOf(tx, "neha.gupta@example.com");
    assert.equal(after.status, neha.status); assert.equal(after.stage_id, neha.stage_id);   // advisory: nothing moves

    const f = fake({ score: 150, summary: "Good fit.", strengths: ["Java"], gaps: [], matched_skills: ["Java"], missing_skills: [] });
    setLlmForTesting(f.p);
    const r2 = await ai.computeScore(c);
    assert.equal(r2.method, "ai"); assert.equal(r2.score, 100, "score clamped to 0–100");
    assert.ok(!/neha\.gupta@example\.com|98450|Neha|Gupta/i.test(f.calls[0].prompt), "names and contact details never leave the app");
    assert.match(f.calls[0].prompt, /Java/);
    setLlmForTesting(fake(new LlmError("Couldn't reach the AI service.", "http")).p);
    const r3 = await ai.computeScore(c);
    assert.equal(r3.method, "keywords"); assert.match(r3.notice ?? "", /keyword match instead/);
    setLlmForTesting(null);

    const js = await ai.jobScores(tx, aditya, backend);
    assert.ok(js.rows.some((x) => x.application_id === neha.id && !x.stale));
    await denied(ai.jobScores(tx, fatima, backend));
    const s = await ai.staleScoreContexts(tx, aditya, backend, 60);
    assert.ok(!s.contexts.some((x) => x.applicationId === neha.id), "current scores aren't redone");
    await tx`update jobs set description_html = description_html || '<p>Also Go.</p>' where id = ${backend}`;
    assert.ok((await ai.jobScores(tx, aditya, backend)).rows.find((x) => x.application_id === neha.id)!.stale, "a changed JD marks scores stale");
    const s2 = await ai.staleScoreContexts(tx, aditya, backend, 60);
    assert.ok(s2.contexts.some((x) => x.applicationId === neha.id));
    assert.ok(await ai.applicationScore(tx, aditya, neha.id));
  });
  ok("resume scoring: job access needed; keyword fallback; one score per application; never moves anyone; AI prompt is redacted; score clamped; errors fall back; stale when the JD changes");

  // ---------- tenant isolation ----------
  {
    const [other] = await admin<{ id: string }[]>`select id from tenants where id <> ${tenant.id} limit 1`;
    if (other) {
      const visible = await withTenant(other.id, (tx) => tx`select 1 from resume_scores union all select 1 from candidate_privacy_requests union all select 1 from hire_settings where tenant_id = ${tenant.id}`);
      assert.equal(visible.length, 0, "another company sees none of these rows");
      await assert.rejects(withTenant(other.id, (tx) => tx`insert into hire_settings (tenant_id) values (${tenant.id})`), /row-level security/);
      await assert.rejects(withTenant(other.id, (tx) => tx`insert into helpdesk_suggestions (tenant_id, employee_id, kind, question, method) values (${tenant.id}, ${rohan.employeeId}, 'self_service', 'x', 'search')`), /row-level security/);
    }
  }
  ok("tenant isolation: scores, requests, settings and suggestions are row-level secured");

  // ---------- settings ----------
  await rollback(tenant.id, async (tx) => {
    await rejectsWith(ai.saveHireSettings(tx, aditya, { ai_enabled: false, candidate_retention_months: 12 }), "forbidden");
    await rejectsWith(ai.saveHireSettings(tx, scopedAdmin, { ai_enabled: false, candidate_retention_months: 12 }), "forbidden");
    await rejectsWith(ai.saveHireSettings(tx, priya, { ai_enabled: false, candidate_retention_months: 3 }), "invalid");
    await ai.saveHireSettings(tx, priya, { ai_enabled: false, candidate_retention_months: 12 });
    assert.deepEqual(await ai.hireSettings(tx), { ai_enabled: false, candidate_retention_months: 12 });
    await rejectsWith(hd.saveHelpdeskSettings(tx, rohan, { ai_enabled: false, suggest_before_raise: false }), "forbidden");
  });
  ok("settings: company-wide hiring admins only (scoped admins can't); retention validated; helpdesk settings admin-only");

  // ---------- helpdesk answers ----------
  await rollback(tenant.id, async (tx) => {
    setLlmForTesting(null);
    await rejectsWith(hd.askContext(tx, rohan, "help"), "invalid");
    const ctx = await hd.askContext(tx, rohan, "How many days of sick leave do I get in a year?");
    assert.ok(ctx.docs.some((d) => d.title === "Leave and holiday policy"));
    assert.ok(!ctx.docs.some((d) => d.title === "Customer data handling"), "documents in folders the person can't see are never used");
    const a = await hd.answer(ctx, "self_service");
    assert.equal(a.method, "search");
    assert.equal(a.citations[0].title, "Leave and holiday policy");
    assert.ok(a.citations[0].fileId, "citation links to the document");
    assert.match(a.answer, /12 days of sick leave/);
    const id = await hd.recordSuggestion(tx, rohan, ctx, a, "self_service");
    await rejectsWith(hd.rateSuggestion(tx, imran, id, true), "not_found");
    await hd.rateSuggestion(tx, rohan, id, true);
    await rejectsWith(hd.rateSuggestion(tx, rohan, id, false), "not_found");
    assert.equal((await hd.assistantStats(tx)).helped >= 1, true);
    const imranCtx = await hd.askContext(tx, imran, "What should I do if customer data is sent to the wrong person?");
    assert.equal((await hd.answer(imranCtx, "self_service")).citations[0]?.title, "Customer data handling", "sales can see the sales folder");
    const none = await hd.answer(await hd.askContext(tx, rohan, "quantum chromodynamics lattice"), "self_service");
    assert.equal(none.answer, ""); assert.equal(none.citations.length, 0);

    // with AI: citations must point at sources it was given; uncited answers are dropped
    setLlmForTesting(fake({ answered: true, answer: "You get 12 days [1].", citations: [1, 9] }).p);
    const x = await hd.answer(ctx, "self_service");
    assert.equal(x.method, "ai"); assert.equal(x.citations.length, 1); assert.equal(x.citations[0].n, 1);
    setLlmForTesting(fake({ answered: true, answer: "Made up.", citations: [7] }).p);
    assert.equal((await hd.answer(ctx, "self_service")).answer, "", "no valid citation, no answer");
    setLlmForTesting(fake({ answered: false, answer: "", citations: [] }).p);
    assert.equal((await hd.answer(ctx, "self_service")).answer, "");
    setLlmForTesting(fake(new LlmError("x", "timeout")).p);
    assert.equal((await hd.answer(ctx, "self_service")).method, "search", "errors fall back to search");
    setLlmForTesting(null);

    // agent drafts: only agents on the ticket; answered from what the requester can see; never sent
    const [tk] = await tx<{ id: string }[]>`select t.id from tickets t join employees e on e.id = t.raised_by_employee_id where e.first_name = 'Sneha' limit 1`;
    await assert.rejects(hd.draftContext(tx, rohan, tk.id));
    await denied(hd.draftContext(tx, sneha, tk.id));
    const dc = await hd.draftContext(tx, priya, tk.id);
    assert.equal(dc.employeeId, sneha.employeeId);
    const msgs = await tx<{ n: number }[]>`select count(*)::int as n from ticket_messages where ticket_id = ${tk.id}`;
    const dr = await hd.answer(dc, "agent_draft");
    await hd.recordSuggestion(tx, priya, dc, dr, "agent_draft");
    assert.equal((await tx<{ n: number }[]>`select count(*)::int as n from ticket_messages where ticket_id = ${tk.id}`)[0].n, msgs[0].n, "a draft is never posted");
    const [au] = await tx`select 1 from audit_logs where action = 'ticket.draft_suggested' and entity_id = ${tk.id}`;
    assert.ok(au);
  });
  ok("helpdesk: answers only from documents the asker can see, with citations; one rating per suggestion; AI citations validated; agent-only drafts never posted");

  // ---------- leaver hook ----------
  await rollback(tenant.id, async (tx) => {
    const [karan] = await tx<{ id: string }[]>`select id from employees where first_name = 'Karan'`;
    const [req] = await tx<{ id: string; status: string }[]>`select r.id, r.status from requisitions r where r.raised_by_employee_id = ${karan.id} and r.status = 'pending'`;
    assert.ok(req, "seeded pending requisition");
    const n = await closeLeaverRequisitions(tx, tenant.id, karan.id, priya.userId);
    assert.ok(n >= 1);
    const [after] = await tx<{ status: string }[]>`select status from requisitions where id = ${req.id}`;
    assert.equal(after.status, "closed");
    const [ar] = await tx<{ status: string }[]>`select status from approval_requests where entity_type = 'requisition' and entity_id = ${req.id} order by created_at desc limit 1`;
    assert.notEqual(ar?.status, "pending", "its approval is cancelled");
    assert.equal(await closeLeaverRequisitions(tx, tenant.id, karan.id, priya.userId), 0, "idempotent");
    const [conv] = await tx<{ status: string }[]>`select status from requisitions where title = 'Backend Engineer'`;
    assert.equal(conv.status, "converted", "decided requisitions are untouched");
    const [nt] = await tx`select 1 from notifications where kind = 'hire.requisition_closed'`;
    assert.ok(nt, "recruiters are told");
  });
  ok("exits: undecided requisitions the leaver raised are closed and their approvals cancelled, once; decided ones stay; recruiters notified");

  // ---------- interview reminders ----------
  await rollback(tenant.id, async (tx) => {
    const ravi = await appOf(tx, "ravi.kumar@example.com");
    const now = new Date();
    const [i] = await tx<{ id: string }[]>`
      insert into interviews (tenant_id, application_id, mode, scheduling, starts_at, ends_at, status, title, meeting_url)
      values (${tenant.id}, ${ravi.id}, 'online', 'fixed', ${new Date(now.getTime() + 3 * 3600_000)}, ${new Date(now.getTime() + 4 * 3600_000)}, 'scheduled', 'Tech round', 'https://meet.example.com/x') returning id`;
    await tx`insert into interview_panelists (tenant_id, interview_id, employee_id) values (${tenant.id}, ${i.id}, ${rohan.employeeId})`;
    const [far] = await tx<{ id: string }[]>`
      insert into interviews (tenant_id, application_id, mode, scheduling, starts_at, ends_at, status, title)
      values (${tenant.id}, ${ravi.id}, 'phone', 'fixed', ${new Date(now.getTime() + 72 * 3600_000)}, ${new Date(now.getTime() + 73 * 3600_000)}, 'scheduled', 'Later') returning id`;
    const sent = await sendInterviewReminders(tx, tenant.id, now);
    assert.ok(sent >= 1);
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from outbound_emails where kind = 'hire.interview_reminder' and to_email = 'ravi.kumar@example.com'`;
    assert.equal(n, 1);
    assert.ok((await tx`select 1 from notifications where kind = 'hire.interview_reminder' and user_id = ${rohan.userId}`).length, "panel notified");
    assert.equal(await sendInterviewReminders(tx, tenant.id, now), 0, "sent once");
    const [fr] = await tx<{ reminder_sent_at: Date | null }[]>`select reminder_sent_at from interviews where id = ${far.id}`;
    assert.equal(fr.reminder_sent_at, null, "interviews more than a day out wait");
    assert.ok(STEPS.some((s) => s.key === "hire_reminders") && STEPS.some((s) => s.key === "hire_privacy"), "both jobs run in the daily scheduler");
  });
  ok("interview reminders: candidate email + panel notification for interviews in the next day, once; later ones wait; registered in jobs:daily");

  // ---------- candidate privacy ----------
  await rollback(tenant.id, async (tx) => {
    const kabir = await appOf(tx, "kabir.shah@example.com");
    const token = await issueToken(tx, { tenantId: tenant.id, kind: "portal", candidateId: kabir.candidate_id, days: 30 });
    await rejectsWith(privacy.requestErasureFromPortal(tx, token, { confirm: false, reason: null }), "invalid");
    const r = await privacy.requestErasureFromPortal(tx, token, { confirm: true, reason: "No longer looking" });
    assert.equal(r.outcome, "removed");
    for (const k of r.keys) blobs.push(k);
    const [c] = await tx<{ first_name: string; email: string; parsed: object; anonymised_at: Date | null; resume_file_id: string | null }[]>`select first_name, email::text, parsed, anonymised_at, resume_file_id from candidates where id = ${kabir.candidate_id}`;
    assert.equal(c.first_name, "Removed candidate"); assert.ok(c.anonymised_at); assert.equal(c.resume_file_id, null); assert.deepEqual(c.parsed, {});
    assert.ok(c.email.endsWith("@erased.invalid"));
    const [{ status }] = await tx<{ status: string }[]>`select status from applications where id = ${kabir.id}`;
    assert.equal(status, "withdrawn", "active applications are withdrawn");
    assert.equal(await findToken(tx, "portal", token, { allowUsed: true }), null, "their links stop working");
    const [mail] = await tx`select 1 from outbound_emails where kind = 'hire.erasure_done' and to_email = 'kabir.shah@example.com'`;
    assert.ok(mail, "confirmation goes to the address they had");
    await rejectsWith(privacy.requestErasureFromPortal(tx, token, { confirm: true, reason: null }), "invalid");
    await rejectsWith(ai.scoreContext(tx, aditya, kabir.id), "conflict");

    // a live offer: waits for a hiring admin, asking twice is a no-op, HR can decline with a reason
    const zoya = await appOf(tx, "zoya.ahmed@example.com");
    await tx`delete from candidate_privacy_requests where candidate_id = ${zoya.candidate_id}`;
    const zt = await issueToken(tx, { tenantId: tenant.id, kind: "portal", candidateId: zoya.candidate_id, days: 30 });
    assert.equal((await privacy.requestErasureFromPortal(tx, zt, { confirm: true, reason: null })).outcome, "pending");
    assert.equal((await privacy.requestErasureFromPortal(tx, zt, { confirm: true, reason: null })).outcome, "pending");
    const reqs = await privacy.privacyRequests(tx, priya);
    const zr = reqs.filter((x) => x.candidate_id === zoya.candidate_id && x.status === "pending");
    assert.equal(zr.length, 1, "one pending request");
    assert.match(zr[0].blocker ?? "", /offer/);
    await rejectsWith(privacy.privacyRequests(tx, scopedAdmin), "forbidden");
    await rejectsWith(privacy.eraseCandidateByHr(tx, priya, zoya.candidate_id, null), "conflict");
    await rejectsWith(privacy.declinePrivacyRequest(tx, priya, zr[0].id, " "), "invalid");
    await privacy.declinePrivacyRequest(tx, priya, zr[0].id, "Your offer is still open.");
    await rejectsWith(privacy.declinePrivacyRequest(tx, priya, zr[0].id, "again"), "not_found");

    // employees: declined with a reason; HR erasure: company-wide admins only
    const fat = await appOf(tx, "fatima@acme.test");
    const ft = await issueToken(tx, { tenantId: tenant.id, kind: "portal", candidateId: fat.candidate_id, days: 30 });
    assert.equal((await privacy.requestErasureFromPortal(tx, ft, { confirm: true, reason: null })).outcome, "declined");
    const ananya = await appOf(tx, "ananya.iyer@example.com");
    await denied(privacy.eraseCandidateByHr(tx, aditya, ananya.candidate_id, null));
    await denied(privacy.eraseCandidateByHr(tx, scopedAdmin, ananya.candidate_id, null));
    const hr = await privacy.eraseCandidateByHr(tx, priya, ananya.candidate_id, "Asked by email");
    for (const k of hr.keys) blobs.push(k);
    await rejectsWith(privacy.eraseCandidateByHr(tx, priya, ananya.candidate_id, null), "conflict");
    assert.ok((await tx`select 1 from audit_logs where action = 'candidate.anonymised' and entity_id = ${ananya.candidate_id}`).length);
  });
  ok("privacy: portal 'delete my data' removes at once (confirmation needed, links die, applications withdrawn, email sent); live offers wait for HR; employees declined; HR erasure company-wide only; idempotent");

  // ---------- retention sweep (commits; throwaway candidate) ----------
  {
    const old = new Date(Date.now() - 400 * 86_400_000);
    const before = await withTenant(tenant.id, (tx) => ai.hireSettings(tx));
    const [cand] = await withTenant(tenant.id, async (tx) => {
      const [c] = await tx<{ id: string }[]>`insert into candidates (tenant_id, first_name, email, source, created_at, updated_at) values (${tenant.id}, 'Old', 'old.applicant@example.com', 'career_site', ${old}, ${old}) returning id`;
      const [stage] = await tx<{ id: string }[]>`select stage_id as id from applications where job_id = ${backend} limit 1`;
      await tx`insert into applications (tenant_id, job_id, candidate_id, stage_id, status, source, created_at, updated_at, stage_entered_at) values (${tenant.id}, ${backend}, ${c.id}, ${stage.id}, 'rejected', 'career_site', ${old}, ${old}, ${old})`;
      await tx`insert into hire_settings (tenant_id, ai_enabled, candidate_retention_months) values (${tenant.id}, ${before.ai_enabled}, 12) on conflict (tenant_id) do update set candidate_retention_months = 12`;
      return [c];
    });
    try {
      const r1 = await privacy.retentionSweep(tenant.id, new Date().toISOString().slice(0, 10));
      assert.ok(r1.removed >= 1);
      const [c] = await withTenant(tenant.id, (tx) => tx<{ anonymised_at: Date | null }[]>`select anonymised_at from candidates where id = ${cand.id}`);
      assert.ok(c.anonymised_at, "inactive past the retention period: anonymised");
      const [{ n }] = await withTenant(tenant.id, (tx) => tx<{ n: number }[]>`select count(*)::int as n from candidates where anonymised_at is not null and id <> ${cand.id}`);
      assert.equal(n, 0, "recent and active candidates are untouched");
      const r2 = await privacy.retentionSweep(tenant.id, new Date().toISOString().slice(0, 10));
      assert.equal(r2.removed, 0, "idempotent");
    } finally {
      await withTenant(tenant.id, async (tx) => {
        await tx`delete from candidate_privacy_requests where candidate_id = ${cand.id}`;
        await tx`delete from applications where candidate_id = ${cand.id}`;
        await tx`delete from candidates where id = ${cand.id}`;
        await tx`update hire_settings set candidate_retention_months = ${before.candidate_retention_months}, ai_enabled = ${before.ai_enabled}`;
      });
    }
  }
  ok("retention: the daily sweep anonymises only inactive candidates past the company's period, once");

  // ---------- joiner portal: sign the offer letter ----------
  await rollback(tenant.id, async (tx) => {
    const [k] = await tx<{ id: string; display_name: string }[]>`select id, display_name from employees where first_name = 'Kavya'`;
    const token = "joiner-token-for-smoke-hp2-0001";
    await tx`update lifecycle_processes set portal_token_hash = ${sha256(token)}, portal_expires_at = now() + interval '7 days' where employee_id = ${k.id} and kind = 'onboarding'`;
    assert.equal(await offerSign.joinerOffer(tx, "wrong-token-wrong-token-wrong"), null);
    const v = await offerSign.joinerOffer(tx, token);
    assert.ok(v && !v.signed, "the seeded offer letter waits for her signature");
    const r = await offerSign.requestJoinerSignCode(tx, tenant, token);
    assert.match(r.sentTo, /•••@/);
    assert.ok((await tx`select 1 from outbound_emails where kind = 'onboarding.sign_code'`).length);
    const [g] = await tx<{ id: string; file_id: string }[]>`
      select g.id, g.file_id from generated_letters g join letter_templates t on t.id = g.template_id where g.employee_id = ${k.id} and t.kind = 'offer' order by g.created_at desc limit 1`;
    await tx`update generated_letters set sign_otp_hash = ${sha256(`${g.id}:123456`)} where id = ${g.id}`;
    const bad = await offerSign.signJoinerOffer(tx, tenant, token, { typedName: "Someone Else", code: "123456", ip: null });
    assert.equal(bad.ok, false); assert.equal(!bad.ok && bad.field, "typedName");
    const wrong = await offerSign.signJoinerOffer(tx, tenant, token, { typedName: k.display_name, code: "000000", ip: null });
    assert.equal(!wrong.ok && wrong.field, "code");
    const [{ sign_otp_attempts }] = await tx<{ sign_otp_attempts: number }[]>`select sign_otp_attempts from generated_letters where id = ${g.id}`;
    assert.equal(sign_otp_attempts, 1, "wrong codes are counted");
    const good = await offerSign.signJoinerOffer(tx, tenant, token, { typedName: k.display_name.toLowerCase(), code: "123456", ip: "10.0.0.1" });
    assert.deepEqual(good, { ok: true });
    const [after] = await tx<{ status: string; file_id: string; signed_name: string }[]>`select status, file_id, signed_name from generated_letters where id = ${g.id}`;
    assert.equal(after.status, "signed"); assert.notEqual(after.file_id, g.file_id, "a signed copy replaces the file");
    const [f] = await tx<{ storage_key: string }[]>`select storage_key from files where id = ${after.file_id}`;
    blobs.push(f.storage_key);
    assert.ok((await tx`select 1 from employee_documents where employee_id = ${k.id} and file_id = ${after.file_id}`).length, "lands in her documents");
    assert.equal((await offerSign.signJoinerOffer(tx, tenant, token, { typedName: k.display_name, code: "123456", ip: null })).ok, false, "signs once");
    assert.equal((await offerSign.joinerOffer(tx, token))!.signed, true);
    assert.ok(await offerSign.joinerOfferFile(tx, token));
  });
  ok("joiner portal: the offer letter is signed with the typed full name and an emailed code; wrong codes counted; signed copy saved to their documents; once only");

  // ---------- integration: joiner portal ↔ erp Sign, letter.signed automation ----------
  await rollback(tenant.id, async (tx) => {
    const [k] = await tx<{ id: string; display_name: string }[]>`select id, display_name from employees where first_name = 'Kavya'`;
    const token = "joiner-token-for-smoke-hp2-0002";
    await tx`update lifecycle_processes set portal_token_hash = ${sha256(token)}, portal_expires_at = now() + interval '7 days' where employee_id = ${k.id} and kind = 'onboarding'`;
    const [g] = await tx<{ id: string }[]>`
      select g.id from generated_letters g join letter_templates t on t.id = g.template_id where g.employee_id = ${k.id} and t.kind = 'offer' order by g.created_at desc limit 1`;
    // HR sent it out through erp Sign: the portal points at the emailed link and won't sign it itself
    const [sr] = await tx<{ id: string }[]>`insert into signature_requests (tenant_id, letter_id, signer_employee_id, signer_email, signer_name, sign_order, status)
      values (${tenant.id}, ${g.id}, ${k.id}, 'kavya@example.com', ${k.display_name}, 1, 'pending') returning id`;
    assert.equal((await offerSign.joinerOffer(tx, token))!.viaErpSign, true);
    await assert.rejects(() => offerSign.requestJoinerSignCode(tx, tenant, token), /signing link/);
    await tx`delete from signature_requests where id = ${sr.id}`;
    // otherwise the portal signs it, with erp Sign's audit page (document hash), and fires the letter.signed automation
    const [auto] = await tx<{ id: string }[]>`insert into automations (tenant_id, name, trigger, conditions, actions, is_active)
      values (${tenant.id}, 'Signed letter note', 'letter.signed', '[]', ${tx.json([{ type: "notify", to: ["employee"], title: "Signed: {{letter.title}}", body: "Thanks" }])}, true) returning id`;
    assert.equal((await offerSign.joinerOffer(tx, token))!.viaErpSign, false);
    await offerSign.requestJoinerSignCode(tx, tenant, token);
    await tx`update generated_letters set sign_otp_hash = ${sha256(`${g.id}:654321`)} where id = ${g.id}`;
    assert.deepEqual(await offerSign.signJoinerOffer(tx, tenant, token, { typedName: k.display_name, code: "654321", ip: "10.0.0.2" }), { ok: true });
    const [log] = await tx<{ diff: { hash: string | null } }[]>`select diff from audit_logs where entity_id = ${g.id} and action = 'letter.signed' order by created_at desc limit 1`;
    assert.match(String(log.diff.hash), /^[0-9a-f]{64}$/, "the audit trail keeps the SHA-256 of the letter she saw");
    const [f] = await tx<{ storage_key: string }[]>`select f.storage_key from generated_letters g join files f on f.id = g.file_id where g.id = ${g.id}`;
    blobs.push(f.storage_key);
    assert.ok((await tx`select 1 from automation_runs where automation_id = ${auto.id}`).length, "letter.signed ran the automation");
  });
  ok("integration: an offer sent through erp Sign is signed only via its link; portal signatures carry erp Sign's audit page and fire letter.signed automations");

  setLlmForTesting(undefined);
  for (const k of blobs) await storage().remove(k).catch(() => {});
  console.log(`\n${passed} hp2 checks passed.`);
  await admin.end(); await sql.end();
}

main().catch(async (e) => { console.error(e); for (const k of blobs) await storage().remove(k).catch(() => {}); await admin.end(); await sql.end(); process.exit(1); });
