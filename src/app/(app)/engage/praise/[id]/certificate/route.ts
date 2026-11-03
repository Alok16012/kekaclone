import { z } from "zod";
import { withTenant } from "@/server/db";
import { getActor } from "@/server/auth/session";
import { praiseCertificate } from "@/server/modules/praise/certificate";

/** PDF certificate for one recipient of a praise (?to=<employee id>). Same visibility as the praise on the wall. */
export async function GET(req: Request, ctx: RouteContext<"/engage/praise/[id]/certificate">) {
  const { id } = await ctx.params;
  const to = new URL(req.url).searchParams.get("to") ?? "";
  const actor = await getActor();
  if (!actor) return new Response("Sign in first.", { status: 401 });
  if (!z.uuid().safeParse(id).success || !z.uuid().safeParse(to).success) return new Response("Not found.", { status: 404 });
  const c = await withTenant(actor.tenant.id, (tx) => praiseCertificate(tx, actor, id, to));
  if (!c) return new Response("Not found.", { status: 404 });
  return new Response(new Uint8Array(c.bytes), {
    headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${c.filename}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
}
