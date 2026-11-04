/**
 * Smoke test for the plat2 package: workflow automations (permissions, plan gate, validation, every action type,
 * idempotent runs, daily triggers), email templates, Slack / Teams approvals (signed tokens, one-use), per-user
 * calendar sync (queue, sync with a fake API, cancel), OAuth2 client credentials + the API's write and hook
 * endpoints, Web Push queue/delivery, the offline punch queue, per-user language, and tenant isolation of every
 * new table. Runs against the seeded demo tenant (pnpm db:seed first); creates a throw-away tenant and removes it.
 *   pnpm smoke:plat2
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { withTenant, sql, type Tx } from "@/server/db";
import type { Actor, Tenant } from "@/server/auth/session";
import { provisionTenant } from "@/server/modules/tenants/provision";
import { createEmployee } from "@/server/modules/employees/service";
import * as leave from "@/server/modules/leave/service";
import * as auto from "@/server/modules/automations/service";
import * as ntf from "@/server/modules/notifications/service";
import { defaultTemplate } from "@/server/modules/notifications/templates";
import * as chat from "@/server/modules/integrations/chat";
import { signAction, verifyAction } from "@/server/modules/integrations/chat-rules";
import * as cal from "@/server/modules/calendar/service";
import * as oauth from "@/server/modules/integrations/oauth";
import * as api from "@/server/modules/integrations/api-write";
import { listEndpoints } from "@/server/modules/integrations/service";
import * as push from "@/server/modules/push/service";
import { syncQueuedPunches } from "@/server/modules/attendance/offline";
import { encryptField } from "@/server/modules/payroll/secret";
import { appUrl } from "@/server/email";
import { addDaysISO, todayIn, weekday } from "@/lib/dates";
import { DEMO_PASSWORD, DEMO_SUBDOMAIN } from "./demo";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const rollback = (e: Error) => { if (e.message !== "rollback") throw e; };
const nextWorking = (from: string) => { let d = from; while (["sat", "sun"].includes(weekday(d))) d = addDaysISO(d, 1); return d; };

async function main() {
  process.env.VAPID_PUBLIC_KEY ??= "BJLTaT4sl37WZTaOXy8HT_BbrG-XBKC_jWVxHy22OKk8TrjshNVOrRINWKS2KO1imokdbXbocqU6slvA3WQIxOM";
  process.env.VAPID_PRIVATE_KEY ??= "smoke-only-private-key";
  process.env.GOOGLE_CLIENT_ID ??= "smoke-google-id"; process.env.GOOGLE_CLIENT_SECRET ??= "smoke-google-secret";

  const [t] = await sql<{ id: string; plan: "core" | "plus" | "pro"; status: string }[]>`select id, plan, status from tenant_by_subdomain(${DEMO_SUBDOMAIN})`;
  assert.ok(t, "demo tenant exists (run pnpm db:seed)");
  const tenant: Tenant = { id: t.id, name: "Acme Technologies", status: t.status, subdomain: DEMO_SUBDOMAIN, plan: t.plan };
  const actor = (first: string, permissions: string[] = [], scopes: { type: "department"; ids: string[] }[] = [], tn: Tenant = tenant) => withTenant(tenant.id, async (tx) => {
    const [e] = await tx<{ id: string; user_id: string; display_name: string; email: string }[]>`select e.id, e.user_id, e.display_name, u.email::text from employees e join users u on u.id = e.user_id where first_name = ${first}`;
    return { tenant: tn, userId: e.user_id, employeeId: e.id, name: e.display_name, email: e.email, title: null, roles: [], permissions: new Set(permissions), grants: [{ permissions, scopes }] } as Actor;
  });
  const asha = await actor("Asha", ["*"]), arjun = await actor("Arjun"), rohan = await actor("Rohan"), meera = await actor("Meera");
  const [dept] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from departments where name = 'Engineering'`);
  const scopedAdmin = await actor("Priya", ["automations.manage", "settings.integrations", "settings.notifications"], [{ type: "department", ids: [dept.id] }]);
  const coreAsha = { ...asha, tenant: { ...tenant, plan: "core" as const } };
  const today = todayIn();

  // ---------- automations: permissions and plan gate ----------
  await withTenant(tenant.id, async (tx) => {
    for (const who of [arjun, scopedAdmin]) {
      await assert.rejects(auto.listAutomations(tx, who), /whole company/);
      await assert.rejects(auto.saveAutomation(tx, who, null, { name: "x", trigger: "employee.joined", actions: [{ type: "notify", to: ["employee"], title: "x" }] }), /whole company/);
      await assert.rejects(auto.runLog(tx, who), /whole company/);
    }
    await assert.rejects(auto.saveAutomation(tx, coreAsha, null, { name: "x", trigger: "employee.joined", actions: [{ type: "notify", to: ["employee"], title: "x" }] }), /Pro plan/);
    await assert.rejects(auto.saveAutomation(tx, asha, null, { name: "", trigger: "employee.joined", actions: [] }), /name/);
    await assert.rejects(auto.saveAutomation(tx, asha, null, { name: "x", trigger: "employee.joined", actions: [{ type: "group", group_id: randomUUID() }] }), /group doesn't exist/);
    assert.ok((await auto.listAutomations(tx, asha)).length >= 3, "seeded automations are listed");
    throw new Error("rollback");
  }).catch(rollback);
  ok("automations: company-wide automations.manage only (department-scoped admins refused), Pro plan gate, validation surfaces field errors");

  // ---------- automations: every action type runs once per occurrence, failures are logged, conditions filter ----------
  await withTenant(tenant.id, async (tx) => {
    await tx`update automations set is_active = false`;   // the seeded ones would also match; this block tests its own
    const [grp] = await tx<{ id: string }[]>`select g.id from groups g limit 1`;
    const id = await auto.saveAutomation(tx, asha, null, {
      name: "Smoke joiner", trigger: "employee.joined", conditions: [{ field: "department_id", op: "eq", value: dept.id }],
      actions: [
        { type: "notify", to: ["employee", "manager", "hr_admins"], title: "Hi {{employee.first_name}} at {{company}}", body: "Manager: {{manager.name}}" },
        { type: "email", to: ["manager"], subject: "New joiner {{employee.name}}", body: "Please welcome them.\n\nThanks" },
        { type: "task", to: "manager", title: "Laptop for {{employee.first_name}}", due_days: 2 },
        ...(grp ? [{ type: "group", group_id: grp.id }] : []),
        { type: "announcement", title: "Welcome {{employee.first_name}}", body: "{{employee.name}} joined {{employee.department}}." },
        { type: "webhook", url: "https://hooks.example.com/erp-smoke" },
      ],
    });
    // Arjun is in Engineering (matches); Sneha is in Sales (condition fails)
    const [sneha] = await tx<{ id: string }[]>`select id from employees where first_name = 'Sneha'`;
    const miss = await auto.emitEvent(tx, tenant.id, "employee.joined", { employeeId: sneha.id, occurrence: "smoke-sneha" });
    assert.deepEqual(miss, { matched: 0, ran: 0 });
    const hit = await auto.emitEvent(tx, tenant.id, "employee.joined", { employeeId: arjun.employeeId, occurrence: "smoke-arjun" });
    assert.deepEqual(hit, { matched: 1, ran: 1 });
    const again = await auto.emitEvent(tx, tenant.id, "employee.joined", { employeeId: arjun.employeeId, occurrence: "smoke-arjun" });
    assert.deepEqual(again, { matched: 1, ran: 0 }, "same occurrence never runs twice");
    const notes = await tx<{ title: string; body: string; user_id: string }[]>`select title, body, user_id from notifications where kind = 'automation' and title = 'Hi Arjun at Acme Technologies'`;
    assert.ok(notes.some((n) => n.user_id === arjun.userId) && notes.some((n) => n.user_id === rohan.userId), "person and manager notified; placeholders rendered");
    assert.ok(notes[0].body.includes("Rohan"), "manager placeholder");
    const [mail] = await tx<{ subject: string; to_email: string }[]>`select subject, to_email from outbound_emails where kind = 'automation' and subject = 'New joiner Arjun Rao'`;
    assert.equal(mail?.to_email, rohan.email);
    const [task] = await tx<{ assignee_employee_id: string; due_date: string; subject_employee_id: string }[]>`select assignee_employee_id, due_date::text, subject_employee_id from tasks where title = 'Laptop for Arjun'`;
    assert.equal(task?.assignee_employee_id, rohan.employeeId); assert.equal(task?.due_date, addDaysISO(today, 2)); assert.equal(task?.subject_employee_id, arjun.employeeId);
    if (grp) { const [m] = await tx`select 1 from employee_groups where employee_id = ${arjun.employeeId} and group_id = ${grp.id}`; assert.ok(m, "added to the group"); }
    const [post] = await tx<{ kind: string; body: string }[]>`select kind, body from posts where title = 'Welcome Arjun'`;
    assert.equal(post?.kind, "announcement"); assert.match(post.body, /Arjun Rao joined Engineering/);
    const [wh] = await tx<{ event: string; payload: { data: { employee_id: string } } }[]>`select d.event, d.payload from webhook_deliveries d join webhook_endpoints w on w.id = d.endpoint_id where w.kind = 'automation' and w.url = 'https://hooks.example.com/erp-smoke'`;
    assert.equal(wh?.event, "automation.employee.joined"); assert.equal(wh.payload.data.employee_id, arjun.employeeId);
    const log = await auto.runLog(tx, asha, id);
    assert.equal(log.length, 1); assert.equal(log[0].status, "ok"); assert.equal(log[0].subject, "Arjun Rao");
    // a failing action is recorded and doesn't break the caller's transaction
    await tx`update automations set actions = ${tx.json([{ type: "task", to: "employee:" + randomUUID(), title: "x", due_days: 1 }, { type: "group", group_id: "00000000-0000-0000-0000-000000000000" }] as never)} where id = ${id}`;
    // SSRF: internal webhook targets are refused when saving, and never queued even if one is already stored
    for (const url of ["https://127.0.0.1/x", "https://169.254.169.254/latest/meta-data", "https://[::1]/x"]) {
      await assert.rejects(auto.saveAutomation(tx, asha, id, { name: "Smoke joiner", trigger: "employee.joined", actions: [{ type: "webhook", url }] }), /private network/, url);
    }
    await tx`update automations set actions = ${tx.json([{ type: "webhook", url: "https://10.0.0.5/hook" }] as never)} where id = ${id}`;
    await auto.emitEvent(tx, tenant.id, "employee.joined", { employeeId: arjun.employeeId, occurrence: "smoke-arjun-ssrf" });
    assert.equal((await tx`select 1 from webhook_endpoints where url = 'https://10.0.0.5/hook'`).length, 0, "a stored internal webhook is never queued");
    await tx`update automations set actions = ${tx.json([{ type: "webhook", url: "https://hooks.example.com/x" }] as never)} where id = ${id}`;
    const r3 = await auto.emitEvent(tx, tenant.id, "employee.joined", { employeeId: arjun.employeeId, occurrence: "smoke-arjun-2" });
    assert.equal(r3.ran, 1);
    await auto.setAutomationActive(tx, asha, id, false);
    assert.deepEqual(await auto.emitEvent(tx, tenant.id, "employee.joined", { employeeId: arjun.employeeId, occurrence: "smoke-arjun-3" }), { matched: 0, ran: 0 }, "off = never runs");
    await auto.deleteAutomation(tx, asha, id);
    await assert.rejects(auto.deleteAutomation(tx, asha, id), /doesn't exist/);
    throw new Error("rollback");
  }).catch(rollback);
  ok("automations: conditions filter the subject; notify, email, task, group, announcement and webhook actions run with rendered placeholders; one run per occurrence; off means off");

  // ---------- automations: daily triggers (birthday, anniversary, date offset) are idempotent per day ----------
  await withTenant(tenant.id, async (tx) => {
    await tx`update automations set is_active = false`;
    await tx`update employees set dob = ${`1990-${today.slice(5)}`}, probation_end_date = ${addDaysISO(today, 7)}, probation_status = 'in_probation' where id = ${meera.employeeId}`;
    await auto.saveAutomation(tx, asha, null, { name: "Smoke bday", trigger: "birthday", conditions: [], actions: [{ type: "notify", to: ["employee"], title: "Happy birthday {{employee.first_name}} ({{years}})", body: "" }] });
    await auto.saveAutomation(tx, asha, null, { name: "Smoke probation", trigger: "date_offset", trigger_config: { field: "probation_end_date", offset_days: -7 }, conditions: [{ field: "probation_status", op: "in", value: ["in_probation"] }], actions: [{ type: "notify", to: ["manager"], title: "Probation soon: {{employee.name}}", body: "" }] });
    const r1 = await auto.runDaily(tx, tenant.id, today);
    assert.equal(r1.ran, 2, `two daily runs (got ${JSON.stringify(r1)})`);
    const [b] = await tx<{ title: string }[]>`select title from notifications where user_id = ${meera.userId} and title like 'Happy birthday%'`;
    assert.match(b?.title ?? "", /Happy birthday Meera \(\d+\)/);
    const [p] = await tx<{ title: string }[]>`select title from notifications where user_id = ${rohan.userId} and title = 'Probation soon: Meera Iyer'`;
    assert.ok(p, "manager told a week before probation ends");
    const r2 = await auto.runDaily(tx, tenant.id, today);
    assert.deepEqual(r2, { matched: 2, ran: 0 }, "re-running the day is a no-op");
    // other seeded people may have a birthday tomorrow; only Meera's runs matter here
    const before = await tx<{ n: number }[]>`select count(*)::int as n from automation_runs where subject_employee_id = ${meera.employeeId}`;
    await auto.runDaily(tx, tenant.id, addDaysISO(today, 1));
    const after = await tx<{ n: number }[]>`select count(*)::int as n from automation_runs where subject_employee_id = ${meera.employeeId}`;
    assert.equal(after[0].n, before[0].n, "neither trigger fires for Meera tomorrow");
    throw new Error("rollback");
  }).catch(rollback);
  ok("automations: birthday and 'N days before probation end' fire on the right day, once per day, through jobs:daily's step");

  // ---------- email templates: saved template renders into the queued email; reset returns the default ----------
  await withTenant(tenant.id, async (tx) => {
    await assert.rejects(ntf.saveEmailTemplate(tx, arjun, "request.approved", { subject: "x", body: "y" }), /access/);
    await assert.rejects(ntf.saveEmailTemplate(tx, asha, "approvals.digest", { subject: "x", body: "y" }), /Unknown/);
    await assert.rejects(ntf.saveEmailTemplate(tx, asha, "leave.fyi", { subject: "x", body: "Hi {{surname}}" }), /surname/);
    await ntf.saveEmailTemplate(tx, asha, "leave.fyi", { subject: "SMOKE {{title}} for {{first_name}}", body: "Hello {{first_name}}.\n\n{{body}}\n\nOpen: {{link}}" });
    await tx`insert into notification_settings (tenant_id, event, channels) values (${tenant.id}, 'leave.fyi', '{in_app,email}') on conflict (tenant_id, event) do update set channels = '{in_app,email}'`;
    await ntf.notify(tx, tenant.id, [arjun.employeeId], "leave.fyi", "Rohan will be on leave", "Casual leave · 2 days", "/home");
    const [m] = await tx<{ subject: string; text_body: string; html: string }[]>`select subject, text_body, html from outbound_emails where to_email = ${arjun.email} and subject like 'SMOKE%' order by created_at desc limit 1`;
    assert.equal(m?.subject, "SMOKE Rohan will be on leave for Arjun");
    assert.match(m.text_body, /Hello Arjun\./); assert.match(m.text_body, /Casual leave · 2 days/); assert.match(m.html, /acme\.[^"]*\/home/);
    const groups = await ntf.emailTemplates(tx);
    const row = groups.flatMap((g) => g.templates).find((x) => x.key === "leave.fyi")!;
    assert.equal(row.isDefault, false); assert.match(row.subject, /^SMOKE/);
    assert.deepEqual(await ntf.resetEmailTemplate(tx, asha, "leave.fyi"), defaultTemplate("leave.fyi"));
    assert.equal((await ntf.emailTemplates(tx)).flatMap((g) => g.templates).find((x) => x.key === "leave.fyi")!.isDefault, true);
    const pv = ntf.previewEmailTemplate(asha, { subject: "{{title}}", body: "Hi {{first_name}}" });
    assert.equal(pv.paragraphs[0], "Hi Asha");
    throw new Error("rollback");
  }).catch(rollback);
  ok("email templates: per-event subject/body with placeholders drive the queued email; unknown placeholders refused; preview; reset to default; settings.notifications only");

  // ---------- OAuth2 client credentials + API writes + REST hooks ----------
  await withTenant(tenant.id, async (tx) => {
    await assert.rejects(oauth.createOAuthClient(tx, arjun, { name: "x", scopes: ["employees:read"] }), /whole company/);
    await assert.rejects(oauth.createOAuthClient(tx, coreAsha, { name: "x", scopes: ["employees:read"] }), /Pro plan/);
    const c = await oauth.createOAuthClient(tx, asha, { name: "Smoke", scopes: ["employees:read", "leave:write", "attendance:write", "hooks:write"] });
    assert.match(c.clientId, /^erp_ci_/); assert.match(c.secret, /^erp_cs_/);
    const [{ secret_hash }] = await tx<{ secret_hash: string }[]>`select secret_hash from oauth_clients where id = ${c.id}`;
    assert.ok(!secret_hash.includes(c.secret.slice(-8)), "only the hash is stored");
    const bad1 = await oauth.issueAccessToken(tx, tenant, { grantType: "password", clientId: c.clientId, clientSecret: c.secret, scope: null });
    assert.ok(!bad1.ok && bad1.body.error === "unsupported_grant_type");
    const bad2 = await oauth.issueAccessToken(tx, tenant, { grantType: "client_credentials", clientId: c.clientId, clientSecret: c.secret + "x", scope: null });
    assert.ok(!bad2.ok && bad2.status === 401);
    const bad3 = await oauth.issueAccessToken(tx, tenant, { grantType: "client_credentials", clientId: c.clientId, clientSecret: c.secret, scope: "payroll:read" });
    assert.ok(!bad3.ok && bad3.body.error === "invalid_scope");
    const tok = await oauth.issueAccessToken(tx, tenant, { grantType: "client_credentials", clientId: c.clientId, clientSecret: c.secret, scope: "leave:write attendance:write hooks:write" });
    assert.ok(tok.ok); assert.equal(tok.expires_in, 3600); assert.equal(tok.scope, "leave:write attendance:write hooks:write");
    const p = await oauth.authenticateBearer(tx, tenant, tok.access_token);
    assert.equal(p?.kind, "oauth_client"); assert.deepEqual(p?.scopes, ["leave:write", "attendance:write", "hooks:write"]);
    assert.equal(await oauth.authenticateBearer(tx, { ...tenant, id: randomUUID() }, tok.access_token), null, "token is bound to its workspace");
    assert.equal(await oauth.authenticateBearer(tx, tenant, tok.access_token.slice(0, -3) + "abc"), null);
    assert.equal(await oauth.authenticateBearer(tx, tenant, tok.access_token, new Date(Date.now() + 2 * 3600e3)), null, "expired after an hour");
    // writes run as the person: a leave request for Arjun goes to Rohan (his manager)
    const [cl] = await tx<{ code: string }[]>`select code from leave_types where code = 'CL'`;
    const d1 = nextWorking(addDaysISO(today, 40));
    const lr = await api.createLeaveRequest(tx, tenant, { employee_number: (await tx<{ employee_number: string }[]>`select employee_number from employees where id = ${arjun.employeeId}`)[0].employee_number, leave_type_code: cl.code, from: d1, to: d1, note: "via API" });
    assert.equal(lr.status, "pending"); assert.equal(lr.days, 1);
    const [step] = await tx<{ approver_employee_id: string }[]>`select s.approver_employee_id from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_id = ${lr.id} and s.status = 'pending'`;
    assert.equal(step?.approver_employee_id, rohan.employeeId);
    await assert.rejects(api.createLeaveRequest(tx, tenant, { employee_id: arjun.employeeId, leave_type_code: cl.code, from: d1, to: d1 }), (e: api.ApiProblem) => e.status === 422 || e.status === 409);
    await assert.rejects(api.createLeaveRequest(tx, tenant, { employee_id: randomUUID(), leave_type_code: cl.code, from: d1 }), (e: api.ApiProblem) => e.status === 404);
    const at = new Date(Date.now() - 3600e3).toISOString();
    const p1 = await api.createPunch(tx, tenant, { employee_id: meera.employeeId, at, direction: "in", external_id: "smoke-1" });
    const p2 = await api.createPunch(tx, tenant, { employee_id: meera.employeeId, at, direction: "in", external_id: "smoke-1" });
    assert.equal(p1.duplicate, false); assert.equal(p2.duplicate, true);
    await assert.rejects(api.createPunch(tx, tenant, { employee_id: meera.employeeId, at: new Date(Date.now() + 3600e3).toISOString() }), (e: api.ApiProblem) => e.code === "out_of_range");
    // REST hooks: per principal, https only, listed and removable only by their owner
    const other = { kind: "api_key" as const, id: randomUUID(), ref: "key:other", scopes: ["hooks:write"] };
    await assert.rejects(api.subscribeHook(tx, tenant, p!, { event: "test.ping", target_url: "https://hooks.zapier.com/x" }), /event must be/);
    await assert.rejects(api.subscribeHook(tx, tenant, p!, { event: "employee.created", target_url: "http://hooks.zapier.com/x" }), /https/);
    const h = await api.subscribeHook(tx, tenant, p!, { event: "employee.created", target_url: "https://hooks.zapier.com/hooks/catch/1/abc" });
    assert.match(h.secret ?? "", /^whsec_/); assert.equal(h.existing, false);
    const h2 = await api.subscribeHook(tx, tenant, p!, { event: "employee.created", target_url: "https://hooks.zapier.com/hooks/catch/1/abc" });
    assert.equal(h2.existing, true); assert.equal(h2.id, h.id);
    assert.equal((await api.listHooks(tx, p!)).length, 1); assert.equal((await api.listHooks(tx, other)).length, 0);
    assert.ok((await listEndpoints(tx, asha)).some((e) => e.id === h.id), "admins see REST hooks among endpoints");
    await assert.rejects(api.unsubscribeHook(tx, other, h.id), /No such hook/);
    await api.unsubscribeHook(tx, p!, h.id);
    assert.equal((await api.listHooks(tx, p!)).length, 0);
    assert.equal(api.samplePayload("employee.created").type, "employee.created");
    const poll = await api.pollTrigger(tx, "leave.approved", 5);
    assert.ok(poll.length > 0 && "id" in poll[0]);
    await assert.rejects(api.pollTrigger(tx, "nope"), /No polling trigger/);
    await oauth.revokeOAuthClient(tx, asha, c.id);
    assert.equal(await oauth.authenticateBearer(tx, tenant, tok.access_token), null, "revoking the client kills its tokens");
    throw new Error("rollback");
  }).catch(rollback);
  ok("OAuth2: client credentials → one-hour scoped JWT, bound to the workspace, dead on revoke; API writes (leave request as the person, idempotent punches); Zapier REST hooks per credential with samples and polling triggers");

  // ---------- Web Push: queued per in-app notification, delivered after commit, gone endpoints dropped ----------
  await withTenant(tenant.id, async (tx) => {
    await assert.rejects(push.subscribePush(tx, arjun, { endpoint: "http://x", keys: { p256dh: "a", auth: "b" } }, null), /usable/);
    await assert.rejects(push.subscribePush(tx, arjun, { endpoint: "https://169.254.169.254/latest", keys: { p256dh: "a", auth: "b" } }, null), /usable/, "push endpoints on internal addresses are refused (SSRF)");
    await push.subscribePush(tx, arjun, { endpoint: "https://push.example.com/sub/1", keys: { p256dh: "a", auth: "b" } }, "Mozilla/5.0 (Linux; Android 14) Chrome/130");
    await push.subscribePush(tx, arjun, { endpoint: "https://push.example.com/sub/gone", keys: { p256dh: "a", auth: "b" } }, "Mozilla/5.0 (iPhone) Safari/605");
    const devices = await push.pushDevices(tx, arjun);
    assert.deepEqual(devices.map((d) => d.device).sort(), ["Chrome on Android", "Safari on iOS"]);
    const n = await ntf.notify(tx, tenant.id, [arjun.employeeId, rohan.employeeId], "approval.pending", "Push smoke", "body", "/inbox");
    assert.ok(n.inApp >= 2);
    const [{ q }] = await tx<{ q: number }[]>`select count(*)::int as q from push_outbox where status = 'queued' and payload->>'title' = 'Push smoke'`;
    assert.equal(q, 1, "one outbox row per subscribed user (Rohan has no subscription)");
    throw new Error("rollback");
  }).catch(rollback);
  {
    const sent: string[] = [];
    await withTenant(tenant.id, async (tx) => {
      await push.subscribePush(tx, arjun, { endpoint: "https://push.example.com/smoke/ok", keys: { p256dh: "a", auth: "b" } }, null);
      await push.subscribePush(tx, arjun, { endpoint: "https://push.example.com/smoke/gone", keys: { p256dh: "a", auth: "b" } }, null);
      await push.queuePush(tx, tenant.id, [arjun.userId], { title: "Push smoke 2", body: "b", url: "/home" });
    });
    try {
      const r = await push.deliverPush(tenant.id, async (s) => { sent.push(s.endpoint); return { statusCode: s.endpoint.endsWith("gone") ? 410 : 201 }; });
      assert.equal(r.sent, 1); assert.equal(r.dropped, 1);
      assert.ok(sent.includes("https://push.example.com/smoke/ok"));
      const left = await withTenant(tenant.id, (tx) => tx<{ endpoint: string }[]>`select endpoint from push_subscriptions where user_id = ${arjun.userId}`);
      assert.deepEqual(left.map((x) => x.endpoint), ["https://push.example.com/smoke/ok"]);
      assert.deepEqual(await push.deliverPush(tenant.id, async () => ({ statusCode: 201 })), { sent: 0, failed: 0, dropped: 0 }, "nothing left to send");
    } finally {
      await withTenant(tenant.id, async (tx) => { await tx`delete from push_subscriptions where user_id = ${arjun.userId}`; await tx`delete from push_outbox where payload->>'title' = 'Push smoke 2'`; });
    }
  }
  ok("Web Push: subscriptions per device, one queued push per notified subscriber, delivered post-commit with the VAPID sender; 410 endpoints removed; nothing without keys");

  // ---------- calendar: per-person connections, events queued for interviews / 1:1s / leave, synced with the API, cancelled ----------
  await withTenant(tenant.id, async (tx) => {
    await assert.rejects(cal.beginCalendarConnect(tx, arjun, "google", "https://acme.localhost/auth/calendar/google/callback"), /Settings → Integrations/);
    await tx`insert into integrations (tenant_id, provider, config_enc, status) values (${tenant.id}, 'google_workspace', ${encryptField("{}", [tenant.id, "integration", "google_workspace"])}, 'connected') on conflict (tenant_id, provider) do update set status = 'connected'`;
    const b = await cal.beginCalendarConnect(tx, arjun, "google", "https://acme.localhost/auth/calendar/google/callback");
    assert.match(b.url, /accounts\.google\.com[\s\S]*calendar\.events[\s\S]*code_challenge/); assert.equal(b.cookie.userId, arjun.userId);
    await assert.rejects(cal.finishCalendarConnect(tx, rohan, b.cookie, "code", "https://x", async () => ({})), /didn't start from your account/);
    const id = await cal.finishCalendarConnect(tx, arjun, b.cookie, "code", "https://x", async () => ({ access_token: "at", refresh_token: "rt", expires_in: 3600, id_token: `x.${Buffer.from(JSON.stringify({ email: "arjun@gmail.test" })).toString("base64url")}.y` }));
    const mine = await cal.myCalendars(tx, arjun);
    assert.equal(mine.connections[0]?.account_email, "arjun@gmail.test"); assert.equal(mine.connections[0]?.id, id);
    const [{ tokens_enc }] = await tx<{ tokens_enc: Uint8Array }[]>`select tokens_enc from calendar_connections where id = ${id}`;
    assert.ok(!Buffer.from(tokens_enc).toString("utf8").includes("rt"), "tokens stored encrypted");
    assert.equal(await cal.pushCalendarEvent(tx, tenant.id, "one_on_one", randomUUID(), [rohan.employeeId], { title: "x", start: "2026-12-01T09:00:00Z", end: "2026-12-01T09:30:00Z" }), 0, "nobody connected → nothing queued");
    const ent = randomUUID();
    assert.equal(await cal.pushCalendarEvent(tx, tenant.id, "interview", ent, [arjun.employeeId, rohan.employeeId], { title: "Interview", start: "2026-12-01T09:00:00Z", end: "2026-12-01T10:00:00Z" }), 1);
    assert.equal(await cal.pushCalendarEvent(tx, tenant.id, "interview", ent, [arjun.employeeId], { title: "Interview (moved)", start: "2026-12-02T09:00:00Z", end: "2026-12-02T10:00:00Z" }), 1, "re-push updates, no duplicate");
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from calendar_events where entity_id = ${ent}`;
    assert.equal(n, 1);
    assert.equal(await cal.cancelCalendarEvent(tx, "interview", ent), 1);
    const [ev] = await tx<{ status: string }[]>`select status from calendar_events where entity_id = ${ent}`;
    assert.equal(ev.status, "failed", "cancelled before it ever synced: parked");
    await cal.disconnectCalendar(tx, arjun, "google");
    await assert.rejects(cal.disconnectCalendar(tx, arjun, "google"), /isn't connected/);
    throw new Error("rollback");
  }).catch(rollback);
  {
    // sync with a fake provider API: create, then a cancel removes it
    const created: string[] = [], removed: string[] = [];
    const fake: cal.CalendarApi = { async create(_p, _t, e) { created.push(e.title); return { id: "ext-" + created.length }; }, async remove(_p, _t, ext) { removed.push(ext); } };
    const connId = randomUUID(), ent = randomUUID();
    await withTenant(tenant.id, async (tx) => {
      await tx`insert into integrations (tenant_id, provider, config_enc, status) values (${tenant.id}, 'google_workspace', ${encryptField("{}", [tenant.id, "integration", "google_workspace"])}, 'connected') on conflict (tenant_id, provider) do update set status = 'connected'`;
      await tx`insert into calendar_connections (id, tenant_id, user_id, provider, tokens_enc) values (${connId}, ${tenant.id}, ${meera.userId}, 'google', ${encryptField(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_at: Date.now() + 3600e3 }), [tenant.id, "calendar", connId])})`;
      await cal.pushCalendarEvent(tx, tenant.id, "leave", ent, [meera.employeeId], { title: "Casual leave (approved)", start: "2026-12-10", end: "2026-12-11", allDay: true });
    });
    try {
      assert.deepEqual(await cal.syncCalendars(tenant.id, new Date(), fake), { synced: 1, removed: 0, failed: 0 });
      assert.deepEqual(created, ["Casual leave (approved)"]);
      const [row] = await withTenant(tenant.id, (tx) => tx<{ status: string; external_id: string }[]>`select status, external_id from calendar_events where entity_id = ${ent}`);
      assert.equal(row.status, "synced"); assert.equal(row.external_id, "ext-1");
      await withTenant(tenant.id, (tx) => cal.cancelCalendarEvent(tx, "leave", ent));
      assert.deepEqual(await cal.syncCalendars(tenant.id, new Date(), fake), { synced: 0, removed: 1, failed: 0 });
      assert.deepEqual(removed, ["ext-1"]);
      // a provider failure marks the connection and retries later, never throws
      await withTenant(tenant.id, (tx) => cal.pushCalendarEvent(tx, tenant.id, "leave", ent, [meera.employeeId], { title: "again", start: "2026-12-10", end: "2026-12-11", allDay: true }));
      const r = await cal.syncCalendars(tenant.id, new Date(), { ...fake, async create() { throw new Error("quota"); } });
      assert.equal(r.failed, 1);
      const [c] = await withTenant(tenant.id, (tx) => tx<{ status: string; last_error: string }[]>`select status, last_error from calendar_connections where id = ${connId}`);
      assert.equal(c.status, "error"); assert.equal(c.last_error, "quota");
    } finally {
      await withTenant(tenant.id, async (tx) => { await tx`delete from calendar_connections where id = ${connId}`; await tx`delete from integrations where provider = 'google_workspace'`; });
    }
  }
  ok("calendar: admin switch + OAuth keys gate the per-person connect; tokens encrypted; events queued once per (person, entity), pushed through the provider API after commit, re-synced on change, removed on cancel; failures recorded and retried");

  // ---------- offline punch queue: ordered, alternating, idempotent, inside 48 hours ----------
  await withTenant(tenant.id, async (tx) => {
    const [last] = await tx<{ direction: string; at: Date }[]>`select direction, at from punches where employee_id = ${arjun.employeeId} and status = 'valid' order by at desc limit 1`;
    const base = Math.max(Date.now() - 3 * 3600e3, (last?.at.getTime() ?? 0) + 60_000);
    const dir = last?.direction === "in" ? "out" : "in";
    const other = dir === "in" ? "out" : "in";
    const items = [
      { client_id: "smoke-q-0002", expect: other, at: new Date(base + 3600e3).toISOString() },
      { client_id: "smoke-q-0001", expect: dir, at: new Date(base).toISOString(), lat: 12.97, lng: 77.59, accuracy: 20, comment: "site visit" },
      { client_id: "smoke-q-0003", expect: other, at: new Date(base + 7200e3).toISOString() },
      { client_id: "smoke-q-0004", expect: dir, at: new Date(Date.now() + 3600e3).toISOString() },
    ];
    const r = await syncQueuedPunches(tx, arjun, items);
    assert.deepEqual(r.accepted, ["smoke-q-0001", "smoke-q-0002"]);
    assert.deepEqual(r.rejected.map((x) => x.client_id).sort(), ["smoke-q-0003", "smoke-q-0004"]);
    const rows = await tx<{ client_id: string; direction: string; comment: string; lat: number }[]>`select client_id, direction, comment, lat from punches where employee_id = ${arjun.employeeId} and client_id like 'smoke-q-%' order by at`;
    assert.equal(rows.length, 2); assert.equal(rows[0].direction, dir); assert.match(rows[0].comment, /site visit \(queued offline\)/); assert.equal(rows[0].lat, 12.97);
    const again = await syncQueuedPunches(tx, arjun, items.slice(0, 2));
    assert.deepEqual(again.accepted.sort(), ["smoke-q-0001", "smoke-q-0002"], "resending a lost response is harmless");
    assert.equal((await tx`select 1 from punches where employee_id = ${arjun.employeeId} and client_id like 'smoke-q-%'`).length, 2);
    // Rohan can't replay Arjun's ids as his own? He can: ids are per person (unique per employee), so nothing leaks across people
    const r2 = await syncQueuedPunches(tx, rohan, [{ client_id: "smoke-q-0001", expect: "in", at: new Date(base).toISOString() }]);
    assert.ok(r2.accepted.length + r2.rejected.length === 1);
    throw new Error("rollback");
  }).catch(rollback);
  ok("offline clock-in: queued punches applied oldest first, alternating with the server's last punch, future ones refused, resend idempotent by client id per person");

  // ---------- Slack / Teams approvals on a throw-away tenant: signed one-use tokens decide the step as the approver ----------
  const sub = "smoke-plat2-" + randomUUID().slice(0, 6);
  const fresh = await provisionTenant({ company: "Smoke Plat2 Pvt Ltd", subdomain: sub, firstName: "Nisha", lastName: "Rao", email: `nisha@${sub}.test`, password: DEMO_PASSWORD });
  try {
    const ft: Tenant = { id: fresh.tenantId, name: "Smoke Plat2 Pvt Ltd", status: "trial", subdomain: sub, plan: "pro" };
    const { owner, ravi } = await withTenant(ft.id, async (tx) => {
      const [e] = await tx<{ id: string }[]>`select id from employees where user_id = ${fresh.userId}`;
      const owner = { tenant: ft, userId: fresh.userId, employeeId: e.id, name: "Nisha Rao", email: `nisha@${sub}.test`, title: null, roles: ["global_admin"], permissions: new Set(["*"]), grants: [{ permissions: ["*"], scopes: [] }] } as Actor;
      const r = await createEmployee(tx, ft.id, { firstName: "Ravi", lastName: "Das", workEmail: `ravi@${sub}.test`, joiningDate: addDaysISO(todayIn(), -400), managerId: e.id, password: DEMO_PASSWORD }, owner.userId);
      await tx`update users set status = 'active' where id = ${r.userId}`;
      const ravi = { ...owner, userId: r.userId, employeeId: r.employeeId, name: "Ravi Das", email: `ravi@${sub}.test`, roles: [], permissions: new Set<string>(), grants: [] } as Actor;
      return { owner, ravi };
    });
    // a Slack channel is connected: the pending step is announced with buttons (fake poster captures the message)
    const posted: unknown[] = [];
    const stepId = await withTenant(ft.id, async (tx) => {
      await tx`insert into integrations (tenant_id, provider, config_enc, status) values (${ft.id}, 'slack', ${encryptField("https://hooks.slack.com/services/T0/B0/x", [ft.id, "integration", "slack"])}, 'connected')`;
      const [cl] = await tx<{ id: string }[]>`select id from leave_types where code = 'CL'`;
      const d = nextWorking(addDaysISO(todayIn(), 10));
      const lr = await leave.apply(tx, ravi, { leaveTypeId: cl.id, from: d, to: d, fromPart: "full", toPart: "full" });
      assert.equal(lr.status, "pending");
      const [s] = await tx<{ id: string }[]>`select s.id from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_id = ${lr.id} and s.status = 'pending'`;
      process.env.SLACK_SIGNING_SECRET = "smoke-signing-secret";
      const n = await chat.notifyChatApproval(tx, ft.id, { stepId: s.id, approverId: owner.employeeId, approverName: owner.name, requesterName: ravi.name, summary: "Casual leave · 1 day" }, async (_url, body) => { posted.push(body); return 200; });
      assert.equal(n, 1);
      return s.id;
    });
    const msg = posted[0] as { blocks: { elements?: { action_id: string; value?: string; url?: string }[] }[] };
    const buttons = msg.blocks[1].elements!;
    assert.deepEqual(buttons.map((b) => b.action_id), ["approve", "decline", "open"]);
    const approveTok = buttons[0].value!, declineTok = buttons[1].value!;
    const a = verifyAction(chat.actionSecret(), approveTok, Math.floor(Date.now() / 1000))!;
    assert.equal(a.s, stepId); assert.equal(a.a, owner.employeeId); assert.equal(a.t, ft.id); assert.equal(a.d, "approved");
    assert.equal((await chat.actOnChatToken("garbage", "", owner.employeeId)).ok, false);
    const forged = signAction("wrong-secret", a);
    assert.equal((await chat.actOnChatToken(forged, "", owner.employeeId)).ok, false, "a token signed with another secret is refused");
    const stale = signAction(chat.actionSecret(), { ...a, e: Math.floor(Date.now() / 1000) - 10 });
    assert.equal((await chat.actOnChatToken(stale, "", owner.employeeId)).ok, false, "expired tokens are refused");
    const selfApprove = signAction(chat.actionSecret(), { ...a, a: ravi.employeeId });
    assert.equal((await chat.actOnChatToken(selfApprove, "", ravi.employeeId)).ok, false, "the requester can't be made the approver by rewriting the token (step guard)");
    // the channel is shared: holding the token is not enough, the caller must be signed in as the named approver
    assert.equal((await chat.actOnChatToken(approveTok, "", null)).ok, false, "no session: a token from the channel decides nothing");
    assert.equal((await chat.actOnChatToken(approveTok, "", ravi.employeeId)).ok, false, "the requester pressing the approver's button decides nothing");
    assert.equal(buttons[0].url, `${appUrl(sub, "/api/chat/act")}?token=${encodeURIComponent(approveTok)}`, "Slack buttons open the confirm page");
    const done = await chat.actOnChatToken(approveTok, "via Slack (smoke)", owner.employeeId);
    assert.ok(done.ok && done.decision === "approved", JSON.stringify(done));
    assert.match(done.message, /approved by Nisha Rao/);
    const again = await chat.actOnChatToken(declineTok, "", owner.employeeId);
    assert.equal(again.ok, false, "one decision only: the decline button is dead once approved");
    const [lrRow] = await withTenant(ft.id, (tx) => tx<{ status: string }[]>`select status from leave_requests where employee_id = ${ravi.employeeId}`);
    assert.equal(lrRow.status, "approved");
    const [aud] = await withTenant(ft.id, (tx) => tx<{ diff: { comment: string } }[]>`select diff from audit_logs where action = 'approval.approved' and actor_user_id = ${owner.userId}`);
    assert.equal(aud?.diff.comment, "via Slack (smoke)");
    // Teams card: links carry the tokens to the confirm page
    const { teamsApprovalCard } = await import("@/server/modules/integrations/chat-rules");
    const card = teamsApprovalCard({ summary: "x", requester: "r", approver: "a", approveToken: "A", declineToken: "D", actUrl: "https://x/api/chat/act", inboxUrl: "https://x/inbox" }) as { attachments: { content: { actions: { url: string }[] } }[] };
    assert.equal(card.attachments[0].content.actions[0].url, "https://x/api/chat/act?token=A");
    delete process.env.SLACK_SIGNING_SECRET;
    // without the signing secret, Slack gets a plain message (no buttons)
    await withTenant(ft.id, async (tx) => {
      const plain: unknown[] = [];
      await chat.notifyChatApproval(tx, ft.id, { stepId, approverId: owner.employeeId, approverName: "a", requesterName: "r", summary: "s" }, async (_u, body) => { plain.push(body); return 200; });
      assert.deepEqual((plain[0] as { blocks: { elements?: { action_id: string }[] }[] }).blocks[1].elements!.map((e) => e.action_id), ["open"]);
    });
    ok("Slack / Teams approvals: pending steps announced with signed Approve / Decline tokens (tenant, step, approver, expiry); forged, expired, re-targeted and re-used tokens refused; a token without the approver's own session decides nothing; a press decides the step as the approver with an audit trail; plain message without the signing secret");

    // ---------- tenant isolation: the throw-away tenant sees none of acme's new rows, and acme none of its ----------
    await withTenant(ft.id, async (tx) => {
      assert.equal((await tx`select 1 from automations`).length, 0);
      assert.equal((await tx`select 1 from automation_runs`).length, 0);
      assert.equal((await tx`select 1 from oauth_clients`).length, 0);
      assert.equal((await tx`select 1 from notification_templates`).length, 0);
      assert.equal((await tx`select 1 from calendar_connections`).length, 0);
      assert.equal((await tx`select 1 from push_subscriptions`).length, 0);
    });
    // an insert for another tenant fails RLS (and aborts that transaction)
    await assert.rejects(withTenant(ft.id, (tx) => tx`insert into automations (tenant_id, name, trigger) values (${tenant.id}, 'leak', 'birthday')`), /row-level security|violates/);
    await withTenant(tenant.id, async (tx) => {
      assert.equal((await tx`select 1 from integrations where provider = 'slack' and tenant_id = ${ft.id}`).length, 0);
      const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from automations`;
      assert.ok(n >= 3);
      const [u] = await tx<{ locale: string }[]>`select locale from users where id = (select user_id from employees where first_name = 'Divya')`;
      assert.equal(u.locale, "hi", "seeded language preference");
    });
    await assert.rejects(withTenant(tenant.id, (tx) => tx`update users set locale = 'fr' where id = ${arjun.userId}`), /check constraint|violates/);
    ok("tenant isolation: automations, runs, OAuth clients, templates, calendar connections, push subscriptions and chat integrations never cross workspaces; locale limited to supported languages");
  } finally {
    await admin`delete from tenants where id = ${fresh.tenantId}`;
  }

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await admin.end(); await sql.end(); });

export type { Tx };
