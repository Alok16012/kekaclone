/** erp Sign rules: signer lists, OTP checks, drawn-signature images, audit stamps. Pure (no I/O). */

export type SignerInput = { employeeId?: string | null; email?: string | null; name?: string | null; title?: string | null };
export type SignerStatus = "waiting" | "pending" | "signed" | "declined";

export const OTP_MINUTES = 10;
export const OTP_TRIES = 5;
export const RESEND_SECONDS = 60;
export const LINK_DAYS = 30;
export const MAX_SIGNERS = 6;
export const MAX_SIGNATURE_PNG = 200 * 1024;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Signers in order: each is a person in the company (by id) or an outside signer (email + name). */
export function validateSigners(raw: unknown): { ok: true; signers: { employeeId: string | null; email: string | null; name: string | null; title: string | null }[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "Add at least one signer." };
  if (raw.length > MAX_SIGNERS) return { ok: false, error: `At most ${MAX_SIGNERS} signers.` };
  const out: { employeeId: string | null; email: string | null; name: string | null; title: string | null }[] = [];
  const seen = new Set<string>();
  for (const s of raw as SignerInput[]) {
    const employeeId = typeof s?.employeeId === "string" && /^[0-9a-f-]{36}$/i.test(s.employeeId) ? s.employeeId : null;
    const email = typeof s?.email === "string" ? s.email.trim().toLowerCase() : "";
    const name = typeof s?.name === "string" ? s.name.trim().slice(0, 120) : "";
    const title = typeof s?.title === "string" ? s.title.trim().slice(0, 80) : "";
    if (!employeeId) {
      if (!EMAIL.test(email)) return { ok: false, error: "Outside signers need a valid email address." };
      if (!name) return { ok: false, error: "Outside signers need a name." };
    }
    const key = employeeId ?? email;
    if (seen.has(key)) return { ok: false, error: "The same person is listed twice." };
    seen.add(key);
    out.push({ employeeId, email: employeeId ? null : email, name: name || null, title: title || null });
  }
  return { ok: true, signers: out };
}

/** data:image/png;base64,… from a canvas → PNG bytes, or null when it isn't a small real PNG. */
export function parsePngDataUrl(s: unknown): Uint8Array | null {
  if (typeof s !== "string" || !s.startsWith("data:image/png;base64,")) return null;
  const b64 = s.slice("data:image/png;base64,".length);
  if (b64.length > MAX_SIGNATURE_PNG * 1.4) return null;
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(Buffer.from(b64, "base64")); } catch { return null; }
  if (bytes.length < 64 || bytes.length > MAX_SIGNATURE_PNG) return null;
  if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) return null;
  return bytes;
}

/** The typed name has to match the signer's name on record, ignoring case, accents and punctuation. */
export const normName = (s: string) => s.normalize("NFKD").replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim().toLowerCase();

export function maskEmail(email: string) {
  return email.replace(/^(.{1,2})[^@]*(@.*)$/, "$1•••$2");
}

export type OtpState = { otp_hash: string | null; otp_expires_at: Date | null; otp_attempts: number };

/** Why a code can't be checked right now (null = go ahead). */
export function otpProblem(s: OtpState, now: Date): string | null {
  if (!s.otp_hash || !s.otp_expires_at) return "Ask for a code first.";
  if (s.otp_expires_at <= now) return "That code has expired. Ask for a new one.";
  if (s.otp_attempts >= OTP_TRIES) return "Too many wrong codes. Ask for a new one.";
  return null;
}

export function canResend(lastSentAt: Date | null, now: Date) {
  return !lastSentAt || now.getTime() - lastSentAt.getTime() >= RESEND_SECONDS * 1000;
}

/** Who signs next after a signature: the first waiting signer in order (null when everyone has signed). */
export function nextSigner<T extends { sign_order: number; status: SignerStatus }>(rows: T[]): T | null {
  return [...rows].filter((r) => r.status === "waiting").sort((a, b) => a.sign_order - b.sign_order)[0] ?? null;
}

export const allSigned = (rows: { status: SignerStatus }[]) => rows.length > 0 && rows.every((r) => r.status === "signed");

/** The audit line printed under each signature. */
export function auditLine(a: { signedAt: Date; ip: string | null; method: "typed" | "drawn"; email: string }) {
  const when = a.signedAt.toLocaleString("en-IN", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Kolkata" });
  return `${a.method === "typed" ? "Typed" : "Drawn"} signature · ${when} IST · code sent to ${a.email}${a.ip ? ` · from ${a.ip}` : ""}`;
}

export const shortHash = (hex: string) => hex.slice(0, 16);

export const STATUS_LABEL: Record<SignerStatus, string> = { waiting: "Waiting for their turn", pending: "Sent, not signed yet", signed: "Signed", declined: "Declined" };
