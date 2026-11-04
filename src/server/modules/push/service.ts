import "server-only";
import { AppError, withTenant, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { endpointUrlProblem } from "@/server/modules/integrations/rules";

/*
 * Web Push (VAPID). Disabled with a clear "not configured" state until VAPID keys are in .env.local:
 *   pnpm push:keys       prints a fresh VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY pair (generated locally, never sent anywhere)
 * notify() queues a push per in-app notification (push_outbox); deliverPush() sends after the action commits and
 * from jobs:daily. Subscriptions that the browser reports gone (404/410) are removed.
 */

export function pushStatus() {
  const pub = process.env.VAPID_PUBLIC_KEY?.trim(), priv = process.env.VAPID_PRIVATE_KEY?.trim();
  return { configured: !!(pub && priv), publicKey: pub ?? null, hint: "VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT in .env.local (pnpm push:keys makes a pair)" };
}

export type PushPayload = { title: string; body: string; url: string };
export type SubscriptionInput = { endpoint: string; keys: { p256dh: string; auth: string } };

const validSubscription = (s: unknown): s is SubscriptionInput => {
  const x = s as SubscriptionInput;
  // the server POSTs to this address, so it must be a public https host (never an internal one: SSRF)
  return !!x && typeof x.endpoint === "string" && /^https:\/\//.test(x.endpoint) && x.endpoint.length < 2000 && !endpointUrlProblem(x.endpoint, (process.env.ROOT_DOMAIN ?? "").split(":")[0] || null) && !!x.keys && typeof x.keys.p256dh === "string" && typeof x.keys.auth === "string";
};

export async function subscribePush(tx: Tx, actor: Actor, sub: unknown, userAgent: string | null) {
  if (!pushStatus().configured) throw new AppError("invalid", "Push notifications aren't set up on this server yet.");
  if (!validSubscription(sub)) throw new AppError("invalid", "The browser didn't give a usable push subscription.");
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from push_subscriptions where user_id = ${actor.userId}`;
  if (n >= 10) await tx`delete from push_subscriptions where id = (select id from push_subscriptions where user_id = ${actor.userId} order by updated_at limit 1)`;
  await tx`insert into push_subscriptions (tenant_id, user_id, endpoint, keys, user_agent) values (${actor.tenant.id}, ${actor.userId}, ${sub.endpoint}, ${tx.json(sub.keys)}, ${userAgent?.slice(0, 200) ?? null})
           on conflict (endpoint) do update set user_id = excluded.user_id, keys = excluded.keys, user_agent = excluded.user_agent, failures = 0`;
}

export async function unsubscribePush(tx: Tx, actor: Actor, endpoint: string) {
  await tx`delete from push_subscriptions where user_id = ${actor.userId} and endpoint = ${endpoint}`;
}

export async function pushDevices(tx: Tx, actor: Actor) {
  const rows = await tx<{ id: string; endpoint: string; user_agent: string | null; created_at: Date }[]>`select id, endpoint, user_agent, created_at from push_subscriptions where user_id = ${actor.userId} order by created_at`;
  return rows.map((r) => ({ id: r.id, endpoint: r.endpoint, device: describeAgent(r.user_agent), created_at: r.created_at.toISOString() }));
}

function describeAgent(ua: string | null) {
  if (!ua) return "Unknown device";
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad/i.test(ua) ? "iOS" : /Windows/i.test(ua) ? "Windows" : /Mac OS/i.test(ua) ? "Mac" : /Linux/i.test(ua) ? "Linux" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${browser} on ${os}`;
}

/** Queue a push for these users (no-op when push isn't configured or nobody subscribed). Inside the caller's transaction. */
export async function queuePush(tx: Tx, tenantId: string, userIds: string[], payload: PushPayload) {
  if (!pushStatus().configured || !userIds.length) return 0;
  const r = await tx`insert into push_outbox (tenant_id, user_id, payload) select ${tenantId}, s.user_id, ${tx.json(payload)} from (select distinct user_id from push_subscriptions where user_id = any(${userIds}::uuid[])) s`;
  return r.count;
}

type Sender = (sub: SubscriptionInput, body: string) => Promise<{ statusCode: number }>;

async function defaultSender(sub: SubscriptionInput, body: string) {
  const { default: webpush } = await import("web-push");
  const st = pushStatus();
  webpush.setVapidDetails(process.env.VAPID_SUBJECT?.trim() || "mailto:admin@example.com", st.publicKey!, process.env.VAPID_PRIVATE_KEY!.trim());
  try { const r = await webpush.sendNotification(sub, body, { TTL: 3600 }); return { statusCode: r.statusCode }; }
  catch (e) { return { statusCode: (e as { statusCode?: number }).statusCode ?? 0 }; }
}

/** Send what's queued for a tenant: each row fans out to every subscription of the user; gone endpoints are dropped. */
export async function deliverPush(tenantId: string, send: Sender = defaultSender) {
  if (!pushStatus().configured) return { sent: 0, failed: 0, dropped: 0 };
  let sent = 0, failed = 0, dropped = 0;
  await withTenant(tenantId, async (tx) => {
    const due = await tx<{ id: string; user_id: string; payload: PushPayload; attempts: number }[]>`select id, user_id, payload, attempts from push_outbox where status = 'queued' and attempts < 3 order by created_at limit 100 for update skip locked`;
    for (const d of due) {
      const subs = await tx<{ id: string; endpoint: string; keys: { p256dh: string; auth: string } }[]>`select id, endpoint, keys from push_subscriptions where user_id = ${d.user_id}`;
      let ok = subs.length === 0, lastErr: string | null = null;
      for (const s of subs) {
        const r = await send({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(d.payload));
        if (r.statusCode >= 200 && r.statusCode < 300) ok = true;
        else if (r.statusCode === 404 || r.statusCode === 410) { dropped++; await tx`delete from push_subscriptions where id = ${s.id}`; }
        else { lastErr = `HTTP ${r.statusCode}`; await tx`update push_subscriptions set failures = failures + 1 where id = ${s.id}`; }
      }
      if (ok) { sent++; await tx`update push_outbox set status = 'sent', attempts = attempts + 1 where id = ${d.id}`; }
      else { failed++; await tx`update push_outbox set attempts = attempts + 1, error = ${lastErr}, status = case when attempts + 1 >= 3 then 'failed' else 'queued' end where id = ${d.id}`; }
    }
  });
  return { sent, failed, dropped };
}
