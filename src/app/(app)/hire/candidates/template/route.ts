import { getActor } from "@/server/auth/session";
import { canRecruit, hasHireAccess } from "@/server/modules/hire/access";
import { importTemplate } from "@/server/modules/hire/candidates";
import { withTenant } from "@/server/db";

/** The Excel template for importing candidates. */
export async function GET() {
  const actor = await getActor();
  if (!actor) return new Response("Sign in first.", { status: 401 });
  const ok = canRecruit(actor) || (await withTenant(actor.tenant.id, (tx) => hasHireAccess(tx, actor)));
  if (!ok) return new Response("Not found.", { status: 404 });
  const bytes = await importTemplate();
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="candidates-import-template.xlsx"',
      "cache-control": "private, no-store",
    },
  });
}
