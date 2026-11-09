import "server-only";
import postgres from "postgres";
import { todayIn } from "@/lib/dates";
import { runTenant, type StepResult } from "./scheduler";

export type DailyOptions = { date?: string; only?: string[]; force?: boolean; tenant?: string };
export type DailyReport = { date: string; tenants: { subdomain: string; results: StepResult[] }[]; failed: number; skipped?: "locked" };

/**
 * The one daily run for every live tenant: the CLI (db/jobs-daily.ts) and the hosted cron (/api/cron/daily) both call
 * this. `admin` is an owner connection (DATABASE_ADMIN_URL) for the single cross-tenant read; a transaction-scoped
 * advisory lock on it stops two runs overlapping (and works through transaction-mode poolers).
 */
export async function runDaily(admin: postgres.Sql, opts: DailyOptions = {}): Promise<DailyReport> {
  const date = opts.date ?? todayIn();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date + "T00:00:00Z"))) throw new Error(`date must be YYYY-MM-DD, got "${date}"`);
  return admin.begin(async (tx) => {
    const [{ locked }] = await tx<{ locked: boolean }[]>`select pg_try_advisory_xact_lock(727001) as locked`;
    if (!locked) return { date, tenants: [], failed: 0, skipped: "locked" as const };
    const sub = opts.tenant ?? null;
    const tenants = await tx<{ id: string; subdomain: string }[]>`
      select id, subdomain::text from tenants where status not in ('suspended','cancelled') and (${sub}::text is null or subdomain = ${sub}::citext) order by created_at`;
    const now = date === todayIn() ? new Date() : new Date(`${date}T23:59:00+05:30`);
    const report: DailyReport = { date, tenants: [], failed: 0 };
    for (const t of tenants) {
      const results = await runTenant(t.id, { today: date, now, force: opts.force, only: opts.only });
      report.failed += results.filter((r) => r.status === "failed").length;
      report.tenants.push({ subdomain: t.subdomain, results });
    }
    return report;
  }) as Promise<DailyReport>;
}
