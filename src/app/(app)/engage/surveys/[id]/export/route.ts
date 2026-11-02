import { z } from "zod";
import { AppError, withTenant } from "@/server/db";
import { getActor } from "@/server/auth/session";
import { exportCsv } from "@/server/modules/surveys/service";

/** CSV of one round's answers, for survey admins. Anonymous surveys: no names and refused under the threshold. */
export async function GET(req: Request, ctx: RouteContext<"/engage/surveys/[id]/export">) {
  const { id } = await ctx.params;
  const actor = await getActor();
  if (!actor) return new Response("Sign in first.", { status: 401 });
  if (!z.uuid().safeParse(id).success) return new Response("Not found.", { status: 404 });
  const round = Number(new URL(req.url).searchParams.get("round")) || null;
  try {
    const f = await withTenant(actor.tenant.id, (tx) => exportCsv(tx, actor, id, round));
    return new Response(f.csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${f.filename}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: e.code === "forbidden" ? 403 : e.code === "not_found" ? 404 : 400 });
    throw e;
  }
}
