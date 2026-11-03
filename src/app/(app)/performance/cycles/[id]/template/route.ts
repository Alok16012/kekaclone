import { z } from "zod";
import { withTenant } from "@/server/db";
import { getActor } from "@/server/auth/session";
import { calibrationTemplate } from "@/server/modules/performance/reviews";
import { AppError } from "@/server/db";

/** Calibration sheet for a cycle: the people the admin covers with computed and final ratings, to fill in and import. */
export async function GET(_req: Request, ctx: RouteContext<"/performance/cycles/[id]/template">) {
  const { id } = await ctx.params;
  const actor = await getActor();
  if (!actor) return new Response("Sign in first.", { status: 401 });
  if (!z.uuid().safeParse(id).success) return new Response("Not found.", { status: 404 });
  try {
    const buf = await withTenant(actor.tenant.id, (tx) => calibrationTemplate(tx, actor, id));
    return new Response(new Uint8Array(buf), { headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="calibration.xlsx"`, "cache-control": "private, no-store",
    } });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: e.code === "forbidden" ? 403 : 404 });
    throw e;
  }
}
