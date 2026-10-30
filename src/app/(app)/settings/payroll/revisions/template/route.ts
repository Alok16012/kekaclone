import { withTenant, AppError } from "@/server/db";
import { getActor } from "@/server/auth/session";
import { buildRevisionTemplate } from "@/server/modules/payroll/revisions";

/** Salary revision template, pre-filled with the people the admin manages and today's CTC. */
export async function GET() {
  const actor = await getActor();
  if (!actor) return new Response("Sign in first.", { status: 401 });
  try {
    const buf = await withTenant(actor.tenant.id, (tx) => buildRevisionTemplate(tx, actor));
    return new Response(new Uint8Array(buf), {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="erp-salary-revisions.xlsx"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: 403 });
    throw e;
  }
}
