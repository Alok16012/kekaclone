import "server-only";
import { AppError, withTenant, type Tx } from "@/server/db";
import { windowStart } from "./rules";

async function bump(tx: Tx, tenantId: string, bucket: string, minutes: number, now: Date) {
  const start = windowStart(now, minutes);
  const [r] = await tx<{ hits: number }[]>`
    insert into hire_rate_limits (tenant_id, bucket, window_start, hits) values (${tenantId}, ${bucket.slice(0, 200)}, ${start}, 1)
    on conflict (tenant_id, bucket, window_start) do update set hits = hire_rate_limits.hits + 1 returning hits`;
  if (Math.random() < 0.02) await tx`delete from hire_rate_limits where window_start < ${new Date(now.getTime() - 2 * 864e5)}`;
  return r.hits;
}

/**
 * Fixed-window counter in Postgres (per tenant and bucket), counted in its own transaction so a request that fails
 * afterwards still uses up an attempt. Throws once more than `limit` hits land in the window.
 */
export async function rateLimit(tenantId: string, bucket: string, limit: number, minutes: number, message = "Too many attempts. Please try again later.", now = new Date()) {
  const hits = await withTenant(tenantId, (tx) => bump(tx, tenantId, bucket, minutes, now));
  if (hits > limit) throw new AppError("forbidden", message);
}

/** Same counter inside the caller's transaction (for scripts and tests). */
export async function rateLimitIn(tx: Tx, tenantId: string, bucket: string, limit: number, minutes: number, message = "Too many attempts. Please try again later.", now = new Date()) {
  if ((await bump(tx, tenantId, bucket, minutes, now)) > limit) throw new AppError("forbidden", message);
}
