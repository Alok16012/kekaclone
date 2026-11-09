import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AppError, type Tx } from "@/server/db";
import type { Actor, Tenant } from "@/server/auth/session";
import { sha256 } from "@/server/auth/password";
import { audit } from "@/server/modules/audit/service";
import { assertFeature, assertWorkspace, hasFeature } from "@/server/modules/saas/gate";
import { ACCESS_TOKEN_SECONDS, CLIENT_ID_PREFIX, CLIENT_SECRET_PREFIX, grantScopes, isClientId, isScope, looksLikeJwt, parseToken, signJwt, verifyJwt } from "./rules";
import { authenticateApiKey } from "./service";

/*
 * OAuth2 client credentials for the public API (plat2). A workspace admin creates a client (id + secret, the
 * secret is shown once and stored hashed); the integration exchanges them at POST /api/oauth/token for a one-hour
 * HS256 JWT carrying its scopes. API keys keep working side by side. Tokens are bound to the tenant (tid) and the
 * request's workspace host must match.
 */

const b36 = (n: number) => { let s = ""; while (s.length < n) s += randomBytes(16).toString("base64").replace(/[^a-z0-9]/g, ""); return s.slice(0, n); };

/** Token signing secret: ERP_JWT_SECRET, else derived from ERP_DATA_KEY (dev fallback mirrors payroll/secret). */
export function jwtSecret() {
  const explicit = process.env.ERP_JWT_SECRET?.trim();
  if (explicit) return explicit;
  const raw = process.env.ERP_DATA_KEY?.trim() || (process.env.NODE_ENV === "production" ? "" : "erp-local-development-key-do-not-use-in-production");
  if (!raw) throw new Error("ERP_JWT_SECRET or ERP_DATA_KEY must be set.");
  return createHash("sha256").update(`oauth-access-tokens|${raw}`).digest("hex");
}

export type OAuthClientRow = { id: string; name: string; client_id: string; scopes: string[]; last_used_at: string | null; revoked_at: string | null; created_at: string; created_by_name: string | null };

export async function listOAuthClients(tx: Tx, actor: Actor): Promise<OAuthClientRow[]> {
  assertWorkspace(actor, "settings.integrations");
  const rows = await tx<(Omit<OAuthClientRow, "last_used_at" | "revoked_at" | "created_at"> & { last_used_at: Date | null; revoked_at: Date | null; created_at: Date })[]>`
    select c.id, c.name, c.client_id, c.scopes, c.last_used_at, c.revoked_at, c.created_at, e.display_name as created_by_name
    from oauth_clients c left join employees e on e.user_id = c.created_by order by c.created_at desc`;
  return rows.map((r) => ({ ...r, last_used_at: r.last_used_at?.toISOString() ?? null, revoked_at: r.revoked_at?.toISOString() ?? null, created_at: r.created_at.toISOString() }));
}

