import "server-only";
import { refresh } from "next/cache";
import { AppError, withTenant, type Tx } from "@/server/db";
import { requireActor, type Actor } from "@/server/auth/session";
import { deliverQueued } from "@/server/email";
import { deliverWebhooks } from "@/server/modules/integrations/service";
import { deliverPush } from "@/server/modules/push/service";
import { syncCalendars } from "@/server/modules/calendar/service";
import { assertFeature } from "@/server/modules/saas/gate";
import type { Feature } from "@/server/modules/saas/plans";

export type ActionResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string; field?: string };

/** Runs a mutation as the signed-in person inside their tenant, maps known errors to messages, refreshes the page. */
export async function runAction<T>(fn: (tx: Tx, actor: Actor) => Promise<T>, opts: { refresh?: boolean; feature?: Feature } = { refresh: true }): Promise<ActionResult<T>> {
  const actor = await requireActor();
  try {
    if (opts.feature) assertFeature(actor, opts.feature);   // plan gate (saas/plans.ts): the page shows the same notice
    const data = await withTenant(actor.tenant.id, (tx) => fn(tx, actor));
    await deliverQueued(actor.tenant.id).catch((e) => console.error("email delivery", e));   // after commit
    await deliverWebhooks(actor.tenant.id).catch((e) => console.error("webhook delivery", e));
    await deliverPush(actor.tenant.id).catch((e) => console.error("push delivery", e));
    await syncCalendars(actor.tenant.id).catch((e) => console.error("calendar sync", e));
    if (opts.refresh !== false) refresh();
    return { ok: true, data };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, error: e.message, field: e.field };
    console.error(e);
    return { ok: false, error: "Something went wrong on our side. Please try again." };
  }
}
