/**
 * Outbound webhook delivery for every tenant: posts due deliveries (new and retries with backoff).
 * Deliveries are also attempted right after the action that queued them; this job catches up anything that failed.
 *   pnpm jobs:webhooks
 */
import postgres from "postgres";
import { sql } from "@/server/db";
import { deliverWebhooks } from "@/server/modules/integrations/service";

const owner = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });

async function main() {
  const tenants = await owner<{ id: string; subdomain: string }[]>`select id, subdomain::text from tenants where status not in ('suspended', 'cancelled') order by created_at`;
  console.log(`webhook job for ${tenants.length} tenant(s)`);
  for (const t of tenants) {
    try { const r = await deliverWebhooks(t.id); if (r.sent || r.failed) console.log(`  ${t.subdomain}: ${r.sent} delivered, ${r.failed} failed`); }
    catch (e) { process.exitCode = 1; console.error(`  ${t.subdomain}: failed`, e); }
  }
}

main().finally(async () => { await owner.end(); await sql.end(); });
