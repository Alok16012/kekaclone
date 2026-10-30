import "server-only";
import { withTenant } from "@/server/db";
import type { ISODate } from "@/lib/dates";
import { processAttendance } from "./process";

/**
 * Nightly run for one tenant and date: every active person who had joined by then, one transaction each,
 * so one bad record doesn't stop the rest. Idempotent, so re-running a date is safe.
 */
export async function processTenantDate(tenantId: string, date: ISODate, now = new Date()) {
  const people = await withTenant(tenantId, (tx) => tx<{ id: string }[]>`
    select id from employees where status <> 'relieved' and joining_date <= ${date} and (exit_date is null or exit_date >= ${date}) order by id`);
  let done = 0, skipped = 0;
  const failed: { employeeId: string; error: string }[] = [];
  for (const p of people) {
    try {
      const r = await withTenant(tenantId, (tx) => processAttendance(tx, tenantId, p.id, date, { now }));
      if (r) done++; else skipped++;
    } catch (e) {
      failed.push({ employeeId: p.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { people: people.length, done, skipped, failed };
}
