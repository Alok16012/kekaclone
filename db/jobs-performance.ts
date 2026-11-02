/**
 * Performance job: adds people to automatic review cycles when they reach the trigger (N days after joining, or N days
 * before probation ends) and sends goal check-in reminders per each company's setting. Safe to run any number of times; schedule daily.
 *   pnpm jobs:performance               all tenants, today (IST)
 *   pnpm jobs:performance 2026-12-01    pretend it's this date (automatic cycles only)
 */
import postgres from "postgres";
import { withTenant, sql } from "@/server/db";
import { runAutoCycles } from "@/server/modules/performance/reviews";
import { checkInReminders } from "@/server/modules/performance/goals";
import { todayIn } from "@/lib/dates";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });

async function main() {
  const arg = process.argv[2];
  if (arg && !/^\d{4}-\d{2}-\d{2}$/.test(arg)) throw new Error("Date must look like 2026-12-01");
  const today = arg ?? todayIn();
  // the one cross-tenant read: which companies exist (owner connection); each is then handled under RLS
  const tenants = await admin<{ id: string; subdomain: string }[]>`select id, subdomain from tenants where status <> 'cancelled' order by subdomain`;
  let added = 0, reminded = 0;
  for (const t of tenants) {
    try {
      const [a, r] = await withTenant(t.id, async (tx) => [await runAutoCycles(tx, t.id, today), await checkInReminders(tx, t.id)]);
      added += a; reminded += r;
      if (a || r) console.log(`${t.subdomain}: ${a} added to automatic reviews, ${r} reminded to check in`);
    } catch (e) {
      console.error(`${t.subdomain}: failed`, e);   // one tenant failing doesn't stop the others
      process.exitCode = 1;
    }
  }
  console.log(`performance job done: ${added} added to reviews, ${reminded} check-in reminders, ${tenants.length} ${tenants.length === 1 ? "company" : "companies"}`);
}

main().finally(async () => { await admin.end(); await sql.end(); });
