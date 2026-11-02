import { z } from "zod";
import { withTenant } from "@/server/db";
import { getActor } from "@/server/auth/session";
import { taxFileFor } from "@/server/modules/tax/service";
import { storage } from "@/server/storage";

/**
 * Open a tax proof or Form 16 file. Only the person it belongs to (Form 16 once published) and payroll admins covering
 * them can; everyone else gets the same "not found" as for a missing file. Private, never cached, sandboxed (PDFs excepted).
 */
export async function GET(req: Request, ctx: RouteContext<"/tax/files/[id]">) {
  const { id } = await ctx.params;
  const actor = await getActor();
  if (!actor) return new Response("Sign in first.", { status: 401 });
  if (!z.uuid().safeParse(id).success) return new Response("Not found.", { status: 404 });
  const f = await withTenant(actor.tenant.id, (tx) => taxFileFor(tx, actor, id));
  if (!f) return new Response("Not found.", { status: 404 });
  const bytes = await storage().get(f.storage_key);
  if (!bytes) return new Response("This file is no longer available.", { status: 410 });
  const download = new URL(req.url).searchParams.has("download");
  const ascii = f.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": f.mime,
      "content-length": String(bytes.byteLength),
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      ...(f.mime === "application/pdf" ? {} : { "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'" }),
    },
  });
}
