import { withTenant } from "@/server/db";
import { resolveTenant } from "@/server/auth/session";
import { deliverQueued } from "@/server/email";
import { deviceBySerial, ingestPunches, touchDevice, type AdmsDevice } from "@/server/modules/attendance/devices";
import { RateLimiter } from "@/server/modules/attendance/device-rules";
import { admsOptions, admsSerial, attlogToPunches, parseAttlog } from "@/server/modules/attendance/adms-rules";

/**
 * Shared plumbing for the ADMS ("iclock") push endpoints. The protocol is plain text over HTTP with the device's serial
 * number as the only identity, so: tenant from the subdomain the device was pointed at, serial must be registered with
 * protocol 'adms' in that tenant, rate limited per IP and per device, bodies capped. Every answer is text/plain.
 */

declare global { var __erpAdmsLimiters: { device: RateLimiter; ip: RateLimiter } | undefined }
const limiters = globalThis.__erpAdmsLimiters ?? { device: new RateLimiter(120, 60_000), ip: new RateLimiter(240, 60_000) };
if (process.env.NODE_ENV !== "production") globalThis.__erpAdmsLimiters = limiters;

export const text = (body: string, status = 200, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra } });

export const MAX_BODY = 2_000_000;

/** Resolves tenant + device for a request, or the error response to send instead. */
export async function admsContext(req: Request): Promise<{ tenantId: string; device: AdmsDevice; serial: string } | Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!limiters.ip.take(ip)) return text("ERROR: too many requests", 429, { "retry-after": String(limiters.ip.retryAfter(ip)) });
  const serial = admsSerial(new URL(req.url).searchParams.get("SN"));
  if (!serial) return text("ERROR: SN missing", 400);
  const tenant = await resolveTenant(req.headers.get("x-erp-tenant"));
  if (!tenant) return text("ERROR: unknown company host", 404);
  const device = await withTenant(tenant.id, (tx) => deviceBySerial(tx, serial));
  if (!device) return text("ERROR: device not registered", 401);   // add it in Settings → Time → Devices with protocol ADMS
  if (!limiters.device.take(device.id)) return text("ERROR: too many requests", 429, { "retry-after": String(limiters.device.retryAfter(device.id)) });
  return { tenantId: tenant.id, device, serial };
}

export async function handshake(ctx: { tenantId: string; device: AdmsDevice; serial: string }) {
  await withTenant(ctx.tenantId, (tx) => touchDevice(tx, ctx.device.id));
  return text(admsOptions(ctx.serial, { attlog: 0, operlog: 0, tz: ctx.device.timezone }));
}

/** POST cdata: ATTLOG lines become punches (idempotent by PIN + device time); other tables are acknowledged and dropped. */
export async function pushData(req: Request, ctx: { tenantId: string; device: AdmsDevice }) {
  const table = (new URL(req.url).searchParams.get("table") ?? "").toUpperCase();
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return text("ERROR: body too large", 413);
  let body = "";
  try { body = await req.text(); } catch { return text("ERROR: unreadable body", 400); }
  if (body.length > MAX_BODY) return text("ERROR: body too large", 413);
  if (table !== "ATTLOG") {
    await withTenant(ctx.tenantId, (tx) => touchDevice(tx, ctx.device.id));
    return text(`OK: ${body.split(/\r?\n/).filter((l) => l.trim()).length}`);
  }
  const { rows, bad } = parseAttlog(body);
  const { items, badTime } = attlogToPunches(rows, ctx.device.timezone, ctx.device.clock_offset_seconds);
  if (!items.length) {
    await withTenant(ctx.tenantId, (tx) => touchDevice(tx, ctx.device.id, new Date(), bad + badTime ? `${bad + badTime} unreadable log lines in the last push` : null));
    return text("OK: 0");
  }
  const r = await withTenant(ctx.tenantId, async (tx) => {
    const res = await ingestPunches(tx, ctx.device, items);
    const note = [res.unknown.length ? `${res.unknown.length} unknown PIN${res.unknown.length > 1 ? "s" : ""}: ${res.unknown.slice(0, 5).join(", ")}` : null, res.rejected.length ? `${res.rejected.length} outside the 45-day window` : null, bad + badTime ? `${bad + badTime} unreadable lines` : null].filter(Boolean).join(" · ");
    await touchDevice(tx, ctx.device.id, new Date(), note || null);
    return res;
  });
  await deliverQueued(ctx.tenantId).catch(() => {});
  // the device only wants to know the lines were taken; duplicates and unknown PINs are still "taken" so it stops resending them
  return text(`OK: ${r.accepted + r.duplicates + r.unknown.length + r.rejected.length}`);
}
