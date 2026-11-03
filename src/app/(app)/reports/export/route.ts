import { z } from "zod";
import { withTenant, AppError } from "@/server/db";
import { getActor } from "@/server/auth/session";
import { exportSaved, exportStandard } from "@/server/modules/reports/service";

/**
 * Download a report: ?key=<standard key>&<filters> or ?saved=<saved report id>, with &format=csv|xlsx.
 * Rows are limited to the people the reader may see; every export is written to the audit log.
 */
export async function GET(req: Request) {
  const actor = await getActor();
  if (!actor) return new Response("Sign in first.", { status: 401 });
  const q = new URL(req.url).searchParams;
  const format = q.get("format") === "csv" ? "csv" : "xlsx";
  const key = q.get("key"), saved = q.get("saved");
  try {
    const file = await withTenant(actor.tenant.id, async (tx) => {
      if (saved) {
        if (!z.uuid().safeParse(saved).success) throw new AppError("not_found", "Report not found.");
        return exportSaved(tx, actor, saved, format);
      }
      if (!key || !/^[a-z_]{2,40}$/.test(key)) throw new AppError("not_found", "Report not found.");
      const raw: Record<string, string | undefined> = {};
      for (const [k, v] of q.entries()) if (/^[a-z_]{1,40}$/.test(k) && k !== "format" && k !== "key") raw[k] = v.slice(0, 80);
      return exportStandard(tx, actor, key, raw, format);
    });
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "content-type": file.mime,
        "content-disposition": `attachment; filename="${file.name}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: e.code === "forbidden" ? 403 : e.code === "not_found" ? 404 : 400 });
    throw e;
  }
}
