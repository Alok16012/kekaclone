"use server";
import { headers } from "next/headers";
import { AppError, withTenant } from "@/server/db";
import { deliverQueued } from "@/server/email";
import { currentSubdomain, resolveTenant } from "@/server/auth/session";
import { applyPublic } from "@/server/modules/hire/public";
import { rateLimit } from "@/server/modules/hire/ratelimit";

const str = (v: FormDataEntryValue | null, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** Careers-page application. Tenant from the address only; rate-limited per IP (10 an hour) and per email (3 an hour). */
export async function applyAction(form: FormData): Promise<{ ok: true } | { ok: false; error: string; field?: string }> {
  try {
    if (!(form instanceof FormData)) return { ok: false, error: "Something went wrong. Please try again." };
    const tenant = await resolveTenant(await currentSubdomain());
    if (!tenant) return { ok: false, error: "This careers page doesn't exist." };
    const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    await rateLimit(tenant.id, `apply:ip:${ip}`, 10, 60, "Too many applications from your network. Please try again in an hour.");
    const email = str(form.get("email"), 254).trim().toLowerCase();
    if (email) await rateLimit(tenant.id, `apply:email:${email}`, 3, 60, "Too many attempts with this email. Please try again in an hour.");
    const f = form.get("resume");
    let resume: { name: string; bytes: Uint8Array } | null = null;
    if (f instanceof File && f.size > 0) {
      if (f.size > 5 * 1024 * 1024) return { ok: false, error: "Your resume is larger than 5 MB.", field: "resume" };
      resume = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
    }
    await withTenant(tenant.id, (tx) => applyPublic(tx, tenant, {
      jobId: str(form.get("jobId"), 40), firstName: str(form.get("firstName"), 100), lastName: str(form.get("lastName"), 100), email, mobile: str(form.get("mobile"), 30),
      currentCompany: str(form.get("currentCompany"), 150), currentTitle: str(form.get("currentTitle"), 150), experienceYears: str(form.get("experienceYears"), 10),
      consent: form.get("consent") === "on" || form.get("consent") === "1", resume, website: str(form.get("website"), 200),
    }));
    await deliverQueued(tenant.id).catch((e) => console.error("email delivery", e));
    return { ok: true };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, error: e.message, field: e.field };
    console.error(e);
    return { ok: false, error: "Something went wrong on our side. Please try again." };
  }
}
