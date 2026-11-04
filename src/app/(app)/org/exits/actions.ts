"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import { AppError } from "@/server/db";
import * as exits from "@/server/modules/exits/service";
import * as checklist from "@/server/modules/exits/checklist";
import * as survey from "@/server/modules/exits/survey";

const uuid = z.uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });

/** Notice period and the last working day it gives, for a person and resignation date. No write. */
export async function noticePreviewAction(employeeId: string | null, resignationDate: string) {
  const id = employeeId == null ? null : uuid.safeParse(employeeId);
  if ((id && !id.success) || !isoDate.safeParse(resignationDate).success) return bad("Pick a person and a date.");
  return runAction((tx, actor) => exits.noticePreview(tx, actor, id?.data ?? actor.employeeId, resignationDate), { refresh: false });
}

const resignInput = z.object({ reasonId: uuid.nullable().optional(), lastWorkingDate: isoDate.nullable().optional(), comments: z.string().max(2000).nullable().optional() });
export async function resignAction(input: z.input<typeof resignInput>) {
  const p = resignInput.safeParse(input);
  if (!p.success) return bad("Check the details and try again.");
  return runAction((tx, actor) => exits.resign(tx, actor, p.data));
}

export async function withdrawResignationAction(exitId: string) {
  if (!uuid.safeParse(exitId).success) return bad("Exit not found.");
  return runAction((tx, actor) => exits.withdraw(tx, actor, exitId));
}

const initiateInput = z.object({
  employeeId: uuid, kind: z.enum(["resignation", "company_action"]), reasonId: uuid.nullable().optional(), resignationDate: isoDate,
  lastWorkingDate: isoDate.nullable().optional(), okToRehire: z.boolean().nullable().optional(), comments: z.string().max(2000).nullable().optional(),
});
export async function initiateExitAction(input: z.input<typeof initiateInput>) {
  const p = initiateInput.safeParse(input);
  if (!p.success) return bad(p.error.issues[0]?.path[0] === "employeeId" ? "Pick the person who is leaving." : "Check the dates and try again.");
  return runAction((tx, actor) => exits.initiateExit(tx, actor, p.data));
}

export async function exitDetailAction(exitId: string) {
  if (!uuid.safeParse(exitId).success) return bad("Exit not found.");
  return runAction(async (tx, actor) => {
    const d = await exits.exitDetail(tx, actor, exitId);
    if (!d) throw new AppError("not_found", "Exit not found.");
    return d;
  }, { refresh: false });
}

export async function decideExitAction(exitId: string, decision: "approved" | "rejected", comment?: string) {
  if (!uuid.safeParse(exitId).success || !["approved", "rejected"].includes(decision)) return bad("Exit not found.");
  return runAction((tx, actor) => exits.hrDecide(tx, actor, exitId, decision, comment?.slice(0, 1000)));
}

const updateInput = z.object({ lastWorkingDate: isoDate.optional(), reasonId: uuid.nullable().optional(), okToRehire: z.boolean().nullable().optional(), comments: z.string().max(2000).nullable().optional() });
export async function updateExitAction(exitId: string, input: z.input<typeof updateInput>) {
  const p = updateInput.safeParse(input);
  if (!uuid.safeParse(exitId).success || !p.success) return bad("Check the details and try again.");
  return runAction((tx, actor) => exits.updateExit(tx, actor, exitId, p.data));
}

export async function cancelExitAction(exitId: string) {
  if (!uuid.safeParse(exitId).success) return bad("Exit not found.");
  return runAction((tx, actor) => exits.cancelExit(tx, actor, exitId));
}

export async function completeExitAction(exitId: string) {
  if (!uuid.safeParse(exitId).success) return bad("Exit not found.");
  return runAction((tx, actor) => exits.completeExit(tx, actor, exitId));
}

export async function setExitTaskAction(taskId: string, status: "open" | "done" | "skipped") {
  if (!uuid.safeParse(taskId).success || !["open", "done", "skipped"].includes(status)) return bad("Task not found.");
  return runAction((tx, actor) => exits.setTaskStatus(tx, actor, taskId, status));
}

