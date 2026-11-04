/**
 * Public API and webhooks: the parts with no I/O. Token format, scopes, event catalogue, request signing and the
 * retry schedule. Pure, so they are unit-tested and shared with the settings screen.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const API_SCOPES = [
  { key: "employees:read", label: "Read employees (directory fields only, no pay or identity numbers)" },
  { key: "departments:read", label: "Read departments" },
  { key: "locations:read", label: "Read locations" },
  { key: "leave:read", label: "Read leave requests" },
  { key: "attendance:read", label: "Read attendance days" },
  { key: "leave:write", label: "Apply for leave on someone's behalf (creates a normal request that goes for approval)" },
  { key: "attendance:write", label: "Record clock-in / clock-out punches" },
  { key: "hooks:write", label: "Subscribe to events (Zapier-style REST hooks)" },
] as const;
export type ApiScope = (typeof API_SCOPES)[number]["key"];
export const ALL_SCOPES: string[] = API_SCOPES.map((s) => s.key);
export const isScope = (v: unknown): v is ApiScope => typeof v === "string" && ALL_SCOPES.includes(v);

export const WEBHOOK_EVENTS = [
  { key: "approval.decided", label: "A request was approved or declined (leave, attendance, expenses, …)" },
  { key: "employee.created", label: "A person was added" },
  { key: "employee.exited", label: "A person's exit was completed" },
  { key: "payroll.finalized", label: "A payroll run was finalised" },
  { key: "leave.approved", label: "A leave request was approved" },
  { key: "test.ping", label: "Test event sent from Settings" },
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]["key"];
export const ALL_EVENTS: string[] = WEBHOOK_EVENTS.map((e) => e.key);
export const isEvent = (v: unknown): v is WebhookEvent => typeof v === "string" && ALL_EVENTS.includes(v);

export const TOKEN_PREFIX = "erp_live_";
/** erp_live_<8 char prefix>_<secret>. The prefix is stored in clear to show which key was used; the hash covers the whole token. */
export function parseToken(raw: string | null | undefined): { token: string; prefix: string } | null {
  const token = (raw ?? "").trim();
  const m = /^erp_live_([a-z0-9]{8})_([a-z0-9]{32,64})$/.exec(token);
  return m ? { token, prefix: m[1] } : null;
}
export const bearerToken = (header: string | null) => (header?.startsWith("Bearer ") ? header.slice(7) : null);

/** Signature header for an outbound webhook: t=<unix seconds>,v1=<hmac-sha256(secret, "<t>.<body>")>. */
export function signWebhook(secret: string, body: string, timestampSec: number) {
  const v1 = createHmac("sha256", secret).update(`${timestampSec}.${body}`).digest("hex");
  return `t=${timestampSec},v1=${v1}`;
}

/** For consumers (and our tests): verify a signature header against the raw body, within a tolerance window. */
export function verifyWebhookSignature(secret: string, body: string, header: string, nowSec: number, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > toleranceSec || !parts.v1) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return expected.length === parts.v1.length && timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}

/** Minutes to wait before the next attempt, by how many attempts have already been made. null = give up. */
export const RETRY_MINUTES = [1, 5, 30, 120, 720];
export const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;
export function nextRetryMinutes(attemptsSoFar: number): number | null {
  return attemptsSoFar >= MAX_ATTEMPTS ? null : RETRY_MINUTES[attemptsSoFar - 1] ?? null;
}

/** Webhook endpoints must be https and not point at private networks or this app. */
export function endpointUrlProblem(url: string, ownRoot?: string | null) {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return "Enter a full URL starting with https://."; }
  if (u.protocol !== "https:") return "Webhook URLs must use https.";
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h === "::1" || h === "[::1]") return "That address points at a private network.";
  if (ownRoot && (h === ownRoot || h.endsWith("." + ownRoot))) return "Webhooks can't point back at erp.";
  return null;
}

/** Simple fixed-window rate limit used per API key: 120 requests per minute. Pure state machine; the caller keeps the map. */
export const RATE_LIMIT = { perMinute: 120 };
export function rateLimitTick(state: { windowStart: number; count: number } | undefined, nowMs: number) {
  const windowStart = Math.floor(nowMs / 60_000) * 60_000;
  const s = state && state.windowStart === windowStart ? { ...state, count: state.count + 1 } : { windowStart, count: 1 };
  return { state: s, allowed: s.count <= RATE_LIMIT.perMinute, remaining: Math.max(0, RATE_LIMIT.perMinute - s.count), resetSec: Math.ceil((windowStart + 60_000 - nowMs) / 1000) };
}

/** Offset cursor for paged JSON: opaque to callers, bounded here. */
export function decodePageCursor(raw: string | null | undefined) {
  if (!raw) return 0;
  const n = Number(Buffer.from(raw, "base64url").toString("utf8"));
  return Number.isInteger(n) && n >= 0 && n <= 1_000_000 ? n : 0;
}
export const encodePageCursor = (offset: number) => Buffer.from(String(offset), "utf8").toString("base64url");
export function pageLimit(raw: string | null | undefined, fallback = 50, max = 100) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

/** Accounting export formats (Settings → Integrations). */
export const ACCOUNTING_FORMATS = { tally: "Tally (journal voucher CSV)", zoho: "Zoho Books (journal import CSV)" } as const;
export type AccountingFormat = keyof typeof ACCOUNTING_FORMATS;
export const isAccountingFormat = (v: unknown): v is AccountingFormat => v === "tally" || v === "zoho";

// ---------------------------------------------------------------- OAuth2 client credentials (plat2)

export const CLIENT_ID_PREFIX = "erp_ci_", CLIENT_SECRET_PREFIX = "erp_cs_";
export const ACCESS_TOKEN_SECONDS = 3600;
export const isClientId = (v: unknown): v is string => typeof v === "string" && /^erp_ci_[a-z0-9]{16}$/.test(v);

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export type AccessClaims = { iss: string; sub: string; tid: string; scope: string; iat: number; exp: number; jti: string };

/** Compact HS256 JWT. One signing secret per server (ERP_JWT_SECRET, else derived from ERP_DATA_KEY). */
export function signJwt(secret: string, claims: AccessClaims) {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" })), body = b64u(JSON.stringify(claims));
  return `${head}.${body}.${b64u(createHmac("sha256", secret).update(`${head}.${body}`).digest())}`;
}

export function verifyJwt(secret: string, token: string | null | undefined, nowSec: number): AccessClaims | null {
  if (!token || token.length > 4000) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const head = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as { alg?: string };
    if (head.alg !== "HS256") return null;
    const expected = b64u(createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest());
    if (expected.length !== parts[2].length || !timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]))) return null;
    const c = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as AccessClaims;
    if (typeof c.exp !== "number" || c.exp <= nowSec || typeof c.tid !== "string" || typeof c.sub !== "string" || typeof c.scope !== "string") return null;
    return c;
  } catch { return null; }
}

export const looksLikeJwt = (raw: string | null | undefined) => !!raw && raw.split(".").length === 3 && raw.startsWith("eyJ");

/** Requested scope ⊆ granted scope (space separated). Empty request = everything granted. */
export function grantScopes(requested: string | null | undefined, granted: string[]): { ok: true; scopes: string[] } | { ok: false; bad: string } {
  const req = (requested ?? "").split(/[\s,]+/).filter(Boolean);
  if (!req.length) return { ok: true, scopes: granted };
  const bad = req.find((s) => !granted.includes(s));
  return bad ? { ok: false, bad } : { ok: true, scopes: [...new Set(req)] };
}
