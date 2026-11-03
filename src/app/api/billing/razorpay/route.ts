import { sql, withTenant } from "@/server/db";
import { billingProvider } from "@/server/modules/billing/provider";
import { applyProviderEvent } from "@/server/modules/billing/service";

/**
 * Razorpay webhook (public, no session). The HMAC signature proves the payload; the event id makes it idempotent
 * (webhook_events is unique per provider + event). The tenant comes from the notes we set at checkout, and the
 * subscription must then exist inside that tenant, so a forged id can't touch another workspace.
 */
export async function POST(req: Request) {
  const provider = billingProvider();
  if (!provider.configured) return new Response("Billing is not configured.", { status: 404 });
  const raw = await req.text();
  if (raw.length > 256 * 1024) return new Response("Too large.", { status: 413 });
  if (!provider.verifyWebhook(raw, req.headers.get("x-razorpay-signature"))) return new Response("Bad signature.", { status: 401 });
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return new Response("Bad JSON.", { status: 400 }); }
  const ev = provider.parseEvent(json, req.headers.get("x-razorpay-event-id"));
  const [row] = await sql<{ id: string }[]>`insert into webhook_events (provider, event_id, payload) values (${provider.name}, ${ev.id}, ${sql.json(json as never)}) on conflict (provider, event_id) do nothing returning id`;
  if (!row) return Response.json({ ok: true, duplicate: true });
  if (!ev.tenantId || !/^[0-9a-f-]{36}$/.test(ev.tenantId)) {
    await sql`update webhook_events set processed_at = now(), error = 'no tenant in notes' where id = ${row.id}`;
    return Response.json({ ok: true, ignored: true });
  }
  try {
    const r = await withTenant(ev.tenantId, (tx) => applyProviderEvent(tx, ev.tenantId!, ev));
    await sql`update webhook_events set processed_at = now(), error = ${r.applied ? null : r.reason ?? null} where id = ${row.id}`;
    return Response.json({ ok: true, applied: r.applied });
  } catch (e) {
    await sql`update webhook_events set processed_at = now(), error = ${String((e as Error).message).slice(0, 500)} where id = ${row.id}`;
    return new Response("Failed.", { status: 500 });
  }
}