/** Create a client; the secret is returned once and only its hash is stored. */
export async function createOAuthClient(tx: Tx, actor: Actor, input: { name: string; scopes: string[] }) {
  assertWorkspace(actor, "settings.integrations");
  assertFeature(actor, "api");
  const name = input.name.trim();
  if (!name) throw new AppError("invalid", "Give the client a name, e.g. the system that will use it.", "name");
  const scopes = [...new Set(input.scopes.filter(isScope))];
  if (!scopes.length) throw new AppError("invalid", "Pick at least one scope.", "scopes");
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from oauth_clients where revoked_at is null`;
  if (n >= 20) throw new AppError("invalid", "You can have up to 20 active clients. Revoke one first.");
  const clientId = `${CLIENT_ID_PREFIX}${b36(16)}`, secret = `${CLIENT_SECRET_PREFIX}${b36(40)}`;
  const [c] = await tx<{ id: string }[]>`insert into oauth_clients (tenant_id, name, client_id, secret_hash, scopes, created_by) values (${actor.tenant.id}, ${name}, ${clientId}, ${sha256(secret)}, ${scopes}, ${actor.userId}) returning id`;
  await audit(tx, actor, { entityType: "oauth_client", entityId: c.id, action: "create", diff: { name, scopes, client_id: clientId } });
  return { id: c.id, clientId, secret };
}

export async function revokeOAuthClient(tx: Tx, actor: Actor, id: string) {
  assertWorkspace(actor, "settings.integrations");
  const [c] = await tx<{ id: string; name: string }[]>`update oauth_clients set revoked_at = now() where id = ${id} and revoked_at is null returning id, name`;
  if (!c) throw new AppError("not_found", "That client doesn't exist or is already revoked.");
  await audit(tx, actor, { entityType: "oauth_client", entityId: c.id, action: "revoke", diff: { name: c.name } });
}

export type TokenProblem = { error: "invalid_request" | "invalid_client" | "invalid_scope" | "unsupported_grant_type" | "access_denied"; error_description: string };

/**
 * The token endpoint's logic: client credentials (Basic auth or body) → short-lived JWT. Inside the tenant, so a
 * client id from another workspace is simply not found.
 */
export async function issueAccessToken(tx: Tx, tenant: Tenant, a: { grantType: string | null; clientId: string | null; clientSecret: string | null; scope: string | null }, now = new Date())
  : Promise<{ ok: true; access_token: string; token_type: "Bearer"; expires_in: number; scope: string } | { ok: false; status: number; body: TokenProblem }> {
  const bad = (status: number, error: TokenProblem["error"], error_description: string) => ({ ok: false as const, status, body: { error, error_description } });
  if (a.grantType !== "client_credentials") return bad(400, "unsupported_grant_type", "Use grant_type=client_credentials.");
  if (!hasFeature({ tenant }, "api")) return bad(403, "access_denied", "The public API isn't included in this workspace's plan.");
  if (!isClientId(a.clientId) || !a.clientSecret?.startsWith(CLIENT_SECRET_PREFIX)) return bad(401, "invalid_client", "Unknown client id or secret.");
  const [c] = await tx<{ id: string; scopes: string[] }[]>`select id, scopes from oauth_clients where client_id = ${a.clientId} and secret_hash = ${sha256(a.clientSecret)} and revoked_at is null`;
  if (!c) return bad(401, "invalid_client", "Unknown client id or secret.");
  const g = grantScopes(a.scope, c.scopes);
  if (!g.ok) return bad(400, "invalid_scope", `This client can't use the ${g.bad} scope.`);
  await tx`update oauth_clients set last_used_at = ${now} where id = ${c.id}`;
  const iat = Math.floor(now.getTime() / 1000);
  const token = signJwt(jwtSecret(), { iss: tenant.subdomain, sub: a.clientId, tid: tenant.id, scope: g.scopes.join(" "), iat, exp: iat + ACCESS_TOKEN_SECONDS, jti: randomUUID() });
  return { ok: true, access_token: token, token_type: "Bearer", expires_in: ACCESS_TOKEN_SECONDS, scope: g.scopes.join(" ") };
}

export type ApiPrincipal = { kind: "api_key" | "oauth_client"; id: string; ref: string; scopes: string[] };

/** Either an API key (erp_live_…) or an OAuth access token; both scoped, both bound to this workspace. */
export async function authenticateBearer(tx: Tx, tenant: Tenant, raw: string | null, now = new Date()): Promise<ApiPrincipal | null> {
  if (!raw) return null;
  if (parseToken(raw)) {
    const k = await authenticateApiKey(tx, tenant, raw);
    return k ? { kind: "api_key", id: k.id, ref: `key:${k.id}`, scopes: k.scopes } : null;
  }
  if (looksLikeJwt(raw)) {
    const c = verifyJwt(jwtSecret(), raw, Math.floor(now.getTime() / 1000));
    if (!c || c.tid !== tenant.id || !hasFeature({ tenant }, "api")) return null;
    const [client] = await tx<{ id: string }[]>`select id from oauth_clients where client_id = ${c.sub} and revoked_at is null`;
    if (!client) return null;   // revoked after the token was issued
    return { kind: "oauth_client", id: client.id, ref: `client:${c.sub}`, scopes: c.scope.split(" ").filter(Boolean) };
  }
  return null;
}
