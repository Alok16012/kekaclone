import { withTenant } from "@/server/db";
import { resolveTenant } from "@/server/auth/session";
import { signFile } from "@/server/modules/documents/esign";
import { storage } from "@/server/storage";

/** The document a signer is asked to sign, as it stands (original plus signatures so far). Token-gated, never cached. */
export async function GET(req: Request, ctx: RouteContext<"/sign/[token]/file">) {
  const { token } = await ctx.params;
  const tenant = await resolveTenant(req.headers.get("x-erp-tenant"));
  if (!tenant || typeof token !== "string" || token.length < 20 || token.length > 100) return new Response("Not found.", { status: 404 });
  const f = await withTenant(tenant.id, (tx) => signFile(tx, token));
  if (!f) return new Response("Not found.", { status: 404 });
  const bytes = await storage().get(f.storage_key);
  if (!bytes) return new Response("This file is no longer available.", { status: 410 });
  const download = new URL(req.url).searchParams.has("download");
  const ascii = f.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  return new Response(new Uint8Array(bytes), {
    headers: { "content-type": f.mime, "content-length": String(bytes.byteLength), "content-disposition": `${download ? "attachment" : "inline"}; filename="${ascii}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
}
