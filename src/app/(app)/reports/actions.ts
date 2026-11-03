"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import * as reports from "@/server/modules/reports/service";

const uuid = z.uuid();
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });

export async function previewReportAction(dataset: string, definition: unknown) {
  if (typeof dataset !== "string") return bad("Pick a dataset.", "dataset");
  return runAction(async (tx, actor) => {
    const r = await reports.preview(tx, actor, dataset, definition);
    return { headers: r.headers, rows: r.rows.slice(0, 200).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "bigint" ? Number(v) : v]))), total: r.rows.length, def: r.def };
  }, { refresh: false });
}

export async function saveReportAction(id: string | null, input: { name: string; dataset: string; definition: unknown; sharedRoles: string[] }) {
  if (id !== null && !uuid.safeParse(id).success) return bad("Report not found.");
  const p = z.object({ name: z.string().max(200), dataset: z.string().max(40), definition: z.unknown(), sharedRoles: z.array(z.string().max(60)).max(20) }).safeParse(input);
  if (!p.success) return bad("Check the report details.", "name");
  return runAction((tx, actor) => reports.saveReport(tx, actor, id, p.data));
}

export async function deleteReportAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Report not found.");
  return runAction((tx, actor) => reports.deleteReport(tx, actor, id));
}

export async function setScheduleAction(id: string, schedule: unknown) {
  if (!uuid.safeParse(id).success) return bad("Report not found.");
  return runAction(async (tx, actor) => {
    const r = await reports.setSchedule(tx, actor, id, schedule);
    return r ? { next_run_at: r.next_run_at.toISOString() } : null;
  });
}
