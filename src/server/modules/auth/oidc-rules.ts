/**
 * OpenID Connect pieces that need no network: PKCE, state cookies and id_token verification (RS256 against a JWKS).
 * Pure except for node:crypto, so it is unit-tested with a locally generated key pair.
 */
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify, type JsonWebKey as NodeJwk } from "node:crypto";

export type SsoProvider = "google" | "microsoft";
export const SSO_PROVIDERS: SsoProvider[] = ["google", "microsoft"];
export const isSsoProvider = (v: unknown): v is SsoProvider => v === "google" || v === "microsoft";
export const SSO_COOKIE = "erp_sso";
export const SSO_LABELS: Record<SsoProvider, string> = { google: "Google", microsoft: "Microsoft" };

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** PKCE: a random verifier and its S256 challenge. */
export function pkce() {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export const randomState = () => b64url(randomBytes(24));

export type SsoCookie = { provider: SsoProvider; state: string; nonce: string; verifier: string; next: string };

export function encodeSsoCookie(c: SsoCookie) { return b64url(Buffer.from(JSON.stringify(c), "utf8")); }
export function decodeSsoCookie(raw: string | undefined | null): SsoCookie | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(fromB64url(raw).toString("utf8")) as Partial<SsoCookie>;
    if (!isSsoProvider(c.provider) || typeof c.state !== "string" || typeof c.nonce !== "string" || typeof c.verifier !== "string") return null;
    const next = typeof c.next === "string" && c.next.startsWith("/") && !c.next.startsWith("//") ? c.next : "/home";
    return { provider: c.provider, state: c.state, nonce: c.nonce, verifier: c.verifier, next };
  } catch { return null; }
}

export type IdClaims = { iss: string; aud: string | string[]; sub: string; exp: number; iat?: number; nonce?: string; email?: string; email_verified?: boolean; name?: string; tid?: string; hd?: string; preferred_username?: string };

export function decodeJwt(token: string): { header: { alg?: string; kid?: string }; claims: IdClaims; signed: string; signature: Buffer } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return { header: JSON.parse(fromB64url(parts[0]).toString("utf8")), claims: JSON.parse(fromB64url(parts[1]).toString("utf8")), signed: `${parts[0]}.${parts[1]}`, signature: fromB64url(parts[2]) };
  } catch { return null; }
}

export type Jwk = NodeJwk & { kid?: string; alg?: string; use?: string };

/**
 * Verify an id_token: RS256 signature against the provider's keys, issuer, audience, expiry and nonce.
 * Returns the claims or the reason it was refused.
 */
export function verifyIdToken(token: string, a: { keys: Jwk[]; issuer: (iss: string) => boolean; audience: string; nonce: string; now?: Date; skewSeconds?: number }):
  { ok: true; claims: IdClaims } | { ok: false; reason: string } {
  const t = decodeJwt(token);
  if (!t) return { ok: false, reason: "malformed token" };
  if (t.header.alg !== "RS256") return { ok: false, reason: `unsupported algorithm ${t.header.alg ?? "none"}` };
  const candidates = t.header.kid ? a.keys.filter((k) => k.kid === t.header.kid) : a.keys;
  const valid = candidates.some((k) => {
    try { return cryptoVerify("sha256", Buffer.from(t.signed, "utf8"), createPublicKey({ key: k, format: "jwk" }), t.signature); } catch { return false; }
  });
  if (!valid) return { ok: false, reason: "bad signature" };
  const c = t.claims;
  if (!a.issuer(c.iss)) return { ok: false, reason: `unexpected issuer ${c.iss}` };
  const auds = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!auds.includes(a.audience)) return { ok: false, reason: "token is for another app" };
  const now = Math.floor((a.now ?? new Date()).getTime() / 1000), skew = a.skewSeconds ?? 120;
  if (typeof c.exp !== "number" || c.exp + skew < now) return { ok: false, reason: "token expired" };
  if (typeof c.iat === "number" && c.iat - skew > now) return { ok: false, reason: "token from the future" };
  if (c.nonce !== a.nonce) return { ok: false, reason: "nonce mismatch" };
  if (typeof c.sub !== "string" || !c.sub) return { ok: false, reason: "no subject" };
  return { ok: true, claims: c };
}

/** Issuer rules per provider. Microsoft's issuer carries the directory (tenant) id; "common" sign-in accepts any. */
export function issuerCheck(provider: SsoProvider, microsoftTenant?: string | null) {
  if (provider === "google") return (iss: string) => iss === "https://accounts.google.com" || iss === "accounts.google.com";
  const m = /^https:\/\/login\.microsoftonline\.com\/([^/]+)\/v2\.0$/;
  return (iss: string) => {
    const x = m.exec(iss);
    if (!x) return false;
    return !microsoftTenant || !/^[0-9a-f-]{36}$/i.test(microsoftTenant) || x[1].toLowerCase() === microsoftTenant.toLowerCase();
  };
}
