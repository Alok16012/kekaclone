/**
 * Learn job: enrols people that assignment rules now match (new joiners, department moves) and sends due-soon / overdue
 * reminders once a day per person and course. Safe to run any number of times. Schedule it daily, early morning IST.
 *   pnpm jobs:learn                 all tenants, today
 *   pnpm jobs:learn 2026-12-01      pretend it's this date (testing)
 */
import postgres from "postgres";
import { withTenant, sql } from "@/server/db";
import { deliverQueued } from "@/server/email";
import { applyAssignments, sendReminders } from "@/server/modules/learn/service";
import { todayIn } from "@/lib/dates";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });

async function main() {
  const arg = process.argv[2];
  const today = arg ?? todayIn();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error("Date must look like 2026-12-01");
  // the one cross-tenant read: companies with a published course (owner connection); each is then handled under RLS
  const tenants = await admin<{ id: string; name: string; subdomain: string }[]>`
    select distinct t.id, t.name, t.subdomain from tenants t join courses c on c.tenant_id = t.id where c.status = 'published' and t.status <> 'cancelled' order by t.subdomain`;
  let enrolled = 0, reminded = 0;
  for (const t of tenants) {
    try {
      const r = await withTenant(t.id, async (tx) => ({ e: await applyAssignments(tx, t.id, today), r: await sendReminders(tx, { id: t.id, name: t.name, subdomain: t.subdomain }, today) }));
      await deliverQueued(t.id);
      enrolled += r.e; reminded += r.r;
      if (r.e || r.r) console.log(`${t.subdomain}: enrolled ${r.e}, reminded ${r.r}`);
    } catch (e) {
      console.error(`${t.subdomain}: failed`, e);   // one tenant failing doesn't stop the others
      process.exitCode = 1;
    }
  }
  console.log(`learn job done: ${enrolled} enrolled, ${reminded} reminded across ${tenants.length} ${tenants.length === 1 ? "company" : "companies"}`);
}

main().finally(async () => { await admin.end(); await sql.end(); });
