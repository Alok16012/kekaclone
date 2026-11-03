import { z } from "zod";
import { withTenant } from "@/server/db";
import { getActor } from "@/server/auth/session";
import { invoiceDetail } from "@/server/modules/psa/service";
import { renderInvoicePdf } from "@/server/modules/psa/pdf";

/** The invoice as a PDF, rendered on demand for billing and project admins. Private, never cached. */
export async function GET(req: Request, ctx: RouteContext<"/psa/billing/[id]/pdf">) {
  const { id } = await ctx.params;
  const actor = await getActor();
  if (!actor) return new Response("Sign in first.", { status: 401 });
  if (!z.uuid().safeParse(id).success) return new Response("Not found.", { status: 404 });
  const inv = await withTenant(actor.tenant.id, (tx) => invoiceDetail(tx, actor, id));
  if (!inv) return new Response("Not found.", { status: 404 });   // same answer for "missing" and "not yours"
  const bytes = await renderInvoicePdf(inv);
  const download = new URL(req.url).searchParams.has("download");
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-length": String(bytes.byteLength),
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${inv.number}.pdf"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
