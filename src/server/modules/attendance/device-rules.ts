/**
 * Biometric device ingest rules: pure. Device key format, batch validation, and a token-bucket rate limiter
 * the API route keeps in memory per device.
 */

const KEY_RE = /^dev_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{32,128})$/;

/** "dev_<device id>.<secret>" → its parts, or null. The id lets the server look the device up before checking the secret's hash. */
export function parseDeviceKey(raw: string | null | undefined): { deviceId: string; secret: string } | null {
  const m = raw?.trim().match(KEY_RE);
  return m ? { deviceId: m[1], secret: m[2] } : null;
}
export const formatDeviceKey = (deviceId: string, secret: string) => `dev_${deviceId}.${secret}`;

export type PunchItem = { employee: string; at: string; direction: "in" | "out" | "auto"; external_id: string };
export type BatchResult = { ok: true; items: PunchItem[] } | { ok: false; error: string };

export const MAX_BATCH = 500;

/** Validates a batch body: { punches: [{ employee, at, direction?, external_id }] }. Dates must be ISO 8601 with a zone; at most 500 per call. */
export function parseBatch(body: unknown): BatchResult {
  if (!body || typeof body !== "object") return { ok: false, error: "Send a JSON object with a punches array." };
  const list = (body as { punches?: unknown }).punches;
  if (!Array.isArray(list)) return { ok: false, error: "punches must be an array." };
  if (list.length === 0) return { ok: false, error: "punches is empty." };
  if (list.length > MAX_BATCH) return { ok: false, error: `Send at most ${MAX_BATCH} punches per call.` };
  const items: PunchItem[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of list.entries()) {
    const p = (raw ?? {}) as Record<string, unknown>;
    const employee = typeof p.employee === "string" ? p.employee.trim() : "";
    const ext = typeof p.external_id === "string" ? p.external_id.trim() : "";
    const at = typeof p.at === "string" ? p.at.trim() : "";
    const dir = p.direction == null ? "auto" : p.direction;
    if (!employee || employee.length > 60) return { ok: false, error: `punches[${i}].employee: the employee or attendance number is missing.` };
    if (!ext || ext.length > 120) return { ok: false, error: `punches[${i}].external_id: give each punch the device's own id (up to 120 characters).` };
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(at) || Number.isNaN(Date.parse(at))) return { ok: false, error: `punches[${i}].at: use an ISO 8601 time with a zone, e.g. 2026-11-03T09:31:00+05:30.` };
    if (dir !== "in" && dir !== "out" && dir !== "auto") return { ok: false, error: `punches[${i}].direction: in, out or auto.` };
    if (seen.has(ext)) return { ok: false, error: `punches[${i}].external_id: "${ext}" appears twice in this batch.` };
    seen.add(ext);
    items.push({ employee, at: new Date(at).toISOString(), direction: dir, external_id: ext });
  }
  return { ok: true, items };
}

/** Token bucket per key: `rate` calls per `perMs`, bursting up to `rate`. Deterministic given `now`. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private rate = 60, private perMs = 60_000) {}
  /** true when the call may proceed (one token consumed). */
  take(key: string, now = Date.now()): boolean {
    const b = this.buckets.get(key) ?? { tokens: this.rate, at: now };
    const refill = ((now - b.at) / this.perMs) * this.rate;
    b.tokens = Math.min(this.rate, b.tokens + Math.max(0, refill));
    b.at = now;
    if (b.tokens < 1) { this.buckets.set(key, b); return false; }
    b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) this.buckets.clear();   // bounded memory; a flush only makes a burst briefly possible
    return true;
  }
  /** Seconds until a token is available (for Retry-After). */
  retryAfter(key: string) {
    const b = this.buckets.get(key);
    if (!b || b.tokens >= 1) return 0;
    return Math.ceil(((1 - b.tokens) / this.rate) * (this.perMs / 1000));
  }
}

export function validateDevice(d: { name: string; serial: string; vendor: string }): string | null {
  if (!d.name.trim() || d.name.length > 80) return "Give the device a name (up to 80 characters).";
  if (!/^[A-Za-z0-9._-]{2,64}$/.test(d.serial.trim())) return "The serial number can have letters, numbers, dots and dashes (2 to 64 characters).";
  if (!["generic", "zkteco", "essl", "matrix", "biomax", "other"].includes(d.vendor)) return "Choose a vendor.";
  return null;
}
