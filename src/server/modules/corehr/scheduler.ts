import "server-only";
import { withTenant, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor } from "@/server/auth/permissions";
import { addDaysISO, todayIn } from "@/lib/dates";
import { processDueExits } from "@/server/modules/exits/service";
import { processTenantDate } from "@/server/modules/attendance/job";
import { runLeaveJobs } from "@/server/modules/leave/accrual";
import { escalateBreaches } from "@/server/modules/helpdesk/service";
import { publishDue } from "@/server/modules/engage/service";
import { deliverQueued } from "@/server/email";
import { applyDueJobChanges, autoConfirmProbation } from "./lifecycle";
import { approverDigest, reassignPending, runApprovalTimers, EVERYWHERE } from "./approvals-admin";

export type StepContext = { tenantId: string; today: string; now: Date };
/**
 * One unit of the daily run. `tx` steps run inside one tenant transaction; `own` steps open their own transactions
 * (e.g. attendance processes one person per transaction). `daily` steps run once per tenant and date (a finished
 * run is skipped on a re-run); the others are cheap and idempotent, so they run every time.
 */
export type Step = { key: string; label: string; daily: boolean } & (
  | { tx: (tx: Tx, c: StepContext) => Promise<Record<string, unknown>> }
  | { own: (c: StepContext) => Promise<Record<string, unknown>> }
);

/**
 * Order matters: exits first (people who left drop out of everything after), then dated changes, then approvals
 * housekeeping, then time (yesterday's attendance, today's leave), then timers and notifications.
 * Payroll / loan hooks: other modules append their own steps here (see EXTRA_STEPS).
 */
export const STEPS: Step[] = [
  { key: "exits", label: "Relieve people whose last day has passed", daily: false, tx: async (tx, c) => ({ relieved: await processDueExits(tx, c.today) }) },
  { key: "job_changes", label: "Apply job changes due today", daily: false, tx: (tx, c) => applyDueJobChanges(tx, c.tenantId, c.today) },
  { key: "probation", label: "Auto-confirm probation and remind managers", daily: true, tx: (tx, c) => autoConfirmProbation(tx, c.tenantId, c.today) },
  { key: "approval_reassign", label: "Move approvals away from people who are away or have left", daily: false, tx: (tx, c) => reassignPending(tx, c.tenantId, { date: c.today }) },
  {
    key: "attendance", label: "Process yesterday's attendance", daily: true,
    own: async (c) => { const r = await processTenantDate(c.tenantId, addDaysISO(c.today, -1), c.now); if (r.failed.length) throw new Error(`${r.failed.length} people failed: ${r.failed[0].error}`); return { done: r.done, skipped: r.skipped }; },
  },
  { key: "leave", label: "Leave accrual and comp-off expiry", daily: false, tx: async (tx, c) => { const r = await runLeaveJobs(tx, c.tenantId, c.today); return { credits: r.accrual.posted, expired: r.expiry.expired }; } },
  { key: "approval_timers", label: "Escalate and auto-approve waiting requests", daily: true, tx: (tx, c) => runApprovalTimers(tx, c.tenantId, c.now) },
  { key: "helpdesk", label: "Escalate helpdesk tickets past their SLA", daily: false, tx: async (tx, c) => ({ escalated: await escalateBreaches(tx, c.tenantId, c.now) }) },
  { key: "engage", label: "Publish scheduled announcements", daily: false, tx: (tx, c) => publishDue(tx, c.tenantId) },
  { key: "approval_digest", label: "Email approvers what's waiting", daily: true, tx: (tx, c) => approverDigest(tx, c.tenantId) },
];
/** Hook for payroll / loans (and future modules): push steps here from their own module; they run after the built-in ones. */
export const EXTRA_STEPS: Step[] = [];

export type StepResult = { key: string; status: "ok" | "failed" | "skipped"; result?: Record<string, unknown>; error?: string };

/** Runs every step for one tenant. A failing step is recorded and the next one still runs. */
export async function runTenant(tenantId: string, opts: { today?: string; now?: Date; force?: boolean; only?: string[] } = {}): Promise<StepResult[]> {
  const today = opts.today ?? todayIn();
  const c: StepContext = { tenantId, today, now: opts.now ?? new Date() };
  const done = new Set((await withTenant(tenantId, (tx) => tx<{ job: string }[]>`select job from scheduler_runs where run_date = ${today} and status = 'ok'`)).map((r) => r.job));
  const out: StepResult[] = [];
  for (const s of [...STEPS, ...EXTRA_STEPS]) {
    if (opts.only?.length && !opts.only.includes(s.key)) continue;
    if (s.daily && done.has(s.key) && !opts.force) { out.push({ key: s.key, status: "skipped" }); continue; }
    const started = new Date();
    try {
      const result = "tx" in s ? await withTenant(tenantId, (tx) => s.tx(tx, c)) : await s.own(c);
      await record(tenantId, s.key, today, "ok", result, started);
      out.push({ key: s.key, status: "ok", result });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await record(tenantId, s.key, today, "failed", { error: error.slice(0, 500) }, started).catch(() => {});
      out.push({ key: s.key, status: "failed", error });
    }
  }
  await deliverQueued(tenantId).catch((e) => console.error("email delivery", e));
  return out;
}

async function record(tenantId: string, job: string, runDate: string, status: "ok" | "failed", result: Record<string, unknown>, started: Date) {
  await withTenant(tenantId, (tx) => tx`
    insert into scheduler_runs (tenant_id, job, run_date, status, result, started_at, finished_at)
    values (${tenantId}, ${job}, ${runDate}, ${status}, ${tx.json(result as never)}, ${started}, now())
    on conflict (tenant_id, job, run_date) do update set status = excluded.status, result = excluded.result, started_at = excluded.started_at, finished_at = now()`);
}

export const canSeeRuns = (actor: Actor) => canFor(actor, "settings.org", EVERYWHERE) || canFor(actor, "settings.audit", EVERYWHERE);

export async function recentRuns(tx: Tx, days = 7) {
  return tx<{ job: string; run_date: string; status: "ok" | "failed"; result: Record<string, unknown>; started_at: Date; finished_at: Date | null }[]>`
    select job, run_date::text, status, result, started_at, finished_at from scheduler_runs where run_date >= current_date - ${days}::int order by run_date desc, started_at`;
}
