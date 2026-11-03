"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import * as rv from "@/server/modules/performance/reviews";
import * as settings from "@/server/modules/performance/settings";
import { savePeriod } from "@/server/modules/performance/goals";

const uuid = z.uuid();
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });
const isId = (id: unknown): id is string => uuid.safeParse(id).success;

export async function saveSettingsAction(raw: unknown) { return runAction((tx, actor) => settings.saveSettings(tx, actor, raw)); }
export async function savePeriodAction(id: string | null, raw: unknown) {
  if (id !== null && !isId(id)) return bad("Period not found.");
  return runAction(async (tx, actor) => { await savePeriod(tx, actor, id, raw); });
}
export async function saveCompetencyAction(id: string | null, raw: unknown) {
  if (id !== null && !isId(id)) return bad("Item not found.");
  return runAction(async (tx, actor) => { await settings.saveCompetency(tx, actor, id, raw); });
}
export async function deleteCompetencyAction(id: string) {
  if (!isId(id)) return bad("Item not found.");
  return runAction((tx, actor) => settings.deleteCompetency(tx, actor, id));
}
export async function saveFormAction(id: string | null, raw: unknown) {
  if (id !== null && !isId(id)) return bad("Form not found.");
  return runAction(async (tx, actor) => { await rv.saveForm(tx, actor, id, raw); });
}

export async function createCycleAction(raw: unknown) { return runAction(async (tx, actor) => { const c = await rv.createCycle(tx, actor, raw); return { id: c.id }; }); }
export async function updateCycleAction(id: string, raw: unknown) {
  if (!isId(id)) return bad("Cycle not found.");
  return runAction((tx, actor) => rv.updateCycle(tx, actor, id, raw));
}
export async function deleteCycleAction(id: string) {
  if (!isId(id)) return bad("Cycle not found.");
  return runAction((tx, actor) => rv.deleteCycle(tx, actor, id));
}
export async function previewParticipantsAction(filter: unknown) {
  const p = rv.cycleInput.shape.employeeFilter.safeParse(filter);
  if (!p.success) return bad("Check the filters.");
  return runAction((tx, actor) => rv.previewParticipants(tx, actor, p.data), { refresh: false });
}
export async function launchCycleAction(id: string) {
  if (!isId(id)) return bad("Cycle not found.");
  return runAction((tx, actor) => rv.launchCycle(tx, actor, id));
}
export async function advanceCycleAction(id: string, to: "calibration" | "closed") {
  if (!isId(id) || (to !== "calibration" && to !== "closed")) return bad("Cycle not found.");
  return runAction((tx, actor) => rv.advanceCycle(tx, actor, id, to));
}
export async function nudgeAction(id: string, type: "self" | "manager" | "peer" | "skip_level" | null) {
  if (!isId(id)) return bad("Cycle not found.");
  if (type !== null && !["self", "manager", "peer", "skip_level"].includes(type)) return bad("Pick a stage.");
  return runAction((tx, actor) => rv.nudge(tx, actor, id, type ?? undefined));
}
export async function setFinalRatingAction(outcomeId: string, raw: unknown) {
  if (!isId(outcomeId)) return bad("Rating not found.");
  return runAction((tx, actor) => rv.setFinalRating(tx, actor, outcomeId, raw));
}
export async function importCalibrationAction(cycleId: string, form: FormData) {
  if (!isId(cycleId)) return bad("Cycle not found.");
  const f = form.get("file");
  if (!(f instanceof File) || f.size === 0) return bad("Choose the filled-in template.", "file");
  if (f.size > 5 * 1024 * 1024) return bad("The file is larger than 5 MB.", "file");
  const bytes = await f.arrayBuffer();
  return runAction((tx, actor) => rv.importCalibration(tx, actor, cycleId, bytes));
}
export async function publishResultsAction(cycleId: string, employeeIds: string[] | null) {
  if (!isId(cycleId) || (employeeIds !== null && (!Array.isArray(employeeIds) || !employeeIds.every(isId)))) return bad("Pick people from the list.");
  return runAction((tx, actor) => rv.publishResults(tx, actor, cycleId, employeeIds));
}
