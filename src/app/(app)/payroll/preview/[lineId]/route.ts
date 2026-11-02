import { z } from "zod";
import { withTenant } from "@/server/db";
import { getActor } from "@/server/auth/session";
import { previewPayslip } from "@/server/modules/payrun/payslips";

/** A payslip rendered on the fly for one line of a run (payroll only), to check it before releasing. */
export async function GET(_req: Request, ctx: RouteContext<"/payroll/preview/[lineId]">) {
  const { lineId } = await ctx.params;
  const actor = await getActor();
  if (!actor) return new Response("Sign in first.", { status: 401 });
  if (!z.uuid().safeParse(lineId).success) return new Response("Not found.", { status: 404 });
  const bytes = await withTenant(actor.tenant.id, (tx) => previewPayslip(tx, actor, lineId));
  if (!bytes) return new Response("Not found.", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="payslip-preview.pdf"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
}
