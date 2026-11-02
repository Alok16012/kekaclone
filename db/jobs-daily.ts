/**
 * The one scheduler entry point: runs every background job for every live tenant, in order (see STEPS in
 * src/server/modules/corehr/scheduler.ts): exits → job changes → probation → approval hand-overs → yesterday's
 * attendance → leave accrual/expiry → approval escalation/auto-approval → helpdesk SLAs → scheduled announcements →
 * approver digest emails (+ any payroll/loan steps registered in EXTRA_STEPS).
 *
 * Safe to run again: a Postgres advisory lock stops two runs overlapping, once-a-day steps that already finished for
 * the date are skipped (recorded in scheduler_runs), and every step is idempotent on its own.
 *
 *   pnpm jobs:daily                               all tenants, today (IST)
 *   pnpm jobs:daily -- --date 2026-11-02          as of another day (catch up a missed run)
 *   pnpm jobs:daily -- --tenant acme --force      one tenant, re-run once-a-day steps
 *   pnpm jobs:daily -- --only attendance,leave    just these steps
 */
import postgres from "postgres";
import { sql } from "@/server/db";
import { todayIn } from "@/lib/dates";
import { runTenant } from "@/server/modules/corehr/scheduler";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
const LOCK = 727_001;   // any constant; one daily run at a time across all machines sharing the database

function arg(name: string) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  return argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main() {
  const date = arg("date") ?? todayIn();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date + "T00:00:00Z"))) throw new Error(`--date must be YYYY-MM-DD, got "${date}"`);
  const only = arg("only")?.split(",").map((s) => s.trim()).filter(Boolean);
  const force = process.argv.includes("--force");
  const [{ locked }] = await admin<{ locked: boolean }[]>`select pg_try_advisory_lock(${LOCK}) as locked`;
  if (!locked) { console.log("Another daily run is still going. Nothing to do."); return; }
  try {
    // the one cross-tenant read: which tenants are live (owner connection); each tenant's work then runs under RLS
    const sub = arg("tenant");
    const tenants = await admin<{ id: string; subdomain: string }[]>`
      select id, subdomain::text from tenants where status not in ('suspended','cancelled') and (${sub ?? null}::text is null or subdomain = ${sub ?? null}::citext) order by created_at`;
    console.log(`daily jobs for ${date} across ${tenants.length} tenant(s)${only ? ` (only ${only.join(", ")})` : ""}${force ? " (forced)" : ""}`);
    let failed = 0;
    const now = date === todayIn() ? new Date() : new Date(`${date}T23:59:00+05:30`);
    for (const t of tenants) {
      const results = await runTenant(t.id, { today: date, now, force, only });
      failed += results.filter((r) => r.status === "failed").length;
      console.log(`  ${t.subdomain}: ${results.map((r) => `${r.key} ${r.status === "ok" ? "✓" : r.status === "skipped" ? "(done earlier)" : "✗"}`).join(" · ")}`);
      for (const r of results) if (r.status === "failed") console.error(`    ${r.key}: ${r.error}`);
    }
    if (failed) process.exitCode = 1;
  } finally {
    await admin`select pg_advisory_unlock(${LOCK})`;
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await admin.end(); await sql.end(); });
