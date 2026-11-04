"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import * as auto from "@/server/modules/automations/service";

const uuid = z.uuid();
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });

/** Settings → Automations: the service validates the whole shape (rules.validateAutomation). */
export async function saveAutomationAction(id: string | null, raw: unknown) {
  if (id !== null && !uuid.safeParse(id).success) return bad("Automation not found.");
  return runAction((tx, actor) => auto.saveAutomation(tx, actor, id, raw), { refresh: true, feature: "workflow_builder" });
}
export async function setAutomationActiveAction(id: string, active: boolean) {
  if (!uuid.safeParse(id).success) return bad("Automation not found.");
  return runAction((tx, actor) => auto.setAutomationActive(tx, actor, id, !!active));
}
export async function deleteAutomationAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Automation not found.");
  return runAction((tx, actor) => auto.deleteAutomation(tx, actor, id));
}
export async function runLogAction(automationId: string | null) {
  if (automationId !== null && !uuid.safeParse(automationId).success) return bad("Automation not found.");
  return runAction((tx, actor) => auto.runLog(tx, actor, automationId ?? undefined), { refresh: false });
}
