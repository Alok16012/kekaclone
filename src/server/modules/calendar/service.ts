import "server-only";
import { AppError, withTenant, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { audit } from "@/server/modules/audit/service";
import { decryptField, encryptField } from "@/server/modules/payroll/secret";
import { pkce, randomState } from "@/server/modules/auth/oidc-rules";

/*
 * Google Workspace / Outlook (Microsoft 365) calendars, connected per person with OAuth (authorization code + PKCE,
 * offline access). Interviews, 1:1s and approved leave become events in the connected calendars of the people
 * involved. Events are queued in the mutation's transaction (calendar_events) and pushed after commit and from
 * jobs:daily, with the ICS download as the fallback. Nothing is enabled until the OAuth keys are in .env.local.
 */

export type CalendarProvider = "google" | "microsoft";
export const isCalendarProvider = (v: unknown): v is CalendarProvider => v === "google" || v === "microsoft";
export const PROVIDER_LABEL: Record<CalendarProvider, string> = { google: "Google Calendar", microsoft: "Outlook calendar" };

type Env = { clientId: string; clientSecret: string };
function env(p: CalendarProvider): Env | null {
  const k = p === "google" ? "GOOGLE" : "MICROSOFT";
  const clientId = process.env[`${k}_CLIENT_ID`]?.trim(), clientSecret = process.env[`${k}_CLIENT_SECRET`]?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function calendarProviders() {
  return {
    google: { configured: !!env("google"), hint: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local (redirect URI …/auth/calendar/google/callback)" },
    microsoft: { configured: !!env("microsoft"), hint: "MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET in .env.local (redirect URI …/auth/calendar/microsoft/callback)" },
  };
}

const ENDPOINTS = {
  google: { auth: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token", scope: "openid email https://www.googleapis.com/auth/calendar.events", events: "https://www.googleapis.com/calendar/v3/calendars/primary/events" },
  microsoft: { auth: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", token: "https://login.microsoftonline.com/common/oauth2/v2.0/token", scope: "openid email offline_access Calendars.ReadWrite", events: "https://graph.microsoft.com/v1.0/me/events" },
} as const;

export const CALENDAR_COOKIE = "erp_cal";
export type CalendarCookie = { provider: CalendarProvider; state: string; verifier: string; userId: string };

/** Step 1: the provider's consent URL (the workspace's own toggle must be on and the keys present). */
export async function beginCalendarConnect(tx: Tx, actor: Actor, provider: CalendarProvider, redirectUri: string) {
  const e = env(provider);
  if (!e) throw new AppError("invalid", `${PROVIDER_LABEL[provider]} isn't set up on this server yet.`);
  const [on] = await tx`select 1 from integrations where provider = ${provider === "google" ? "google_workspace" : "microsoft_365"} and status = 'connected'`;
  if (!on) throw new AppError("forbidden", `An admin needs to turn on ${PROVIDER_LABEL[provider]} sync under Settings → Integrations first.`);
  const { verifier, challenge } = pkce();
  const state = randomState();
  const u = new URL(ENDPOINTS[provider].auth);
  u.searchParams.set("client_id", e.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", ENDPOINTS[provider].scope);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (provider === "google") { u.searchParams.set("access_type", "offline"); u.searchParams.set("prompt", "consent"); }
  else u.searchParams.set("response_mode", "query");
  const cookie: CalendarCookie = { provider, state, verifier, userId: actor.userId };
  return { url: u.toString(), cookie };
}

type Tokens = { access_token: string; refresh_token: string | null; expires_at: number; email?: string | null };
const tokenScope = (tenantId: string, connectionId: string) => [tenantId, "calendar", connectionId];

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string; error?: string; error_description?: string };

async function exchange(provider: CalendarProvider, body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(ENDPOINTS[provider].token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, cache: "no-store" });
  return (await res.json().catch(() => ({}))) as TokenResponse;
}

const emailFromIdToken = (idToken?: string) => {
  try { const c = JSON.parse(Buffer.from(idToken!.split(".")[1], "base64url").toString("utf8")) as { email?: string; preferred_username?: string }; return c.email ?? c.preferred_username ?? null; } catch { return null; }
};

/** Step 2: exchange the code, store the tokens encrypted against this connection. */
export async function finishCalendarConnect(tx: Tx, actor: Actor, c: CalendarCookie, code: string, redirectUri: string, exch = exchange) {
  const e = env(c.provider);
  if (!e || c.userId !== actor.userId) throw new AppError("invalid", "This calendar connection didn't start from your account. Try again.");
  const r = await exch(c.provider, new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: e.clientId, client_secret: e.clientSecret, code_verifier: c.verifier }));
  if (!r.access_token) throw new AppError("invalid", `The provider refused the connection${r.error_description ? `: ${r.error_description}` : ""}.`);
  const tokens: Tokens = { access_token: r.access_token, refresh_token: r.refresh_token ?? null, expires_at: Date.now() + (r.expires_in ?? 3600) * 1000, email: emailFromIdToken(r.id_token) };
  const [existing] = await tx<{ id: string }[]>`select id from calendar_connections where user_id = ${actor.userId} and provider = ${c.provider}`;
  const id = existing?.id ?? crypto.randomUUID();
  await tx`insert into calendar_connections (id, tenant_id, user_id, provider, account_email, tokens_enc, status) values (${id}, ${actor.tenant.id}, ${actor.userId}, ${c.provider}, ${tokens.email ?? null}, ${encryptField(JSON.stringify(tokens), tokenScope(actor.tenant.id, id))}, 'connected')
           on conflict (user_id, provider) do update set tokens_enc = excluded.tokens_enc, account_email = excluded.account_email, status = 'connected', last_error = null`;
  await audit(tx, actor, { entityType: "calendar_connection", entityId: id, action: "connect", diff: { provider: c.provider } });
  return id;
}

export async function myCalendars(tx: Tx, actor: Actor) {
  const rows = await tx<{ id: string; provider: CalendarProvider; account_email: string | null; status: string; last_error: string | null; updated_at: Date }[]>`select id, provider, account_email, status, last_error, updated_at from calendar_connections where user_id = ${actor.userId}`;
  const [{ pending }] = await tx<{ pending: number }[]>`select count(*)::int as pending from calendar_events ev join calendar_connections c on c.id = ev.connection_id where c.user_id = ${actor.userId} and ev.status = 'pending'`;
  const on = await tx<{ provider: string }[]>`select provider from integrations where provider in ('google_workspace','microsoft_365') and status = 'connected'`;
  const providers = calendarProviders();
  return {
    connections: rows.map((r) => ({ ...r, updated_at: r.updated_at.toISOString(), label: PROVIDER_LABEL[r.provider] })),
    pending,
    google: { ...providers.google, enabled: on.some((x) => x.provider === "google_workspace") },
    microsoft: { ...providers.microsoft, enabled: on.some((x) => x.provider === "microsoft_365") },
  };
}

export async function disconnectCalendar(tx: Tx, actor: Actor, provider: CalendarProvider) {
  const [r] = await tx<{ id: string }[]>`delete from calendar_connections where user_id = ${actor.userId} and provider = ${provider} returning id`;
  if (!r) throw new AppError("not_found", "That calendar isn't connected.");
  await audit(tx, actor, { entityType: "calendar_connection", entityId: r.id, action: "disconnect", diff: { provider } });
}

export type EventKind = "interview" | "one_on_one" | "leave";
export type EventPayload = { title: string; start: string; end: string; allDay?: boolean; description?: string; location?: string | null };

/**
 * Queue an event for everyone listed who has a connected calendar. Idempotent per (connection, kind, entity):
 * calling again updates the payload and re-syncs. Inside the mutation's transaction.
 */
export async function pushCalendarEvent(tx: Tx, tenantId: string, kind: EventKind, entityId: string, employeeIds: string[], payload: EventPayload) {
  if (!employeeIds.length) return 0;
  const conns = await tx<{ id: string }[]>`select c.id from calendar_connections c join employees e on e.user_id = c.user_id where e.id = any(${employeeIds}::uuid[]) and c.status <> 'disconnected'`;
  for (const c of conns) {
    await tx`insert into calendar_events (tenant_id, connection_id, kind, entity_id, payload, status) values (${tenantId}, ${c.id}, ${kind}, ${entityId}, ${tx.json(payload)}, 'pending')
             on conflict (connection_id, kind, entity_id) do update set payload = excluded.payload, status = 'pending', attempts = 0, last_error = null`;
  }
  return conns.length;
}

/** Remove the event from every calendar it reached (or stop it from being created). */
export async function cancelCalendarEvent(tx: Tx, kind: EventKind, entityId: string) {
  const r = await tx`update calendar_events set status = case when external_id is null then 'failed' else 'cancelled' end, attempts = 0, last_error = case when external_id is null then 'cancelled before sync' else null end where kind = ${kind} and entity_id = ${entityId} and status in ('pending','synced')`;
  return r.count;
}

export type CalendarApi = {
  create(provider: CalendarProvider, accessToken: string, p: EventPayload): Promise<{ id: string }>;
  remove(provider: CalendarProvider, accessToken: string, externalId: string): Promise<void>;
};

const toGoogle = (p: EventPayload) => ({
  summary: p.title, description: p.description ?? "", location: p.location ?? undefined,
  start: p.allDay ? { date: p.start.slice(0, 10) } : { dateTime: p.start },
  end: p.allDay ? { date: p.end.slice(0, 10) } : { dateTime: p.end },
});
const toMicrosoft = (p: EventPayload) => ({
  subject: p.title, body: { contentType: "text", content: p.description ?? "" }, location: p.location ? { displayName: p.location } : undefined, isAllDay: !!p.allDay,
  start: { dateTime: p.allDay ? `${p.start.slice(0, 10)}T00:00:00` : p.start, timeZone: p.allDay ? "Asia/Kolkata" : "UTC" },
  end: { dateTime: p.allDay ? `${p.end.slice(0, 10)}T00:00:00` : p.end, timeZone: p.allDay ? "Asia/Kolkata" : "UTC" },
});

const httpApi: CalendarApi = {
  async create(provider, token, p) {
    const res = await fetch(ENDPOINTS[provider].events, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(provider === "google" ? toGoogle(p) : toMicrosoft(p)), signal: AbortSignal.timeout(8000) });
    const j = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
    if (!res.ok || !j.id) throw new Error(j.error?.message ?? `HTTP ${res.status}`);
    return { id: j.id };
  },
  async remove(provider, token, externalId) {
    const res = await fetch(`${ENDPOINTS[provider].events}/${encodeURIComponent(externalId)}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
    if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`HTTP ${res.status}`);
  },
};

async function freshToken(tx: Tx, tenantId: string, conn: { id: string; provider: CalendarProvider; tokens_enc: Uint8Array }, now: Date, exch = exchange): Promise<string> {
  const t = JSON.parse(decryptField(conn.tokens_enc, tokenScope(tenantId, conn.id))) as Tokens;
  if (t.expires_at - 60_000 > now.getTime()) return t.access_token;
  const e = env(conn.provider);
  if (!e || !t.refresh_token) throw new Error("The calendar connection expired. Connect it again.");
  const r = await exch(conn.provider, new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: e.clientId, client_secret: e.clientSecret }));
  if (!r.access_token) throw new Error(`Couldn't refresh the calendar connection${r.error_description ? `: ${r.error_description}` : ""}.`);
  const next: Tokens = { ...t, access_token: r.access_token, refresh_token: r.refresh_token ?? t.refresh_token, expires_at: now.getTime() + (r.expires_in ?? 3600) * 1000 };
  await tx`update calendar_connections set tokens_enc = ${encryptField(JSON.stringify(next), tokenScope(tenantId, conn.id))} where id = ${conn.id}`;
  return next.access_token;
}

/** Push pending events and delete cancelled ones. Runs after a mutation (best effort) and from jobs:daily. */
export async function syncCalendars(tenantId: string, now = new Date(), api: CalendarApi = httpApi) {
  const providers = calendarProviders();
  if (!providers.google.configured && !providers.microsoft.configured) return { synced: 0, removed: 0, failed: 0 };
  let synced = 0, removed = 0, failed = 0;
  await withTenant(tenantId, async (tx) => {
    const due = await tx<{ id: string; connection_id: string; provider: CalendarProvider; tokens_enc: Uint8Array; status: "pending" | "cancelled"; payload: EventPayload; external_id: string | null; attempts: number }[]>`
      select ev.id, ev.connection_id, c.provider, c.tokens_enc, ev.status, ev.payload, ev.external_id, ev.attempts from calendar_events ev join calendar_connections c on c.id = ev.connection_id
      where ev.status in ('pending','cancelled') and ev.attempts < 5 and c.status <> 'disconnected' order by ev.created_at limit 50 for update of ev skip locked`;
    for (const ev of due) {
      try {
        const token = await freshToken(tx, tenantId, { id: ev.connection_id, provider: ev.provider, tokens_enc: ev.tokens_enc }, now);
        if (ev.status === "cancelled") {
          if (ev.external_id) await api.remove(ev.provider, token, ev.external_id);
          await tx`delete from calendar_events where id = ${ev.id}`;
          removed++;
        } else {
          if (ev.external_id) await api.remove(ev.provider, token, ev.external_id).catch(() => {});   // re-sync after a change: replace
          const { id } = await api.create(ev.provider, token, ev.payload);
          await tx`update calendar_events set status = 'synced', external_id = ${id}, attempts = attempts + 1, last_error = null where id = ${ev.id}`;
          synced++;
        }
        await tx`update calendar_connections set status = 'connected', last_error = null where id = ${ev.connection_id}`;
      } catch (e) {
        failed++;
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        await tx`update calendar_events set attempts = attempts + 1, last_error = ${msg}, status = case when attempts + 1 >= 5 then 'failed' else status end where id = ${ev.id}`;
        await tx`update calendar_connections set status = 'error', last_error = ${msg} where id = ${ev.connection_id}`;
      }
    }
  });
  return { synced, removed, failed };
}

/** Settings → Integrations: how many people connected each provider. */
export async function calendarOverview(tx: Tx) {
  const rows = await tx<{ provider: CalendarProvider; n: number }[]>`select provider, count(*)::int as n from calendar_connections where status <> 'disconnected' group by provider`;
  return { google: rows.find((r) => r.provider === "google")?.n ?? 0, microsoft: rows.find((r) => r.provider === "microsoft")?.n ?? 0 };
}
