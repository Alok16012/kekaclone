import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { AppError, withTenant, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { sha256 } from "@/server/auth/password";
import { audit } from "@/server/modules/audit/service";
import { assertFeature, assertWorkspace, canWorkspace, hasFeature } from "@/server/modules/saas/gate";
import { decryptField, encryptField } from "@/server/modules/payroll/secret";
import { calendarOverview } from "@/server/modules/calendar/service";
import { chatApprovalStatus } from "./chat";
import { ALL_EVENTS, endpointUrlProblem, isEvent, isScope, MAX_ATTEMPTS, nextRetryMinutes, parseToken, rateLimitTick, signWebhook, TOKEN_PREFIX } from "./rules";

const b36 = (n: number) => { let s = ""; while (s.length < n) s += randomBytes(16).toString("base64").replace(/[^a-z0-9]/g, ""); return s.slice(0, n); };

// ---------------------------------------------------------------- API keys

export type ApiKeyRow = { id: string; name: string; key_prefix: string; scopes: string[]; last_used_at: string | null; revoked_at: string | null; created_at: string; created_by_name: string | null };

export async function listApiKeys(tx: Tx, actor: Actor): Promise<ApiKeyRow[]> {
  assertWorkspace(actor, "settings.integrations");
  const rows = await tx<(Omit<ApiKeyRow, "last_used_at" | "revoked_at" | "created_at"> & { last_used_at: Date | null; revoked_at: Date | null; created_at: Date })[]>`
    select k.id, k.name, k.key_prefix, k.scopes, k.last_used_at, k.revoked_at, k.created_at, e.display_name as created_by_name
    from api_keys k left join employees e on e.user_id = k.created_by order by k.created_at desc`;
  return rows.map((r) => ({ ...r, last_used_at: r.last_used_at?.toISOString() ?? null, revoked_at: r.revoked_at?.toISOString() ?? null, created_at: r.created_at.toISOString() }));
}

/** Create a key; the full token is returned once and only its hash is stored. */
export async function createApiKey(tx: Tx, actor: Actor, input: { name: string; scopes: string[] }) {
  assertWorkspace(actor, "settings.integrations");
  assertFeature(actor, "api");
  const name = input.name.trim();
  if (!name) throw new AppError("invalid", "Give the key a name, e.g. the system that will use it.", "name");
  const scopes = [...new Set(input.scopes.filter(isScope))];
  if (!scopes.length) throw new AppError("invalid", "Pick at least one scope.", "scopes");
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from api_keys where revoked_at is null`;
  if (n >= 20) throw new AppError("invalid", "You can have up to 20 active keys. Revoke one first.");
  const prefix = b36(8), token = `${TOKEN_PREFIX}${prefix}_${b36(40)}`;
  const [k] = await tx<{ id: string }[]>`insert into api_keys (tenant_id, name, key_prefix, key_hash, scopes, created_by) values (${actor.tenant.id}, ${name}, ${prefix}, ${sha256(token)}, ${scopes}, ${actor.userId}) returning id`;
  await audit(tx, actor, { entityType: "api_key", entityId: k.id, action: "create", diff: { name, scopes } });
  return { id: k.id, token };
}

export async function revokeApiKey(tx: Tx, actor: Actor, id: string) {
  assertWorkspace(actor, "settings.integrations");
  const [k] = await tx<{ id: string; name: string }[]>`update api_keys set revoked_at = now() where id = ${id} and revoked_at is null returning id, name`;
  if (!k) throw new AppError("not_found", "That key doesn't exist or is already revoked.");
  await audit(tx, actor, { entityType: "api_key", entityId: k.id, action: "revoke", diff: { name: k.name } });
}

/** Resolve a bearer token inside the tenant (the token alone never finds a key across tenants). */
export async function authenticateApiKey(tx: Tx, tenant: { plan?: string | null; status?: string | null }, raw: string | null) {
  const t = parseToken(raw);
  if (!t) return null;
  if (!hasFeature({ tenant }, "api")) return null;
  const [k] = await tx<{ id: string; scopes: string[] }[]>`select id, scopes from api_keys where key_hash = ${sha256(t.token)} and revoked_at is null`;
  if (!k) return null;
  await tx`update api_keys set last_used_at = now() where id = ${k.id} and (last_used_at is null or last_used_at < now() - interval '1 minute')`;
  return k;
}

declare global { var __erpApiRate: Map<string, { windowStart: number; count: number }> | undefined }
/** Per-key fixed-window limit kept in process memory (good enough for one node; move to Redis for many). */
export function rateLimit(keyId: string, now = Date.now()) {
  const map = (globalThis.__erpApiRate ??= new Map());
  const r = rateLimitTick(map.get(keyId), now);
  map.set(keyId, r.state);
  if (map.size > 5000) for (const [k, v] of map) if (v.windowStart < r.state.windowStart) map.delete(k);
  return r;
}

// ---------------------------------------------------------------- webhook endpoints

export type EndpointRow = { id: string; url: string; events: string[]; is_active: boolean; created_at: string; pending: number; failed: number; last_status: number | null; last_at: string | null };

export async function listEndpoints(tx: Tx, actor: Actor): Promise<EndpointRow[]> {
  assertWorkspace(actor, "settings.integrations");
  const rows = await tx<(Omit<EndpointRow, "created_at" | "last_at"> & { created_at: Date; last_at: Date | null })[]>`
    select w.id, w.url, w.events, w.is_active, w.created_at,
      (select count(*)::int from webhook_deliveries d where d.endpoint_id = w.id and d.delivered_at is null and d.attempts < ${MAX_ATTEMPTS}) as pending,
      (select count(*)::int from webhook_deliveries d where d.endpoint_id = w.id and d.delivered_at is null and d.attempts >= ${MAX_ATTEMPTS}) as failed,
      (select d.last_status from webhook_deliveries d where d.endpoint_id = w.id and d.attempts > 0 order by d.updated_at desc limit 1) as last_status,
      (select max(d.updated_at) from webhook_deliveries d where d.endpoint_id = w.id and d.attempts > 0) as last_at
    from webhook_endpoints w order by w.created_at desc`;
  return rows.map((r) => ({ ...r, created_at: r.created_at.toISOString(), last_at: r.last_at?.toISOString() ?? null }));
}

const secretScope = (tenantId: string, endpointId: string) => [tenantId, "webhook", endpointId];

/** Add an endpoint; the signing secret is shown once and stored encrypted. */
export async function createEndpoint(tx: Tx, actor: Actor, input: { url: string; events: string[] }) {
  assertWorkspace(actor, "settings.integrations");
  assertFeature(actor, "webhooks");
  const url = input.url.trim();
  const problem = endpointUrlProblem(url, (process.env.ROOT_DOMAIN ?? "").split(":")[0] || null);
  if (problem) throw new AppError("invalid", problem, "url");
  const events = [...new Set(input.events.filter(isEvent))];
  if (!events.length) throw new AppError("invalid", "Pick at least one event.", "events");
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from webhook_endpoints`;
  if (n >= 10) throw new AppError("invalid", "You can have up to 10 endpoints.");
  const id = randomUUID(), secret = `whsec_${b36(40)}`;
  await tx`insert into webhook_endpoints (id, tenant_id, url, events, secret_enc) values (${id}, ${actor.tenant.id}, ${url}, ${events}, ${encryptField(secret, secretScope(actor.tenant.id, id))})`;
  await audit(tx, actor, { entityType: "webhook_endpoint", entityId: id, action: "create", diff: { url, events } });
  return { id, secret };
}

export async function setEndpointActive(tx: Tx, actor: Actor, id: string, active: boolean) {
  assertWorkspace(actor, "settings.integrations");
  const [w] = await tx<{ id: string }[]>`update webhook_endpoints set is_active = ${active} where id = ${id} returning id`;
  if (!w) throw new AppError("not_found", "That endpoint doesn't exist.");
  await audit(tx, actor, { entityType: "webhook_endpoint", entityId: id, action: active ? "enable" : "disable" });
}

export async function deleteEndpoint(tx: Tx, actor: Actor, id: string) {
  assertWorkspace(actor, "settings.integrations");
  const [w] = await tx<{ url: string }[]>`delete from webhook_endpoints where id = ${id} returning url`;
  if (!w) throw new AppError("not_found", "That endpoint doesn't exist.");
  await audit(tx, actor, { entityType: "webhook_endpoint", entityId: id, action: "delete", diff: { url: w.url } });
}

export type DeliveryRow = { id: string; event: string; event_id: string; attempts: number; last_status: number | null; last_error: string | null; next_attempt_at: string | null; delivered_at: string | null; created_at: string; payload: unknown };

export async function listDeliveries(tx: Tx, actor: Actor, endpointId: string, limit = 50): Promise<DeliveryRow[]> {
  assertWorkspace(actor, "settings.integrations");
  const rows = await tx<(Omit<DeliveryRow, "next_attempt_at" | "delivered_at" | "created_at"> & { next_attempt_at: Date | null; delivered_at: Date | null; created_at: Date })[]>`
    select id, event, event_id, attempts, last_status, last_error, next_attempt_at, delivered_at, created_at, payload from webhook_deliveries where endpoint_id = ${endpointId} order by created_at desc limit ${limit}`;
  return rows.map((r) => ({ ...r, next_attempt_at: r.next_attempt_at?.toISOString() ?? null, delivered_at: r.delivered_at?.toISOString() ?? null, created_at: r.created_at.toISOString() }));
}

/** Queue an event for every active endpoint that subscribed to it. Call inside the mutation's transaction. */
export async function emitWebhook(tx: Tx, tenantId: string, event: string, payload: Record<string, unknown>) {
  if (!ALL_EVENTS.includes(event)) throw new Error(`unknown webhook event ${event}`);
  const endpoints = await tx<{ id: string }[]>`select id from webhook_endpoints where is_active and ${event} = any(events)`;
  if (!endpoints.length) return 0;
  const eventId = randomUUID();
  const body = { id: eventId, type: event, created_at: new Date().toISOString(), data: payload };
  for (const e of endpoints) await tx`insert into webhook_deliveries (tenant_id, endpoint_id, event, event_id, payload, next_attempt_at) values (${tenantId}, ${e.id}, ${event}, ${eventId}, ${tx.json(body as never)}, now())`;
  return endpoints.length;
}

export async function sendTestEvent(tx: Tx, actor: Actor, endpointId: string) {
  assertWorkspace(actor, "settings.integrations");
  const [w] = await tx<{ id: string }[]>`select id from webhook_endpoints where id = ${endpointId}`;
  if (!w) throw new AppError("not_found", "That endpoint doesn't exist.");
  const eventId = randomUUID();
  await tx`insert into webhook_deliveries (tenant_id, endpoint_id, event, event_id, payload, next_attempt_at) values (${actor.tenant.id}, ${w.id}, 'test.ping', ${eventId}, ${tx.json({ id: eventId, type: "test.ping", created_at: new Date().toISOString(), data: { workspace: actor.tenant.subdomain, sent_by: actor.name } })}, now())`;
}

export async function retryDelivery(tx: Tx, actor: Actor, deliveryId: string) {
  assertWorkspace(actor, "settings.integrations");
  const [d] = await tx<{ id: string }[]>`update webhook_deliveries set attempts = 0, next_attempt_at = now(), last_error = null where id = ${deliveryId} and delivered_at is null returning id`;
  if (!d) throw new AppError("not_found", "That delivery doesn't exist or was already delivered.");
}

type Poster = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number }>;
const defaultPoster: Poster = async (url, body, headers) => {
  const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(8000), redirect: "manual" });
  return { status: res.status };
};

