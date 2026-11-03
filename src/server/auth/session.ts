import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { sql, withTenant } from "@/server/db";
import { newToken, sha256 } from "./password";
import type { Scope } from "./catalog";
import { ipAllowed, readAuthSettings, type AuthSettings } from "./network-rules";
import type { Plan } from "@/server/modules/saas/plans";

const COOKIE = process.env.SESSION_COOKIE ?? "erp_session";

export type Branding = { logo_file_id?: string | null; accent?: string | null; accent_dark?: string | null; login_note?: string | null };
export type Tenant = {
  id: string; name: string; status: string; subdomain: string;
  /** plan, trial and sign-in settings come from the public tenant lookup; scripts may leave them out */
  plan?: Plan; trialEndsAt?: string | null; seats?: number; authSettings?: AuthSettings; branding?: Branding;
};
export type Actor = {
  tenant: Tenant;
  userId: string;
  employeeId: string;
  name: string;
  email: string;
  title: string | null;
  roles: string[];
  permissions: Set<string>;
  /** each role assignment: its permissions and where they apply ([] = whole company) */
  grants: { permissions: string[]; scopes: Scope[] }[];
};

export async function currentSubdomain() {
  return (await headers()).get("x-erp-tenant");
}

export async function resolveTenant(subdomain: string | null): Promise<Tenant | null> {
  if (!subdomain) return null;
  const [t] = await sql<{ id: string; name: string; status: string; plan: Plan; trial_ends_at: Date | null; seats: number; auth_settings: unknown; branding: Branding | null }[]>`
    select id, name, status, plan, trial_ends_at, seats, auth_settings, branding from tenant_by_subdomain(${subdomain})`;
  if (!t) return null;
  return { id: t.id, name: t.name, status: t.status, subdomain, plan: t.plan, trialEndsAt: t.trial_ends_at?.toISOString() ?? null, seats: t.seats, authSettings: readAuthSettings(t.auth_settings), branding: t.branding ?? {} };
}

/** The caller's address as the proxy reports it (null on a direct local connection). */
export async function clientIp() {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
}

/** Session length comes from the company's sign-in settings (default 14 days). */
export async function createSession(tenantId: string, userId: string) {
  const token = newToken();
  const h = await headers();
  const [t] = await withTenant(tenantId, (tx) => tx<{ auth_settings: unknown }[]>`select auth_settings from tenants where id = ${tenantId}`);
  const expires = new Date(Date.now() + readAuthSettings(t?.auth_settings).session_hours * 3600e3);
  await withTenant(tenantId, (tx) => tx`
    insert into sessions (tenant_id, user_id, token_hash, expires_at, ip, user_agent)
    values (${tenantId}, ${userId}, ${sha256(token)}, ${expires}, ${h.get("x-forwarded-for")?.split(",")[0] ?? null}, ${h.get("user-agent")})`);
  (await cookies()).set(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", expires });
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  const tenant = await resolveTenant(await currentSubdomain());
  if (token && tenant) await withTenant(tenant.id, (tx) => tx`delete from sessions where token_hash = ${sha256(token)}`);
  jar.delete(COOKIE);
}

/** The signed-in person on this tenant, or null. Request-time read: call it inside a Suspense boundary. */
export const getActor = cache(async function getActor(): Promise<Actor | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const tenant = await resolveTenant(await currentSubdomain());
  if (!tenant) return null;
  // IP allowlist (Settings → Sign-in security): an existing session stops working as soon as the network isn't allowed
  if (!ipAllowed(await clientIp(), tenant.authSettings?.ip_allowlist ?? [])) return null;
  return withTenant(tenant.id, async (tx) => {
    const [row] = await tx<{ user_id: string; email: string; employee_id: string; display_name: string; title: string | null }[]>`
      select u.id as user_id, u.email, e.id as employee_id, e.display_name, d.title
      from sessions s
      join users u on u.id = s.user_id and u.status = 'active'
      join employees e on e.user_id = u.id and e.status <> 'relieved'
      left join designations d on d.id = e.designation_id
      where s.token_hash = ${sha256(token)} and s.expires_at > now()`;
    if (!row) return null;
    const roles = await tx<{ key: string; permissions: string[]; scopes: Scope[] }[]>`
      select r.key, r.permissions, ra.scopes from role_assignments ra join roles r on r.id = ra.role_id where ra.employee_id = ${row.employee_id}`;
    return {
      tenant, userId: row.user_id, employeeId: row.employee_id, name: row.display_name, email: row.email, title: row.title,
      roles: roles.map((r) => r.key), permissions: new Set(roles.flatMap((r) => r.permissions)),
      grants: roles.map((r) => ({ permissions: r.permissions, scopes: r.scopes ?? [] })),
    };
  });
});

export async function requireActor(): Promise<Actor> {
  const a = await getActor();
  if (!a) redirect("/login");
  return a;
}

export { can, assertCan } from "./permissions";
