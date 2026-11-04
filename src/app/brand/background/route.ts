import type { NextRequest } from "next/server";
import { withTenant } from "@/server/db";
import { resolveTenant } from "@/server/auth/session";
import { backgroundFile } from "@/server/modules/saas/branding";
import { storage } from "@/server/storage";

/** The sign-in page background image, public like the logo: only the one file the tenant's branding points at. */
export async function GET(req: NextRequest) {
  const tenant = await resolveTenant(req.headers.get("x-erp-tenant"));
  if (!tenant) return new Response("Not found.", { status: 404 });
  const f = await withTenant(tenant.id, (tx) => backgroundFile(tx, tenant.branding));
  if (!f) return new Response("Not found.", { status: 404 });
  const bytes = await storage().get(f.storage_key);
  if (!bytes) return new Response("Not found.", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: { "content-type": f.mime, "cache-control": "public, max-age=300", "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'" },
  });
}
