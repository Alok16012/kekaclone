import "server-only";
import type { Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";

export async function cycleStartFor(tx: Tx, employeeId: string, date: string) {
  const [p] = await tx<{ year_start: string }[]>`select p.year_start from employees e join leave_plans p on p.id = e.leave_plan_id where e.id = ${employeeId}`;
  const startMonth = p?.year_start === "apr" ? 4 : 1;
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  return `${m >= startMonth ? y : y - 1}-${String(startMonth).padStart(2, "0")}-01`;
}

/** Final decision on a leave request: status + ledger debit (idempotent by request id). */
export async function onLeaveDecided(tx: Tx, actor: Actor | null, requestId: string, final: "approved" | "rejected") {
  const [r] = await tx<{ tenant_id: string; employee_id: string; leave_type_id: string; from_date: string; days: string }[]>`
    update leave_requests set status = ${final} where id = ${requestId} and status = 'pending'
    returning tenant_id, employee_id, leave_type_id, from_date::text, days`;
  if (!r || final !== "approved") return;
  const cycle = await cycleStartFor(tx, r.employee_id, r.from_date);
  await tx`
    insert into leave_ledger (tenant_id, employee_id, leave_type_id, cycle_start, entry_date, kind, amount, ref_type, ref_id, idempotency_key, created_by)
    values (${r.tenant_id}, ${r.employee_id}, ${r.leave_type_id}, ${cycle}, ${r.from_date}, 'use', ${-Number(r.days)}, 'leave_request', ${requestId},
            ${`use:${requestId}`}, ${actor?.userId ?? null})
    on conflict (tenant_id, idempotency_key) do nothing`;
}
