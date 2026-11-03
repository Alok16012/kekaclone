"use server";
import { headers } from "next/headers";
import { AppError, withTenant } from "@/server/db";
import { deliverQueued } from "@/server/email";
import { currentSubdomain, resolveTenant } from "@/server/auth/session";
import { sha256 } from "@/server/auth/password";
import * as esign from "@/server/modules/documents/esign";
import { rateLimit } from "@/server/modules/hire/ratelimit";

type R<T = undefined> = { ok: true; data?: T } | { ok: false; error: string; field?: string };

/** Token links: the tenant comes from the address, the token picks the request; every call is rate-limited per token. */
async function run<T>(token: unknown, fn: (tenant: NonNullable<Awaited<ReturnType<typeof resolveTenant>>>, token: string) => Promise<T>, limit = 30): Promise<R<T>> {
  try {
    if (typeof token !== "string" || token.length < 20 || token.length > 100) return { ok: false, error: "This link doesn't work. Ask the sender for a new one." };
    const tenant = await resolveTenant(await currentSubdomain());
    if (!tenant) return { ok: false, error: "This link doesn't work." };
    await rateLimit(tenant.id, `sign:${sha256(token).slice(0, 32)}`, limit, 60, "Too many attempts. Please try again in an hour.");
    const data = await fn(tenant, token);
    await deliverQueued(tenant.id).catch((e) => console.error("email delivery", e));
    return { ok: true, data };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, error: e.message, field: e.field };
    console.error(e);
    return { ok: false, error: "Something went wrong on our side. Please try again." };
  }
}

export async function requestSignCodeAction(token: string) {
  return run(token, (t, k) => withTenant(t.id, (tx) => esign.requestSignCode(tx, t, k)), 8);
}

export async function signAction(token: string, input: { code: string; method: "typed" | "drawn"; typedName?: string | null; png?: string | null }) {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null, userAgent = h.get("user-agent");
  const method = input?.method === "drawn" ? "drawn" : "typed";
  const r = await run(token, (t, k) => withTenant(t.id, (tx) => esign.sign(tx, t, k, {
    code: String(input?.code ?? "").slice(0, 10), method, typedName: typeof input?.typedName === "string" ? input.typedName.slice(0, 150) : null,
    png: typeof input?.png === "string" ? input.png.slice(0, 400_000) : null, ip, userAgent,
  })), 20);
  if (!r.ok) return r;
  return r.data!.ok ? { ok: true as const, data: { done: r.data!.done } } : { ok: false as const, error: r.data!.error, field: r.data!.field };
}

export async function declineSignAction(token: string, reason: string) {
  return run(token, (t, k) => withTenant(t.id, (tx) => esign.declineSignature(tx, t, k, String(reason ?? "").slice(0, 500))));
}
