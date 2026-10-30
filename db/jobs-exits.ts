/**
 * Daily exits job: relieves everyone whose last working day has passed (exit → Exited, employee → Relieved,
 * sign-in disabled, sessions ended). Safe to run any number of times a day. Schedule it once a night, e.g. 00:30 IST.
 *   pnpm jobs:exits            all tenants, today in each tenant's time zone
 *   pnpm jobs:exits 2026-12-01 pretend it's this date (testing)
 */
import postgres from "postgres";
import { withTenant, sql } from "@/server/db";
import { processDueExits } from "@/server/modules/exits/service";
import { todayIn } from "@/lib/dates";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });

async function main() {
  const asOf = process.argv[2];
  if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error("Date must look like 2026-12-01");
  // the one cross-tenant read: which tenants have exits due (owner connection); each tenant is then processed under RLS
  const due = await admin<{ id: string; subdomain: string; timezone: string }[]>`
    select distinct t.id, t.subdomain, t.timezone from tenants t join exit_requests x on x.tenant_id = t.id
    where x.status = 'in_progress' and t.status <> 'cancelled' order by t.subdomain`;
  let total = 0;
  for (const t of due) {
    const today = asOf ?? todayIn(t.timezone);
    try {
      const n = await withTenant(t.id, (tx) => processDueExits(tx, today));
      total += n;
      if (n) console.log(`${t.subdomain}: relieved ${n} ${n === 1 ? "person" : "people"} (as of ${today})`);
    } catch (e) {
      console.error(`${t.subdomain}: failed`, e);   // one tenant failing doesn't stop the others
      process.exitCode = 1;
    }
  }
  console.log(`exits job done: ${total} relieved across ${due.length} ${due.length === 1 ? "company" : "companies"} with open exits`);
}

main().finally(async () => { await admin.end(); await sql.end(); });
