import { z } from "zod";
import { withTenant } from "@/server/db";
import { getActor } from "@/server/auth/session";
import { payrollFileFor } from "@/server/modules/payrun/payslips";
import { claimFileFor } from "@/server/modules/payroll/claims";
import { storage } from "@/server/storage";

/**
 * Open a payroll file: a payslip (its owner once released, or payroll), a final settlement statement (the person once
 * finalised, or payroll) or a bank transfer file (payroll only). Anyone else gets the same "not found" as for a missing file.
 */
export async function GET(req: Request, ctx: RouteContext<"/payroll/files/[id]">) {
  const { id } = await ctx.params;
  const actor = await getActor();
  if (!actor) return new Response("Sign in first.", { status: 401 });
  if (!z.uuid().safeParse(id).success) return new Response("Not found.", { status: 404 });
  const f = await withTenant(actor.tenant.id, async (tx) => (await payrollFileFor(tx, actor, id)) ?? (await claimFileFor(tx, actor, id)));
  if (!f) return new Response("Not found.", { status: 404 });
  const bytes = await storage().get(f.storage_key);
  if (!bytes) return new Response("This file is no longer available.", { status: 410 });
  const download = new URL(req.url).searchParams.has("download") || f.mime !== "application/pdf";
  const ascii = f.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": f.mime, "content-length": String(bytes.byteLength),
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      "cache-control": "private, no-store", "x-content-type-options": "nosniff",
      ...(f.mime === "application/pdf" ? {} : { "content-security-policy": "sandbox; default-src 'none'" }),
    },
  });
}
