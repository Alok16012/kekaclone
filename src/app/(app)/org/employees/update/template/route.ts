import { withTenant, AppError } from "@/server/db";
import { getActor } from "@/server/auth/session";
import { buildUpdateTemplate } from "@/server/modules/corehr/bulk-update";
import { todayIn } from "@/lib/dates";

/** Today's data for everyone the signed-in HR person manages, ready to edit and upload back. */
export async function GET() {
  const actor = await getActor();
  if (!actor) return new Response("Sign in first.", { status: 401 });
  try {
    const buf = await withTenant(actor.tenant.id, (tx) => buildUpdateTemplate(tx, actor));
    return new Response(new Uint8Array(buf), {
      headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename="erp-people-update-${todayIn()}.xlsx"`, "cache-control": "no-store" },
    });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: 403 });
    throw e;
  }
}
