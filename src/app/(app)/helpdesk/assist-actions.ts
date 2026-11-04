"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import * as hd from "@/server/modules/helpdesk/assist";

/** Helpdesk assistant actions: the AI call (when configured) runs between a read and a save, outside any transaction. */
const uuid = z.uuid();
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });

export type SuggestionDTO = { id: string; answer: string; method: "ai" | "search"; notice: string | null; citations: { n: number; title: string; excerpt: string; fileId: string }[] };

const dto = (id: string, a: hd.Answer): SuggestionDTO => ({ id, answer: a.answer, method: a.method, notice: a.notice, citations: a.citations.map((c) => ({ n: c.n, title: c.title, excerpt: c.excerpt, fileId: c.fileId })) });

/** Before raising a ticket: an answer from the policies the asker can see, with sources. */
export async function askPoliciesAction(question: string) {
  const c = await runAction((tx, actor) => hd.askContext(tx, actor, String(question ?? "").slice(0, 2000)), { refresh: false });
  if (!c.ok) return c;
  const a = await hd.answer(c.data!, "self_service");
  return runAction(async (tx, actor) => dto(await hd.recordSuggestion(tx, actor, c.data!, a, "self_service"), a), { refresh: false });
}

export async function rateSuggestionAction(id: string, helpful: boolean) {
  if (!uuid.safeParse(id).success) return bad("Suggestion not found.");
  return runAction((tx, actor) => hd.rateSuggestion(tx, actor, id, helpful === true), { refresh: false });
}

/** For agents: a draft reply to a ticket, from the policies the requester can see. Never sent automatically. */
export async function draftReplyAction(ticketId: string) {
  if (!uuid.safeParse(ticketId).success) return bad("Ticket not found.");
  const c = await runAction((tx, actor) => hd.draftContext(tx, actor, ticketId), { refresh: false });
  if (!c.ok) return c;
  const a = await hd.answer(c.data!, "agent_draft");
  return runAction(async (tx, actor) => dto(await hd.recordSuggestion(tx, actor, c.data!, a, "agent_draft"), a), { refresh: false });
}

export async function saveHelpdeskAssistantAction(input: { aiEnabled: boolean; suggestBeforeRaise: boolean }) {
  return runAction((tx, actor) => hd.saveHelpdeskSettings(tx, actor, { ai_enabled: input?.aiEnabled !== false, suggest_before_raise: input?.suggestBeforeRaise !== false }));
}
