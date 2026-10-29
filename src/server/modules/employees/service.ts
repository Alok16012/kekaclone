import "server-only";
import { AppError, type Tx } from "@/server/db";
import { hashPassword } from "@/server/auth/password";
import { proratedOpening } from "@/server/modules/leave/rules";
import { todayIn } from "@/lib/dates";

export type NewEmployee = {
  firstName: string; lastName?: string | null; workEmail: string; mobile?: string | null;
  employeeNumber?: string | null; joiningDate: string; gender?: string | null;
  departmentId?: string | null; designationId?: string | null; locationId?: string | null; managerId?: string | null;
  password?: string;            // set for the founding admin; others get an invite
};

/** Creates employee + login + default policies + opening leave balances + timeline. Caller owns the transaction. */
export async function createEmployee(tx: Tx, tenantId: string, input: NewEmployee, actorUserId: string | null) {
  const email = input.workEmail.trim().toLowerCase();
  const [dupe] = await tx`select 1 from employees where work_email = ${email}`;
  if (dupe) throw new AppError("conflict", "Someone in your company already uses this work email.", "workEmail");

  const number = input.employeeNumber?.trim() || `EMP-${String(await tx`select next_counter('employee_number') as n`.then((r) => r[0].n)).padStart(4, "0")}`;
  const [numDupe] = await tx`select 1 from employees where employee_number = ${number}`;
  if (numDupe) throw new AppError("conflict", "This employee number is already taken.", "employeeNumber");

  const [defaults] = await tx<{ legal_entity_id: string | null; leave_plan_id: string | null; capture_policy_id: string | null; shift_id: string | null; weekly_off_id: string | null; location_id: string | null }[]>`
    select (select id from legal_entities order by created_at limit 1) as legal_entity_id,
           (select id from leave_plans where is_default limit 1) as leave_plan_id,
           (select id from capture_policies order by created_at limit 1) as capture_policy_id,
           (select id from shifts order by created_at limit 1) as shift_id,
           (select id from weekly_off_policies order by created_at limit 1) as weekly_off_id,
           (select id from locations order by created_at limit 1) as location_id`;

  const [user] = await tx<{ id: string }[]>`
    insert into users (tenant_id, email, password_hash, status, email_verified_at)
    values (${tenantId}, ${email}, ${input.password ? await hashPassword(input.password) : null},
            ${input.password ? "active" : "invited"}, ${input.password ? new Date() : null})
    returning id`;

  const display = [input.firstName.trim(), input.lastName?.trim()].filter(Boolean).join(" ");
  const [emp] = await tx<{ id: string }[]>`
    insert into employees (tenant_id, user_id, employee_number, first_name, last_name, display_name, work_email, mobile, gender,
      joining_date, legal_entity_id, department_id, designation_id, location_id, manager_id, leave_plan_id, capture_policy_id)
    values (${tenantId}, ${user.id}, ${number}, ${input.firstName.trim()}, ${input.lastName?.trim() || null}, ${display}, ${email},
      ${input.mobile || null}, ${input.gender || null}, ${input.joiningDate}, ${defaults.legal_entity_id}, ${input.departmentId || null},
      ${input.designationId || null}, ${input.locationId || defaults.location_id}, ${input.managerId || null}, ${defaults.leave_plan_id}, ${defaults.capture_policy_id})
    returning id`;

  if (defaults.shift_id) await tx`insert into shift_assignments (tenant_id, employee_id, shift_id, period) values (${tenantId}, ${emp.id}, ${defaults.shift_id}, daterange(${input.joiningDate}::date, null))`;
  if (defaults.weekly_off_id) await tx`insert into weekly_off_assignments (tenant_id, employee_id, policy_id, period) values (${tenantId}, ${emp.id}, ${defaults.weekly_off_id}, daterange(${input.joiningDate}::date, null))`;

  // opening balances for the leave year running today (prorated from the joining date if they join during it).
  // M0 credits upfront; the monthly accrual + year-rollover job replaces this in M2.
  if (defaults.leave_plan_id) {
    const rules = await tx<{ leave_type_id: string; yearly_quota: string | null; year_start: string }[]>`
      select r.leave_type_id, r.yearly_quota, p.year_start from leave_plan_rules r join leave_plans p on p.id = r.leave_plan_id where r.leave_plan_id = ${defaults.leave_plan_id}`;
    const today = todayIn();
    for (const r of rules) {
      if (r.yearly_quota == null) continue;
      const startMonth = r.year_start === "apr" ? 4 : 1;
      const ty = Number(today.slice(0, 4)), tm = Number(today.slice(5, 7));
      const cycleStart = `${tm >= startMonth ? ty : ty - 1}-${String(startMonth).padStart(2, "0")}-01`;
      const from = input.joiningDate > cycleStart ? input.joiningDate : cycleStart;
      const amount = proratedOpening(Number(r.yearly_quota), from, startMonth);
      if (amount > 0) await tx`
        insert into leave_ledger (tenant_id, employee_id, leave_type_id, cycle_start, entry_date, kind, amount, note, idempotency_key, created_by)
        values (${tenantId}, ${emp.id}, ${r.leave_type_id}, ${cycleStart}, ${from}, 'opening', ${amount}, 'Opening balance for the leave year',
                ${`opening:${emp.id}:${r.leave_type_id}:${cycleStart}`}, ${actorUserId})`;
    }
  }
  await tx`insert into timeline_events (tenant_id, employee_id, kind, effective_date, actor_user_id) values (${tenantId}, ${emp.id}, 'joined', ${input.joiningDate}, ${actorUserId})`;
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action) values (${tenantId}, ${actorUserId}, 'employee', ${emp.id}, 'create')`;
  return { employeeId: emp.id, userId: user.id, employeeNumber: number };
}

export type DirectoryRow = { id: string; display_name: string; employee_number: string; work_email: string; designation: string | null; department: string | null; location: string | null; manager: string | null; status: string; joining_date: string; login: "active" | "invited" | "not_invited" | "disabled" };

export async function listEmployees(tx: Tx, q?: string) {
  const term = q?.trim() ? `%${q.trim()}%` : null;
  return tx<DirectoryRow[]>`
    select e.id, e.display_name, e.employee_number, e.work_email, d.title as designation, dp.name as department, l.name as location,
           m.display_name as manager, e.status, e.joining_date::text,
           case when u.status = 'active' then 'active' when u.status = 'disabled' then 'disabled' when u.invited_at is not null then 'invited' else 'not_invited' end as login
    from employees e
    left join users u on u.id = e.user_id
    left join designations d on d.id = e.designation_id
    left join departments dp on dp.id = e.department_id
    left join locations l on l.id = e.location_id
    left join employees m on m.id = e.manager_id
    where e.status <> 'relieved'
      and (${term}::text is null or e.display_name ilike ${term} or e.employee_number ilike ${term} or e.work_email ilike ${term} or d.title ilike ${term})
    order by e.display_name
    limit 500`;
}

export async function orgOptions(tx: Tx) {
  const [departments, designations, locations, people] = await Promise.all([
    tx<{ id: string; name: string }[]>`select id, name from departments order by name`,
    tx<{ id: string; name: string }[]>`select id, title as name from designations order by title`,
    tx<{ id: string; name: string }[]>`select id, name from locations order by name`,
    tx<{ id: string; name: string; title: string | null; department: string | null }[]>`
      select e.id, e.display_name as name, d.title, dp.name as department from employees e
      left join designations d on d.id = e.designation_id left join departments dp on dp.id = e.department_id
      where e.status <> 'relieved' order by e.display_name`,
  ]);
  return { departments, designations, locations, people };
}

export type PersonHit = { id: string; name: string; title: string | null; department: string | null; email: string; number: string };

/**
 * Quick people search for the command palette: prefix matches on name parts rank first, then
 * anything containing the text in name, email, employee number or designation.
 */
export async function searchPeople(tx: Tx, q: string, limit = 8) {
  const term = q.trim().slice(0, 80);
  if (term.length < 2) return [];
  const like = `%${term.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
  const prefix = `${term.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
  return tx<PersonHit[]>`
    select e.id, e.display_name as name, d.title, dp.name as department, e.work_email as email, e.employee_number as number
    from employees e left join designations d on d.id = e.designation_id left join departments dp on dp.id = e.department_id
    where e.status <> 'relieved'
      and (e.display_name ilike ${like} or e.work_email ilike ${like} or e.employee_number ilike ${like} or d.title ilike ${like})
    order by (e.display_name ilike ${prefix} or e.last_name ilike ${prefix}) desc, similarity(e.display_name, ${term}) desc, e.display_name
    limit ${limit}`;
}
