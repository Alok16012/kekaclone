import "server-only";
import type { Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";

/** Called by approvals.decide when a loan's chain finishes. Guarded on status, so a repeat does nothing. */
export async function onLoanDecided(tx: Tx, _actor: Actor | null, id: string, final: "approved" | "rejected") {
  await tx`update loans set status = ${final} where id = ${id} and status = 'requested'`;
}
