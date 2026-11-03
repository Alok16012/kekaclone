import "server-only";
import { AppError, type Tx } from "@/server/db";
import { hashPassword } from "@/server/auth/password";
import { creditOnJoining } from "@/server/modules/leave/accrual";
import { addDaysISO } from "@/lib/dates";

export type NewEmployee = {
  firstName: string; lastName?: string | null; workEmail: string; mobile?: string | null;
  employeeNumber?: string | null; joiningDate: string; gender?: string | null;
  departmentId?: string | null; designationId?: string | null; locationId?: string | null; managerId?: string | null;
  password?: string;            // set for the founding admin; others get an invite
  // the add-employee wizard's job and work-policy steps (all optional; defaults apply when left out)
  middleName?: string | null; personalEmail?: string | null; dob?: string | null;
  legalEntityId?: string | null; businessUnitId?: string | null; bandId?: string | null; l2ManagerId?: string | null; dottedManagerId?: string | null;
  workerType?: "permanent" | "contract" | "intern" | "consultant"; timeType?: "full_time" | "part_time";
  probationPolicyId?: string | null; noticePolicyId?: string | null;
  leavePlanId?: string | null; holidayListId?: string | null; shiftId?: string | null; weeklyOffId?: string | null;
  capturePolicyId?: string | null; penalizationPolicyId?: string | null; payGroupId?: string | null;
  custom?: Record<string, unknown>;
};

/** Client-supplied ids are looked up inside the tenant first (FK checks alone would accept another tenant's row). */
const REFS: [keyof NewEmployee, string, string][] = [
  ["departmentId", "departments", "department"], ["designationId", "designations", "designation"], ["locationId", "locations", "location"],
  ["legalEntityId", "legal_entities", "legal entity"], ["businessUnitId", "business_units", "business unit"], ["bandId", "bands", "band"],
  ["probationPolicyId", "probation_policies", "probation policy"], ["noticePolicyId", "notice_period_policies", "notice period"],
  ["leavePlanId", "leave_plans", "leave plan"], ["holidayListId", "holiday_lists", "holiday list"], ["shiftId", "shifts", "shift"],
  ["weeklyOffId", "weekly_off_policies", "weekly-off policy"], ["capturePolicyId", "capture_policies", "attendance capture policy"],
  ["penalizationPolicyId", "penalization_policies", "penalty policy"], ["payGroupId", "pay_groups", "pay group"],
];
async function assertRefs(tx: Tx, input: NewEmployee) {
  for (const [field, table, label] of REFS) {
    const id = input[field] as string | null | undefined;
    if (!id) continue;
    const [r] = await tx`select 1 from ${tx(table)} where id = ${id}`;
    if (!r) throw new AppError("invalid", `That ${label} doesn't exist. Pick another.`, field);
  }
  for (const field of ["managerId", "l2ManagerId", "dottedManagerId"] as const) {
    const id = input[field];
    if (!id) continue;
    const [r] = await tx`select 1 from employees where id = ${id} and status <> 'relieved'`;
    if (!r) throw new AppError("invalid", "Pick a manager who works here.", field);
  }
}

/** Creates employee + login + default policies + opening leave balances + timeline. Caller owns the transaction. */
export async function createEmployee(tx: Tx, tenantId: string, input: NewEmployee, actorUserId: string | null) {
  const email = input.workEmail.trim().toLowerCase();
  const [dupe] = await tx`select 1 from employees where work_email = ${email}`;
  if (dupe) throw new AppError("conflict", "Someone in your company already uses this work email.", "workEmail");

  const number = input.employeeNumber?.trim() || `EMP-${String(await tx`select next_counter('employee_number') as n`.then((r) => r[0].n)).padStart(4, "0")}`;
  const [numDupe] = await tx`select 1 from employees where employee_number = ${number}`;
  if (numDupe) throw new AppError("conflict", "This employee number is already taken.", "employeeNumber");
  await assertRefs(tx, input);

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
  const [probation] = input.probationPolicyId
    ? await tx<{ days: number }[]>`select duration_days as days from probation_policies where id = ${input.probationPolicyId}`
    : [null];
  const probationEnd = probation && probation.days > 0 ? addDaysISO(input.joiningDate, probation.days) : null;
  const leavePlanId = input.leavePlanId || defaults.leave_plan_id;
  const shiftId = input.shiftId || defaults.shift_id, weeklyOffId = input.weeklyOffId || defaults.weekly_off_id;
  const [emp] = await tx<{ id: string }[]>`
    insert into employees ${tx({
      tenant_id: tenantId, user_id: user.id, employee_number: number, first_name: input.firstName.trim(), middle_name: input.middleName?.trim() || null,
      last_name: input.lastName?.trim() || null, display_name: display, work_email: email, personal_email: input.personalEmail?.trim().toLowerCase() || null,
      mobile: input.mobile || null, gender: input.gender || null, dob: input.dob || null, joining_date: input.joiningDate,
      legal_entity_id: input.legalEntityId || defaults.legal_entity_id, business_unit_id: input.businessUnitId || null, department_id: input.departmentId || null,
      designation_id: input.designationId || null, location_id: input.locationId || defaults.location_id, band_id: input.bandId || null,
      manager_id: input.managerId || null, l2_manager_id: input.l2ManagerId || null, dotted_manager_id: input.dottedManagerId || null,
      worker_type: input.workerType ?? "permanent", time_type: input.timeType ?? "full_time",
      probation_policy_id: input.probationPolicyId || null, probation_end_date: probationEnd, probation_status: probationEnd ? "in_probation" : "none",
      notice_period_policy_id: input.noticePolicyId || null,
      leave_plan_id: leavePlanId, holiday_list_id: input.holidayListId || null,
      capture_policy_id: input.capturePolicyId || defaults.capture_policy_id, penalization_policy_id: input.penalizationPolicyId || null,
      pay_group_id: input.payGroupId || null, custom: tx.json((input.custom ?? {}) as never),
    } as never)}
    returning id`;

  if (shiftId) await tx`insert into shift_assignments (tenant_id, employee_id, shift_id, period) values (${tenantId}, ${emp.id}, ${shiftId}, daterange(${input.joiningDate}::date, null))`;
  if (weeklyOffId) await tx`insert into weekly_off_assignments (tenant_id, employee_id, policy_id, period) values (${tenantId}, ${emp.id}, ${weeklyOffId}, daterange(${input.joiningDate}::date, null))`;

  // first leave credits under the plan (upfront plans: the prorated year; accruing plans: the joining period)
  if (leavePlanId) await creditOnJoining(tx, tenantId, emp.id, input.joiningDate, actorUserId);
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
