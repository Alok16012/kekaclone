import "server-only";
import type { Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { notify } from "@/server/modules/notifications/service";
import { markOpenRunStale, markPersonRunsStale } from "@/server/modules/payrun/stale";
import { addMonths, isLockedStatus, monthLabel, monthStart } from "@/server/modules/payrun/rules";
import { inr } from "@/server/modules/tax/rules";
import { todayIn } from "@/lib/dates";

const N = (v: bigint | number | string | null | undefined) => (v == null ? 0 : Number(v));
const log = (tx: Tx, actor: Actor | null, entityType: string, entityId: string, action: string, diff: Record<string, unknown>) =>
  tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (app_tenant(), ${actor?.userId ?? null}, ${entityType}, ${entityId}, ${action}, ${tx.json(diff as never)})`;

/**
 * A salary revision that went through approval: approved → it becomes a real salary record (payroll picks it up, with
 * arrears if it is back-dated); declined → the pending record goes away. Guarded on status, so a repeat call does nothing.
 */
export async function onSalaryRevisionDecided(tx: Tx, actor: Actor | null, salaryId: string, final: "approved" | "rejected") {
  const [s] = await tx<{ id: string; employee_id: string; effective_from: string; ctc_paise: bigint; arrears_from_month: string | null; created_by: string | null; tenant_id: string; name: string }[]>`
    select s.id, s.employee_id, s.effective_from::text, s.ctc_paise, s.arrears_from_month::text, s.created_by, s.tenant_id, e.display_name as name
    from employee_salaries s join employees e on e.id = s.employee_id where s.id = ${salaryId} and s.status = 'pending_approval' for update of s`;
  if (!s) return;
  if (final === "approved") {
    await tx`update employee_salaries set status = 'superseded', updated_at = now() where id = ${s.id}`;
    await tx`
      update employee_salaries x set status = case when x.id = y.latest then 'active' else 'superseded' end, updated_at = now()
      from (select id as latest from employee_salaries where employee_id = ${s.employee_id} and status in ('active','superseded') order by effective_from desc limit 1) y
      where x.employee_id = ${s.employee_id} and x.status in ('active','superseded') and x.status <> case when x.id = y.latest then 'active' else 'superseded' end`;
    await markPersonRunsStale(tx, s.employee_id, s.arrears_from_month ?? s.effective_from);
    await notify(tx, s.tenant_id, [s.employee_id], "salary.updated", "Your salary has been revised", `Effective ${s.effective_from}. See the breakup on the Finances tab of your profile.`, `/people/${s.employee_id}?tab=finances`);
  } else {
    await tx`delete from employee_salaries where id = ${s.id}`;
  }
  await log(tx, actor, "employee_salary", s.id, final === "approved" ? "salary.revision_approved" : "salary.revision_rejected", { employeeId: s.employee_id, ctcPaise: N(s.ctc_paise), effectiveFrom: s.effective_from, arrearsFromMonth: s.arrears_from_month });
  const [by] = s.created_by ? await tx<{ id: string }[]>`select id from employees where user_id = ${s.created_by}` : [];
  if (by && by.id !== s.employee_id) await notify(tx, s.tenant_id, [by.id], "salary.revision", final === "approved" ? `${s.name}'s salary revision was approved` : `${s.name}'s salary revision was declined`, `${inr(N(s.ctc_paise))} a year from ${s.effective_from}.`, `/people/${s.employee_id}?tab=finances`);
}

/** The first month a claim can be paid in: the claim's month, or the first later month whose payroll isn't finalised. A past month payroll never ran is paid with this month's salary. */
export async function nextOpenMonth(tx: Tx, payGroupId: string, from: string, today = todayIn()) {
  const runs = await tx<{ m: string; status: string }[]>`select period_month::text as m, status from payroll_runs where pay_group_id = ${payGroupId} and status <> 'rolled_back'`;
  const locked = new Set(runs.filter((r) => isLockedStatus(r.status)).map((r) => r.m));
  let m = from;
  while (locked.has(m)) m = addMonths(m, 1);
  if (m < monthStart(today) && !runs.some((r) => r.m === m)) m = monthStart(today);
  while (locked.has(m)) m = addMonths(m, 1);
  return m;
}

/**
 * A reimbursable claim decided: approved → the amount that still fits in the year's limit becomes a payroll input
 * (kind component_claim, paid tax-free as the component is) in the next open month; declined → marked so.
 */
export async function onComponentClaimDecided(tx: Tx, actor: Actor | null, claimId: string, final: "approved" | "rejected") {
  const [c] = await tx<{ id: string; employee_id: string; component_id: string; fy_start: string; claim_month: string; amount_paise: bigint; tenant_id: string; pay_group_id: string | null; component: string; code: string; annual_max_paise: bigint | null }[]>`
    select c.id, c.employee_id, c.component_id, c.fy_start::text, c.claim_month::text, c.amount_paise, c.tenant_id, e.pay_group_id, sc.name as component, sc.code, sc.annual_max_paise
    from component_claims c join employees e on e.id = c.employee_id join salary_components sc on sc.id = c.component_id where c.id = ${claimId} and c.status = 'submitted' for update of c`;
  if (!c) return;
  if (final === "rejected") {
    await tx`update component_claims set status = 'rejected', decided_by = ${actor?.userId ?? null}, decided_at = now(), updated_at = now() where id = ${c.id}`;
    await log(tx, actor, "component_claim", c.id, "claim.rejected", { employeeId: c.employee_id, amountPaise: N(c.amount_paise) });
    return;
  }
  // what still fits in the year's limit (the lower of the component's cap and a year of it in the salary in force at the claim month)
  const [sal] = await tx<{ breakup: Record<string, number> }[]>`select breakup from employee_salaries where employee_id = ${c.employee_id} and status in ('active','superseded') and effective_from <= ${c.claim_month}::date + interval '1 month' - interval '1 day' order by effective_from desc limit 1`;
  const monthly = sal?.breakup[c.code] ?? 0, cap = c.annual_max_paise == null ? null : N(c.annual_max_paise);
  const limit = cap == null ? monthly * 12 : monthly > 0 ? Math.min(cap, monthly * 12) : cap;
  const [{ used }] = await tx<{ used: string }[]>`select coalesce(sum(coalesce(allowed_paise, amount_paise)), 0)::text as used from component_claims where employee_id = ${c.employee_id} and fy_start = ${c.fy_start} and component_id = ${c.component_id} and status in ('approved','paid')`;
  const allowed = Math.min(N(c.amount_paise), Math.max(0, limit - N(used)));
  if (allowed <= 0 || !c.pay_group_id) {
    await tx`update component_claims set status = 'rejected', allowed_paise = 0, decided_by = ${actor?.userId ?? null}, decided_at = now(), note = coalesce(note || ' · ', '') || ${allowed <= 0 ? "Nothing left in the year's limit when it was approved." : "Not in a pay group, so it couldn't be scheduled into payroll."}, updated_at = now() where id = ${c.id}`;
    await log(tx, actor, "component_claim", c.id, "claim.rejected", { employeeId: c.employee_id, reason: allowed <= 0 ? "limit" : "no_pay_group" });
    return;
  }
  const month = await nextOpenMonth(tx, c.pay_group_id, c.claim_month);
  const [input] = await tx<{ id: string }[]>`
    insert into payroll_inputs (tenant_id, pay_group_id, period_month, employee_id, kind, component_id, amount_paise, source_ref, action, note, created_by)
    values (${c.tenant_id}, ${c.pay_group_id}, ${month}, ${c.employee_id}, 'component_claim', ${c.component_id}, ${allowed}, ${tx.json({ component_claim_id: c.id, claim_month: c.claim_month })}, 'pay',
      ${`${c.component} claim for ${c.claim_month.slice(0, 7)}`}, ${actor?.userId ?? null})
    on conflict ((source_ref->>'component_claim_id')) where kind = 'component_claim' and source_ref ? 'component_claim_id' do update set amount_paise = excluded.amount_paise, period_month = excluded.period_month returning id`;
  await markOpenRunStale(tx, c.pay_group_id, month);
  await tx`update component_claims set status = 'approved', allowed_paise = ${allowed}, payroll_input_id = ${input.id}, decided_by = ${actor?.userId ?? null}, decided_at = now(), updated_at = now() where id = ${c.id}`;
  await log(tx, actor, "component_claim", c.id, "claim.approved", { employeeId: c.employee_id, amountPaise: N(c.amount_paise), allowedPaise: allowed, month });
  await notify(tx, c.tenant_id, [c.employee_id], "claim.approved", `Your ${c.component} claim was approved`,
    `${inr(allowed)}${allowed < N(c.amount_paise) ? ` of ${inr(N(c.amount_paise))} (the rest is over this year's limit)` : ""} will be paid with your ${monthLabel(month)} salary.`, "/me/pay?tab=claims");
}
