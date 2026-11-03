/**
 * Daily approvers' digest: one email per person with requests waiting for their decision, for every tenant that has
 * the "approvals.digest" event emailed (Settings → Notifications). Once a day per person: re-running is harmless.
 *   pnpm jobs:digest            (meant for 09:00 IST; pnpm jobs:daily runs the same step)
 */
import postgres from "postgres";
import { sql, withTenant } from "@/server/db";
import { deliverQueued } from "@/server/email";
import { digestIn } from "@/server/modules/notifications/digest";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });

export { digestIn };
export async function digestTenant(tenantId: string, now = new Date()) {
  return withTenant(tenantId, (tx) => digestIn(tx, tenantId, now));
}

async function main() {
  const tenants = await admin<{ id: string; subdomain: string }[]>`select id, subdomain::text from tenants where status in ('trial','active','past_due') order by subdomain`;
  console.log(`Approver digests across ${tenants.length} tenant(s)…`);
  for (const t of tenants) {
    const r = await digestTenant(t.id);
    await deliverQueued(t.id);
    console.log(`  ${t.subdomain}: ${r.sent} sent, ${r.skipped} already sent today, ${r.approvers} approvers with pending items`);
  }
}

if (process.argv[1]?.endsWith("jobs-digest.ts")) main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await admin.end(); await sql.end(); });
