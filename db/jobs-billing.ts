/**
 * Nightly billing job for every tenant: trial reminders (7 days, 1 day, ended → suspended), billed seats follow
 * the active headcount, and the subscription status is re-read from the provider in case a webhook was missed.
 *   pnpm jobs:billing
 */
import postgres from "postgres";
import { sql, withTenant } from "@/server/db";
import { deliverQueued } from "@/server/email";
import { syncSeats, syncStatus, trialReminders } from "@/server/modules/billing/service";

const owner = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });

async function main() {
  const tenants = await owner<{ id: string; subdomain: string }[]>`select id, subdomain::text from tenants where status <> 'cancelled' order by created_at`;
  console.log(`billing job for ${tenants.length} tenant(s)`);
  let failed = 0;
  for (const t of tenants) {
    try {
      const r = await withTenant(t.id, async (tx) => ({ trial: await trialReminders(tx, t.id), seats: await syncSeats(tx, t.id), status: await syncStatus(tx, t.id) }));
      await deliverQueued(t.id);
      console.log(`  ${t.subdomain}: trial reminder ${r.trial.sent ?? "none"}, seats ${r.seats.changed ? `→ ${r.seats.seats}` : "unchanged"}, status ${r.status.changed ? `→ ${r.status.status}` : "unchanged"}`);
    } catch (e) { failed++; console.error(`  ${t.subdomain}: failed`, e); }
  }
  if (failed) process.exitCode = 1;
}

main().finally(async () => { await owner.end(); await sql.end(); });
