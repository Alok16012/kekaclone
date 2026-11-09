"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import * as branding from "@/server/modules/saas/branding";

const bad = (error: string, field?: string) => ({ ok: false as const, error, field });
const input = z.object({ accent: z.string().max(10), accentDark: z.string().max(10), loginNote: z.string().max(300) });

export async function saveBrandingAction(raw: z.input<typeof input>) {
  const p = input.safeParse(raw);
  if (!p.success) return bad("Check the branding details.");
  return runAction((tx, actor) => branding.saveBranding(tx, actor, p.data));
}

export async function uploadLogoAction(form: FormData) {
  const f = form.get("logo");
  if (!(f instanceof File) || !f.size) return bad("Choose an image to upload.", "logo");
  if (f.size > 600 * 1024) return bad("Keep the logo under 512 KB.", "logo");
  const bytes = new Uint8Array(await f.arrayBuffer());
  return runAction((tx, actor) => branding.saveLogo(tx, actor, { name: f.name, mime: f.type, bytes }));
}

export async function uploadBackgroundAction(form: FormData) {
  const f = form.get("background");
  if (!(f instanceof File) || !f.size) return bad("Choose an image to upload.", "background");
  if (f.size > 2 * 1024 * 1024 + 1024) return bad("Keep the background under 2 MB.", "background");
  const bytes = new Uint8Array(await f.arrayBuffer());
  return runAction((tx, actor) => branding.saveLoginBackground(tx, actor, { name: f.name, mime: f.type, bytes }));
}

export async function removeBackgroundAction() {
  return runAction((tx, actor) => branding.removeLoginBackground(tx, actor));
}

export async function removeLogoAction() {
  return runAction((tx, actor) => branding.removeLogo(tx, actor));
}
