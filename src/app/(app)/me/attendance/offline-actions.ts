"use server";
import { runAction } from "@/server/action";
import { syncQueuedPunches } from "@/server/modules/attendance/offline";

/** Punches the clock card queued while the phone was offline (plat2). The service validates and orders them. */
export async function syncQueuedPunchesAction(items: unknown) {
  if (!Array.isArray(items) || items.length > 50) return { ok: false as const, error: "Nothing to send, or too many queued punches." };
  return runAction((tx, actor) => syncQueuedPunches(tx, actor, items));
}
