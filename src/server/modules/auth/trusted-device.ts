import "server-only";
import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { withTenant, type Tx } from "@/server/db";
import type { Tenant } from "@/server/auth/session";
import { newToken, sha256 } from "@/server/auth/password";
import { deviceCookieValue, parseDeviceCookie, TRUSTED_DEVICE_DAYS } from "./device-rules";

const COOKIE = "erp_device";

/** Store a new trusted-device token for this user; returns the cookie value. */
export async function createTrustedDevice(tx: Tx, tenantId: string, userId: string) {
  const secret = newToken();
  const [t] = await tx<{ id: string }[]>`
    insert into auth_tokens (tenant_id, user_id, purpose, target, token_hash, expires_at)
    values (${tenantId}, ${userId}, 'trusted_device', 'device', ${sha256(secret)}, now() + make_interval(days => ${TRUSTED_DEVICE_DAYS})) returning id`;
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action) values (${tenantId}, ${userId}, 'user', ${userId}, 'device.trusted')`;
  return deviceCookieValue(t.id, secret);
}

/** True if the cookie value is a live trusted-device token belonging to this exact user. */
export async function checkTrustedDevice(tx: Tx, userId: string, cookieValue: string | null | undefined) {
  const c = parseDeviceCookie(cookieValue);
  if (!c) return false;
  const [t] = await tx<{ token_hash: string }[]>`
    select token_hash from auth_tokens where id = ${c.id} and user_id = ${userId} and purpose = 'trusted_device' and consumed_at is null and expires_at > now()`;
  return !!t && timingSafeEqual(Buffer.from(sha256(c.secret)), Buffer.from(t.token_hash));
}

/** Request-time wrappers used by the sign-in actions. */
export async function rememberThisDevice(tenant: Tenant, userId: string) {
  const value = await withTenant(tenant.id, (tx) => createTrustedDevice(tx, tenant.id, userId));
  (await cookies()).set(COOKIE, value, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: TRUSTED_DEVICE_DAYS * 86400 });
}

export async function isTrustedDevice(tenant: Tenant, userId: string) {
  const value = (await cookies()).get(COOKIE)?.value;
  if (!value) return false;
  return withTenant(tenant.id, (tx) => checkTrustedDevice(tx, userId, value));
}
