/**
 * Daily surveys job: opens scheduled surveys on their start date, starts the next round of pulse surveys (and tells the
 * audience), closes surveys past their end date. Safe to run any number of times a day. Schedule it once a night.
 *   pnpm jobs:surveys            all tenants, today in each tenant's time zone
 *   pnpm jobs:surveys 2026-12-01 pretend it's this date (testing)
 */
import postgres from "postgres";
import { withTenant, sql } from "@/server/db";
import { processDueSurveys } from "@/server/modules/surveys/service";
import { todayIn } from "@/lib/dates";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });

async function main() {
  const asOf = process.argv[2];
  if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error("Date must look like 2026-12-01");
  // the one cross-tenant read: which tenants have open or scheduled surveys (owner connection); each is then processed under RLS
  const due = await admin<{ id: string; subdomain: string; timezone: string }[]>`
    select distinct t.id, t.subdomain, t.timezone from tenants t join surveys s on s.tenant_id = t.id
    where s.status in ('draft', 'live') and t.status <> 'cancelled' order by t.subdomain`;
  const total = { launched: 0, rounds: 0, closed: 0 };
  for (const t of due) {
    const today = asOf ?? todayIn(t.timezone);
    try {
      const n = await withTenant(t.id, (tx) => processDueSurveys(tx, today));
      total.launched += n.launched; total.rounds += n.rounds; total.closed += n.closed;
      if (n.launched || n.rounds || n.closed) console.log(`${t.subdomain}: ${n.launched} opened, ${n.rounds} new pulse rounds, ${n.closed} closed (as of ${today})`);
    } catch (e) {
      console.error(`${t.subdomain}: failed`, e);   // one tenant failing doesn't stop the others
      process.exitCode = 1;
    }
  }
  console.log(`surveys job done: ${total.launched} opened, ${total.rounds} rounds, ${total.closed} closed across ${due.length} ${due.length === 1 ? "company" : "companies"}`);
}

main().finally(async () => { await admin.end(); await sql.end(); });
