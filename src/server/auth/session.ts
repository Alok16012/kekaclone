import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { sql, withTenant } from "@/server/db";
import { newToken, sha256 } from "./password";

const COOKIE = process.env.SESSION_COOKIE ?? "erp_session";
const TTL_DAYS = 14;

export type Tenant = { id: string; name: string; status: string; subdomain: string };
export type Actor = {
  tenant: Tenant;
  userId: string;
  employeeId: string;
  name: string;
  email: string;
  title: string | null;
  roles: string[];
  permissions: Set<string>;
};

export async function currentSubdomain() {
  return (await headers()).get("x-erp-tenant");
}

export async function resolveTenant(subdomain: string | null): Promise<Tenant | null> {
  if (!subdomain) return null;
  const [t] = await sql<{ id: string; name: string; status: string }[]>`select id, name, status from tenant_by_subdomain(${subdomain})`;
  return t ? { ...t, subdomain } : null;
}

export async function createSession(tenantId: string, userId: string) {
  const token = newToken();
  const h = await headers();
  const expires = new Date(Date.now() + TTL_DAYS * 864e5);
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
  return withTenant(tenant.id, async (tx) => {
    const [row] = await tx<{ user_id: string; email: string; employee_id: string; display_name: string; title: string | null }[]>`
      select u.id as user_id, u.email, e.id as employee_id, e.display_name, d.title
      from sessions s
      join users u on u.id = s.user_id and u.status = 'active'
      join employees e on e.user_id = u.id and e.status <> 'relieved'
      left join designations d on d.id = e.designation_id
      where s.token_hash = ${sha256(token)} and s.expires_at > now()`;
    if (!row) return null;
    const roles = await tx<{ key: string; permissions: string[] }[]>`
      select r.key, r.permissions from role_assignments ra join roles r on r.id = ra.role_id where ra.employee_id = ${row.employee_id}`;
    return {
      tenant, userId: row.user_id, employeeId: row.employee_id, name: row.display_name, email: row.email, title: row.title,
      roles: roles.map((r) => r.key), permissions: new Set(roles.flatMap((r) => r.permissions)),
    };
  });
});

export async function requireActor(): Promise<Actor> {
  const a = await getActor();
  if (!a) redirect("/login");
  return a;
}

export { can, assertCan } from "./permissions";
