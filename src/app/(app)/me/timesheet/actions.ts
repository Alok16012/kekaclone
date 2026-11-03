"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import * as psa from "@/server/modules/psa/service";
import { isWeekStart, type GridRow } from "@/server/modules/psa/rules";

const rowSchema = z.object({
  projectId: z.uuid(), taskId: z.uuid().nullable(), billable: z.boolean(), note: z.string().max(500),
  minutes: z.array(z.number().int().min(0).max(1440)).length(7),
});
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });

function parse(weekStart: string, rows: unknown) {
  if (!isWeekStart(weekStart)) return "Weeks start on a Monday.";
  const r = z.array(rowSchema).max(40).safeParse(rows);
  if (!r.success) return "Some of the hours don't look right. Check each cell is a number of hours.";
  return r.data as GridRow[];
}

export async function saveWeekAction(weekStart: string, rows: unknown) {
  const parsed = parse(weekStart, rows);
  if (typeof parsed === "string") return bad(parsed);
  return runAction((tx, actor) => psa.saveWeek(tx, actor, weekStart, parsed));
}

export async function submitWeekAction(weekStart: string, rows: unknown) {
  const parsed = parse(weekStart, rows);
  if (typeof parsed === "string") return bad(parsed);
  return runAction((tx, actor) => psa.submitWeek(tx, actor, weekStart, parsed));
}

export async function withdrawWeekAction(weekStart: string) {
  if (!isWeekStart(weekStart)) return bad("Weeks start on a Monday.");
  return runAction((tx, actor) => psa.withdrawWeek(tx, actor, weekStart));
}
