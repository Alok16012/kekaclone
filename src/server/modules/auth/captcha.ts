import "server-only";
import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { withTenant } from "@/server/db";
import type { Tenant } from "@/server/auth/session";
import { newToken, sha256 } from "@/server/auth/password";
import { CAPTCHA_TTL_MINUTES, CAPTCHA_WINDOW_MINUTES, answerMatches, makeChallenge } from "@/server/auth/captcha-rules";

const COOKIE = "erp_captcha", MAX_TRIES = 5;

/** Failed password sign-ins for this email in the last 15 minutes (any device: the counter is per account, like the lockout). */
export async function recentFailures(tenant: Tenant, email: string) {
  const [{ n }] = await withTenant(tenant.id, (tx) => tx<{ n: number }[]>`
    select count(*)::int as n from login_events where email = ${email.trim().toLowerCase()} and method = 'password' and not success
      and created_at > now() - make_interval(mins => ${CAPTCHA_WINDOW_MINUTES})
      and created_at > coalesce((select max(created_at) from login_events l2 where l2.email = ${email.trim().toLowerCase()} and l2.method = 'password' and l2.success), '-infinity')`);
  return n;
}

/**
 * Make a challenge: the answer's hash lives in the database (auth_tokens, bound to a nonce in an httpOnly cookie), so
 * the browser only ever sees the question, and the server checks the answer with a 5-try limit.
 */
export async function issueChallenge(tenant: Tenant) {
  const c = makeChallenge();
  const nonce = newToken();
  const [row] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`
    insert into auth_tokens (tenant_id, user_id, purpose, target, token_hash, expires_at)
    values (${tenant.id}, null, 'login_otp', 'captcha', ${sha256(`${nonce}:${c.answer}`)}, now() + make_interval(mins => ${CAPTCHA_TTL_MINUTES})) returning id`);
  (await cookies()).set(COOKIE, `${row.id}.${nonce}`, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/login", maxAge: CAPTCHA_TTL_MINUTES * 60 });
  return { question: c.question };
}

/** True when the answer matches the outstanding challenge; the challenge is used up either way. */
export async function verifyChallenge(tenant: Tenant, given: unknown) {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value ?? "";
  const [id, nonce] = raw.split(".");
  if (!id || !nonce || !/^[0-9a-f-]{36}$/.test(id)) return false;
  const ok = await withTenant(tenant.id, async (tx) => {
    const [t] = await tx<{ token_hash: string; attempts: number }[]>`
      select token_hash, attempts from auth_tokens where id = ${id} and purpose = 'login_otp' and target = 'captcha' and consumed_at is null and expires_at > now() for update`;
    if (!t || t.attempts >= MAX_TRIES) return false;
    const s = typeof given === "string" ? given.trim().toLowerCase() : "";
    // the stored hash is of the numeric answer; words are mapped to the number by the rules before hashing
    const candidates = numericCandidates(s);
    const hit = candidates.some((n) => timingSafeEqual(Buffer.from(sha256(`${nonce}:${n}`)), Buffer.from(t.token_hash)) && answerMatches(s, n));
    await tx`update auth_tokens set attempts = attempts + 1, consumed_at = now() where id = ${id}`;
    return hit;
  });
  jar.delete(COOKIE);
  return ok;
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
function numericCandidates(s: string): number[] {
  const clean = s.replace(/[^a-z0-9-]/g, "");
  if (/^-?\d+$/.test(clean)) return [Number(clean)];
  const i = WORDS.indexOf(clean);
  return i >= 0 ? [i] : [];
}
