/**
 * Helpdesk SLA job: finds open tickets past their first-response or resolution target and escalates each breach once
 * (notification to the category's escalation contact and the assignee; helpdesk admins when there's nobody).
 * Safe to run any number of times. Schedule it every 15 minutes.
 *   pnpm jobs:helpdesk                          all tenants, now
 *   pnpm jobs:helpdesk 2026-12-01T10:00:00+05:30  pretend it's this moment (testing)
 */
import postgres from "postgres";
import { withTenant, sql } from "@/server/db";
import { escalateBreaches } from "@/server/modules/helpdesk/service";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });

async function main() {
  const arg = process.argv[2];
  const now = arg ? new Date(arg) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error("Time must look like 2026-12-01T10:00:00+05:30");
  // the one cross-tenant read: which tenants have breached, unescalated tickets (owner connection); each is then handled under RLS
  const due = await admin<{ id: string; subdomain: string }[]>`
    select distinct t.id, t.subdomain from tenants t join tickets k on k.tenant_id = t.id
    where k.status <> 'closed' and t.status <> 'cancelled'
      and ((k.first_response_escalated_at is null and k.first_responded_at is null and k.first_response_due_at < ${now})
           or (k.resolution_escalated_at is null and k.resolution_due_at < ${now}))
    order by t.subdomain`;
  let total = 0;
  for (const t of due) {
    try {
      const n = await withTenant(t.id, (tx) => escalateBreaches(tx, t.id, now));
      total += n;
      if (n) console.log(`${t.subdomain}: escalated ${n} ${n === 1 ? "ticket" : "tickets"}`);
    } catch (e) {
      console.error(`${t.subdomain}: failed`, e);   // one tenant failing doesn't stop the others
      process.exitCode = 1;
    }
  }
  console.log(`helpdesk job done: ${total} escalated across ${due.length} ${due.length === 1 ? "company" : "companies"} with breaches`);
}

main().finally(async () => { await admin.end(); await sql.end(); });
