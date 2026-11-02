import "server-only";
import type { Tx } from "@/server/db";

/**
 * Other modules change a month's payroll inputs outside the run screen (an expense claim scheduled, moved or paid
 * off-cycle; a loan EMI skipped or prepaid; a final settlement taking over a claim). When that month's run is still
 * open, its calculated lines no longer match the inputs, so the run must be recalculated before it can be finalised.
 * This clears the run's "calculated at this version" marker; finalising then refuses until someone recalculates.
 * No module dependencies on purpose, so loans and expenses can call it without an import cycle.
 */
export async function markOpenRunStale(tx: Tx, payGroupId: string | null | undefined, month: string | null | undefined) {
  if (!payGroupId || !month) return 0;
  const r = await tx`
    update payroll_runs set step_state = step_state - 'computedVersion', updated_at = now()
    where pay_group_id = ${payGroupId} and period_month = ${month} and status in ('draft','in_progress') and step_state ? 'computedVersion'`;
  return r.count;
}

/** The same for a change to one person's pay (salary record, statutory details): their pay group's open run from `fromMonth` on. */
export async function markPersonRunsStale(tx: Tx, employeeId: string, fromMonth: string | null = null) {
  const r = await tx`
    update payroll_runs r set step_state = r.step_state - 'computedVersion', updated_at = now()
    from employees e
    where e.id = ${employeeId} and r.pay_group_id = e.pay_group_id and r.status in ('draft','in_progress') and r.step_state ? 'computedVersion'
      ${fromMonth ? tx`and r.period_month >= date_trunc('month', ${fromMonth}::date)::date` : tx``}`;
  return r.count;
}
