/**
 * Leave administration demo data for the seeded tenant (called once at the end of db/seed.ts):
 * this year's and next year's holiday lists with optional (floater) days, a second leave plan with its own rules,
 * last leave year's accruals (so year-end processing has something to preview), and comp-off claims.
 */
import { withTenant } from "@/server/db";
import { addDaysISO, todayIn, weekday } from "@/lib/dates";
import { runAccrual } from "@/server/modules/leave/accrual";
import { requestCompOff } from "@/server/modules/leave/comp-off";
import { decide } from "@/server/modules/approvals/service";
import type { Actor } from "@/server/auth/session";
import { DEMO_SUBDOMAIN } from "./demo";

export async function seedLeave(tenantId: string) {
  const today = todayIn();
  const year = Number(today.slice(0, 4));
  const ids = await withTenant(tenantId, async (tx) => {
    const people = await tx<{ id: string; first_name: string; user_id: string; display_name: string }[]>`select id, first_name, user_id, display_name from employees`;
    return Object.fromEntries(people.map((p) => [p.first_name, p]));
  });
  const actor = (first: string): Actor => ({
    tenant: { id: tenantId, name: "Acme Technologies", status: "trial", subdomain: DEMO_SUBDOMAIN },
    userId: ids[first].user_id, employeeId: ids[first].id, name: ids[first].display_name, email: "", title: null, roles: [], permissions: new Set(), grants: [],
  });

  await withTenant(tenantId, async (tx) => {
    // holidays: this year's list (made at sign-up) gets the usual days; next year's list is a copy
    const [list] = await tx<{ id: string }[]>`update holiday_lists set floater_limit = 2 where year = ${year} returning id`;
    const fixed: [string, string, boolean][] = [
      ["New Year's Day", "01-01", false], ["Republic Day", "01-26", false], ["Labour Day", "05-01", false], ["Independence Day", "08-15", false],
      ["Gandhi Jayanti", "10-02", false], ["Christmas", "12-25", false],
      ["Christmas Eve (optional)", "12-24", true], ["New Year's Eve (optional)", "12-31", true], ["Founders' day (optional)", "11-27", true],
    ];
    for (const [name, md, floater] of fixed) {
      await tx`insert into holidays (tenant_id, holiday_list_id, name, date, is_floater) values (${tenantId}, ${list.id}, ${name}, ${`${year}-${md}`}, ${floater}) on conflict do nothing`;
    }
    const [next] = await tx<{ id: string }[]>`insert into holiday_lists (tenant_id, name, year, floater_limit) values (${tenantId}, 'Head office', ${year + 1}, 2) returning id`;
    for (const [name, md, floater] of fixed) {
      await tx`insert into holidays (tenant_id, holiday_list_id, name, date, is_floater) values (${tenantId}, ${next.id}, ${name}, ${`${year + 1}-${md}`}, ${floater})`;
    }
    await tx`update locations set default_holiday_list_id = ${list.id} where name = 'Head office'`;

    // a second plan with a financial-year leave year, quarterly casual leave and no accrual during probation
    const [plan] = await tx<{ id: string }[]>`
      insert into leave_plans (tenant_id, name, description, year_start) values (${tenantId}, 'Trainees', 'For interns and trainees in their first year.', 'apr') returning id`;
    const type = async (code: string) => (await tx<{ id: string }[]>`select id from leave_types where code = ${code}`)[0].id;
    const trainee = [
      { code: "CL", quota: 6, accrual: { frequency: "quarterly", day: 1, prorate_joining: true, stop_in_probation: true }, app: { allowHalfDay: true, backdateDays: 3, maxConsecutiveDays: 3 } },
      { code: "SL", quota: 6, accrual: { frequency: "upfront", day: 1, prorate_joining: true, stop_in_probation: false }, app: { allowHalfDay: true, backdateDays: 15, attachmentAfterDays: 1 } },
      { code: "LWP", quota: null, accrual: { frequency: "monthly", day: 1, prorate_joining: true, stop_in_probation: false }, app: { allowHalfDay: true, backdateDays: 7 } },
    ];
    for (const r of trainee) {
      await tx`insert into leave_plan_rules (tenant_id, leave_plan_id, leave_type_id, yearly_quota, accrual, application, year_end, approval)
               values (${tenantId}, ${plan.id}, ${await type(r.code)}, ${r.quota}, ${tx.json(r.accrual)}, ${tx.json(r.app)}, ${tx.json({ carry: "none" })},
                       ${tx.json(r.code === "CL" ? { auto: false, levels: [{ approver: "manager" }, { approver: "role", role: "hr_admin" }] } : {})})`;
    }
    // Aditya is a trainee on probation for two more months
    await tx`update employees set leave_plan_id = ${plan.id}, probation_status = 'in_probation', probation_end_date = ${addDaysISO(today, 60)} where id = ${ids.Aditya.id}`;

    // last leave year's credits (for the year-end preview) and anything due today under the new plan
    await runAccrual(tx, tenantId, `${year - 1}-12-31`);
    await runAccrual(tx, tenantId, today);
  });

  // comp-off: Meera worked last weekend (approved, credited); Vikram worked the weekend before (waiting for Rohan)
  const lastSat = (() => { let d = addDaysISO(today, -1); while (weekday(d) !== "sat") d = addDaysISO(d, -1); return d; })();
  const meera = await withTenant(tenantId, (tx) => requestCompOff(tx, actor("Meera"), { dates: [lastSat], note: "Release weekend support" }));
  await withTenant(tenantId, async (tx) => {
    const [step] = await tx<{ id: string }[]>`select s.id from approval_steps s join approval_requests q on q.id = s.request_id where q.entity_id = ${meera.id} and s.status = 'pending'`;
    if (step) await decide(tx, actor("Rohan"), step.id, "approved", "Thanks for covering the release");
  });
  await withTenant(tenantId, (tx) => requestCompOff(tx, actor("Vikram"), { dates: [addDaysISO(lastSat, -7)], note: "Data migration over the weekend" }));
}
