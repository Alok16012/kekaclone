import { z } from "zod";
import { withTenant } from "@/server/db";
import { getActor } from "@/server/auth/session";
import { todayIn } from "@/lib/dates";
import { isLeaveAdmin } from "@/server/modules/leave/access";
import { policyFor, policyPdf } from "@/server/modules/leave/policy-doc";

/** A plan's policy document as a PDF, for leave admins. */
export async function GET(_req: Request, ctx: RouteContext<"/settings/leave/plans/[id]/policy/pdf">) {
  const { id } = await ctx.params;
  const actor = await getActor();
  if (!actor) return new Response("Sign in first.", { status: 401 });
  if (!isLeaveAdmin(actor)) return new Response("You don't have access to this.", { status: 403 });
  if (!z.uuid().safeParse(id).success) return new Response("Not found.", { status: 404 });
  const doc = await withTenant(actor.tenant.id, (tx) => policyFor(tx, id, todayIn()));
  if (!doc) return new Response("Not found.", { status: 404 });
  const bytes = await policyPdf(doc);
  const name = doc.plan.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  return new Response(new Uint8Array(bytes), { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${name} leave policy.pdf"`, "cache-control": "private, no-store" } });
}
