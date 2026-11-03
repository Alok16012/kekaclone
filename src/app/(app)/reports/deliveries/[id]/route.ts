import { z } from "zod";
import { withTenant } from "@/server/db";
import { getActor } from "@/server/auth/session";
import { deliveryFileFor } from "@/server/modules/reports/service";
import { storage } from "@/server/storage";

/** A scheduled report's file: only for the people it was sent to and the report's owner. Private, never cached. */
export async function GET(_req: Request, ctx: RouteContext<"/reports/deliveries/[id]">) {
  const { id } = await ctx.params;
  const actor = await getActor();
  if (!actor) return new Response("Sign in first.", { status: 401 });
  if (!z.uuid().safeParse(id).success) return new Response("Not found.", { status: 404 });
  const d = await withTenant(actor.tenant.id, (tx) => deliveryFileFor(tx, actor, id));
  if (!d) return new Response("Not found.", { status: 404 });   // same answer for "missing" and "not yours"
  const bytes = await storage().get(d.storage_key);
  if (!bytes) return new Response("This file is no longer available.", { status: 410 });
  const ascii = d.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": d.mime,
      "content-length": String(bytes.byteLength),
      "content-disposition": `attachment; filename="${ascii}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
