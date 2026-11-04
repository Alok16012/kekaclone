import { withTenant } from "@/server/db";
import { currentSubdomain, resolveTenant } from "@/server/auth/session";
import { joinerOfferFile } from "@/server/modules/onboarding/offer-sign";
import { storage } from "@/server/storage";

/** The joiner's offer letter (the signed copy once signed), via their joiner-portal token. */
export async function GET(_req: Request, ctx: RouteContext<"/join/[token]/offer">) {
  const { token } = await ctx.params;
  const tenant = await resolveTenant(await currentSubdomain());
  if (!tenant) return new Response("Not found.", { status: 404 });
  const f = await withTenant(tenant.id, (tx) => joinerOfferFile(tx, token));
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
