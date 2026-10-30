/**
 * Nightly leave job: credits due accruals and expires comp-off past its use-by date, for every active tenant.
 * Safe to re-run (ledger idempotency keys). Year-end carry/lapse/encash is admin-triggered in Settings → Year-end.
 *   pnpm jobs:leave                       # as of today (IST)
 *   pnpm jobs:leave -- --date 2026-11-01  # as of a given day (backfills or catches up a missed run)
 */
import postgres from "postgres";
import { sql, withTenant } from "@/server/db";
import { runLeaveJobs } from "@/server/modules/leave/accrual";
import { todayIn } from "@/lib/dates";

const owner = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });

function asOfFromArgs(argv: string[]) {
  const i = argv.indexOf("--date");
  const v = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith("--date="))?.slice(7);
  if (!v) return todayIn();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v + "T00:00:00Z"))) throw new Error(`--date must be YYYY-MM-DD, got "${v}"`);
  return v;
}

async function main() {
  const asOf = asOfFromArgs(process.argv.slice(2));
  // listing tenants is the one cross-tenant read; each tenant's work runs under its own RLS context
  const tenants = await owner<{ id: string; subdomain: string }[]>`select id, subdomain::text from tenants where status not in ('suspended', 'cancelled') order by created_at`;
  console.log(`leave job as of ${asOf} for ${tenants.length} tenant(s)`);
  let failed = 0;
  for (const t of tenants) {
    try {
      const r = await withTenant(t.id, (tx) => runLeaveJobs(tx, t.id, asOf));
      console.log(`  ${t.subdomain}: ${r.accrual.posted} accrual credits (${r.accrual.days} days), ${r.expiry.expired} comp-off expiries (${r.expiry.days} days)`);
    } catch (e) {
      failed++;
      console.error(`  ${t.subdomain}: failed`, e);
    }
  }
  if (failed) process.exitCode = 1;
}

main().finally(async () => { await owner.end(); await sql.end(); });
