import { z } from "zod";
import { AppError, withTenant } from "@/server/db";
import { getActor } from "@/server/auth/session";
import { canRunPayroll } from "@/server/modules/payrun/access";
import * as reports from "@/server/modules/payrun/reports";

const KINDS = ["register", "pf-ecr", "esi", "pt", "journal"] as const;
const headers = (mime: string, name: string) => ({
  "content-type": mime, "content-disposition": `attachment; filename="${name}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff",
});

/** Payroll reports for one run: register (xlsx), PF ECR (text), ESI, PT and journal (CSV). Payroll only. */
export async function GET(_req: Request, ctx: RouteContext<"/payroll/runs/[id]/export/[kind]">) {
  const { id, kind } = await ctx.params;
  const actor = await getActor();
  if (!actor) return new Response("Sign in first.", { status: 401 });
  if (!canRunPayroll(actor)) return new Response("You don't have access to payroll reports.", { status: 403 });
  if (!z.uuid().safeParse(id).success || !(KINDS as readonly string[]).includes(kind)) return new Response("Not found.", { status: 404 });
  try {
    return await withTenant(actor.tenant.id, async (tx) => {
      if (kind === "register") { const r = await reports.registerXlsx(tx, actor, id); return new Response(new Uint8Array(r.bytes), { headers: headers("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", r.name) }); }
      const r = kind === "pf-ecr" ? await reports.pfEcr(tx, actor, id) : kind === "esi" ? await reports.esiFile(tx, actor, id) : kind === "pt" ? await reports.ptSummary(tx, actor, id) : await reports.journal(tx, actor, id);
      return new Response((kind === "pf-ecr" ? "" : "\ufeff") + r.text, { headers: headers(kind === "pf-ecr" ? "text/plain; charset=utf-8" : "text/csv; charset=utf-8", r.name) });
    });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: e.code === "not_found" ? 404 : e.code === "forbidden" ? 403 : 422, headers: { "content-type": "text/plain; charset=utf-8" } });
    throw e;
  }
}
