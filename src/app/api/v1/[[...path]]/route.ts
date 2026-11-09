import type { NextRequest } from "next/server";
import { withTenant } from "@/server/db";
import { resolveTenant } from "@/server/auth/session";
import { deliverQueued } from "@/server/email";
import { deliverWebhooks, rateLimit } from "@/server/modules/integrations/service";
import { authenticateBearer, type ApiPrincipal } from "@/server/modules/integrations/oauth";
import { RESOURCES } from "@/server/modules/integrations/api";
import { ApiProblem, createLeaveRequest, createPunch, listHooks, pollTrigger, samplePayload, subscribeHook, unsubscribeHook } from "@/server/modules/integrations/api-write";
import { openapiDocument } from "@/server/modules/integrations/openapi";
import { bearerToken, API_SCOPES } from "@/server/modules/integrations/rules";

/**
 * Public REST API v1 on the workspace's own address: https://<workspace>.erp.app/api/v1/<resource>.
 * Authorization: Bearer <API key> or Bearer <OAuth2 access token from /api/oauth/token>. Scoped, rate limited (120/min).
 *   GET  /api/v1/openapi.json       the OpenAPI description (no auth)
 *   GET  /api/v1/me                 the credential's scopes
 *   GET  /api/v1/employees | departments | locations | leave-requests | attendance     (paged, see openapi.json)
 *   POST /api/v1/leave-requests     leave:write        POST /api/v1/attendance/punches   attendance:write
 *   GET/POST /api/v1/hooks, DELETE /api/v1/hooks/:id   hooks:write (Zapier REST hooks)
 *   GET  /api/v1/hooks/sample/:event, GET /api/v1/triggers/:event                      (any scope)
 */
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "private, no-store", ...headers } });
const problem = (status: number, code: string, message: string, headers?: Record<string, string>) => json({ error: { code, message } }, status, headers);

type Handler = (ctx: { tx: Parameters<Parameters<typeof withTenant>[1]>[0]; tenant: NonNullable<Awaited<ReturnType<typeof resolveTenant>>>; principal: ApiPrincipal; path: string[]; req: NextRequest; rl: Record<string, string> }) => Promise<Response>;

async function handle(req: NextRequest, ctx: RouteContext<"/api/v1/[[...path]]">, fn: Handler) {
  const { path = [] } = await ctx.params;
  const host = req.headers.get("host") ?? "";
  if (req.method === "GET" && path.join("/") === "openapi.json") return json(openapiDocument(host), 200, { "cache-control": "public, max-age=300" });
  const tenant = await resolveTenant(req.headers.get("x-erp-tenant"));
  if (!tenant) return problem(404, "unknown_workspace", "Use your workspace address, e.g. https://acme.erp.app/api/v1/employees.");
  const raw = bearerToken(req.headers.get("authorization"));
  if (!raw) return problem(401, "unauthenticated", "Send an API key or an OAuth2 access token as a Bearer token.", { "www-authenticate": "Bearer" });
  const res = await withTenant(tenant.id, async (tx) => {
    const principal = await authenticateBearer(tx, tenant, raw);
    if (!principal) return problem(401, "invalid_credentials", "This key or token isn't valid for this workspace, was revoked, expired, or the plan doesn't include the API.", { "www-authenticate": "Bearer" });
    const rl = rateLimit(principal.ref);
    const rlHeaders = { "x-ratelimit-limit": "120", "x-ratelimit-remaining": String(rl.remaining), "x-ratelimit-reset": String(rl.resetSec) };
    if (!rl.allowed) return problem(429, "rate_limited", "Slow down: 120 requests per minute per credential.", { ...rlHeaders, "retry-after": String(rl.resetSec) });
    try {
      return await fn({ tx, tenant, principal, path, req, rl: rlHeaders });
    } catch (e) {
      if (e instanceof ApiProblem) return problem(e.status, e.code, e.message, rlHeaders);
      console.error(e);
      return problem(500, "server_error", "Something went wrong on our side.", rlHeaders);
    }
  });
  if (req.method !== "GET") { await deliverQueued(tenant.id).catch(() => {}); await deliverWebhooks(tenant.id).catch(() => {}); }
  return res;
}

const needs = (principal: ApiPrincipal, scope: string, rl: Record<string, string>) => (principal.scopes.includes(scope) ? null : problem(403, "insufficient_scope", `This credential needs the ${scope} scope.`, rl));

export function GET(req: NextRequest, ctx: RouteContext<"/api/v1/[[...path]]">) {
  return handle(req, ctx, async ({ tx, tenant, principal, path, rl }) => {
    const [resource, ...rest] = path;
    if (!resource || resource === "me") return json({ data: { workspace: tenant.subdomain, credential: principal.kind, scopes: principal.scopes, resources: Object.keys(RESOURCES), scope_catalog: API_SCOPES } }, 200, rl);
    if (resource === "hooks" && rest[0] === "sample" && rest[1]) return json({ data: samplePayload(rest[1]) }, 200, rl);
    if (resource === "hooks" && !rest.length) return needs(principal, "hooks:write", rl) ?? json({ data: await listHooks(tx, principal) }, 200, rl);
    if (resource === "triggers" && rest[0]) return json({ data: await pollTrigger(tx, rest[0], Number(req.nextUrl.searchParams.get("limit") ?? 25) || 25) }, 200, rl);
    const r = RESOURCES[resource];
    if (!r || rest.length) return problem(404, "not_found", `Unknown resource. Try one of: ${Object.keys(RESOURCES).join(", ")}, hooks, triggers.`, rl);
    return needs(principal, r.scope, rl) ?? json(await r.list(tx, req.nextUrl.searchParams), 200, rl);
  });
}

export function POST(req: NextRequest, ctx: RouteContext<"/api/v1/[[...path]]">) {
  return handle(req, ctx, async ({ tx, tenant, principal, path, rl }) => {
    let body: Record<string, unknown>;
    try { body = ((await req.json()) ?? {}) as Record<string, unknown>; } catch { return problem(400, "invalid_request", "The body isn't valid JSON.", rl); }
    const key = path.join("/");
    if (key === "leave-requests") return needs(principal, "leave:write", rl) ?? json({ data: await createLeaveRequest(tx, tenant, body) }, 201, rl);
    if (key === "attendance/punches") return needs(principal, "attendance:write", rl) ?? json({ data: await createPunch(tx, tenant, body) }, 201, rl);
    if (key === "hooks") {
      const denied = needs(principal, "hooks:write", rl);
      if (denied) return denied;
      const h = await subscribeHook(tx, tenant, principal, body);
      return json({ data: h }, h.existing ? 200 : 201, rl);
    }
    return problem(404, "not_found", "Nothing to POST here. See /api/v1/openapi.json.", rl);
  });
}

export function DELETE(req: NextRequest, ctx: RouteContext<"/api/v1/[[...path]]">) {
  return handle(req, ctx, async ({ tx, principal, path, rl }) => {
    if (path[0] === "hooks" && path[1] && path.length === 2) {
      const denied = needs(principal, "hooks:write", rl);
      if (denied) return denied;
      await unsubscribeHook(tx, principal, path[1]);
      return new Response(null, { status: 204, headers: rl });
    }
    return problem(404, "not_found", "Nothing to DELETE here. See /api/v1/openapi.json.", rl);
  });
}
