import "server-only";
import type postgres from "postgres";
import { todayIn } from "@/lib/dates";
import { runTenant } from "./scheduler";

export const DAILY_LOCK = 727_001;   // any constant; one daily run at a time across all machines sharing the database

export type DailyOpts = { date?: string; only?: string[]; force?: boolean; tenant?: string; log?: (line: string) => void };

/**
 * One daily run across every live tenant: the body of `pnpm jobs:daily`, shared with the in-app scheduler.
 * Takes the advisory lock (returns `locked: false` when another run holds it), reads the tenant list on the owner
 * connection, then runs each tenant's steps under RLS. Returns how many steps failed.
 */
export async function runDaily(admin: postgres.Sql, opts: DailyOpts = {}) {
  const log = opts.log ?? ((l: string) => console.log(l));
  const date = opts.date ?? todayIn();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date + "T00:00:00Z"))) throw new Error(`date must be YYYY-MM-DD, got "${date}"`);
  const [{ locked }] = await admin<{ locked: boolean }[]>`select pg_try_advisory_lock(${DAILY_LOCK}) as locked`;
  if (!locked) { log("Another daily run is still going. Nothing to do."); return { locked: false, failed: 0, tenants: 0 }; }
  let failed = 0, tenants = 0;
  try {
    const sub = opts.tenant ?? null;
    const rows = await admin<{ id: string; subdomain: string }[]>`
      select id, subdomain::text from tenants where status not in ('suspended','cancelled') and (${sub}::text is null or subdomain = ${sub}::citext) order by created_at`;
    tenants = rows.length;
    log(`daily jobs for ${date} across ${rows.length} tenant(s)${opts.only?.length ? ` (only ${opts.only.join(", ")})` : ""}${opts.force ? " (forced)" : ""}`);
    const now = date === todayIn() ? new Date() : new Date(`${date}T23:59:00+05:30`);
    for (const t of rows) {
      const results = await runTenant(t.id, { today: date, now, force: opts.force, only: opts.only });
      failed += results.filter((r) => r.status === "failed").length;
      log(`  ${t.subdomain}: ${results.map((r) => `${r.key} ${r.status === "ok" ? "✓" : r.status === "skipped" ? "(done earlier)" : "✗"}`).join(" · ")}`);
      for (const r of results) if (r.status === "failed") log(`    ${r.key}: ${r.error}`);
    }
  } finally {
    await admin`select pg_advisory_unlock(${DAILY_LOCK})`;
  }
  return { locked: true, failed, tenants };
}
