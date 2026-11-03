import "server-only";
import { AppError, withTenant, type Tx } from "@/server/db";
import type { Tenant } from "@/server/auth/session";
import { domainAllowed } from "@/server/auth/network-rules";
import { issuerCheck, pkce, randomState, verifyIdToken, type IdClaims, type Jwk, type SsoProvider } from "./oidc-rules";

/**
 * Google / Microsoft (Entra) sign-in with OpenID Connect: authorization code + PKCE, state and nonce in an httpOnly
 * cookie, id_token verified against the provider's JWKS. erp never creates accounts from SSO: it links the identity
 * to an existing active user with the same verified email (just-in-time link), optionally restricted to listed domains.
 * Disabled until the client id and secret are in the environment.
 */

type ProviderEnv = { clientId: string; clientSecret: string };
function env(provider: SsoProvider): ProviderEnv | null {
  const p = provider === "google" ? "GOOGLE" : "MICROSOFT";
  const clientId = process.env[`${p}_CLIENT_ID`]?.trim(), clientSecret = process.env[`${p}_CLIENT_SECRET`]?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function ssoProviderStatus() {
  return {
    google: { configured: !!env("google"), hint: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local" },
    microsoft: { configured: !!env("microsoft"), hint: "MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET in .env.local" },
  };
}

/** Which buttons the login page shows: the provider is on for the company and configured on the server. */
export function ssoButtons(tenant: Tenant): SsoProvider[] {
  const a = tenant.authSettings;
  if (!a) return [];
  return (["google", "microsoft"] as const).filter((p) => a[p] && env(p));
}

type Discovery = { authorization_endpoint: string; token_endpoint: string; jwks_uri: string; issuer: string };
const discoveryCache = new Map<string, { at: number; doc: Discovery }>();
const jwksCache = new Map<string, { at: number; keys: Jwk[] }>();
const HOUR = 3600e3;

function discoveryUrl(provider: SsoProvider, microsoftTenant?: string | null) {
  return provider === "google" ? "https://accounts.google.com/.well-known/openid-configuration"
    : `https://login.microsoftonline.com/${encodeURIComponent(microsoftTenant?.trim() || "common")}/v2.0/.well-known/openid-configuration`;
}

async function discover(provider: SsoProvider, microsoftTenant?: string | null): Promise<Discovery> {
  const url = discoveryUrl(provider, microsoftTenant);
  const hit = discoveryCache.get(url);
  if (hit && Date.now() - hit.at < 12 * HOUR) return hit.doc;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new AppError("invalid", "The sign-in provider isn't reachable right now. Try again in a minute.");
  const doc = (await res.json()) as Discovery;
  discoveryCache.set(url, { at: Date.now(), doc });
  return doc;
}

async function jwks(uri: string, force = false): Promise<Jwk[]> {
  const hit = jwksCache.get(uri);
  if (hit && !force && Date.now() - hit.at < 6 * HOUR) return hit.keys;
  const res = await fetch(uri, { cache: "no-store" });
  if (!res.ok) throw new AppError("invalid", "The sign-in provider isn't reachable right now. Try again in a minute.");
  const keys = ((await res.json()) as { keys: Jwk[] }).keys ?? [];
  jwksCache.set(uri, { at: Date.now(), keys });
  return keys;
}

/** Build the provider's authorization URL and the values to keep in the cookie until the callback. */
export async function beginSso(provider: SsoProvider, tenant: Tenant, redirectUri: string, next: string) {
  const e = env(provider);
  if (!e || !tenant.authSettings?.[provider]) throw new AppError("forbidden", "This sign-in method isn't available for your company.");
  const doc = await discover(provider, tenant.authSettings.microsoft_tenant);
  const { verifier, challenge } = pkce();
  const state = randomState(), nonce = randomState();
  const u = new URL(doc.authorization_endpoint);
  u.searchParams.set("client_id", e.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", state);
  u.searchParams.set("nonce", nonce);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (provider === "google") { u.searchParams.set("prompt", "select_account"); u.searchParams.set("access_type", "online"); }
  else u.searchParams.set("response_mode", "query");
  return { url: u.toString(), cookie: { provider, state, nonce, verifier, next } };
}

/** Exchange the code and verify the id_token. Returns verified claims. */
export async function finishSso(provider: SsoProvider, tenant: Tenant, a: { code: string; redirectUri: string; verifier: string; nonce: string }): Promise<IdClaims> {
  const e = env(provider);
  if (!e) throw new AppError("forbidden", "This sign-in method isn't available for your company.");
  const doc = await discover(provider, tenant.authSettings?.microsoft_tenant);
  const body = new URLSearchParams({ grant_type: "authorization_code", code: a.code, redirect_uri: a.redirectUri, client_id: e.clientId, client_secret: e.clientSecret, code_verifier: a.verifier });
  const res = await fetch(doc.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, cache: "no-store" });
  const json = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
  if (!res.ok || !json.id_token) throw new AppError("invalid", `The provider refused the sign-in${json.error_description ? `: ${json.error_description}` : ""}.`);
  const check = (keys: Jwk[]) => verifyIdToken(json.id_token!, { keys, issuer: issuerCheck(provider, tenant.authSettings?.microsoft_tenant), audience: e.clientId, nonce: a.nonce });
  let r = check(await jwks(doc.jwks_uri));
  if (!r.ok && r.reason === "bad signature") r = check(await jwks(doc.jwks_uri, true));   // keys rotated
  if (!r.ok) throw new AppError("invalid", `We couldn't verify the sign-in (${r.reason}).`);
  return r.claims;
}

/**
 * Turn verified claims into a signed-in user: email must be verified and on an allowed domain, the person must already
 * have an active account, and the provider identity is linked on first use (and must match afterwards).
 */
export async function linkSsoIdentity(tx: Tx, tenant: Tenant, provider: SsoProvider, claims: IdClaims, ctx: { ip: string | null; userAgent: string | null }) {
  const email = (claims.email ?? claims.preferred_username ?? "").trim().toLowerCase();
  const log = (userId: string | null, success: boolean) => tx`insert into login_events (tenant_id, user_id, email, method, success, ip, user_agent) values (${tenant.id}, ${userId}, ${email || null}, ${provider}, ${success}, ${ctx.ip}, ${ctx.userAgent})`;
  const refuse = async (msg: string, userId: string | null = null) => { await log(userId, false); throw new AppError("forbidden", msg); };
  if (!email || !email.includes("@")) return refuse("The provider didn't share an email address, so we can't match you to an account.");
  if (provider === "google" && claims.email_verified === false) return refuse("This Google account's email isn't verified.");
  if (!domainAllowed(email, tenant.authSettings?.sso_domains ?? [])) return refuse(`Accounts on ${email.split("@")[1]} can't sign in to this workspace with SSO.`);
  const [u] = await tx<{ id: string; status: string }[]>`select id, status from users where email = ${email}`;
  if (!u) return refuse(`There's no ${tenant.name} account for ${email}. Ask HR to add you first.`);
  if (u.status !== "active") return refuse("Your account isn't activated yet. Use the link in your invite email first.");
  const [link] = await tx<{ user_id: string }[]>`select user_id from auth_accounts where provider = ${provider} and subject = ${claims.sub}`;
  if (link && link.user_id !== u.id) return refuse("This identity is already linked to a different account.", u.id);
  const [mine] = await tx<{ subject: string }[]>`select subject from auth_accounts where provider = ${provider} and user_id = ${u.id}`;
  if (mine && mine.subject !== claims.sub) return refuse("Your account is linked to a different identity at this provider. Ask an admin to reset it.", u.id);
  if (!link) {
    await tx`insert into auth_accounts (tenant_id, user_id, provider, subject) values (${tenant.id}, ${u.id}, ${provider}, ${claims.sub})`;
    await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${tenant.id}, ${u.id}, 'user', ${u.id}, 'sso.linked', ${tx.json({ provider })})`;
  }
  await tx`update users set failed_logins = 0, locked_until = null, last_login_at = now(), email_verified_at = coalesce(email_verified_at, now()) where id = ${u.id}`;
  await log(u.id, true);
  return u.id;
}

export async function completeSso(tenant: Tenant, provider: SsoProvider, claims: IdClaims, ctx: { ip: string | null; userAgent: string | null }) {
  return withTenant(tenant.id, (tx) => linkSsoIdentity(tx, tenant, provider, claims, ctx));
}
