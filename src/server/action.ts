import "server-only";
import { refresh } from "next/cache";
import { AppError, withTenant, type Tx } from "@/server/db";
import { requireActor, type Actor } from "@/server/auth/session";

export type ActionResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string; field?: string };

/** Runs a mutation as the signed-in person inside their tenant, maps known errors to messages, refreshes the page. */
export async function runAction<T>(fn: (tx: Tx, actor: Actor) => Promise<T>, opts: { refresh?: boolean } = { refresh: true }): Promise<ActionResult<T>> {
  const actor = await requireActor();
  try {
    const data = await withTenant(actor.tenant.id, (tx) => fn(tx, actor));
    if (opts.refresh !== false) refresh();
    return { ok: true, data };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, error: e.message, field: e.field };
    console.error(e);
    return { ok: false, error: "Something went wrong on our side. Please try again." };
  }
}
