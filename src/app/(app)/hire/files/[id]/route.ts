import { z } from "zod";
import { withTenant } from "@/server/db";
import { getActor } from "@/server/auth/session";
import { hireFileFor } from "@/server/modules/hire/candidates";
import { storage } from "@/server/storage";

const INLINE = new Set(["application/pdf", "image/png", "image/jpeg", "text/plain"]);

/** Resumes, joining documents and offer letters, for people who can see the candidate. Same 404 for missing and not yours. */
export async function GET(req: Request, ctx: RouteContext<"/hire/files/[id]">) {
  const { id } = await ctx.params;
  const actor = await getActor();
  if (!actor) return new Response("Sign in first.", { status: 401 });
  if (!z.uuid().safeParse(id).success) return new Response("Not found.", { status: 404 });
  const f = await withTenant(actor.tenant.id, (tx) => hireFileFor(tx, actor, id));
  if (!f) return new Response("Not found.", { status: 404 });
  const bytes = await storage().get(f.storage_key);
  if (!bytes) return new Response("This file is no longer available.", { status: 410 });
  const download = new URL(req.url).searchParams.has("download") || !INLINE.has(f.mime);
  const ascii = f.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": f.mime, "content-length": String(bytes.byteLength),
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      "cache-control": "private, no-store", "x-content-type-options": "nosniff",
      ...(f.mime === "application/pdf" ? {} : { "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'" }),
    },
  });
}
