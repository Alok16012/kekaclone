/**
 * Hiring job: released offers past their accept-by date become "expired" (the candidate portal then shows that).
 * Safe to run any number of times. Schedule it once a day, shortly after midnight IST.
 *   pnpm jobs:hire              all tenants, today (IST)
 *   pnpm jobs:hire 2026-12-01   pretend it's this date (testing)
 */
import postgres from "postgres";
import { withTenant, sql } from "@/server/db";
import { expireOffers } from "@/server/modules/hire/offers";
import { todayIn } from "@/lib/dates";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });

async function main() {
  const today = process.argv[2] ?? todayIn();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error("Date must look like 2026-12-01");
  // the one cross-tenant read: which tenants have offers to expire (owner connection); each is then handled under RLS
  const due = await admin<{ id: string; subdomain: string }[]>`
    select distinct t.id, t.subdomain from tenants t join offers o on o.tenant_id = t.id where o.status = 'released' and o.expires_on < ${today} order by t.subdomain`;
  let total = 0;
  for (const t of due) {
    try {
      const n = await withTenant(t.id, (tx) => expireOffers(tx, today));
      total += n;
      if (n) console.log(`${t.subdomain}: ${n} ${n === 1 ? "offer" : "offers"} expired`);
    } catch (e) { console.error(`${t.subdomain}: failed`, e); }
  }
  console.log(`Done: ${total} expired across ${due.length} ${due.length === 1 ? "tenant" : "tenants"}.`);
}

main().then(async () => { await admin.end(); await sql.end(); }).catch(async (e) => { console.error(e); await admin.end(); await sql.end(); process.exit(1); });
