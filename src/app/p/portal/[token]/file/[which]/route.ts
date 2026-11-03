import { withTenant } from "@/server/db";
import { currentSubdomain, resolveTenant } from "@/server/auth/session";
import { portalFile } from "@/server/modules/hire/offers";
import { storage } from "@/server/storage";

/** The candidate's own offer letter ("offer") or a document they uploaded (its request id), via their portal token. */
export async function GET(_req: Request, ctx: RouteContext<"/p/portal/[token]/file/[which]">) {
  const { token, which } = await ctx.params;
  if (which !== "offer" && !/^[0-9a-f-]{36}$/i.test(which)) return new Response("Not found.", { status: 404 });
  const tenant = await resolveTenant(await currentSubdomain());
  if (!tenant) return new Response("Not found.", { status: 404 });
  const f = await withTenant(tenant.id, (tx) => portalFile(tx, token, which));
  if (!f) return new Response("Not found.", { status: 404 });
  const bytes = await storage().get(f.storage_key);
  if (!bytes) return new Response("This file is no longer available.", { status: 410 });
  const ascii = f.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": f.mime, "content-disposition": `${f.mime === "application/pdf" ? "inline" : "attachment"}; filename="${ascii}"`,
      "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      ...(f.mime === "application/pdf" ? {} : { "content-security-policy": "sandbox; default-src 'none'" }),
    },
  });
}