/**
 * Deliver due webhooks for a tenant: POST with X-Erp-Signature, retry with backoff (1m, 5m, 30m, 2h, 12h), then stop.
 * Runs after a mutation commits (best effort) and from the nightly job (catches everything up).
 */
export async function deliverWebhooks(tenantId: string, post: Poster = defaultPoster, now = new Date()) {
  let sent = 0, failed = 0;
  await withTenant(tenantId, async (tx) => {
    const due = await tx<{ id: string; endpoint_id: string; url: string; secret_enc: Uint8Array; payload: unknown; attempts: number; is_active: boolean }[]>`
      select d.id, d.endpoint_id, w.url, w.secret_enc, d.payload, d.attempts, w.is_active from webhook_deliveries d join webhook_endpoints w on w.id = d.endpoint_id
      where d.delivered_at is null and d.attempts < ${MAX_ATTEMPTS} and (d.next_attempt_at is null or d.next_attempt_at <= ${now}) order by d.created_at limit 25 for update of d skip locked`;
    for (const d of due) {
      if (!d.is_active) { await tx`update webhook_deliveries set next_attempt_at = ${now} + interval '1 day' where id = ${d.id}`; continue; }
      const body = JSON.stringify(d.payload);
      const ts = Math.floor(now.getTime() / 1000);
      let status = 0, error: string | null = null;
      try {
        const secret = decryptField(d.secret_enc, secretScope(tenantId, d.endpoint_id));
        const r = await post(d.url, body, { "content-type": "application/json", "user-agent": "erp-webhooks/1", "x-erp-signature": signWebhook(secret, body, ts), "x-erp-event": (d.payload as { type: string }).type, "x-erp-delivery": d.id });
        status = r.status;
      } catch (e) { error = String((e as Error).message).slice(0, 300); }
      const attempts = d.attempts + 1;
      if (status >= 200 && status < 300) {
        sent++;
        await tx`update webhook_deliveries set attempts = ${attempts}, last_status = ${status}, last_error = null, delivered_at = ${now}, next_attempt_at = null where id = ${d.id}`;
      } else {
        failed++;
        const wait = nextRetryMinutes(attempts);
        await tx`update webhook_deliveries set attempts = ${attempts}, last_status = ${status || null}, last_error = ${error ?? (status ? `HTTP ${status}` : "no response")},
          next_attempt_at = ${wait === null ? null : new Date(now.getTime() + wait * 60_000)} where id = ${d.id}`;
      }
    }
  });
  return { sent, failed };
}

