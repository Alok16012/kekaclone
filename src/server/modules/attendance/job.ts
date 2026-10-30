import "server-only";
import { withTenant } from "@/server/db";
import type { ISODate } from "@/lib/dates";
import { processAttendance } from "./process";

/**
 * Nightly run for one tenant and date: everyone employed on that date (joined, and not past their last working day,
 * so someone relieved today still gets their final days processed), one transaction each,
 * so one bad record doesn't stop the rest. Idempotent, so re-running a date is safe.
 */
export async function processTenantDate(tenantId: string, date: ISODate, now = new Date()) {
  const people = await withTenant(tenantId, (tx) => tx<{ id: string }[]>`
    select id from employees where joining_date <= ${date} and (exit_date is null or exit_date >= ${date}) and (status <> 'relieved' or exit_date is not null) order by id`);
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
