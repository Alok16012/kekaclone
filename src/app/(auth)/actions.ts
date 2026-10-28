"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { AppError } from "@/server/db";
import { createSession, currentSubdomain, destroySession, resolveTenant } from "@/server/auth/session";
import { provisionTenant } from "@/server/modules/tenants/provision";
import { createHandoff, passwordLogin } from "@/server/modules/auth/service";
import { requestReset, setPasswordWithToken } from "@/server/modules/auth/flows";

/**
 * Auth actions return `redirectTo` instead of calling redirect(): a redirect inside a server action is rendered
 * by Next internally without the tenant subdomain, so the browser does a full navigation on the right host instead.
 */
export type FormState = { error?: string; fields?: Record<string, string>; values?: Record<string, string>; redirectTo?: string };

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
  let target: string;
  try {
    const t = await provisionTenant(parsed.data);
    const token = await createHandoff(t.tenantId, t.userId);
    const h = await headers();
    const proto = h.get("x-forwarded-proto") ?? "http";
    target = `${proto}://${t.subdomain}.${process.env.ROOT_DOMAIN}/auth/handoff?t=${encodeURIComponent(token)}`;
  } catch (e) {
    if (e instanceof AppError) return e.field ? { fields: { [e.field]: e.message }, values } : { error: e.message, values };
    console.error(e);
    return { error: "We couldn't create your workspace. Please try again.", values };
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
  try {
    const userId = await passwordLogin(tenant, parsed.data.email, parsed.data.password);
    await createSession(tenant.id, userId);
  } catch (e) {
    if (e instanceof AppError) return { error: e.message, values };
    console.error(e);
    return { error: "We couldn't sign you in. Please try again.", values };
  }
  const next = String(form.get("next") ?? "");
  return { redirectTo: next.startsWith("/") && !next.startsWith("//") ? next : "/home" };
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