// ---------- settings: notice periods ----------
const policyInput = z.object({ name: z.string().max(120), days: z.number().int(), probationDays: z.number().int().nullable(), isDefault: z.boolean() });
export async function saveNoticePolicyAction(id: string | null, input: z.input<typeof policyInput>) {
  const p = policyInput.safeParse(input);
  if ((id && !uuid.safeParse(id).success) || !p.success) return bad("Days must be whole numbers.");
  return runAction((tx, actor) => exits.saveNoticePolicy(tx, actor, id, p.data));
}

export async function deleteNoticePolicyAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Notice period not found.");
  return runAction((tx, actor) => exits.deleteNoticePolicy(tx, actor, id));
}

export async function assignNoticePolicyAction(id: string, employeeIds: string[]) {
  const ids = z.array(uuid).min(1).max(2000).safeParse(employeeIds);
  if (!uuid.safeParse(id).success || !ids.success) return bad("Choose at least one person.");
  return runAction((tx, actor) => exits.assignNoticePolicy(tx, actor, id, ids.data));
}

export async function addExitReasonAction(input: { kind: string; name: string }) {
  if (typeof input?.name !== "string" || typeof input?.kind !== "string") return bad("Write the reason.");
  return runAction((tx, actor) => exits.addReason(tx, actor, input));
}

export async function deleteExitReasonAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Reason not found.");
  return runAction((tx, actor) => exits.deleteReason(tx, actor, id));
}

// ---------- settings: the exit checklist template ----------
const ownerInput = z.union([z.object({ type: z.literal("self") }), z.object({ type: z.literal("manager") }), z.object({ type: z.literal("role"), role: z.string().max(40) }), z.object({ type: z.literal("employee"), id: uuid })]);
const checklistInput = z.object({ title: z.string().max(160), description: z.string().max(1000).nullable().optional(), owner: ownerInput, dueOffsetDays: z.number().int(), auto: z.enum(["assets_returned", "access_revoked", "fnf_finalized"]).nullable().optional() });
export async function saveChecklistItemAction(id: string | null, input: z.input<typeof checklistInput>) {
  const p = checklistInput.safeParse(input);
  if ((id && !uuid.safeParse(id).success) || !p.success) return bad("Check the task details.");
  return runAction((tx, actor) => checklist.saveChecklistItem(tx, actor, id, p.data));
}
export async function deleteChecklistItemAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Task not found.");
  return runAction((tx, actor) => checklist.deleteChecklistItem(tx, actor, id));
}
export async function moveChecklistItemAction(id: string, dir: "up" | "down") {
  if (!uuid.safeParse(id).success || !["up", "down"].includes(dir)) return bad("Task not found.");
  return runAction((tx, actor) => checklist.moveChecklistItem(tx, actor, id, dir));
}

// ---------- exit survey ----------
const questionInput = z.object({ prompt: z.string().max(300), type: z.string().max(20), options: z.array(z.string().max(120)).max(20).optional(), required: z.boolean().optional() });
export async function saveExitQuestionAction(id: string | null, input: z.input<typeof questionInput>) {
  const p = questionInput.safeParse(input);
  if ((id && !uuid.safeParse(id).success) || !p.success) return bad("Check the question.");
  return runAction((tx, actor) => survey.saveExitQuestion(tx, actor, id, p.data));
}
export async function deleteExitQuestionAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Question not found.");
  return runAction((tx, actor) => survey.deleteExitQuestion(tx, actor, id));
}
export async function moveExitQuestionAction(id: string, dir: "up" | "down") {
  if (!uuid.safeParse(id).success || !["up", "down"].includes(dir)) return bad("Question not found.");
  return runAction((tx, actor) => survey.moveExitQuestion(tx, actor, id, dir));
}
const answersInput = z.record(z.string().max(40), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]));
export async function submitExitSurveyAction(answers: unknown) {
  const p = answersInput.safeParse(answers);
  if (!p.success) return bad("Check your answers.");
  return runAction((tx, actor) => survey.submitExitSurvey(tx, actor, p.data));
}
