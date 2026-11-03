import type { NextRequest } from "next/server";
import { withTenant } from "@/server/db";
import { resolveTenant } from "@/server/auth/session";
import { authenticateApiKey, rateLimit } from "@/server/modules/integrations/service";
import { RESOURCES } from "@/server/modules/integrations/api";
import { bearerToken, API_SCOPES } from "@/server/modules/integrations/rules";

/**
 * Public REST API v1, read-only, on the workspace's own address: https://<workspace>.erp.app/api/v1/<resource>.
 * Authorization: Bearer <api key>. Keys are hashed, scoped and rate limited (120 requests/minute/key).
 *   GET /api/v1/me                 the key's scopes
 *   GET /api/v1/employees          ?status=&updated_since=&limit=&cursor=
 *   GET /api/v1/departments, /locations
 *   GET /api/v1/leave-requests     ?employee_id=&status=&from=&to=
 *   GET /api/v1/attendance         ?employee_id=&from=&to=
 */
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "private, no-store", ...headers } });
const problem = (status: number, code: string, message: string, headers?: Record<string, string>) => json({ error: { code, message } }, status, headers);

export async function GET(req: NextRequest, ctx: RouteContext<"/api/v1/[[...path]]">) {
  const { path = [] } = await ctx.params;
  const tenant = await resolveTenant(req.headers.get("x-erp-tenant"));
  if (!tenant) return problem(404, "unknown_workspace", "Use your workspace address, e.g. https://acme.erp.app/api/v1/employees.");
  const raw = bearerToken(req.headers.get("authorization"));
  if (!raw) return problem(401, "unauthenticated", "Send an API key as a Bearer token.", { "www-authenticate": "Bearer" });
  return withTenant(tenant.id, async (tx) => {
    const key = await authenticateApiKey(tx, tenant, raw);
    if (!key) return problem(401, "invalid_key", "This API key isn't valid for this workspace, was revoked, or the plan doesn't include the API.", { "www-authenticate": "Bearer" });
    const rl = rateLimit(key.id);
    const rlHeaders = { "x-ratelimit-limit": "120", "x-ratelimit-remaining": String(rl.remaining), "x-ratelimit-reset": String(rl.resetSec) };
    if (!rl.allowed) return problem(429, "rate_limited", "Slow down: 120 requests per minute per key.", { ...rlHeaders, "retry-after": String(rl.resetSec) });
    const [resource, ...rest] = path;
    if (!resource || resource === "me") return json({ data: { workspace: tenant.subdomain, scopes: key.scopes, resources: Object.keys(RESOURCES), scope_catalog: API_SCOPES } }, 200, rlHeaders);
    const r = RESOURCES[resource];
    if (!r || rest.length) return problem(404, "not_found", `Unknown resource. Try one of: ${Object.keys(RESOURCES).join(", ")}.`, rlHeaders);
    if (!key.scopes.includes(r.scope)) return problem(403, "insufficient_scope", `This key needs the ${r.scope} scope.`, rlHeaders);
    return json(await r.list(tx, req.nextUrl.searchParams), 200, rlHeaders);
  });
}
