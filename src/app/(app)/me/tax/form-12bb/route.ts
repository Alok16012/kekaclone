import { z } from "zod";
import { withTenant } from "@/server/db";
import { getActor } from "@/server/auth/session";
import { form12bbData } from "@/server/modules/tax/service";
import { render12bb } from "@/server/modules/tax/pdf";
import { fyStartFromLabel } from "@/server/modules/tax/rules";

/**
 * The declaration summary (Form 12BB details) as a PDF: `?fy=2026-27`, and `&employee=<id>` for a payroll admin.
 * Built on the fly from the saved declaration; never cached.
 */
export async function GET(req: Request) {
  const actor = await getActor();
  if (!actor) return new Response("Sign in first.", { status: 401 });
  const u = new URL(req.url);
  const fy = fyStartFromLabel(u.searchParams.get("fy") ?? "");
  const employee = u.searchParams.get("employee") ?? actor.employeeId;
  if (!fy || !z.uuid().safeParse(employee).success) return new Response("Not found.", { status: 404 });
  const d = await withTenant(actor.tenant.id, (tx) => form12bbData(tx, actor, employee, fy));
  if (!d) return new Response("Not found.", { status: 404 });
  const bytes = await render12bb(d);
  const name = `declaration-${d.fy}-${d.name.replace(/[^A-Za-z0-9]+/g, "-")}.pdf`;
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/pdf", "content-length": String(bytes.byteLength),
      "content-disposition": `attachment; filename="${name}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff",
    },
  });
}
