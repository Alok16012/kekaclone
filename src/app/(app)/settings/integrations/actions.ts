"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import * as integ from "@/server/modules/integrations/service";

const bad = (error: string, field?: string) => ({ ok: false as const, error, field });
const chat = z.enum(["slack", "teams"]);
const calendar = z.enum(["google_workspace", "microsoft_365"]);

export async function saveChatIntegrationAction(provider: string, url: string) {
  const p = chat.safeParse(provider);
  if (!p.success) return bad("Unknown provider.");
  return runAction((tx, actor) => integ.saveChatIntegration(tx, actor, p.data, String(url ?? "")));
}

export async function removeIntegrationAction(provider: string) {
  if (!chat.safeParse(provider).success && !calendar.safeParse(provider).success) return bad("Unknown provider.");
  return runAction((tx, actor) => integ.removeIntegration(tx, actor, provider));
}

export async function sendChatTestAction(provider: string) {
  const p = chat.safeParse(provider);
  if (!p.success) return bad("Unknown provider.");
  return runAction((tx, actor) => integ.sendChatTest(tx, actor, p.data), { refresh: false });
}

export async function setCalendarPlaceholderAction(provider: string, on: boolean) {
  const p = calendar.safeParse(provider);
  if (!p.success) return bad("Unknown provider.");
  return runAction((tx, actor) => integ.setCalendarPlaceholder(tx, actor, p.data, !!on));
}
