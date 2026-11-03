import type { NextRequest } from "next/server";
import { withTenant } from "@/server/db";
import { resolveTenant } from "@/server/auth/session";
import { logoFile } from "@/server/modules/saas/branding";
import { storage } from "@/server/storage";

/**
 * The company logo, public (the sign-in page shows it before anyone is signed in). The tenant comes from the
 * subdomain and only the one file its branding points at is ever served.
 */
export async function GET(req: NextRequest) {
  const tenant = await resolveTenant(req.headers.get("x-erp-tenant"));
  if (!tenant) return new Response("Not found.", { status: 404 });
  const f = await withTenant(tenant.id, (tx) => logoFile(tx, tenant.branding));
  if (!f) return new Response("Not found.", { status: 404 });
  const bytes = await storage().get(f.storage_key);
  if (!bytes) return new Response("Not found.", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: { "content-type": f.mime, "cache-control": "public, max-age=300", "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'" },
  });
}
