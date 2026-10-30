import "server-only";
import type { Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { addDaysISO, todayIn } from "@/lib/dates";
import { cycleStart } from "./accrual-rules";

/** Start of the leave year (per the person's leave plan) that contains `date`. */
export async function cycleStartFor(tx: Tx, employeeId: string, date: string) {
  const [p] = await tx<{ year_start: string | null; joining_date: string }[]>`
    select p.year_start, e.joining_date::text from employees e left join leave_plans p on p.id = e.leave_plan_id where e.id = ${employeeId}`;
  return cycleStart(p?.year_start ?? "jan", p?.joining_date ?? date, date);
}

/** Final decision on a leave request: status + ledger debit (idempotent by request id). */
export async function onLeaveDecided(tx: Tx, actor: Actor | null, requestId: string, final: "approved" | "rejected") {
  const [r] = await tx<{ tenant_id: string; employee_id: string; leave_type_id: string; from_date: string; to_date: string; days: string }[]>`
    update leave_requests set status = ${final} where id = ${requestId} and status = 'pending'
    returning tenant_id, employee_id, leave_type_id, from_date::text, to_date::text, days`;
  if (!r || final !== "approved") return;
  const cycle = await cycleStartFor(tx, r.employee_id, r.from_date);
  await tx`
    insert into leave_ledger (tenant_id, employee_id, leave_type_id, cycle_start, entry_date, kind, amount, ref_type, ref_id, idempotency_key, created_by)
    values (${r.tenant_id}, ${r.employee_id}, ${r.leave_type_id}, ${cycle}, ${r.from_date}, 'use', ${-Number(r.days)}, 'leave_request', ${requestId},
            ${`use:${requestId}`}, ${actor?.userId ?? null})
    on conflict (tenant_id, idempotency_key) do nothing`;
  // Leave approved for days already processed (backdated or approved late): recompute attendance so the absence,
  // loss of pay and penalties on those days give way to the leave. Dynamic import: attendance depends on leave.
  if (r.from_date <= todayIn()) {
    const { reprocessFrom } = await import("@/server/modules/attendance/process");
    await reprocessFrom(tx, r.tenant_id, r.employee_id, r.from_date, r.to_date);
  }
}

/**
 * Final decision on a comp-off claim. Approved → credit to the comp-off leave type in the person's plan, valid for the
 * plan's expiry window from today (idempotent by request id).
 */
export async function onCompOffDecided(tx: Tx, actor: Actor | null, requestId: string, final: "approved" | "rejected") {
  const [r] = await tx<{ tenant_id: string; employee_id: string; days: string; worked_dates: string[] }[]>`
    update comp_off_requests set status = ${final}, updated_at = now() where id = ${requestId} and status = 'pending'
    returning tenant_id, employee_id, days, worked_dates::text[]`;
  if (!r || final !== "approved") return;
  const [t] = await tx<{ id: string; expiry_days: number | null }[]>`
    select t.id, nullif(r.application->>'compOffExpiryDays', '')::int as expiry_days
    from employees e join leave_plan_rules r on r.leave_plan_id = e.leave_plan_id join leave_types t on t.id = r.leave_type_id and t.kind = 'comp_off'
    where e.id = ${r.employee_id} order by t.created_at limit 1`;
  if (!t) return;   // the plan lost its comp-off type after the claim was made; nothing to credit
  const today = todayIn();
  const expires = t.expiry_days && t.expiry_days > 0 ? addDaysISO(today, t.expiry_days) : null;
  await tx`update comp_off_requests set expires_on = ${expires} where id = ${requestId}`;
  const cycle = await cycleStartFor(tx, r.employee_id, today);
  await tx`
    insert into leave_ledger (tenant_id, employee_id, leave_type_id, cycle_start, entry_date, kind, amount, ref_type, ref_id, note, idempotency_key, created_by)
    values (${r.tenant_id}, ${r.employee_id}, ${t.id}, ${cycle}, ${today}, 'comp_off_credit', ${Number(r.days)}, 'comp_off_request', ${requestId},
            ${`Worked ${r.worked_dates.join(", ")}${expires ? ` · use by ${expires}` : ""}`}, ${`comp_off:${requestId}`}, ${actor?.userId ?? null})
    on conflict (tenant_id, idempotency_key) do nothing`;
}
