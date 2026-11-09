"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import type { Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import * as ai from "@/server/modules/hire/assist";
import * as privacy from "@/server/modules/hire/privacy";

/**
 * Hiring assistant actions. AI work runs between two short transactions (read, then save), never inside one; every
 * call needs the hire feature on the plan, like the rest of Hiring.
 */
const gated = <T,>(fn: (tx: Tx, actor: Actor) => Promise<T>, refresh = true) => runAction(fn, { refresh, feature: "hire" });
const uuid = z.uuid();
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });
const optId = (v: unknown) => (typeof v === "string" && uuid.safeParse(v).success ? v : null);
const int = (v: unknown) => (v === "" || v == null ? null : Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 60 ? Number(v) : null);

export async function draftJdAction(input: { title: string; skills: string; departmentId: string; locationId: string; experienceMin: string; experienceMax: string; jobType: string; notes: string }) {
  const i: ai.JdInput = {
    title: String(input?.title ?? "").slice(0, 200), skills: String(input?.skills ?? "").slice(0, 600).split(/[,;\n]/), departmentId: optId(input?.departmentId), locationId: optId(input?.locationId),
    experienceMin: int(input?.experienceMin), experienceMax: int(input?.experienceMax), jobType: typeof input?.jobType === "string" ? input.jobType.slice(0, 20) : null, notes: String(input?.notes ?? "").slice(0, 500) || null,
  };
  const c = await gated((tx, actor) => ai.jdContext(tx, actor, i), false);
  if (!c.ok) return c;
  const d = await ai.draftJd(c.data!.brief, c.data!.aiEnabled);
  const saved = await gated(async (tx, actor) => { await ai.recordJdDraft(tx, actor, c.data!.brief, d); return d; }, false);
  return saved;
}

export async function scoreApplicationAction(applicationId: string) {
  if (!uuid.safeParse(applicationId).success) return bad("Application not found.");
  const c = await gated((tx, actor) => ai.scoreContext(tx, actor, applicationId), false);
  if (!c.ok) return c;
  const r = await ai.computeScore(c.data!);
  return gated(async (tx, actor) => { await ai.saveScore(tx, actor, c.data!, r); return { score: r.score, method: r.method, notice: r.notice }; });
}

/** Scores candidates on a job that have no current score: up to 8 per click with AI (it's slower), 60 offline. */
export async function scoreJobAction(jobId: string) {
  if (!uuid.safeParse(jobId).success) return bad("Job not found.");
  const st = await gated(async (tx) => ai.assistantState(tx), false);
  if (!st.ok) return st;
  const c = await gated((tx, actor) => ai.staleScoreContexts(tx, actor, jobId, st.data!.active ? 8 : 60), false);
  if (!c.ok) return c;
  const results: { ctx: ai.ScoreContext; r: ai.ScoreResult }[] = [];
  for (const ctx of c.data!.contexts) results.push({ ctx, r: await ai.computeScore(ctx) });
  return gated(async (tx, actor) => {
    for (const x of results) await ai.saveScore(tx, actor, x.ctx, x.r);
    return { scored: results.length, remaining: c.data!.remaining, method: results[0]?.r.method ?? (st.data!.active ? "ai" : "keywords"), notice: results.find((x) => x.r.notice)?.r.notice ?? null };
  });
}

export async function saveHirePrivacyAction(input: { aiEnabled: boolean; retentionMonths: string }) {
  const m = input?.retentionMonths === "" || input?.retentionMonths == null ? null : Number(input.retentionMonths);
  if (m !== null && !Number.isInteger(m)) return bad("Pick how long to keep candidate details.", "retention");
  return gated((tx, actor) => ai.saveHireSettings(tx, actor, { ai_enabled: input?.aiEnabled !== false, candidate_retention_months: m }));
}

export async function eraseCandidateAction(candidateId: string, note: string) {
  if (!uuid.safeParse(candidateId).success) return bad("Candidate not found.");
  const r = await gated((tx, actor) => privacy.eraseCandidateByHr(tx, actor, candidateId, typeof note === "string" ? note : null));
  if (!r.ok) return r;
  await privacy.removeBlobs(r.data!.keys);
  return { ok: true as const };
}

export async function declinePrivacyRequestAction(requestId: string, note: string) {
  if (!uuid.safeParse(requestId).success) return bad("Request not found.");
  return gated((tx, actor) => privacy.declinePrivacyRequest(tx, actor, requestId, String(note ?? "")));
}
