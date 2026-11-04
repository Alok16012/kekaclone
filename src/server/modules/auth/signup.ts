import "server-only";
import { randomInt, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { AppError, sql } from "@/server/db";
import { hashPassword, newToken, sha256 } from "@/server/auth/password";
import { passwordProblem } from "@/server/auth/password-policy";
import { sendPlatformEmail } from "@/server/email/platform";
import { simpleEmail } from "@/server/email/simple";
import { assertSubdomainFree, provisionTenant, type Signup } from "@/server/modules/tenants/provision";

const COOKIE = "erp_signup", MINUTES = 15, MAX_ATTEMPTS = 5, PER_WINDOW = 3;
const maskEmail = (email: string) => email.replace(/^(.{1,2})[^@]*(@.*)$/, "$1•••$2");

/**
 * Sign-up in two steps: the form is checked and parked (with the password already hashed) until the person types the
 * 6-digit code we emailed them; only then is the workspace created. The subdomain is checked both times.
 */
export async function startSignup(s: Signup, ip: string | null) {
  await assertSubdomainFree(s.subdomain);
  const problem = passwordProblem(s.password, s.email);
  if (problem) throw new AppError("invalid", problem, "password");
  const email = s.email.trim().toLowerCase();
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from signup_verifications where email = ${email} and created_at > now() - interval '15 minutes'`;
  if (n >= PER_WINDOW) throw new AppError("invalid", "Too many codes were sent to this email. Try again in 15 minutes.", "email");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const nonce = newToken();
  const payload = { company: s.company.trim(), subdomain: s.subdomain.trim().toLowerCase(), firstName: s.firstName.trim(), lastName: s.lastName.trim(), email, passwordHash: await hashPassword(s.password) };
  await sql`update signup_verifications set consumed_at = now() where email = ${email} and consumed_at is null`;
  const [row] = await sql<{ id: string }[]>`
    insert into signup_verifications (email, subdomain, code_hash, payload, expires_at, ip)
    values (${email}, ${payload.subdomain}, ${sha256(`${nonce}:${code}`)}, ${sql.json(payload)}, now() + make_interval(mins => ${MINUTES}), ${ip}) returning id`;
  await sendCode(payload.company, email, s.firstName.trim(), code);
  (await cookies()).set(COOKIE, `${row.id}.${nonce}`, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/signup", maxAge: MINUTES * 60 });
  return { maskedEmail: maskEmail(email) };
}

async function sendCode(company: string, to: string, firstName: string, code: string) {
  const mail = simpleEmail({ company, subject: `${code} is your erp verification code`, heading: `Your code: ${code}`,
    paragraphs: [`Hi ${firstName},`, `Enter this code to confirm your email and create the ${company} workspace. It works for ${MINUTES} minutes.`, "If you didn't sign up for erp, you can ignore this email."],
    footnote: "You're getting this because someone used this address to sign up for erp." });
  await sendPlatformEmail({ kind: "signup.code", to, ...mail });
}

function parseCookie(raw: string) {
  const [id, nonce] = raw.split(".");
  return id && nonce && /^[0-9a-f-]{36}$/.test(id) ? { id, nonce } : null;
}

/** A fresh code on the same pending sign-up (rate-limited per email). */
export async function resendSignupCode() {
  const c = parseCookie((await cookies()).get(COOKIE)?.value ?? "");
  if (!c) throw new AppError("invalid", "Your sign-up timed out. Fill in the form again.");
  const [row] = await sql<{ email: string; payload: { company: string; firstName: string; sent?: number } }[]>`select email::text as email, payload from signup_verifications where id = ${c.id} and consumed_at is null and expires_at > now()`;
  if (!row) throw new AppError("invalid", "Your sign-up timed out. Fill in the form again.");
  if ((row.payload.sent ?? 1) >= PER_WINDOW) throw new AppError("invalid", "Too many codes were sent to this email. Try again in 15 minutes.");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await sql`update signup_verifications set code_hash = ${sha256(`${c.nonce}:${code}`)}, attempts = 0, expires_at = now() + make_interval(mins => ${MINUTES}),
            payload = payload || jsonb_build_object('sent', coalesce((payload->>'sent')::int, 1) + 1) where id = ${c.id}`;
  await sendCode(row.payload.company, row.email, row.payload.firstName, code);
  return { maskedEmail: maskEmail(row.email) };
}

/** Check the code and create the workspace. Returns what the caller needs to hand the admin over to their subdomain. */
export async function verifySignup(code: string) {
  const jar = await cookies();
  const c = parseCookie(jar.get(COOKIE)?.value ?? "");
  if (!c) throw new AppError("invalid", "Your sign-up timed out. Fill in the form again.");
  const clean = code.replace(/\D/g, "");
  const payload = await sql.begin(async (tx) => {
    const [row] = await tx<{ code_hash: string; attempts: number; payload: Signup & { passwordHash: string } }[]>`
      select code_hash, attempts, payload from signup_verifications where id = ${c.id} and consumed_at is null and expires_at > now() for update`;
    if (!row) throw new AppError("invalid", "This code has expired. Fill in the form again.");
    const ok = clean.length === 6 && timingSafeEqual(Buffer.from(sha256(`${c.nonce}:${clean}`)), Buffer.from(row.code_hash));
    if (!ok) {
      const left = MAX_ATTEMPTS - (row.attempts + 1);
      await tx`update signup_verifications set attempts = attempts + 1, consumed_at = case when attempts + 1 >= ${MAX_ATTEMPTS} then now() else null end where id = ${c.id}`;
      throw new AppError("invalid", left > 0 ? `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong codes. Fill in the form again.");
    }
    await tx`update signup_verifications set consumed_at = now() where id = ${c.id}`;
    return row.payload;
  });
  const t = await provisionTenant({ ...payload, password: newToken(), passwordHash: payload.passwordHash, emailVerified: true });
  jar.delete(COOKIE);
  return t;
}
