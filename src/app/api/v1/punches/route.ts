import { withTenant } from "@/server/db";
import { resolveTenant } from "@/server/auth/session";
import { deliverQueued } from "@/server/email";
import { authenticateDevice, ingestPunches } from "@/server/modules/attendance/devices";
import { MAX_BATCH, parseBatch, RateLimiter } from "@/server/modules/attendance/device-rules";

/**
 * Biometric / device punch ingest (public route, device API key, no session).
 *   POST https://<company>.<root>/api/v1/punches
 *   Authorization: Bearer dev_<device id>.<secret>      (or X-Device-Key)
 *   { "punches": [{ "employee": "EMP0042", "at": "2026-11-03T09:31:00+05:30", "direction": "in", "external_id": "dev1-000123" }] }
 * The tenant comes from the subdomain and the key is checked inside that tenant, so a key can never reach another company's data.
 * Idempotent by (device, external_id): resend a batch freely. Rate limited per device (60 calls/min) and per IP before auth.
 */

declare global { var __erpPunchLimiters: { device: RateLimiter; ip: RateLimiter } | undefined }
const limiters = globalThis.__erpPunchLimiters ?? { device: new RateLimiter(60, 60_000), ip: new RateLimiter(120, 60_000) };
if (process.env.NODE_ENV !== "production") globalThis.__erpPunchLimiters = limiters;

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!limiters.ip.take(ip)) return json({ error: "Too many requests from this address. Slow down." }, 429, { "retry-after": String(limiters.ip.retryAfter(ip)) });
  const tenant = await resolveTenant(req.headers.get("x-erp-tenant"));
  if (!tenant) return json({ error: "Unknown company. Use your company's own address, e.g. https://acme.example.com/api/v1/punches." }, 404);
  const auth = req.headers.get("authorization");
  const rawKey = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7) : req.headers.get("x-device-key");
  if (!rawKey) return json({ error: "Missing device key. Send it as Authorization: Bearer dev_… (from Settings → Time → Devices)." }, 401);
  const device = await withTenant(tenant.id, (tx) => authenticateDevice(tx, rawKey));
  if (!device) return json({ error: "This device key isn't valid for this company." }, 401);
  if (!limiters.device.take(device.id)) return json({ error: "Too many requests for this device. At most 60 calls a minute." }, 429, { "retry-after": String(limiters.device.retryAfter(device.id)) });

  if ((req.headers.get("content-length") ?? "0").length > 8 || Number(req.headers.get("content-length") ?? 0) > 2_000_000) return json({ error: "Body too large. Send at most 2 MB per call." }, 413);
  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: "The body isn't valid JSON." }, 400); }
  const parsed = parseBatch(body);
  if (!parsed.ok) return json({ error: parsed.error, max_batch: MAX_BATCH }, 400);

  const result = await withTenant(tenant.id, (tx) => ingestPunches(tx, device, parsed.items));
  await deliverQueued(tenant.id).catch(() => {});
  return json({ device: device.name, accepted: result.accepted, duplicates: result.duplicates, unknown_employees: result.unknown, rejected: result.rejected, processed_days: result.processedDays }, 200);
}

export function GET() {
  return json({ error: "POST a JSON body { punches: [...] } with your device key. See Settings → Time → Devices for the format." }, 405, { allow: "POST" });
}
