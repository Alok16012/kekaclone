import "server-only";
import { randomInt, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { AppError, withTenant } from "@/server/db";
import type { Tenant } from "@/server/auth/session";
import { newToken, sha256 } from "@/server/auth/password";
import { deliverQueued, queueEmail } from "@/server/email";
import { loginCodeEmail } from "@/server/email/templates";

const COOKIE = "erp_mfa", MINUTES = 10, MAX_ATTEMPTS = 5, RESEND_SECONDS = 30;
export type MfaMode = "off" | "optional" | "required";

export async function needsCode(tenant: Tenant, userId: string) {
  return withTenant(tenant.id, async (tx) => {
    const [r] = await tx<{ mode: MfaMode | null; mine: boolean }[]>`
      select (select auth_settings->>'mfa' from tenants) as mode, mfa_enabled as mine from users where id = ${userId}`;
    return r.mode === "required" || (r.mode !== "off" && r.mine);
  });
}

const mask = (email: string) => email.replace(/^(.)(.*)(.@.*)$/, (_, a, b, c) => a + "•".repeat(Math.min(6, b.length)) + c);

/**
 * Start (or restart) a code challenge after a correct password. The code is bound to this browser:
 * a random nonce lives in an httpOnly cookie and the stored hash is sha256(nonce:code).
 */
export async function startChallenge(tenant: Tenant, userId: string) {
  const nonce = newToken();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const { id, email } = await withTenant(tenant.id, async (tx) => {
    const [u] = await tx<{ email: string; name: string }[]>`select u.email, coalesce(e.display_name, u.email) as name from users u left join employees e on e.user_id = u.id where u.id = ${userId}`;
    await tx`update auth_tokens set consumed_at = now() where user_id = ${userId} and purpose = 'mfa_otp' and consumed_at is null`;
    const [t] = await tx<{ id: string }[]>`insert into auth_tokens (tenant_id, user_id, purpose, target, token_hash, expires_at)
      values (${tenant.id}, ${userId}, 'mfa_otp', ${u.email}, ${sha256(nonce + ":" + code)}, now() + make_interval(mins => ${MINUTES})) returning id`;
    await queueEmail(tx, tenant.id, { kind: "login_code", to: u.email, ...loginCodeEmail({ company: tenant.name, name: u.name, code, minutes: MINUTES }) });
    return { id: t.id, email: u.email };
  });
  await deliverQueued(tenant.id).catch((e) => console.error(e));
  (await cookies()).set(COOKIE, `${id}.${nonce}`, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: MINUTES * 60 });
  return { maskedEmail: mask(email) };
}

/** Check the code. Returns the user id on success; counts failures and gives up after 5. */
export async function verifyChallenge(tenant: Tenant, code: string) {
  const raw = (await cookies()).get(COOKIE)?.value ?? "";
  const [id, nonce] = raw.split(".");
  if (!id || !nonce || !/^[0-9a-f-]{36}$/.test(id)) throw new AppError("invalid", "Your sign-in timed out. Enter your email and password again.");
  const clean = code.replace(/\D/g, "");
  const userId = await withTenant(tenant.id, async (tx) => {
    const [t] = await tx<{ user_id: string; token_hash: string; attempts: number }[]>`
      select user_id, token_hash, attempts from auth_tokens where id = ${id} and purpose = 'mfa_otp' and consumed_at is null and expires_at > now() for update`;
    if (!t) throw new AppError("invalid", "This code has expired. Enter your email and password again.");
    const ok = clean.length === 6 && timingSafeEqual(Buffer.from(sha256(nonce + ":" + clean)), Buffer.from(t.token_hash));
    if (!ok) {
      const left = MAX_ATTEMPTS - (t.attempts + 1);
      await tx`update auth_tokens set attempts = attempts + 1, consumed_at = case when attempts + 1 >= ${MAX_ATTEMPTS} then now() else null end where id = ${id}`;
      await tx`insert into login_events (tenant_id, user_id, method, success) values (${tenant.id}, ${t.user_id}, 'password', false)`;
      throw new AppError("invalid", left > 0 ? `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong codes. Enter your email and password again.");
    }
    await tx`update auth_tokens set consumed_at = now() where id = ${id}`;
    return t.user_id;
  });
  (await cookies()).delete(COOKIE);
  return userId;
}

/** New code for the same challenge window, at most every 30 seconds. */
export async function resendChallenge(tenant: Tenant) {
  const raw = (await cookies()).get(COOKIE)?.value ?? "";
  const [id] = raw.split(".");
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) throw new AppError("invalid", "Your sign-in timed out. Enter your email and password again.");
  const userId = await withTenant(tenant.id, async (tx) => {
    const [t] = await tx<{ user_id: string; recent: boolean }[]>`
      select user_id, created_at > now() - make_interval(secs => ${RESEND_SECONDS}) as recent from auth_tokens where id = ${id} and purpose = 'mfa_otp' and consumed_at is null and expires_at > now()`;
    if (!t) throw new AppError("invalid", "Your sign-in timed out. Enter your email and password again.");
    if (t.recent) throw new AppError("invalid", "Wait a few seconds before asking for another code.");
    return t.user_id;
  });
  return startChallenge(tenant, userId);
}
