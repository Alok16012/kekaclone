"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import * as home from "@/server/modules/home/service";

const uuid = z.uuid();
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });

export async function saveQuickLinkAction(id: string | null, input: { label: string; url: string }) {
  if ((id !== null && !uuid.safeParse(id).success) || typeof input?.label !== "string" || typeof input?.url !== "string" || input.url.length > 2100) return bad("Check the link and try again.");
  return runAction((tx, actor) => home.saveQuickLink(tx, actor, id, { label: input.label.slice(0, 100), url: input.url }));
}

export async function deleteQuickLinkAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Link not found.");
  return runAction((tx, actor) => home.deleteQuickLink(tx, actor, id));
}

export async function moveQuickLinkAction(id: string, dir: "up" | "down") {
  if (!uuid.safeParse(id).success || !["up", "down"].includes(dir)) return bad("Link not found.");
  return runAction((tx, actor) => home.moveQuickLink(tx, actor, id, dir));
}
