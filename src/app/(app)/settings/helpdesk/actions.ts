"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import * as hd from "@/server/modules/helpdesk/service";

const uuid = z.uuid();
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });
const mins = z.number().int().nullable();
const input = z.object({
  name: z.string().max(200), priority: z.enum(["low", "medium", "high"]), firstResponseMins: mins, resolutionMins: mins,
  assigneeIds: z.array(uuid).max(50), escalateToId: uuid.nullable(),
});

export async function saveTicketCategoryAction(id: string | null, raw: z.input<typeof input>) {
  const p = input.safeParse(raw);
  if ((id && !uuid.safeParse(id).success) || !p.success) return bad("Check the category details.");
  return runAction((tx, actor) => hd.saveCategory(tx, actor, id, p.data));
}

export async function deleteTicketCategoryAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Category not found.");
  return runAction((tx, actor) => hd.deleteCategory(tx, actor, id));
}
