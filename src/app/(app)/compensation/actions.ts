"use server";
import { z } from "zod";
import { runAction as runGated } from "@/server/action";
import type { Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";

/** Every mutation here needs the performance feature on the plan (Settings → Billing). */
const runAction = <T,>(fn: (tx: Tx, actor: Actor) => Promise<T>, opts: { refresh?: boolean } = { refresh: true }) => runGated(fn, { ...opts, feature: "performance" });
import { AppError } from "@/server/db";
import * as comp from "@/server/modules/performance/compensation";

const uuid = z.uuid();
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });
const isId = (id: unknown): id is string => uuid.safeParse(id).success;

export async function createCompCycleAction(raw: unknown) { return runAction(async (tx, actor) => { const c = await comp.createCompCycle(tx, actor, raw); return { id: c.id }; }); }
export async function updateCompCycleAction(id: string, raw: unknown) {
  if (!isId(id)) return bad("Cycle not found.");
  return runAction((tx, actor) => comp.updateCompCycle(tx, actor, id, raw));
}
export async function deleteCompCycleAction(id: string) {
  if (!isId(id)) return bad("Cycle not found.");
  return runAction((tx, actor) => comp.deleteCompCycle(tx, actor, id));
}
export async function openRecommendationsAction(id: string) {
  if (!isId(id)) return bad("Cycle not found.");
  return runAction((tx, actor) => comp.openRecommendations(tx, actor, id));
}
export async function recommendAction(proposalId: string, raw: unknown) {
  if (!isId(proposalId)) return bad("Proposal not found.");
  return runAction((tx, actor) => comp.recommend(tx, actor, proposalId, raw));
}
export async function submitRecommendationsAction(id: string) {
  if (!isId(id)) return bad("Cycle not found.");
  return runAction((tx, actor) => comp.submitRecommendations(tx, actor, id));
}
export async function withdrawRecommendationAction(proposalId: string) {
  if (!isId(proposalId)) return bad("Proposal not found.");
  return runAction((tx, actor) => comp.withdrawRecommendation(tx, actor, proposalId));
}
export async function closeRecommendationsAction(id: string) {
  if (!isId(id)) return bad("Cycle not found.");
  return runAction((tx, actor) => comp.closeRecommendations(tx, actor, id));
}
export async function markApprovedAction(id: string) {
  if (!isId(id)) return bad("Cycle not found.");
  return runAction((tx, actor) => comp.markApproved(tx, actor, id));
}
export async function applyCycleAction(id: string) {
  if (!isId(id)) return bad("Cycle not found.");
  return runAction((tx, actor) => comp.applyCycle(tx, actor, id));
}
/** Inbox detail for a compensation proposal. */
export async function proposalDetailAction(id: string) {
  if (!isId(id)) return bad("Proposal not found.");
  return runAction(async (tx, actor) => {
    const d = await comp.proposalDetail(tx, actor, id);
    if (!d) throw new AppError("not_found", "This proposal isn't available.");
    return d;
  }, { refresh: false });
}
