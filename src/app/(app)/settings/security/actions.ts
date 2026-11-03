"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import { clientIp } from "@/server/auth/session";
import * as security from "@/server/modules/settings/security";

const bad = (error: string, field?: string) => ({ ok: false as const, error, field });

export async function setSessionHoursAction(hours: number) {
  if (!Number.isInteger(hours)) return bad("Pick a session length.");
  return runAction((tx, actor) => security.setSessionHours(tx, actor, hours));
}

export async function setIpAllowlistAction(text: string) {
  const list = String(text ?? "").split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  const ip = await clientIp();
  return runAction((tx, actor) => security.setIpAllowlist(tx, actor, list, ip));
}

const ssoInput = z.object({ google: z.boolean(), microsoft: z.boolean(), domains: z.string().max(2000), ssoOnly: z.boolean(), microsoftTenant: z.string().max(120) });
export async function setSsoAction(raw: z.input<typeof ssoInput>) {
  const p = ssoInput.safeParse(raw);
  if (!p.success) return bad("Check the SSO settings.");
  return runAction((tx, actor) => security.setSso(tx, actor, { ...p.data, domains: p.data.domains.split(/[\n,\s]/).filter(Boolean) }));
}

export async function setMobileOtpAction(on: boolean) {
  return runAction((tx, actor) => security.setMobileOtp(tx, actor, !!on));
}
