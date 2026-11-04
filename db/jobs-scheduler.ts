/**
 * In-app scheduler: a small long-running process that calls the daily run (the same code as `pnpm jobs:daily`) once a
 * day at a set IST time, catching up if it was started late. Cron stays the recommended way to run jobs; use this
 * where there is no cron (a single container, a PaaS worker dyno) and keep exactly one instance up.
 *
 *   pnpm jobs:scheduler                      runs at SCHEDULER_TIME (default 00:15) in SCHEDULER_TZ (default Asia/Kolkata)
 *   SCHEDULER_TIME=01:30 pnpm jobs:scheduler
 *   SCHEDULER_REPEAT_MINUTES=60 …            also re-run every hour after that (escalations / email stay timely)
 *
 * Two instances can't both run: a session-level Postgres advisory lock makes the second one wait on standby and take
 * over if the first dies. The daily run itself takes its own lock too, so a cron run and the scheduler never overlap.
 */
import postgres from "postgres";
import { sql } from "@/server/db";
import { runDaily } from "@/server/modules/corehr/daily-run";
import { parseTime, shouldRun, type SchedulerState } from "@/server/modules/corehr/scheduler-rules";

const RUNNER_LOCK = 727_002;
const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
const cfg = {
  time: parseTime(process.env.SCHEDULER_TIME),
  tz: process.env.SCHEDULER_TZ?.trim() || "Asia/Kolkata",
  repeatMinutes: Math.max(0, Math.trunc(Number(process.env.SCHEDULER_REPEAT_MINUTES ?? 0)) || 0),
};
const pollMs = Math.min(600_000, Math.max(5_000, Number(process.env.SCHEDULER_POLL_MS ?? 60_000) || 60_000));
const log = (l: string) => console.log(`${new Date().toISOString()} ${l}`);

let stopping = false;
const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); timers.add(t); });
const timers = new Set<ReturnType<typeof setTimeout>>();
const stop = () => { if (stopping) return; stopping = true; log("stopping after the current step"); for (const t of timers) clearTimeout(t); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);

async function main() {
  try { new Intl.DateTimeFormat("en-US", { timeZone: cfg.tz }); } catch { throw new Error(`SCHEDULER_TZ "${cfg.tz}" isn't a time zone`); }
  log(`scheduler: daily run at ${cfg.time} ${cfg.tz}${cfg.repeatMinutes ? `, then every ${cfg.repeatMinutes} min` : ""} (poll every ${pollMs / 1000}s)`);
  // the runner lock is session-level: held as long as this connection lives, released when the process ends
  let holder = false;
  const state: SchedulerState = { lastRunDate: null, lastRunAt: null };
  while (!stopping) {
    if (!holder) {
      const [{ locked }] = await admin<{ locked: boolean }[]>`select pg_try_advisory_lock(${RUNNER_LOCK}) as locked`;
      holder = locked;
      if (!holder) { log("another scheduler holds the lock; standing by"); await sleep(pollMs); continue; }
      log("this instance is the active scheduler");
    }
    const d = shouldRun(cfg, state, new Date());
    if (d.run) {
      log(`starting the daily run (${d.why})`);
      try {
        const r = await runDaily(admin, { date: d.date, log });
        state.lastRunDate = d.date; state.lastRunAt = Date.now();
        log(r.locked ? `daily run finished: ${r.tenants} tenant(s), ${r.failed} failed step(s)` : "daily run skipped: another run holds the lock");
      } catch (e) {
        log(`daily run crashed: ${e instanceof Error ? e.message : String(e)}`);   // the next tick tries again
      }
    }
    if (!stopping) await sleep(pollMs);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  await admin`select pg_advisory_unlock_all()`.catch(() => {});
  await admin.end(); await sql.end();
});
