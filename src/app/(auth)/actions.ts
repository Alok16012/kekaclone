"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { AppError } from "@/server/db";
import { createSession, currentSubdomain, destroySession, resolveTenant } from "@/server/auth/session";
import { createHandoff, passwordLogin } from "@/server/modules/auth/service";
import { requestReset, setPasswordWithToken } from "@/server/modules/auth/flows";
import { needsCode, resendChallenge, startChallenge, verifyChallenge } from "@/server/modules/auth/mfa";
import { isTrustedDevice, rememberThisDevice } from "@/server/modules/auth/trusted-device";
import { startMobileOtp, verifyMobileOtp } from "@/server/modules/auth/mobile-otp";
import { resendSignupCode, startSignup, verifySignup } from "@/server/modules/auth/signup";
import { issueChallenge, recentFailures, verifyChallenge as verifyCaptcha } from "@/server/modules/auth/captcha";
import { challengeRequired } from "@/server/auth/captcha-rules";

/**
 * Auth actions return `redirectTo` instead of calling redirect(): a redirect inside a server action is rendered
 * by Next internally without the tenant subdomain, so the browser does a full navigation on the right host instead.
 */
export type FormState = {
  error?: string; fields?: Record<string, string>; values?: Record<string, string>; redirectTo?: string;
  mfa?: { maskedEmail: string; next: string }; otp?: { maskedPhone: string; next: string }; notice?: string;
  /** sign-up: the email verification step */ verify?: { maskedEmail: string };
  /** sign-in: an arithmetic challenge after repeated failures */ captcha?: { question: string };
};

const signupSchema = z.object({
  company: z.string().trim().min(2, "Enter your company name").max(120),
  subdomain: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/, "3–32 characters: letters, numbers and hyphens"),
  firstName: z.string().trim().min(1, "Enter your first name").max(60),
  lastName: z.string().trim().max(60).default(""),
  email: z.email("Enter a valid work email").max(200),
  password: z.string().min(10, "Use at least 10 characters").max(200),
});

export async function signupAction(_: FormState, form: FormData): Promise<FormState> {
  const values = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
  const parsed = signupSchema.safeParse(values);
  delete values.password;
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const i of parsed.error.issues) fields[String(i.path[0])] ??= i.message;
    return { fields, values };
  }
  // step 1: park the sign-up and email a code; the workspace is created once the code checks out (verifySignupAction)
  try {
    const h = await headers();
    const r = await startSignup(parsed.data, h.get("x-forwarded-for")?.split(",")[0]?.trim() || null);
    return { verify: r, values };
  } catch (e) {
    if (e instanceof AppError) return e.field ? { fields: { [e.field]: e.message }, values } : { error: e.message, values };
    console.error(e);
    return { error: "We couldn't send the verification code. Please try again.", values };
  }
}

/** Sign-up step 2: the emailed code. On success the workspace exists and the admin is handed over to its address. */
export async function verifySignupAction(prev: FormState, form: FormData): Promise<FormState> {
  if (!prev.verify) return { error: "Your sign-up timed out. Fill in the form again.", values: prev.values };
  if (form.get("intent") === "resend") {
    try { const r = await resendSignupCode(); return { ...prev, verify: r, error: undefined, notice: "We've sent a new code." }; }
    catch (e) { return { ...prev, notice: undefined, error: e instanceof AppError ? e.message : "Couldn't send a new code." }; }
  }
  let target: string;
  try {
    const t = await verifySignup(String(form.get("code") ?? ""));
    const token = await createHandoff(t.tenantId, t.userId);
    const h = await headers();
    const proto = h.get("x-forwarded-proto") ?? "http";
    target = `${proto}://${t.subdomain}.${process.env.ROOT_DOMAIN}/auth/handoff?t=${encodeURIComponent(token)}`;
  } catch (e) {
    const msg = e instanceof AppError ? e.message : "We couldn't create your workspace. Please try again.";
    if (e instanceof AppError && e.field) return { fields: { [e.field]: e.message }, values: prev.values };   // e.g. the address was taken meanwhile
    const restart = /Fill in the form again\.$/.test(msg);
    if (!(e instanceof AppError)) console.error(e);
    return restart ? { error: msg, values: prev.values } : { ...prev, notice: undefined, error: msg };
  }
  redirect(target);
}

const loginSchema = z.object({ email: z.email("Enter your work email"), password: z.string().min(1, "Enter your password") });

export async function loginAction(_: FormState, form: FormData): Promise<FormState> {
  const values = { email: String(form.get("email") ?? "") };
  const parsed = loginSchema.safeParse({ email: form.get("email"), password: form.get("password") });
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const i of parsed.error.issues) fields[String(i.path[0])] ??= i.message;
    return { fields, values };
  }
  const tenant = await resolveTenant(await currentSubdomain());
  if (!tenant) return { error: "This workspace doesn't exist.", values };
  const raw = String(form.get("next") ?? "");
  const next = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/home";
  // after repeated failures the form must answer a small arithmetic question first (server-generated and checked)
  const failures = await recentFailures(tenant, parsed.data.email);
  if (challengeRequired(failures)) {
    const answer = form.get("captcha");
    if (typeof answer !== "string" || !answer.trim()) return { captcha: await issueChallenge(tenant), values, error: "Please answer the question below so we know you're a person." };
    if (!(await verifyCaptcha(tenant, answer))) return { captcha: await issueChallenge(tenant), values, error: "That answer wasn't right. Try the new question." };
  }
  try {
    const userId = await passwordLogin(tenant, parsed.data.email, parsed.data.password);
    if ((await needsCode(tenant, userId)) && !(await isTrustedDevice(tenant, userId))) return { mfa: { ...(await startChallenge(tenant, userId)), next }, values };
    await createSession(tenant.id, userId);
  } catch (e) {
    if (e instanceof AppError) {
      // one more failure may cross the threshold: show the challenge right away so the next try isn't bounced
      const captcha = challengeRequired(failures + 1) ? await issueChallenge(tenant) : undefined;
      return { error: e.message, values, captcha };
    }
    console.error(e);
    return { error: "We couldn't sign you in. Please try again.", values };
  }
  return { redirectTo: next };
}

