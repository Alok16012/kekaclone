import "server-only";
import { randomInt, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { AppError, withTenant } from "@/server/db";
import type { Tenant } from "@/server/auth/session";
import { newToken, sha256 } from "@/server/auth/password";
import { deliverQueuedSms, normalizeIndianMobile, queueSms } from "@/server/sms";

const COOKIE = "erp_motp", MINUTES = 5, MAX_ATTEMPTS = 5, PER_WINDOW = 3;

/**
 * Sign in with a 6-digit code sent to the person's mobile (the number on their profile). Looks the same from outside
 * whether or not the number is known; at most 3 codes per number per 15 minutes; 5 wrong tries end the challenge.
 */
export async function startMobileOtp(tenant: Tenant, rawPhone: string, ip: string | null) {
  if (!tenant.authSettings?.mobile_otp) throw new AppError("forbidden", "Mobile sign-in isn't turned on for your company.");
  const phone = normalizeIndianMobile(rawPhone);
  if (!phone) throw new AppError("invalid", "Enter a 10-digit Indian mobile number.", "phone");
  const nonce = newToken();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const id = await withTenant(tenant.id, async (tx) => {
    const [u] = await tx<{ id: string; name: string }[]>`
      select u.id, coalesce(e.display_name, u.email::text) as name from users u left join employees e on e.user_id = u.id and e.status <> 'relieved'
      where u.status = 'active' and (regexp_replace(coalesce(u.phone, ''), '[^0-9]', '', 'g') like '%' || ${phone.slice(-10)}
         or regexp_replace(coalesce(e.mobile, ''), '[^0-9]', '', 'g') like '%' || ${phone.slice(-10)})
      order by (u.phone is not null) desc limit 1`;
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from auth_tokens where purpose = 'login_otp' and target = ${phone} and created_at > now() - interval '15 minutes'`;
    if (n >= PER_WINDOW) throw new AppError("invalid", "Too many codes were sent to this number. Try again in 15 minutes.");
    await tx`update auth_tokens set consumed_at = now() where purpose = 'login_otp' and target = ${phone} and consumed_at is null`;
    // an unknown number still gets a (useless) row so the response time and rate limit look the same
    const [t] = await tx<{ id: string }[]>`insert into auth_tokens (tenant_id, user_id, purpose, target, token_hash, expires_at)
      values (${tenant.id}, ${u?.id ?? null}, 'login_otp', ${phone}, ${sha256(nonce + ":" + code)}, now() + make_interval(mins => ${MINUTES})) returning id`;
    if (u) await queueSms(tx, tenant.id, { kind: "login_otp", to: phone, body: `${code} is your ${tenant.name} sign-in code. It works for ${MINUTES} minutes. Don't share it.` });
    else await tx`insert into login_events (tenant_id, email, method, success, ip) values (${tenant.id}, ${phone}, 'mobile_otp', false, ${ip})`;
    return t.id;
  });
  await deliverQueuedSms(tenant.id).catch((e) => console.error(e));
  (await cookies()).set(COOKIE, `${id}.${nonce}`, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: MINUTES * 60 });
  return { maskedPhone: phone.replace(/^(\+91)(\d{6})(\d{4})$/, "$1 ••••••$3") };
}

export async function verifyMobileOtp(tenant: Tenant, code: string, ip: string | null) {
  const raw = (await cookies()).get(COOKIE)?.value ?? "";
  const [id, nonce] = raw.split(".");
  if (!id || !nonce || !/^[0-9a-f-]{36}$/.test(id)) throw new AppError("invalid", "Your sign-in timed out. Enter your mobile number again.");
  const clean = code.replace(/\D/g, "");
  const userId = await withTenant(tenant.id, async (tx) => {
    const [t] = await tx<{ user_id: string | null; token_hash: string; attempts: number; target: string }[]>`
      select user_id, token_hash, attempts, target from auth_tokens where id = ${id} and purpose = 'login_otp' and consumed_at is null and expires_at > now() for update`;
    if (!t) throw new AppError("invalid", "This code has expired. Enter your mobile number again.");
    const ok = !!t.user_id && clean.length === 6 && timingSafeEqual(Buffer.from(sha256(nonce + ":" + clean)), Buffer.from(t.token_hash));
    if (!ok) {
      const left = MAX_ATTEMPTS - (t.attempts + 1);
      await tx`update auth_tokens set attempts = attempts + 1, consumed_at = case when attempts + 1 >= ${MAX_ATTEMPTS} then now() else null end where id = ${id}`;
      await tx`insert into login_events (tenant_id, user_id, email, method, success, ip) values (${tenant.id}, ${t.user_id}, ${t.target}, 'mobile_otp', false, ${ip})`;
      throw new AppError("invalid", left > 0 ? `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong codes. Enter your mobile number again.");
    }
    await tx`update auth_tokens set consumed_at = now() where id = ${id}`;
    await tx`update users set failed_logins = 0, locked_until = null, last_login_at = now() where id = ${t.user_id}`;
    await tx`insert into login_events (tenant_id, user_id, email, method, success, ip) values (${tenant.id}, ${t.user_id}, ${t.target}, 'mobile_otp', true, ${ip})`;
    return t.user_id!;
  });
  (await cookies()).delete(COOKIE);
  return userId;
}
