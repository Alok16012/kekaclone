/**
 * Attendance processing for every tenant and one date (default: yesterday in India).
 *   pnpm jobs:attendance -- --date 2026-10-29
 * Lists tenants over the admin connection, then processes each person through the app connection (RLS on).
 * The real scheduler arrives later; this is what it will call.
 */
import postgres from "postgres";
import { sql } from "@/server/db";
import { addDaysISO, todayIn } from "@/lib/dates";
import { processTenantDate } from "@/server/modules/attendance/job";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });

async function main() {
  const i = process.argv.indexOf("--date");
  const date = i > -1 ? process.argv[i + 1] : addDaysISO(todayIn(), -1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || isNaN(Date.parse(date))) throw new Error("Use --date YYYY-MM-DD");
  const tenants = await admin<{ id: string; subdomain: string }[]>`select id, subdomain::text from tenants where status in ('trial','active','past_due') order by subdomain`;
  console.log(`Processing attendance for ${date} across ${tenants.length} tenant(s)…`);
  let failures = 0;
  for (const t of tenants) {
    const r = await processTenantDate(t.id, date);
    failures += r.failed.length;
    console.log(`  ${t.subdomain}: ${r.done} processed, ${r.skipped} locked${r.failed.length ? `, ${r.failed.length} failed` : ""}`);
    for (const f of r.failed) console.error(`    ${f.employeeId}: ${f.error}`);
  }
  if (failures) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await admin.end(); await sql.end(); });
