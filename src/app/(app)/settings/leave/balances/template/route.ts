import { withTenant, AppError } from "@/server/db";
import { getActor } from "@/server/auth/session";
import { buildBalanceTemplate } from "@/server/modules/leave/admin";

/** Opening-balance template, pre-filled with today's balances for the people the admin manages. */
export async function GET() {
  const actor = await getActor();
  if (!actor) return new Response("Sign in first.", { status: 401 });
  try {
    const buf = await withTenant(actor.tenant.id, (tx) => buildBalanceTemplate(tx, actor));
    return new Response(new Uint8Array(buf), {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="erp-leave-balances.xlsx"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: 403 });
    throw e;
  }
}