// ---------------------------------------------------------------- chat (Slack / Teams incoming webhooks) and calendar placeholders

export type ChatProvider = "slack" | "teams";
const chatScope = (tenantId: string, provider: string) => [tenantId, "integration", provider];

export async function integrationsOverview(tx: Tx, actor: Actor) {
  assertWorkspace(actor, "settings.integrations");
  const rows = await tx<{ provider: string; status: string; updated_at: Date; config_enc: Uint8Array }[]>`select provider, status, updated_at, config_enc from integrations`;
  const byProvider = Object.fromEntries(rows.map((r) => [r.provider, r]));
  const chat = (p: ChatProvider) => {
    const r = byProvider[p];
    if (!r) return { connected: false as const };
    let hint = "";
    try { const u = new URL(decryptField(r.config_enc, chatScope(actor.tenant.id, p))); hint = `${u.hostname}/…${u.pathname.slice(-6)}`; } catch { hint = "(unreadable)"; }
    return { connected: true as const, status: r.status, hint, updatedAt: r.updated_at.toISOString() };
  };
  const counts = await calendarOverview(tx);
  const calendars = {
    google: { configured: !!process.env.GOOGLE_CLIENT_ID, hint: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local", on: byProvider.google_workspace?.status === "connected", people: counts.google },
    microsoft: { configured: !!process.env.MICROSOFT_CLIENT_ID, hint: "MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET in .env.local", on: byProvider.microsoft_365?.status === "connected", people: counts.microsoft },
  };
  return { slack: chat("slack"), teams: chat("teams"), calendars, chatApprovals: chatApprovalStatus(), allowed: hasFeature(actor, "integrations"), accountingAllowed: hasFeature(actor, "accounting_export") };
}

const CHAT_HOSTS: Record<ChatProvider, RegExp> = { slack: /(^|\.)slack\.com$/i, teams: /(^|\.)(office\.com|webhook\.office\.com|logic\.azure\.com|azure\.com|microsoft\.com)$/i };

export async function saveChatIntegration(tx: Tx, actor: Actor, provider: ChatProvider, webhookUrl: string) {
  assertWorkspace(actor, "settings.integrations");
  assertFeature(actor, "integrations");
  const url = webhookUrl.trim();
  let u: URL;
  try { u = new URL(url); } catch { throw new AppError("invalid", "Paste the incoming webhook URL from Slack or Teams.", "url"); }
  if (u.protocol !== "https:" || !CHAT_HOSTS[provider].test(u.hostname)) throw new AppError("invalid", provider === "slack" ? "Slack webhook URLs look like https://hooks.slack.com/services/…" : "Teams webhook URLs come from the Incoming Webhook connector (…webhook.office.com or …logic.azure.com).", "url");
  await tx`insert into integrations (tenant_id, provider, config_enc, status) values (${actor.tenant.id}, ${provider}, ${encryptField(url, chatScope(actor.tenant.id, provider))}, 'connected')
    on conflict (tenant_id, provider) do update set config_enc = excluded.config_enc, status = 'connected'`;
  await audit(tx, actor, { entityType: "integration", action: "connect", diff: { provider, host: u.hostname } });
}

export async function removeIntegration(tx: Tx, actor: Actor, provider: string) {
  assertWorkspace(actor, "settings.integrations");
  const [r] = await tx<{ provider: string }[]>`delete from integrations where provider = ${provider} returning provider`;
  if (!r) throw new AppError("not_found", "That integration isn't connected.");
  await audit(tx, actor, { entityType: "integration", action: "disconnect", diff: { provider } });
}

/** Calendar sync switch: once on (and the OAuth keys exist) people connect their own calendar under Me → Calendar & devices. */
export async function setCalendarPlaceholder(tx: Tx, actor: Actor, provider: "google_workspace" | "microsoft_365", on: boolean) {
  assertWorkspace(actor, "settings.integrations");
  assertFeature(actor, "integrations");
  const configured = provider === "google_workspace" ? !!process.env.GOOGLE_CLIENT_ID : !!process.env.MICROSOFT_CLIENT_ID;
  if (on && !configured) throw new AppError("invalid", "Add the OAuth client keys to .env.local first.");
  if (on) await tx`insert into integrations (tenant_id, provider, config_enc, status) values (${actor.tenant.id}, ${provider}, ${encryptField(JSON.stringify({ calendar: true }), chatScope(actor.tenant.id, provider))}, 'connected') on conflict (tenant_id, provider) do update set status = 'connected'`;
  else await tx`delete from integrations where provider = ${provider}`;
  await audit(tx, actor, { entityType: "integration", action: on ? "connect" : "disconnect", diff: { provider } });
}

type ChatPoster = (url: string, body: unknown) => Promise<number>;
const chatPost: ChatPoster = async (url, body) => (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(6000) })).status;

