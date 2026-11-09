"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import { requireActor } from "@/server/auth/session";
import { previewEmailTemplate, resetEmailTemplate, saveEmailTemplate } from "@/server/modules/notifications/service";

const event = z.string().max(60);
const tpl = z.object({ subject: z.string().max(400), body: z.string().max(8000) });
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });

export async function saveEmailTemplateAction(ev: string, raw: z.input<typeof tpl>) {
  const e = event.safeParse(ev), p = tpl.safeParse(raw);
  if (!e.success || !p.success) return bad("Check the template.");
  return runAction((tx, actor) => saveEmailTemplate(tx, actor, e.data, p.data));
}
export async function resetEmailTemplateAction(ev: string) {
  const e = event.safeParse(ev);
  if (!e.success) return bad("Unknown event.");
  return runAction((tx, actor) => resetEmailTemplate(tx, actor, e.data));
}
/** Render with sample values; nothing is saved or sent. */
export async function previewEmailTemplateAction(raw: z.input<typeof tpl>) {
  const p = tpl.safeParse(raw);
  if (!p.success) return bad("Check the template.");
  const actor = await requireActor();
  try { return { ok: true as const, data: previewEmailTemplate(actor, p.data) }; }
  catch (e) { return bad((e as Error).message, (e as { field?: string }).field); }
}
