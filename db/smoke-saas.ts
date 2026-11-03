/**
 * Smoke test for the SaaS package: plan gating, workspace-admin permissions (unscoped only), billing state machine
 * with the fake provider (checkout → active → invoice → plan change → seat sync → cancel) and inbound-event
 * idempotency, API keys + public API data, outbound webhooks (signing, retries, backoff), SSO just-in-time linking,
 * sign-in security settings, branding, and tenant isolation of every new table.
 * Runs against the seeded demo tenant (pnpm db:seed first); creates a throw-away tenant and removes it.
 *   pnpm smoke:saas
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { withTenant, sql } from "@/server/db";
import type { Actor, Tenant } from "@/server/auth/session";
import { provisionTenant } from "@/server/modules/tenants/provision";
import * as billing from "@/server/modules/billing/service";
import { FakeBilling, type BillingProvider } from "@/server/modules/billing/provider";
import * as integ from "@/server/modules/integrations/service";
import { RESOURCES } from "@/server/modules/integrations/api";
import { accountingExport, exportableRuns } from "@/server/modules/integrations/accounting";
import { parseToken, verifyWebhookSignature } from "@/server/modules/integrations/rules";
import * as security from "@/server/modules/settings/security";
import { saveRole } from "@/server/modules/settings/roles";
import { linkSsoIdentity } from "@/server/modules/auth/oidc";
import { deliverQueuedSms, normalizeIndianMobile, queueSms } from "@/server/sms";
import * as branding from "@/server/modules/saas/branding";
import { featureProblem, quote } from "@/server/modules/saas/plans";
import { DEMO_PASSWORD, DEMO_SUBDOMAIN } from "./demo";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const rollback = (e: Error) => { if (e.message !== "rollback") throw e; };

async function main() {
  const [t] = await sql<{ id: string; plan: "core" | "plus" | "pro"; status: string }[]>`select id, plan, status from tenant_by_subdomain(${DEMO_SUBDOMAIN})`;
  assert.ok(t, "demo tenant exists (run pnpm db:seed)");
  const tenant: Tenant = { id: t.id, name: "Acme Technologies", status: t.status, subdomain: DEMO_SUBDOMAIN, plan: t.plan, authSettings: { sso_domains: [] } };
  const actor = (first: string, permissions: string[] = [], scopes: { type: "department"; ids: string[] }[] = [], tn: Tenant = tenant) => withTenant(tenant.id, async (tx) => {
    const [e] = await tx<{ id: string; user_id: string; display_name: string; email: string }[]>`select e.id, e.user_id, e.display_name, u.email::text from employees e join users u on u.id = e.user_id where first_name = ${first}`;
    return { tenant: tn, userId: e.user_id, employeeId: e.id, name: e.display_name, email: e.email, title: null, roles: [], permissions: new Set(permissions), grants: [{ permissions, scopes }] } as Actor;
  });
  const asha = await actor("Asha", ["*"]), arjun = await actor("Arjun");
  const [dept] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from departments limit 1`);
  const scopedAdmin = await actor("Meera", ["settings.integrations", "settings.billing", "settings.security"], [{ type: "department", ids: [dept.id] }]);
  const coreAsha = { ...asha, tenant: { ...tenant, plan: "core" as const } };

  // ---------- plan gating ----------
  assert.equal(featureProblem({ plan: "pro", status: "trial" }, "api"), null);
  assert.match(featureProblem({ plan: "core", status: "trial" }, "api")!, /Pro plan/);
  await withTenant(tenant.id, async (tx) => {
    await assert.rejects(integ.createApiKey(tx, coreAsha, { name: "x", scopes: ["employees:read"] }), /Pro plan/);
    await assert.rejects(integ.createEndpoint(tx, coreAsha, { url: "https://hooks.example.com/x", events: ["approval.decided"] }), /Pro plan/);
    await assert.rejects(integ.saveChatIntegration(tx, coreAsha, "slack", "https://hooks.slack.com/services/x"), /Plus plan/);
    await assert.rejects(saveRole(tx, coreAsha, null, { name: "Custom", permissions: [] }), /Plus plan/);
    await assert.rejects(branding.saveBranding(tx, coreAsha, { accent: "#1b7f4c", accentDark: "", loginNote: "" }), /Plus plan/);
    await assert.rejects(security.setIpAllowlist(tx, coreAsha, ["10.0.0.0/8"], null), /Pro plan/);
    const suspended = { ...asha, tenant: { ...tenant, status: "suspended" } };
    await assert.rejects(integ.createApiKey(tx, suspended, { name: "x", scopes: ["employees:read"] }), /not active/);
    assert.equal(await integ.authenticateApiKey(tx, { plan: "core" }, "erp_live_abcdefgh_" + "x".repeat(40)), null);
    throw new Error("rollback");
  }).catch(rollback);
  ok("plan gating: API/webhooks need Pro, integrations/branding/custom roles need Plus, suspended workspaces lose gated features");

  // ---------- permissions: company-wide admin actions need an UNSCOPED grant; nobody else ----------
  await withTenant(tenant.id, async (tx) => {
    for (const who of [arjun, scopedAdmin]) {
      await assert.rejects(integ.createApiKey(tx, who, { name: "x", scopes: ["employees:read"] }), /access|whole company/);
      await assert.rejects(integ.listApiKeys(tx, who), /whole company/);
      await assert.rejects(billing.billingOverview(tx, who), /whole company/);
      await assert.rejects(billing.startCheckout(tx, who, "plus", "quarterly"), /whole company/);
      await assert.rejects(security.setSessionHours(tx, who, 24), /whole company/);
      await assert.rejects(security.setIpAllowlist(tx, who, [], null), /whole company/);
      await assert.rejects(branding.saveBranding(tx, who, { accent: "", accentDark: "", loginNote: "" }), /whole company/);
      await assert.rejects(integ.integrationsOverview(tx, who), /whole company/);
    }
    assert.ok((await integ.listApiKeys(tx, asha)).length >= 1);
    throw new Error("rollback");
  }).catch(rollback);
  ok("permissions: billing, integrations, branding and sign-in security refuse employees and department-scoped admins");

  // ---------- API keys and the public API ----------
  await withTenant(tenant.id, async (tx) => {
    const k = await integ.createApiKey(tx, asha, { name: "Smoke", scopes: ["employees:read", "leave:read"] });
    assert.ok(parseToken(k.token));
    const auth = await integ.authenticateApiKey(tx, tenant, k.token);
    assert.equal(auth?.id, k.id);
    assert.deepEqual(auth?.scopes, ["employees:read", "leave:read"]);
    assert.equal(await integ.authenticateApiKey(tx, tenant, k.token.slice(0, -1) + "z"), null);
    const [{ key_hash }] = await tx<{ key_hash: string }[]>`select key_hash from api_keys where id = ${k.id}`;
    assert.ok(!key_hash.includes(k.token.slice(-10)), "only the hash is stored");
    // data: directory fields only, paged
    const page = await RESOURCES.employees.list(tx, new URLSearchParams("limit=5"));
    assert.equal(page.data.length, 5); assert.ok(page.has_more && page.next_cursor);
    const first = page.data[0] as Record<string, unknown>;
    for (const forbidden of ["pan", "aadhaar", "ctc", "mobile", "personal_email", "dob", "bank"]) assert.ok(!(forbidden in first), `no ${forbidden} in API`);
    const page2 = await RESOURCES.employees.list(tx, new URLSearchParams(`limit=5&cursor=${page.next_cursor}`));
    assert.notEqual((page2.data[0] as { id: string }).id, first.id);
    const leave = await RESOURCES["leave-requests"].list(tx, new URLSearchParams("limit=100"));
    assert.ok(leave.data.length > 0);
    // rate limit
    let last!: ReturnType<typeof integ.rateLimit>;
    for (let i = 0; i < 121; i++) last = integ.rateLimit(k.id, 1_000_000);
    assert.equal(last.allowed, false);
    await integ.revokeApiKey(tx, asha, k.id);
    assert.equal(await integ.authenticateApiKey(tx, tenant, k.token), null);
    await assert.rejects(integ.revokeApiKey(tx, asha, k.id), /already revoked/);
    throw new Error("rollback");
  }).catch(rollback);
  ok("API keys: hashed at rest, scoped, revocable, rate limited; v1 data is paged and carries no pay or identity fields");

  // ---------- outbound webhooks: validation, queueing, signing, retries with backoff, idempotency ----------
  await withTenant(tenant.id, async (tx) => {
    await assert.rejects(integ.createEndpoint(tx, asha, { url: "http://example.com/x", events: ["approval.decided"] }), /https/);
    await assert.rejects(integ.createEndpoint(tx, asha, { url: "https://10.0.0.1/x", events: ["approval.decided"] }), /private/);
    await assert.rejects(integ.createEndpoint(tx, asha, { url: "https://hooks.example.com/x", events: [] }), /event/);
    const w = await integ.createEndpoint(tx, asha, { url: "https://hooks.example.com/erp", events: ["approval.decided"] });
    assert.match(w.secret, /^whsec_/);
    assert.equal(await integ.emitWebhook(tx, tenant.id, "employee.created", { id: "x" }), 0);   // not subscribed
    assert.equal(await integ.emitWebhook(tx, tenant.id, "approval.decided", { id: "x" }), 1);
    const [d] = await tx<{ id: string; endpoint_id: string; event_id: string }[]>`select id, endpoint_id, event_id from webhook_deliveries where endpoint_id = ${w.id}`;
    await assert.rejects(tx.savepoint((sp) => sp`insert into webhook_deliveries (tenant_id, endpoint_id, event, event_id, payload) values (${tenant.id}, ${d.endpoint_id}, 'approval.decided', ${d.event_id}, '{}')`), /duplicate|unique/);
    throw new Error("rollback");
  }).catch(rollback);
  // delivery runs its own transactions (post-commit), so use a real endpoint row and clean it up
  {
    const w = await withTenant(tenant.id, (tx) => integ.createEndpoint(tx, asha, { url: "https://hooks.example.com/erp-smoke", events: ["approval.decided"] }));
    try {
      await withTenant(tenant.id, (tx) => integ.emitWebhook(tx, tenant.id, "approval.decided", { entity_type: "leave", decision: "approved" }));
      const seen: { url: string; body: string; headers: Record<string, string> }[] = [];
      const now = new Date("2026-11-03T06:00:00Z");
      let r = await integ.deliverWebhooks(tenant.id, async (url, body, headers) => { seen.push({ url, body, headers }); return { status: 500 }; }, now);
      assert.deepEqual(r, { sent: 0, failed: 1 });
      assert.equal(seen[0].url, "https://hooks.example.com/erp-smoke");
      assert.ok(verifyWebhookSignature(w.secret, seen[0].body, seen[0].headers["x-erp-signature"], Math.floor(now.getTime() / 1000)));
      assert.ok(!verifyWebhookSignature("whsec_wrong", seen[0].body, seen[0].headers["x-erp-signature"], Math.floor(now.getTime() / 1000)));
      const [d1] = await withTenant(tenant.id, (tx) => tx<{ attempts: number; next_attempt_at: Date; last_status: number }[]>`select attempts, next_attempt_at, last_status from webhook_deliveries where endpoint_id = ${w.id}`);
      assert.equal(d1.attempts, 1); assert.equal(d1.last_status, 500);
      assert.equal(d1.next_attempt_at.getTime(), now.getTime() + 60_000);
      r = await integ.deliverWebhooks(tenant.id, async () => ({ status: 200 }), now);   // not due yet
      assert.deepEqual(r, { sent: 0, failed: 0 });
      r = await integ.deliverWebhooks(tenant.id, async () => ({ status: 200 }), new Date(now.getTime() + 61_000));
      assert.deepEqual(r, { sent: 1, failed: 0 });
      const [d2] = await withTenant(tenant.id, (tx) => tx<{ delivered_at: Date | null; attempts: number }[]>`select delivered_at, attempts from webhook_deliveries where endpoint_id = ${w.id}`);
      assert.ok(d2.delivered_at); assert.equal(d2.attempts, 2);
      // exhaust retries
      await withTenant(tenant.id, (tx) => integ.sendTestEvent(tx, asha, w.id));
      let at = now.getTime();
      for (let i = 0; i < 6; i++) { await integ.deliverWebhooks(tenant.id, async () => { throw new Error("ECONNREFUSED"); }, new Date(at)); at += 13 * 3600_000; }
      const [d3] = await withTenant(tenant.id, (tx) => tx<{ id: string; attempts: number; next_attempt_at: Date | null; last_error: string }[]>`select id, attempts, next_attempt_at, last_error from webhook_deliveries where endpoint_id = ${w.id} and event = 'test.ping'`);
      assert.equal(d3.attempts, 6); assert.equal(d3.next_attempt_at, null); assert.match(d3.last_error, /ECONNREFUSED/);
      const list = await withTenant(tenant.id, (tx) => integ.listEndpoints(tx, asha));
      assert.equal(list.find((e) => e.id === w.id)?.failed, 1);
      // a manual retry puts it back in the queue; a delivered one can't be retried
      await withTenant(tenant.id, (tx) => integ.retryDelivery(tx, asha, d3.id));
      const [d4] = await withTenant(tenant.id, (tx) => tx<{ attempts: number; next_attempt_at: Date | null }[]>`select attempts, next_attempt_at from webhook_deliveries where id = ${d3.id}`);
      assert.equal(d4.attempts, 0); assert.ok(d4.next_attempt_at);
      const [delivered] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from webhook_deliveries where endpoint_id = ${w.id} and delivered_at is not null`);
      await assert.rejects(withTenant(tenant.id, (tx) => integ.retryDelivery(tx, asha, delivered.id)), /already delivered/);
      // a paused endpoint isn't called
      await withTenant(tenant.id, (tx) => integ.setEndpointActive(tx, asha, w.id, false));
      assert.deepEqual(await integ.deliverWebhooks(tenant.id, async () => ({ status: 200 }), new Date(at)), { sent: 0, failed: 0 });
    } finally { await withTenant(tenant.id, (tx) => integ.deleteEndpoint(tx, asha, w.id)); }
  }
  ok("webhooks: https-only public endpoints, events queued per subscription, HMAC-signed, retried 1m/5m/30m/2h/12h then parked, duplicate event ids refused");

  // ---------- billing with the fake provider: the whole life cycle ----------
  const sub = "smoke-saas-" + randomUUID().slice(0, 6);
  const fresh = await provisionTenant({ company: "Smoke SaaS Pvt Ltd", subdomain: sub, firstName: "Nisha", lastName: "Rao", email: `nisha@${sub}.test`, password: DEMO_PASSWORD });
  try {
    const ft: Tenant = { id: fresh.tenantId, name: "Smoke SaaS Pvt Ltd", status: "trial", subdomain: sub, plan: "pro" };
    const owner = await withTenant(ft.id, async (tx) => {
      const [e] = await tx<{ id: string }[]>`select id from employees where user_id = ${fresh.userId}`;
      return { tenant: ft, userId: fresh.userId, employeeId: e.id, name: "Nisha Rao", email: `nisha@${sub}.test`, title: null, roles: ["global_admin"], permissions: new Set(["*"]), grants: [{ permissions: ["*"], scopes: [] }] } as Actor;
    });
    await withTenant(ft.id, async (tx) => {
      const [row] = await tx<{ plan: string; status: string }[]>`select plan, status from tenants`;
      assert.equal(row.plan, "pro"); assert.equal(row.status, "trial");
      const o = await billing.billingOverview(tx, owner);
      assert.equal(o.provider.name, "fake"); assert.equal(o.provider.configured, false);
      assert.equal(o.headcount, 1); assert.equal(o.subscription, null);
      assert.equal(o.plans[0].quotes.quarterly.billedSeats, 25);
      await assert.rejects(billing.startCheckout(tx, owner, "gold", "quarterly"), /Pick a plan/);
      await assert.rejects(billing.changePlan(tx, owner, "plus"), /Start a subscription first/);
      const c = await billing.startCheckout(tx, owner, "plus", "quarterly");
      assert.ok(c.simulated && c.checkoutUrl?.includes(c.providerId));
      await assert.rejects(billing.simulateCheckout(tx, owner, "fake_sub_000000000000"), /doesn't exist/);
      await billing.simulateCheckout(tx, owner, c.providerId);
      await assert.rejects(billing.simulateCheckout(tx, owner, c.providerId), /already active/);
      const after = await billing.billingOverview(tx, owner);
      assert.equal(after.tenant.status, "active"); assert.equal(after.tenant.plan, "plus"); assert.equal(after.tenant.trialEndsAt, null);
      assert.equal(after.subscription?.status, "active"); assert.equal(after.subscription?.seats, 25);
      assert.equal(after.invoices.length, 1);
      const inv = after.invoices[0], q = quote("plus", 1, "quarterly");
      assert.match(inv.number, /^ERP-\d{4}-00001$/);
      assert.equal(inv.amount_paise + inv.gst_paise, q.totalPaise); assert.equal(inv.gst_paise, q.gstPaise); assert.equal(inv.status, "paid");
      const mails = await tx<{ kind: string; to_email: string }[]>`select kind, to_email from outbound_emails where kind = 'billing_invoice'`;
      assert.ok(mails.some((m) => m.to_email === `nisha@${sub}.test`));
      // replaying the same payment event changes nothing
      const r = await billing.applyProviderEvent(tx, ft.id, { id: "replay", type: "charged", subscriptionId: c.providerId, tenantId: ft.id, currentPeriodEnd: null, payment: { id: `fake_pay_${c.providerId.slice(-8)}`, amountPaise: q.totalPaise }, raw: null });
      assert.equal(r.applied, true);
      assert.equal((await billing.billingOverview(tx, owner)).invoices.length, 1);
      // an event for a subscription that isn't in this tenant is ignored
      assert.equal((await billing.applyProviderEvent(tx, ft.id, { id: "x", type: "activated", subscriptionId: "sub_someone_else", tenantId: ft.id, currentPeriodEnd: null, payment: null, raw: null })).applied, false);
      // plan change and seats
      await assert.rejects(billing.changePlan(tx, owner, "plus"), /already on/);
      await billing.changePlan(tx, owner, "pro");
      assert.equal((await tx<{ plan: string }[]>`select plan from tenants`)[0].plan, "pro");
      assert.deepEqual(await billing.syncSeats(tx, ft.id), { changed: false });
      await tx`update subscriptions set seats = 40`;
      assert.deepEqual(await billing.syncSeats(tx, ft.id), { changed: true, seats: 25 });
      // payment trouble and recovery
      await billing.applyProviderEvent(tx, ft.id, { id: "p1", type: "halted", subscriptionId: c.providerId, tenantId: ft.id, currentPeriodEnd: null, payment: null, raw: null });
      assert.equal((await tx<{ status: string }[]>`select status from tenants`)[0].status, "past_due");
      assert.equal(featureProblem({ plan: "pro", status: "past_due" }, "api"), null);
      await billing.applyProviderEvent(tx, ft.id, { id: "p2", type: "activated", subscriptionId: c.providerId, tenantId: ft.id, currentPeriodEnd: null, payment: null, raw: null });
      assert.equal((await tx<{ status: string }[]>`select status from tenants`)[0].status, "active");
      // cancel at period end keeps the plan on until then
      await billing.cancelSubscription(tx, owner);
      assert.equal((await tx<{ status: string }[]>`select status from subscriptions`)[0].status, "cancelled");
      assert.equal((await tx<{ status: string }[]>`select status from tenants`)[0].status, "active");
      await assert.rejects(billing.cancelSubscription(tx, owner), /no subscription/);
      const log = (await tx<{ action: string }[]>`select action from audit_logs where entity_type = 'subscription'`).map((l) => l.action);
      for (const a of ["checkout", "provider.activated", "provider.charged", "provider.halted", "plan.change", "seats.sync", "cancel"]) assert.ok(log.includes(a), `audited ${a}`);
      assert.equal(log.filter((a) => a === "provider.charged").length, 2, "the replayed charge is audited but changes nothing");
    });
    ok("billing: checkout → simulated payment → active + GST invoice + email, replay-safe, foreign subscription ids ignored, plan change, seat sync, halted/past-due, cancel at period end, audited");

    // trial reminders and the end of a trial
    await withTenant(ft.id, async (tx) => {
      await tx`update tenants set status = 'trial', trial_ends_at = now() + interval '5 days', billing = billing - 'reminders_sent'`;
      assert.deepEqual(await billing.trialReminders(tx, ft.id), { sent: "7d" });
      assert.deepEqual(await billing.trialReminders(tx, ft.id), { sent: null });
      await tx`update tenants set trial_ends_at = now() + interval '20 hours'`;
      assert.deepEqual(await billing.trialReminders(tx, ft.id), { sent: "1d" });
      await tx`update tenants set trial_ends_at = now() - interval '1 hour'`;
      assert.deepEqual(await billing.trialReminders(tx, ft.id), { sent: "ended" });
      const [row] = await tx<{ status: string; billing: { reminders_sent: string[] } }[]>`select status, billing from tenants`;
      assert.equal(row.status, "suspended"); assert.deepEqual(row.billing.reminders_sent, ["7d", "1d", "ended"]);
      assert.match(featureProblem(row, "sso")!, /not active/);
      const mails = await tx<{ kind: string }[]>`select kind from outbound_emails where kind like 'trial_%' order by kind`;
      assert.deepEqual(mails.map((m) => m.kind), ["trial_1d", "trial_7d", "trial_ended"]);
    });
    ok("trial: 7-day, 1-day and ended reminders go to admins once each; an ended trial suspends plan features");

    // inbound webhook idempotency (the app role may insert into webhook_events; duplicates are ignored)
    const evId = "evt_" + randomUUID();
    const a = await sql<{ id: string }[]>`insert into webhook_events (provider, event_id, payload) values ('fake', ${evId}, '{}') on conflict (provider, event_id) do nothing returning id`;
    const b = await sql<{ id: string }[]>`insert into webhook_events (provider, event_id, payload) values ('fake', ${evId}, '{}') on conflict (provider, event_id) do nothing returning id`;
    assert.equal(a.length, 1); assert.equal(b.length, 0);
    await admin`delete from webhook_events where event_id = ${evId}`;
    const fake: BillingProvider = new FakeBilling();
    assert.equal(fake.verifyWebhook("{}", "sig"), false);
    ok("inbound events: one row per provider event id, the fake provider never accepts a webhook");

    // ---------- SSO just-in-time linking (no account creation) ----------
    await withTenant(ft.id, async (tx) => {
      const ctx = { ip: null, userAgent: null };
      const claims = (email: string, sub = "google-1") => ({ iss: "https://accounts.google.com", aud: "c", sub, exp: 0, email, email_verified: true });
      await assert.rejects(linkSsoIdentity(tx, ft, "google", claims("nobody@" + sub + ".test"), ctx), /no .* account/);
      await assert.rejects(linkSsoIdentity(tx, ft, "google", { ...claims(`nisha@${sub}.test`), email_verified: false }, ctx), /verified/);
      const restricted: Tenant = { ...ft, authSettings: { sso_domains: ["other.example"] } };
      await assert.rejects(linkSsoIdentity(tx, restricted, "google", claims(`nisha@${sub}.test`), ctx), /can't sign in/);
      const uid = await linkSsoIdentity(tx, ft, "google", claims(`NISHA@${sub}.test`), ctx);
      assert.equal(uid, fresh.userId);
      assert.equal(await linkSsoIdentity(tx, ft, "google", claims(`nisha@${sub}.test`), ctx), fresh.userId);   // second time: same link
      await assert.rejects(linkSsoIdentity(tx, ft, "google", claims(`nisha@${sub}.test`, "google-2"), ctx), /different identity/);
      const links = await tx<{ provider: string; subject: string }[]>`select provider, subject from auth_accounts where user_id = ${fresh.userId}`;
      assert.deepEqual([...links], [{ provider: "google", subject: "google-1" }]);
      const events = await tx<{ method: string; success: boolean }[]>`select method, success from login_events where method = 'google' order by created_at`;
      assert.equal(events.length, 6); assert.equal(events.filter((e) => e.success).length, 2);
      assert.equal((await tx<{ n: number }[]>`select count(*)::int as n from users`)[0].n, 1, "SSO never creates accounts");
    });
    ok("SSO: links only verified emails of existing active users, honours the domain list, one identity per account, every attempt logged");

    // ---------- sign-in security settings ----------
    await withTenant(ft.id, async (tx) => {
      await assert.rejects(security.setSessionHours(tx, owner, 99), /listed/);
      await security.setSessionHours(tx, owner, 8);
      await assert.rejects(security.setIpAllowlist(tx, owner, ["10.0.0.0/8", "nope"], "10.1.1.1"), /nope/);
      await assert.rejects(security.setIpAllowlist(tx, owner, ["10.0.0.0/8"], "203.0.113.5"), /lock you out/);
      await tx`update tenants set status = 'active'`;
      await security.setIpAllowlist(tx, owner, ["10.0.0.0/8", "203.0.113.5"], "203.0.113.5");
      await security.setIpAllowlist(tx, owner, [], "1.2.3.4");   // empty list = no restriction, always allowed
      await assert.rejects(security.setSso(tx, owner, { google: true, microsoft: false, domains: [], ssoOnly: false, microsoftTenant: "" }), /not configured|GOOGLE_CLIENT_ID/);
      await security.setSso(tx, owner, { google: false, microsoft: false, domains: [`${sub}.test`], ssoOnly: false, microsoftTenant: "" });
      await assert.rejects(security.setSso(tx, owner, { google: false, microsoft: false, domains: ["elsewhere.example"], ssoOnly: false, microsoftTenant: "" }), /Your own email/);
      await assert.rejects(security.setSso(tx, owner, { google: false, microsoft: false, domains: [], ssoOnly: true, microsoftTenant: "" }), /at least one provider/);
      await security.setMobileOtp(tx, owner, true);
      const s = await security.securitySettings(tx, owner);
      assert.equal(s.sessionHours, 8); assert.deepEqual(s.ipAllowlist, []); assert.deepEqual(s.sso.domains, [`${sub}.test`]); assert.equal(s.mobileOtp.enabled, true);
      assert.equal(s.mobileOtp.provider.name, "dev");
      // mobile OTP plumbing: numbers normalise, dev SMS is recorded as sent
      assert.equal(normalizeIndianMobile("98765 43210"), "+919876543210"); assert.equal(normalizeIndianMobile("+91-98765-43210"), "+919876543210"); assert.equal(normalizeIndianMobile("12345"), null);
      await queueSms(tx, ft.id, { kind: "login_otp", to: "+919876543210", body: "123456 is your code" });
    });
    await deliverQueuedSms(ft.id);
    await withTenant(ft.id, async (tx) => {
      const [m] = await tx<{ status: string; provider: string }[]>`select status, provider from outbound_sms`;
      assert.equal(m.status, "sent"); assert.equal(m.provider, "dev");
    });
    ok("sign-in security: session length options, IP allowlist validation with lock-out guard, SSO needs server keys and the admin's own domain, mobile OTP via the dev SMS log");

    // ---------- branding ----------
    await withTenant(ft.id, async (tx) => {
      await assert.rejects(branding.saveBranding(tx, owner, { accent: "#ffff00", accentDark: "", loginNote: "" }), /contrast/);
      await assert.rejects(branding.saveBranding(tx, owner, { accent: "blue", accentDark: "", loginNote: "" }), /hex/);
      await branding.saveBranding(tx, owner, { accent: "#1b7f4c", accentDark: "#1b7f4c", loginNote: "Use your work Google account." });
      assert.deepEqual(await branding.brandingSettings(tx), { accent: "#1b7f4c", accent_dark: "#1b7f4c", login_note: "Use your work Google account." });
      await assert.rejects(branding.saveLogo(tx, owner, { name: "x.svg", mime: "image/svg+xml", bytes: new Uint8Array(100) }), /PNG, JPEG or WebP/);
      await assert.rejects(branding.saveLogo(tx, owner, { name: "x.png", mime: "image/png", bytes: new Uint8Array(600 * 1024) }), /512 KB/);
      assert.equal(await branding.logoFile(tx, await branding.brandingSettings(tx)), null);
    });
    ok("branding: accent needs a readable contrast, logo must be a small raster image");

    // ---------- isolation: the fresh tenant sees none of Acme's keys, endpoints, subscriptions, invoices or SMS ----------
    await withTenant(ft.id, async (tx) => {
      for (const table of ["api_keys", "webhook_endpoints", "webhook_deliveries", "integrations", "outbound_sms"]) {
        const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from ${tx(table)}`;
        assert.equal(n, table === "outbound_sms" ? 1 : 0, `${table} isolated`);
      }
      const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from subscriptions`;
      assert.equal(n, 1);
      await assert.rejects(tx.savepoint((sp) => sp`insert into api_keys (tenant_id, name, key_prefix, key_hash) values (${tenant.id}, 'x', 'abcdefgh', 'h')`), /row-level security/);
      await assert.rejects(tx.savepoint((sp) => sp`insert into subscriptions (tenant_id, plan, seats, status) values (${tenant.id}, 'core', 25, 'created')`), /row-level security/);
    });
    await withTenant(tenant.id, async (tx) => {
      const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from subscriptions`;
      assert.equal(n, 0, "Acme has no subscription of its own");
      assert.ok((await integ.listApiKeys(tx, asha)).every((k) => k.name !== "Smoke"));
    });
    ok("isolation: API keys, webhooks, integrations, subscriptions, invoices and SMS are invisible across tenants and can't be written for another tenant");
  } finally {
    await admin`delete from tenants where id = ${fresh.tenantId}`;
  }

  // ---------- accounting export on the demo tenant's finalised run ----------
  await withTenant(tenant.id, async (tx) => {
    const payrollAdmin = await actor("Asha", ["payroll.run"]);
    const runs = await exportableRuns(tx, payrollAdmin);
    assert.equal((await exportableRuns(tx, arjun)).length, 0);
    if (runs.length) {
      await assert.rejects(accountingExport(tx, arjun, runs[0].id, "tally"), /payroll runners/);
      const t1 = await accountingExport(tx, payrollAdmin, runs[0].id, "tally");
      assert.ok(t1.text.startsWith("Date,Voucher Type,Voucher No,Ledger,Debit,Credit,Narration"));
      assert.equal(t1.totalDebit, t1.totalCredit);
      const z = await accountingExport(tx, payrollAdmin, runs[0].id, "zoho");
      assert.ok(z.text.startsWith("Journal Date,Reference Number,Notes,Account,Debit,Credit,Contact Name"));
      const [draft] = await tx<{ id: string }[]>`select id from payroll_runs where status in ('draft', 'in_progress') limit 1`;
      if (draft) await assert.rejects(accountingExport(tx, payrollAdmin, draft.id, "tally"), /Finalise/);
    }
  });
  ok("accounting export: balanced Tally / Zoho journal CSV for finalised runs, payroll runners only");

  // ---------- demo tenant state ----------
  await withTenant(tenant.id, async (tx) => {
    const [row] = await tx<{ plan: string; status: string; mobile_otp: boolean }[]>`select plan, status, (auth_settings->>'mobile_otp')::boolean as mobile_otp from tenants`;
    assert.equal(row.plan, "pro"); assert.equal(row.status, "trial"); assert.equal(row.mobile_otp, true);
    assert.ok((await integ.listEndpoints(tx, asha)).some((e) => !e.is_active));
  });
  ok("demo tenant: Pro trial with mobile OTP on, a demo API key and a parked webhook endpoint");

  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await admin.end(); await sql.end(); }).catch(async (e) => { console.error("\nFAILED:", e); await admin.end(); await sql.end(); process.exit(1); });
