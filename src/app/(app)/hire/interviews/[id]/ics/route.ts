import { z } from "zod";
import { withTenant } from "@/server/db";
import { getActor } from "@/server/auth/session";
import { interviewIcs } from "@/server/modules/hire/interviews";

/** A calendar file for an interview (until Google / Microsoft calendar sync is configured). */
export async function GET(_req: Request, ctx: RouteContext<"/hire/interviews/[id]/ics">) {
  const { id } = await ctx.params;
  const actor = await getActor();
  if (!actor) return new Response("Sign in first.", { status: 401 });
  if (!z.uuid().safeParse(id).success) return new Response("Not found.", { status: 404 });
  const ics = await withTenant(actor.tenant.id, (tx) => interviewIcs(tx, actor, id));
  if (!ics) return new Response("Not found.", { status: 404 });
  return new Response(ics, { headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": 'attachment; filename="interview.ics"', "cache-control": "private, no-store" } });
}