/** Second step: the 6-digit code from email. Keeps the challenge on screen until it succeeds or runs out. */
export async function verifyCodeAction(prev: FormState, form: FormData): Promise<FormState> {
  const tenant = await resolveTenant(await currentSubdomain());
  if (!tenant || !prev.mfa) return { error: "Your sign-in timed out. Enter your email and password again." };
  if (form.get("intent") === "resend") {
    try { await resendChallenge(tenant); return { ...prev, error: undefined, notice: "We've sent a new code." }; }
    catch (e) { return { ...prev, notice: undefined, error: e instanceof AppError ? e.message : "Couldn't send a new code." }; }
  }
  try {
    const userId = await verifyChallenge(tenant, String(form.get("code") ?? ""));
    if (form.get("remember") === "on") await rememberThisDevice(tenant, userId);
    await createSession(tenant.id, userId);
    return { redirectTo: prev.mfa.next };
  } catch (e) {
    const msg = e instanceof AppError ? e.message : "We couldn't check the code. Please try again.";
    const restart = /again\.$/.test(msg) && !/tries? left/.test(msg);
    return restart ? { error: msg, values: prev.values } : { ...prev, notice: undefined, error: msg };
  }
}

/** Mobile OTP step 1: send a code to the number (same response whether or not the number is known). */
export async function mobileOtpStartAction(_: FormState, form: FormData): Promise<FormState> {
  const phone = String(form.get("phone") ?? "").trim();
  const values = { phone };
  if (!phone) return { fields: { phone: "Enter your mobile number." }, values };
  const tenant = await resolveTenant(await currentSubdomain());
  if (!tenant) return { error: "This workspace doesn't exist.", values };
  const raw = String(form.get("next") ?? "");
  const next = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/home";
  try {
    const h = await headers();
    const r = await startMobileOtp(tenant, phone, h.get("x-forwarded-for")?.split(",")[0]?.trim() || null);
    return { otp: { ...r, next }, values };
  } catch (e) {
    if (e instanceof AppError) return e.field ? { fields: { [e.field]: e.message }, values } : { error: e.message, values };
    console.error(e);
    return { error: "We couldn't send the code. Please try again.", values };
  }
}

/** Mobile OTP step 2: check the code and sign in. */
export async function mobileOtpVerifyAction(prev: FormState, form: FormData): Promise<FormState> {
  const tenant = await resolveTenant(await currentSubdomain());
  if (!tenant || !prev.otp) return { error: "Your sign-in timed out. Enter your mobile number again." };
  try {
    const h = await headers();
    const userId = await verifyMobileOtp(tenant, String(form.get("code") ?? ""), h.get("x-forwarded-for")?.split(",")[0]?.trim() || null);
    await createSession(tenant.id, userId);
    return { redirectTo: prev.otp.next };
  } catch (e) {
    const msg = e instanceof AppError ? e.message : "We couldn't check the code. Please try again.";
    const restart = /again\.$/.test(msg) && !/tries? left/.test(msg);
    return restart ? { error: msg, values: prev.values } : { ...prev, error: msg };
  }
}

export async function logoutAction() {
  await destroySession();
  return { redirectTo: "/login" };
}

/** Invite acceptance and password reset share one form: token + new password (twice). */
export async function setPasswordAction(_: FormState, form: FormData): Promise<FormState> {
  const token = String(form.get("token") ?? ""), purpose = form.get("purpose") === "invite" ? "invite" : "reset_password";
  const password = String(form.get("password") ?? ""), confirm = String(form.get("confirm") ?? "");
  if (password !== confirm) return { fields: { confirm: "The two passwords don't match." } };
  const tenant = await resolveTenant(await currentSubdomain());
  if (!tenant) return { error: "This workspace doesn't exist." };
  try {
    const userId = await setPasswordWithToken(tenant, token, purpose, password);
    await createSession(tenant.id, userId);
  } catch (e) {
    if (e instanceof AppError) return e.field ? { fields: { [e.field]: e.message } } : { error: e.message };
    console.error(e);
    return { error: "We couldn't save your password. Please try again." };
  }
  return { redirectTo: purpose === "invite" ? "/home?welcome=1" : "/home" };
}

export async function requestResetAction(_: FormState, form: FormData): Promise<FormState & { sent?: boolean }> {
  const email = String(form.get("email") ?? "").trim();
  if (!z.email().safeParse(email).success) return { fields: { email: "Enter your work email." }, values: { email } };
  const tenant = await resolveTenant(await currentSubdomain());
  if (tenant) await requestReset(tenant, email).catch((e) => console.error(e));
  return { sent: true, values: { email } };
}
