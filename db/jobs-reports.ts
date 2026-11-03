/**
 * Scheduled reports job: runs every saved report whose next run is due, as its owner, stores the file and tells the
 * recipients (notification + email with a sign-in link). Safe to run any number of times. Schedule it hourly.
 *   pnpm jobs:reports                              all tenants, now
 *   pnpm jobs:reports 2026-12-01T09:05:00+05:30    pretend it's this moment (testing)
 */
import postgres from "postgres";
import { withTenant, sql } from "@/server/db";
import { deliverQueued } from "@/server/email";
import { deliverDue } from "@/server/modules/reports/service";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });

async function main() {
  const arg = process.argv[2];
  const now = arg ? new Date(arg) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error("Time must look like 2026-12-01T09:05:00+05:30");
  const due = await admin<{ id: string; name: string; subdomain: string }[]>`
    select distinct t.id, t.name, t.subdomain from tenants t join saved_reports s on s.tenant_id = t.id where s.next_run_at <= ${now} and t.status <> 'cancelled' order by t.subdomain`;
  let total = 0;
  for (const t of due) {
    try {
      const n = await withTenant(t.id, (tx) => deliverDue(tx, { id: t.id, name: t.name, status: "active", subdomain: t.subdomain }, now));
      await deliverQueued(t.id);
      total += n;
      if (n) console.log(`${t.subdomain}: sent ${n} ${n === 1 ? "report" : "reports"}`);
    } catch (e) {
      console.error(`${t.subdomain}: failed`, e);
      process.exitCode = 1;
    }
  }
  console.log(`reports job done: ${total} sent across ${due.length} ${due.length === 1 ? "company" : "companies"} with due schedules`);
}

main().finally(async () => { await admin.end(); await sql.end(); });
