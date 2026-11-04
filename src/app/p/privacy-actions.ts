"use server";
import { AppError, withTenant } from "@/server/db";
import { deliverQueued } from "@/server/email";
import { currentSubdomain, resolveTenant } from "@/server/auth/session";
import { sha256 } from "@/server/auth/password";
import { rateLimit } from "@/server/modules/hire/ratelimit";
import { removeBlobs, requestErasureFromPortal } from "@/server/modules/hire/privacy";

type R<T> = { ok: true; data: T } | { ok: false; error: string; field?: string };

/**
 * "Delete my data" from the candidate portal. Tenant from the subdomain, candidate from the token, rate-limited per
 * token. File bytes are removed only after the database change commits.
 */
export async function deleteMyDataAction(token: string, input: { confirm: boolean; reason: string }): Promise<R<{ outcome: string; message: string }>> {
  try {
    if (typeof token !== "string" || token.length < 20 || token.length > 100) return { ok: false, error: "This link doesn't work. Ask the hiring team for a new one." };
    const tenant = await resolveTenant(await currentSubdomain());
    if (!tenant) return { ok: false, error: "This link doesn't work." };
    await rateLimit(tenant.id, `erase:${sha256(token).slice(0, 32)}`, 5, 60, "Too many attempts. Please try again in an hour.");
    const r = await withTenant(tenant.id, (tx) => requestErasureFromPortal(tx, token, { confirm: input?.confirm === true, reason: typeof input?.reason === "string" ? input.reason.slice(0, 500) : null }));
    await removeBlobs(r.keys);
    await deliverQueued(tenant.id).catch((e) => console.error("email delivery", e));
    return { ok: true, data: { outcome: r.outcome, message: r.message } };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, error: e.message, field: e.field };
    console.error(e);
    return { ok: false, error: "Something went wrong on our side. Please try again." };
  }
}
