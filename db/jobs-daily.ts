/**
 * The one scheduler entry point: runs every background job for every live tenant, in order (see STEPS in
 * src/server/modules/corehr/scheduler.ts): exits → job changes → probation → approval hand-overs → yesterday's
 * attendance → leave accrual/expiry → approval escalation/auto-approval → helpdesk SLAs → scheduled announcements →
 * approver digest emails (+ any payroll/loan steps registered in EXTRA_STEPS).
 *
 * Safe to run again: a Postgres advisory lock stops two runs overlapping, once-a-day steps that already finished for
 * the date are skipped (recorded in scheduler_runs), and every step is idempotent on its own.
 * Hosted installs call the same runner from /api/cron/daily (Vercel Cron) instead of this CLI.
 *
 *   pnpm jobs:daily                               all tenants, today (IST)
 *   pnpm jobs:daily -- --date 2026-11-02          as of another day (catch up a missed run)
 *   pnpm jobs:daily -- --tenant acme --force      one tenant, re-run once-a-day steps
 *   pnpm jobs:daily -- --only attendance,leave    just these steps
 */
import postgres from "postgres";
import { pooled, sql } from "@/server/db";
import { runDaily } from "@/server/modules/corehr/daily";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, prepare: !pooled(process.env.DATABASE_ADMIN_URL), onnotice: () => {} });

function arg(name: string) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  return argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main() {
  const only = arg("only")?.split(",").map((s) => s.trim()).filter(Boolean);
  const force = process.argv.includes("--force");
  const r = await runDaily(admin, { date: arg("date"), only, force, tenant: arg("tenant") });
  if (r.skipped === "locked") { console.log("Another daily run is still going. Nothing to do."); return; }
  console.log(`daily jobs for ${r.date} across ${r.tenants.length} tenant(s)${only ? ` (only ${only.join(", ")})` : ""}${force ? " (forced)" : ""}`);
  for (const t of r.tenants) {
    console.log(`  ${t.subdomain}: ${t.results.map((x) => `${x.key} ${x.status === "ok" ? "✓" : x.status === "skipped" ? "(done earlier)" : "✗"}`).join(" · ")}`);
    for (const x of t.results) if (x.status === "failed") console.error(`    ${x.key}: ${x.error}`);
  }
  if (r.failed) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await admin.end(); await sql.end(); });
