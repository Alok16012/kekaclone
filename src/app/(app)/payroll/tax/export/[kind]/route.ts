import { AppError, withTenant } from "@/server/db";
import { getActor } from "@/server/auth/session";
import { form24q } from "@/server/modules/payrun/returns";
import { fyStartFromLabel } from "@/server/modules/tax/rules";

/** Form 24Q data: /payroll/tax/export/24q-annexure1?fy=2026-27&q=1 and /payroll/tax/export/24q-annexure2?fy=2026-27 (Q4). CSV data exports, payroll admins only. */
export async function GET(req: Request, ctx: RouteContext<"/payroll/tax/export/[kind]">) {
  const { kind } = await ctx.params;
  const actor = await getActor();
  if (!actor) return new Response("Sign in first.", { status: 401 });
  const url = new URL(req.url);
  const fy = fyStartFromLabel(url.searchParams.get("fy") ?? "");
  const q = Number(url.searchParams.get("q") ?? (kind === "24q-annexure2" ? "4" : ""));
  if (!fy || !["24q-annexure1", "24q-annexure2"].includes(kind) || ![1, 2, 3, 4].includes(q)) return new Response("Not found.", { status: 404 });
  try {
    return await withTenant(actor.tenant.id, async (tx) => {
      const r = await form24q(tx, actor, fy, q as 1 | 2 | 3 | 4, kind === "24q-annexure1" ? 1 : 2);
      return new Response("\ufeff" + r.text, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${r.name}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
    });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: e.code === "not_found" ? 404 : e.code === "forbidden" ? 403 : 422, headers: { "content-type": "text/plain; charset=utf-8" } });
    throw e;
  }
}
