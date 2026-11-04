"use server";
import { headers } from "next/headers";
import { refresh } from "next/cache";
import { AppError, withTenant } from "@/server/db";
import { deliverQueued } from "@/server/email";
import { currentSubdomain, resolveTenant } from "@/server/auth/session";
import { sha256 } from "@/server/auth/password";
import { rateLimit } from "@/server/modules/hire/ratelimit";
import { requestJoinerSignCode, signJoinerOffer } from "@/server/modules/onboarding/offer-sign";

type R<T = undefined> = { ok: true; data?: T } | { ok: false; error: string; field?: string };
const tokenOk = (t: unknown): t is string => typeof t === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(t);

/** Joiner portal signing: company from the subdomain, joiner from the token, rate-limited per token. */
async function run<T>(token: unknown, limit: number, fn: (tenant: { id: string; name: string }, token: string) => Promise<T>): Promise<R<T>> {
  try {
    if (!tokenOk(token)) return { ok: false, error: "This link doesn't work anymore. Ask HR for a fresh one." };
    const tenant = await resolveTenant(await currentSubdomain());
    if (!tenant) return { ok: false, error: "This link doesn't work anymore." };
    await rateLimit(tenant.id, `join-sign:${sha256(token).slice(0, 32)}`, limit, 60, "Too many attempts. Please try again in an hour.");
    const data = await withTenant(tenant.id, () => fn(tenant, token));
    await deliverQueued(tenant.id).catch((e) => console.error("email delivery", e));
    return { ok: true, data };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, error: e.message, field: e.field };
    console.error(e);
    return { ok: false, error: "Something went wrong on our side. Please try again." };
  }
}

export async function joinerSignCodeAction(token: string) {
  return run(token, 8, (t, k) => withTenant(t.id, (tx) => requestJoinerSignCode(tx, t, k)));
}

export async function joinerSignAction(token: string, typedName: string, code: string) {
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const r = await run(token, 20, (t, k) => withTenant(t.id, (tx) => signJoinerOffer(tx, t, k, { typedName: String(typedName ?? "").slice(0, 150), code: String(code ?? "").slice(0, 10), ip })));
  if (!r.ok) return r;
  if (!r.data!.ok) return { ok: false as const, error: r.data!.error, field: r.data!.field };
  refresh();
  return { ok: true as const };
}
