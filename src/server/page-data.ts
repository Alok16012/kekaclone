import "server-only";
import { connection } from "next/server";
import { withTenant, type Tx } from "@/server/db";
import { requireActor, type Actor } from "@/server/auth/session";
import { addDaysISO, eachDay, todayIn } from "@/lib/dates";
import { dayType } from "@/server/modules/leave/rules";
import { calendarFor } from "@/server/modules/leave/service";
import type { DayMark } from "@/ui/calendar";

/** Read-only page loader: the signed-in actor + a tenant-scoped transaction. */
export async function load<T>(fn: (tx: Tx, actor: Actor) => Promise<T>) {
  await connection();   // signed-in pages always render per request; reading the clock after this is fine
  const actor = await requireActor();
  return withTenant(actor.tenant.id, (tx) => fn(tx, actor));
}

/** Calendar decorations for the leave picker: off days and the person's own leave, ~2 months back to 12 ahead. */
export async function leaveMarks(tx: Tx, employeeId: string): Promise<Record<string, DayMark>> {
  const t = todayIn();
  const from = addDaysISO(t, -62), to = addDaysISO(t, 366);
  const cal = await calendarFor(tx, employeeId);
  const marks: Record<string, DayMark> = {};
  for (const d of eachDay(from, to)) {
    const k = dayType(d, cal);
    if (k === "holiday") marks[d] = "holiday";
    else if (k === "weekly_off") marks[d] = "weekly_off";
  }
  const mine = await tx<{ from_date: string; to_date: string; days: string }[]>`
    select from_date::text, to_date::text, days from leave_requests where employee_id = ${employeeId} and status in ('pending','approved') and to_date >= ${from}`;
  for (const l of mine) for (const d of eachDay(l.from_date, l.to_date)) if (!marks[d]) marks[d] = Number(l.days) < 1 ? "half" : "leave";
  return marks;
}

export function timeAgo(d: Date, now = new Date()) {
  const s = Math.round((now.getTime() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const days = Math.floor(s / 86400);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
