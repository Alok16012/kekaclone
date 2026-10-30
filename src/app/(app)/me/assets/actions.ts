"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import * as assets from "@/server/modules/assets/service";

const uuid = z.uuid();
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });

const requestInput = z.object({ typeId: uuid, kind: z.enum(["new", "replacement"]), reason: z.string().max(1000).nullable().optional() });
export async function requestAssetAction(raw: z.input<typeof requestInput>) {
  const p = requestInput.safeParse(raw);
  if (!p.success) return bad("Pick what you need.", "typeId");
  return runAction((tx, actor) => assets.requestAsset(tx, actor, p.data));
}

export async function cancelAssetRequestAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Request not found.");
  return runAction((tx, actor) => assets.cancelRequest(tx, actor, id));
}

export async function acknowledgeAssetAction(assignmentId: string) {
  if (!uuid.safeParse(assignmentId).success) return bad("Asset not found.");
  return runAction(async (tx, actor) => { await assets.acknowledgeAssignment(tx, actor, assignmentId); });
}
