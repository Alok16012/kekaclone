import { withTenant, AppError } from "@/server/db";
import { getActor } from "@/server/auth/session";
import { todayIn } from "@/lib/dates";
import { buildHolidayTemplate } from "@/server/modules/leave/holidays-import";

/** Holiday import template, pre-filled with the year's lists (?year=2027 for another year). */
export async function GET(req: Request) {
  const actor = await getActor();
  if (!actor) return new Response("Sign in first.", { status: 401 });
  const asked = Number(new URL(req.url).searchParams.get("year"));
  const year = Number.isInteger(asked) && asked >= 2000 && asked <= 2100 ? asked : Number(todayIn().slice(0, 4));
  try {
    const buf = await withTenant(actor.tenant.id, (tx) => buildHolidayTemplate(tx, actor, year));
    return new Response(new Uint8Array(buf), {
      headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename="erp-holidays-${year}.xlsx"`, "cache-control": "no-store" },
    });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: 403 });
    throw e;
  }
}
