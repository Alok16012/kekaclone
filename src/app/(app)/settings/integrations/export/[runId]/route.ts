import { z } from "zod";
import { AppError, withTenant } from "@/server/db";
import { getActor } from "@/server/auth/session";
import { accountingExport, isAccountingFormat } from "@/server/modules/integrations/accounting";

/** Accounting export of a finalised payroll run: ?format=tally|zoho. Payroll runners only. */
export async function GET(req: Request, ctx: RouteContext<"/settings/integrations/export/[runId]">) {
  const { runId } = await ctx.params;
  const actor = await getActor();
  if (!actor) return new Response("Sign in first.", { status: 401 });
  const format = new URL(req.url).searchParams.get("format");
  if (!z.uuid().safeParse(runId).success || !isAccountingFormat(format)) return new Response("Not found.", { status: 404 });
  try {
    const r = await withTenant(actor.tenant.id, (tx) => accountingExport(tx, actor, runId, format));
    return new Response("﻿" + r.text, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${r.name}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: e.code === "not_found" ? 404 : e.code === "forbidden" ? 403 : 422, headers: { "content-type": "text/plain; charset=utf-8" } });
    throw e;
  }
}
