"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import { AppError } from "@/server/db";
import * as ob from "@/server/modules/onboarding/service";
import { MAX_UPLOAD_BYTES } from "@/server/modules/documents/rules";
import { DOC_CATEGORIES, PROFILE_FIELDS, TASK_TYPES } from "@/server/modules/onboarding/rules";

const uuid = z.uuid();
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });

// ---------- templates (Settings → Onboarding tasks)
const criteria = z.object({
  department_ids: z.array(uuid).max(200).optional(), location_ids: z.array(uuid).max(200).optional(),
  designation_ids: z.array(uuid).max(200).optional(), legal_entity_ids: z.array(uuid).max(200).optional(),
});
export async function saveOnboardingTemplateAction(id: string | null, input: { name: string; criteria: z.input<typeof criteria> }) {
  const c = criteria.safeParse(input?.criteria ?? {});
  if ((id !== null && !uuid.safeParse(id).success) || !c.success || typeof input?.name !== "string") return bad("Check the details and try again.");
  return runAction((tx, actor) => ob.saveTemplate(tx, actor, id, { name: input.name, criteria: c.data }));
}

export async function deleteOnboardingTemplateAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Template not found.");
  return runAction((tx, actor) => ob.deleteTemplate(tx, actor, id));
}

const owner = z.union([
  z.object({ type: z.literal("self") }), z.object({ type: z.literal("manager") }),
  z.object({ type: z.literal("role"), role: z.string().min(1).max(60) }), z.object({ type: z.literal("employee"), id: uuid }),
]);
const item = z.object({
  title: z.string().max(200), description: z.string().max(2000).nullable().optional(), type: z.enum(TASK_TYPES), owner, dueOffsetDays: z.number().int(),
  config: z.object({
    field: z.enum(Object.keys(PROFILE_FIELDS) as [keyof typeof PROFILE_FIELDS]).optional(), docType: z.string().max(80).optional(),
    category: z.enum(DOC_CATEGORIES).optional(), ackText: z.string().max(4000).optional(),
  }).optional(),
});
export async function saveOnboardingItemAction(templateId: string, itemId: string | null, input: z.input<typeof item>) {
  const p = item.safeParse(input);
  if (!uuid.safeParse(templateId).success || (itemId !== null && !uuid.safeParse(itemId).success)) return bad("Task not found.");
  if (!p.success) {
    const f = String(p.error.issues[0]?.path[0] ?? "");
    return bad(f === "owner" ? "Pick who owns this task." : f === "dueOffsetDays" ? "Use whole days." : "Check the details and try again.", f || undefined);
  }
  return runAction((tx, actor) => ob.saveItem(tx, actor, templateId, itemId, p.data));
}

export async function deleteOnboardingItemAction(itemId: string) {
  if (!uuid.safeParse(itemId).success) return bad("Task not found.");
  return runAction((tx, actor) => ob.deleteItem(tx, actor, itemId));
}

export async function moveOnboardingItemAction(itemId: string, dir: "up" | "down") {
  if (!uuid.safeParse(itemId).success || !["up", "down"].includes(dir)) return bad("Task not found.");
  return runAction((tx, actor) => ob.moveItem(tx, actor, itemId, dir));
}

// ---------- processes
export async function initiateOnboardingAction(employeeId: string, templateId: string | null) {
  if (!uuid.safeParse(employeeId).success || (templateId !== null && !uuid.safeParse(templateId).success)) return bad("Pick a person and a template.");
  return runAction((tx, actor) => ob.initiateOnboarding(tx, actor, employeeId, templateId));
}

export async function cancelOnboardingAction(processId: string) {
  if (!uuid.safeParse(processId).success) return bad("Onboarding not found.");
  return runAction((tx, actor) => ob.cancelOnboarding(tx, actor, processId));
}

export async function portalLinkAction(processId: string, email: boolean) {
  if (!uuid.safeParse(processId).success) return bad("Onboarding not found.");
  return runAction((tx, actor) => ob.sendPortalLink(tx, actor, processId, { email: !!email }));
}

// ---------- tasks
const complete = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("done") }), z.object({ kind: z.literal("acknowledge") }),
  z.object({ kind: z.literal("decide"), decision: z.enum(["approved", "declined"]), note: z.string().max(1000).nullable().optional() }),
  z.object({ kind: z.literal("field"), value: z.string().max(200) }),
]);
export async function completeTaskAction(taskId: string, input: z.input<typeof complete>) {
  const p = complete.safeParse(input);
  if (!uuid.safeParse(taskId).success || !p.success) return bad("Check the details and try again.");
  return runAction((tx, actor) => ob.completeTask(tx, actor, taskId, p.data));
}

export async function uploadTaskDocumentAction(form: FormData) {
  const taskId = form.get("taskId");
  const f = form.get("file");
  if (typeof taskId !== "string" || !uuid.safeParse(taskId).success) return bad("Task not found.");
  if (!(f instanceof File) || f.size === 0) return bad("Choose a file to upload.", "file");
  if (f.size > MAX_UPLOAD_BYTES) return bad("This file is larger than 5 MB.", "file");
  const file = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
  return runAction((tx, actor) => ob.uploadForTask(tx, actor, taskId, file));
}

export async function setTaskStateAction(taskId: string, state: "skipped" | "open") {
  if (!uuid.safeParse(taskId).success || !["skipped", "open"].includes(state)) return bad("Task not found.");
  return runAction((tx, actor) => ob.setTaskState(tx, actor, taskId, state));
}

export async function reassignTaskAction(taskId: string, employeeId: string) {
  if (!uuid.safeParse(taskId).success || !uuid.safeParse(employeeId).success) return bad("Pick someone.", "employeeId");
  return runAction((tx, actor) => ob.reassignTask(tx, actor, taskId, employeeId));
}

export async function processDetailAction(processId: string) {
  if (!uuid.safeParse(processId).success) return bad("Onboarding not found.");
  return runAction(async (tx, actor) => {
    const d = await ob.processDetail(tx, actor, processId);
    if (!d) throw new AppError("not_found", "Onboarding not found.");
    return d;
  }, { refresh: false });
}
