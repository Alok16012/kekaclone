import ExcelJS from "exceljs";
import { withTenant, AppError } from "@/server/db";
import { getActor } from "@/server/auth/session";
import { directoryExport, filtersFrom } from "@/server/modules/corehr/people";
import { toCsv } from "@/server/modules/corehr/rules";
import { todayIn } from "@/lib/dates";

/** People export (CSV or Excel) with the directory's filters. HR/readers only, rows limited to their scope. */
export async function GET(req: Request) {
  const actor = await getActor();
  if (!actor) return new Response("Sign in first.", { status: 401 });
  const url = new URL(req.url);
  const f = filtersFrom(Object.fromEntries(url.searchParams));
  const format = url.searchParams.get("format") === "xlsx" ? "xlsx" : "csv";
  try {
    const { header, rows } = await withTenant(actor.tenant.id, (tx) => directoryExport(tx, actor, f));
    const name = `people-${todayIn()}`;
    if (format === "csv") {
      return new Response("﻿" + toCsv([header, ...rows]), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}.csv"`, "cache-control": "no-store" } });
    }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("People", { views: [{ state: "frozen", ySplit: 1 }] });
    ws.addRow(header).font = { bold: true };
    for (const r of rows) ws.addRow(r);
    ws.columns.forEach((c) => (c.width = 18));
    const buf = await wb.xlsx.writeBuffer();
    return new Response(new Uint8Array(buf as ArrayBuffer), { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename="${name}.xlsx"`, "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: 403 });
    throw e;
  }
}
