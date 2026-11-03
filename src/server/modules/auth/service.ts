import "server-only";
import { headers } from "next/headers";
import { withTenant, AppError } from "@/server/db";
import { newToken, sha256, verifyPassword } from "@/server/auth/password";
import type { Tenant } from "@/server/auth/session";
import { ipAllowed } from "@/server/auth/network-rules";

const MAX_FAILS = 5, LOCK_MINUTES = 15;

/** Password login. Same message for unknown email and wrong password; locks for 15 minutes after 5 failures. */
export async function passwordLogin(tenant: Tenant, email: string, password: string) {
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  if (!ipAllowed(ip, tenant.authSettings?.ip_allowlist ?? [])) throw new AppError("forbidden", "Sign-in isn't allowed from this network. Ask your admin about the IP allowlist.");
  if (tenant.authSettings?.sso_only) throw new AppError("forbidden", "Your company signs in with single sign-on. Use the Google or Microsoft button.");
  return withTenant(tenant.id, async (tx) => {
    const [u] = await tx<{ id: string; password_hash: string | null; status: string; failed_logins: number; locked_until: Date | null }[]>`
      select id, password_hash, status, failed_logins, locked_until from users where email = ${email.trim().toLowerCase()} for update`;
    const log = (success: boolean) => tx`insert into login_events (tenant_id, user_id, email, method, success, ip) values (${tenant.id}, ${u?.id ?? null}, ${email}, 'password', ${success}, ${ip})`;
    if (u?.locked_until && u.locked_until > new Date()) {
      await log(false);
      throw new AppError("forbidden", `Too many attempts. Try again in ${Math.ceil((u.locked_until.getTime() - Date.now()) / 60000)} minutes, or reset your password.`);
    }
    const ok = u && u.status === "active" && (await verifyPassword(password, u.password_hash));
    if (!ok) {
      if (u) await tx`update users set failed_logins = failed_logins + 1,
        locked_until = case when failed_logins + 1 >= ${MAX_FAILS} then now() + make_interval(mins => ${LOCK_MINUTES}) else null end where id = ${u.id}`;
      await log(false);
      throw new AppError("unauthenticated", u?.status === "invited" ? "Your account isn't activated yet. Use the link in your invite email." : "That email and password don't match.");
    }
    await tx`update users set failed_logins = 0, locked_until = null, last_login_at = now() where id = ${u.id}`;
    await log(true);
    return u.id;
  });
}

/** One-time token to carry a fresh signup from the apex domain onto the tenant's subdomain (cookies don't cross hosts). */
export async function createHandoff(tenantId: string, userId: string) {
  const token = newToken();
  await withTenant(tenantId, (tx) => tx`insert into auth_tokens (tenant_id, user_id, purpose, target, token_hash, expires_at)
    values (${tenantId}, ${userId}, 'login_otp', 'handoff', ${sha256(token)}, now() + interval '2 minutes')`);
  return token;
}

export async function consumeHandoff(tenantId: string, token: string) {
  return withTenant(tenantId, async (tx) => {
    const [t] = await tx<{ user_id: string }[]>`update auth_tokens set consumed_at = now()
      where token_hash = ${sha256(token)} and purpose = 'login_otp' and target = 'handoff' and consumed_at is null and expires_at > now()
      returning user_id`;
    return t?.user_id ?? null;
  });
}