/**
 * Post a short message to the connected Slack / Teams channel. Best effort: a failure marks the integration
 * "error" (shown in Settings) and never fails the action that triggered it.
 */
export async function notifyChat(tx: Tx, tenantId: string, text: string, post: ChatPoster = chatPost) {
  const rows = await tx<{ provider: ChatProvider; config_enc: Uint8Array }[]>`select provider, config_enc from integrations where provider in ('slack', 'teams')`;
  const results: { provider: ChatProvider; ok: boolean }[] = [];
  for (const r of rows) {
    let ok = false;
    try {
      const url = decryptField(r.config_enc, chatScope(tenantId, r.provider));
      const status = await post(url, r.provider === "slack" ? { text } : { text, "@type": "MessageCard", "@context": "https://schema.org/extensions", summary: text.slice(0, 80) });
      ok = status >= 200 && status < 300;
    } catch { ok = false; }
    await tx`update integrations set status = ${ok ? "connected" : "error"} where provider = ${r.provider}`;
    results.push({ provider: r.provider, ok });
  }
  return results;
}

export async function sendChatTest(tx: Tx, actor: Actor, provider: ChatProvider) {
  assertWorkspace(actor, "settings.integrations");
  const r = (await notifyChat(tx, actor.tenant.id, `Hello from erp (${actor.tenant.name}): notifications are connected.`)).find((x) => x.provider === provider);
  if (!r) throw new AppError("not_found", "Connect the channel first.");
  if (!r.ok) throw new AppError("invalid", "The channel didn't accept the message. Check the webhook URL.");
}

export const canSeeIntegrations = (actor: Actor) => canWorkspace(actor, "settings.integrations");
