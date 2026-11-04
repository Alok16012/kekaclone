import { withTenant } from "@/server/db";
import { resolveTenant } from "@/server/auth/session";
import { issueAccessToken } from "@/server/modules/integrations/oauth";

/**
 * OAuth2 token endpoint (client credentials only), on the workspace's own address:
 *   POST https://<workspace>.<root>/api/oauth/token
 *   Content-Type: application/x-www-form-urlencoded (JSON also accepted)
 *   grant_type=client_credentials&scope=employees:read leave:read
 *   Authorization: Basic base64(client_id:client_secret)   — or client_id / client_secret in the body
 * Answers { access_token, token_type: "Bearer", expires_in: 3600, scope } or an RFC 6749 error.
 */
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store", pragma: "no-cache" } });

async function readForm(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) { try { return Object.fromEntries(Object.entries((await req.json()) ?? {}).map(([k, v]) => [k, String(v)])); } catch { return {}; } }
  try { return Object.fromEntries(new URLSearchParams(await req.text())); } catch { return {}; }
}

export async function POST(req: Request) {
  const tenant = await resolveTenant(req.headers.get("x-erp-tenant"));
  if (!tenant) return json({ error: "invalid_request", error_description: "Use your workspace address, e.g. https://acme.erp.app/api/oauth/token." }, 404);
  const form = await readForm(req);
  let clientId = form.client_id ?? null, clientSecret = form.client_secret ?? null;
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Basic ")) {
    const [id, ...rest] = Buffer.from(auth.slice(6), "base64").toString("utf8").split(":");
    clientId = decodeURIComponent(id ?? ""); clientSecret = decodeURIComponent(rest.join(":"));
  }
  const r = await withTenant(tenant.id, (tx) => issueAccessToken(tx, tenant, { grantType: form.grant_type ?? null, clientId, clientSecret, scope: form.scope ?? null }));
  if (!r.ok) return json(r.body, r.status);
  return json({ access_token: r.access_token, token_type: r.token_type, expires_in: r.expires_in, scope: r.scope });
}

export function GET() {
  return json({ error: "invalid_request", error_description: "POST grant_type=client_credentials with your client id and secret." }, 405);
}
