"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import * as sv from "@/server/modules/surveys/service";
import { QUESTION_TYPES, RECURRENCES } from "@/server/modules/surveys/rules";

const uuid = z.uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });

export async function createSurveyAction(starter: string) {
  if (typeof starter !== "string" || starter.length > 20) return bad("Pick a starting point.");
  return runAction((tx, actor) => sv.createFromStarter(tx, actor, starter));
}

const audience = z.union([z.object({ type: z.literal("org") }), z.object({ type: z.enum(["departments", "locations"]), ids: z.array(uuid).max(500) })]);
const settings = z.object({
  title: z.string().max(200), description: z.string().max(2000).nullable().optional(), anonymous: z.boolean(), minResponses: z.number().int(),
  audience, startOn: isoDate.nullable(), endOn: isoDate.nullable(), recurrence: z.enum(RECURRENCES),
});
export async function saveSurveyAction(id: string | null, input: z.input<typeof settings>) {
  const p = settings.safeParse(input);
  if ((id !== null && !uuid.safeParse(id).success) || !p.success) return bad("Check the details and try again.", String(p.error?.issues[0]?.path[0] ?? "") || undefined);
  return runAction((tx, actor) => sv.saveSurvey(tx, actor, id, p.data));
}

const question = z.object({
  type: z.enum(QUESTION_TYPES), prompt: z.string().max(600), required: z.boolean(),
  options: z.object({ choices: z.array(z.string().max(300)).max(30).optional(), max: z.number().int().optional(), left: z.string().max(80).optional(), right: z.string().max(80).optional() }).nullable().optional(),
});
export async function saveQuestionAction(surveyId: string, questionId: string | null, input: z.input<typeof question>) {
  const p = question.safeParse(input);
  if (!uuid.safeParse(surveyId).success || (questionId !== null && !uuid.safeParse(questionId).success) || !p.success) return bad("Check the question and try again.");
  return runAction((tx, actor) => sv.saveQuestion(tx, actor, surveyId, questionId, p.data));
}

export async function deleteQuestionAction(surveyId: string, questionId: string) {
  if (!uuid.safeParse(surveyId).success || !uuid.safeParse(questionId).success) return bad("Question not found.");
  return runAction((tx, actor) => sv.deleteQuestion(tx, actor, surveyId, questionId));
}

export async function moveQuestionAction(surveyId: string, questionId: string, dir: "up" | "down") {
  if (!uuid.safeParse(surveyId).success || !uuid.safeParse(questionId).success || !["up", "down"].includes(dir)) return bad("Question not found.");
  return runAction((tx, actor) => sv.moveQuestion(tx, actor, surveyId, questionId, dir));
}

export async function launchSurveyAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Survey not found.");
  return runAction((tx, actor) => sv.launchSurvey(tx, actor, id));
}

export async function closeSurveyAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Survey not found.");
  return runAction((tx, actor) => sv.closeSurvey(tx, actor, id));
}

export async function deleteSurveyAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Survey not found.");
  return runAction((tx, actor) => sv.deleteSurvey(tx, actor, id));
}

const answer = z.union([z.string().max(4000), z.number(), z.array(z.string().max(300)).max(30), z.null()]);
export async function submitSurveyAction(id: string, answers: Record<string, unknown>) {
  const p = z.record(uuid, answer).safeParse(answers);
  if (!uuid.safeParse(id).success || !p.success) return bad("Check your answers and try again.");
  return runAction((tx, actor) => sv.submitResponse(tx, actor, id, p.data));
}
