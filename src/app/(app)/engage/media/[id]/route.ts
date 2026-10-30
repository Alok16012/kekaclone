import { getActor } from "@/server/auth/session";
import { withTenant } from "@/server/db";
import { imageFor } from "@/server/modules/engage/service";
import { getObject } from "@/server/modules/engage/storage";

/** Wall images: only for signed-in people who can see the post (or uploaded the image). Never cached publicly. */
export async function GET(_req: Request, ctx: RouteContext<"/engage/media/[id]">) {
  const { id } = await ctx.params;
  const actor = await getActor();
  if (!actor) return new Response("Not found", { status: 404 });
  const f = await withTenant(actor.tenant.id, (tx) => imageFor(tx, actor, id));
  const bytes = f ? await getObject(f.storage_key) : null;
  if (!f || !bytes) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": f.mime,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
    },
  });
}
