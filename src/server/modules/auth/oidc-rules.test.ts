import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { decodeSsoCookie, encodeSsoCookie, issuerCheck, pkce, verifyIdToken, type Jwk } from "./oidc-rules";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: "jwk" }) as Jwk), kid: "k1", alg: "RS256" };
const mint = (claims: Record<string, unknown>, alg = "RS256", kid = "k1") => {
  const signed = `${b64url(JSON.stringify({ alg, kid, typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  const sig = sign("sha256", Buffer.from(signed), privateKey);
  return `${signed}.${b64url(sig)}`;
};
const now = new Date("2026-11-03T06:00:00Z");
const base = { iss: "https://accounts.google.com", aud: "client-1", sub: "u-1", exp: Math.floor(now.getTime() / 1000) + 300, iat: Math.floor(now.getTime() / 1000), nonce: "n1", email: "a@acme.in", email_verified: true };
const args = { keys: [jwk], issuer: issuerCheck("google"), audience: "client-1", nonce: "n1", now };

describe("id_token verification", () => {
  it("accepts a well-formed token signed by a listed key", () => {
    const r = verifyIdToken(mint(base), args);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claims.email).toBe("a@acme.in");
  });
  it("refuses bad signatures, other audiences, expiry, nonce and algorithm tricks", () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const otherJwk = { ...(other.publicKey.export({ format: "jwk" }) as Jwk), kid: "k1" };
    expect(verifyIdToken(mint(base), { ...args, keys: [otherJwk] })).toMatchObject({ ok: false, reason: "bad signature" });
    expect(verifyIdToken(mint({ ...base, aud: "someone-else" }), args)).toMatchObject({ ok: false, reason: /another app/ });
    expect(verifyIdToken(mint({ ...base, exp: base.iat - 1000 }), args)).toMatchObject({ ok: false, reason: "token expired" });
    expect(verifyIdToken(mint({ ...base, nonce: "other" }), args)).toMatchObject({ ok: false, reason: "nonce mismatch" });
    expect(verifyIdToken(mint({ ...base, iss: "https://evil.example" }), args)).toMatchObject({ ok: false, reason: /issuer/ });
    expect(verifyIdToken(mint(base, "none"), args)).toMatchObject({ ok: false, reason: /algorithm/ });
    expect(verifyIdToken("not.a.jwt", args).ok).toBe(false);
  });
  it("checks Microsoft issuers against the configured directory", () => {
    const common = issuerCheck("microsoft");
    expect(common("https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0")).toBe(true);
    expect(common("https://login.microsoftonline.com/x/v3.0")).toBe(false);
    const pinned = issuerCheck("microsoft", "9188040d-6c67-4c5b-b112-36a304b66dad");
    expect(pinned("https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0")).toBe(true);
    expect(pinned("https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0")).toBe(false);
  });
});

describe("pkce and state cookie", () => {
  it("round-trips the cookie and rejects tampering", () => {
    const p = pkce();
    expect(p.verifier.length).toBeGreaterThan(40);
    expect(p.challenge).not.toBe(p.verifier);
    const c = { provider: "google" as const, state: "s", nonce: "n", verifier: p.verifier, next: "//evil" };
    const back = decodeSsoCookie(encodeSsoCookie(c));
    expect(back?.next).toBe("/home");
    expect(back?.state).toBe("s");
    expect(decodeSsoCookie("garbage")).toBeNull();
  });
});
