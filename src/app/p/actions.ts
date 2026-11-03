"use server";
import { headers } from "next/headers";
import { AppError, withTenant } from "@/server/db";
import { deliverQueued } from "@/server/email";
import { currentSubdomain, resolveTenant } from "@/server/auth/session";
import { sha256 } from "@/server/auth/password";
import * as offers from "@/server/modules/hire/offers";
import * as iv from "@/server/modules/hire/interviews";
import { rateLimit } from "@/server/modules/hire/ratelimit";

type R<T = undefined> = { ok: true; data?: T } | { ok: false; error: string; field?: string };

/** Token links: the tenant comes from the address, the token picks the record; every call is rate-limited per token. */
async function run<T>(token: unknown, fn: (tenant: { id: string; name: string }, token: string) => Promise<T>, limit = 30): Promise<R<T>> {
  try {
    if (typeof token !== "string" || token.length < 20 || token.length > 100) return { ok: false, error: "This link doesn't work. Ask the hiring team for a new one." };
    const tenant = await resolveTenant(await currentSubdomain());
    if (!tenant) return { ok: false, error: "This link doesn't work." };
    await rateLimit(tenant.id, `link:${sha256(token).slice(0, 32)}`, limit, 60, "Too many attempts. Please try again in an hour.");
    const data = await fn(tenant, token);
    await deliverQueued(tenant.id).catch((e) => console.error("email delivery", e));
    return { ok: true, data };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, error: e.message, field: e.field };
    console.error(e);
    return { ok: false, error: "Something went wrong on our side. Please try again." };
  }
}

export async function pickSlotAction(token: string, index: number) {
  return run(token, (t, k) => withTenant(t.id, (tx) => iv.pickSlot(tx, t, k, Number(index))));
}

export async function requestCodeAction(token: string) {
  return run(token, (t, k) => withTenant(t.id, (tx) => offers.requestSignCode(tx, k)), 8);
}

export async function acceptOfferAction(token: string, typedName: string, code: string) {
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const r = await run(token, (t, k) => withTenant(t.id, (tx) => offers.acceptOffer(tx, k, { typedName: String(typedName ?? "").slice(0, 150), code: String(code ?? "").slice(0, 10), ip })), 20);
  if (!r.ok) return r;
  return r.data!.ok ? { ok: true as const } : { ok: false as const, error: r.data!.error, field: r.data!.field };
}

export async function declineOfferAction(token: string, reason: string) {
  return run(token, (t, k) => withTenant(t.id, (tx) => offers.declineOffer(tx, k, String(reason ?? "").slice(0, 500))));
}

export async function uploadDocAction(token: string, form: FormData) {
  const id = form instanceof FormData ? form.get("requestId") : null;
  const f = form instanceof FormData ? form.get("file") : null;
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id) || !(f instanceof File) || !f.size) return { ok: false as const, error: "Choose a file to upload.", field: "file" };
  if (f.size > 5 * 1024 * 1024) return { ok: false as const, error: "The file is larger than 5 MB.", field: "file" };
  const bytes = new Uint8Array(await f.arrayBuffer());
  return run(token, (t, k) => withTenant(t.id, (tx) => offers.portalUpload(tx, k, id, { name: f.name, bytes })));
}

export async function taskAction(token: string, taskId: string, done: boolean) {
  if (!/^[0-9a-f-]{36}$/i.test(String(taskId))) return { ok: false as const, error: "Task not found." };
  return run(token, (t, k) => withTenant(t.id, (tx) => offers.portalTask(tx, k, taskId, !!done)));
}

export async function submitScorecardLinkAction(token: string, input: { ratings: Record<string, number>; overall: number | null; recommendation: string | null; comments: string | null }) {
  const ratings: Record<string, number> = {};
  for (const [k, v] of Object.entries(input?.ratings ?? {}).slice(0, 200)) if (typeof v === "number" && k.length <= 40) ratings[k] = v;
  return run(token, (t, k) => withTenant(t.id, (tx) => iv.submitScorecardByToken(tx, t.id, k, {
    ratings, overall: typeof input?.overall === "number" ? input.overall : null, recommendation: typeof input?.recommendation === "string" ? input.recommendation.slice(0, 20) : null,
    comments: typeof input?.comments === "string" ? input.comments.slice(0, 4000) : null,
  })), 20);
}
