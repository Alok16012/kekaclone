import "server-only";
import { createHash } from "node:crypto";
import QRCode from "qrcode";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { audit } from "@/server/modules/audit/service";
import { accessTo } from "@/server/modules/employees/profile";
import { createEmployee, type NewEmployee } from "@/server/modules/employees/service";
import { invite } from "@/server/modules/auth/flows";
import { balances, myRequests as leaveRequests } from "@/server/modules/leave/service";
import { creditOnJoining } from "@/server/modules/leave/accrual";
import { saveSalary } from "@/server/modules/payroll/salary";
import { canPayrollFor } from "@/server/modules/payroll/access";
import { appUrl } from "@/server/email";
import { addDaysISO, todayIn } from "@/lib/dates";
import { EVERYWHERE } from "./approvals-admin";
import { checkValues, listDefs } from "./custom-fields";
import { idCardToken } from "./id-token";

export const hasAnyGrant = (actor: Actor, perm: string) => (actor.grants ?? []).some((g) => g.permissions.includes("*") || g.permissions.includes(perm));
export async function placementOf(tx: Tx, employeeId: string) {
  const [p] = await tx<(Placement & { status: string; display_name: string })[]>`select department_id, location_id, legal_entity_id, business_unit_id, status, display_name from employees where id = ${employeeId}`;
  if (!p) throw new AppError("not_found", "That person isn't in your company.");
  return p;
}

// ---------------------------------------------------------------- directory

export const STATUSES = ["current", "active", "notice", "preboarding", "relieved", "all"] as const;
export type DirectoryFilters = {
  q?: string; departmentIds?: string[]; locationIds?: string[]; designationIds?: string[];
  status?: (typeof STATUSES)[number]; joinedFrom?: string | null; joinedTo?: string | null;
};
export type DirectoryPerson = {
  id: string; display_name: string; employee_number: string; work_email: string; mobile: string | null; designation: string | null; department: string | null;
  location: string | null; manager: string | null; status: string; joining_date: string; exit_date: string | null; worker_type: string;
  login: "active" | "invited" | "not_invited" | "disabled"; department_id: string | null; location_id: string | null; legal_entity_id: string | null; business_unit_id: string | null;
};

/**
 * Filtered people list. Everyone sees current colleagues; people who have left (and mobile numbers) only show for
 * those with employees.read/write over them. Filters are ids resolved by the query itself (no cross-tenant reach).
 */
export async function directory(tx: Tx, actor: Actor, f: DirectoryFilters, limit = 2000) {
  const term = f.q?.trim() ? `%${f.q.trim().slice(0, 80).replace(/[%_\\]/g, (c) => "\\" + c)}%` : null;
  const status = f.status ?? "current";
  const reader = hasAnyGrant(actor, "employees.read") || hasAnyGrant(actor, "employees.write");
  const wantRelieved = status === "relieved" || status === "all";
  const ids = (xs?: string[]) => (xs?.length ? xs.filter((x) => /^[0-9a-f-]{36}$/i.test(x)) : null);
  const deps = ids(f.departmentIds), locs = ids(f.locationIds), dess = ids(f.designationIds);
  const rows = await tx<DirectoryPerson[]>`
    select e.id, e.display_name, e.employee_number, e.work_email, e.mobile, d.title as designation, dp.name as department, l.name as location,
           m.display_name as manager, e.status, e.joining_date::text, e.exit_date::text, e.worker_type,
           case when u.status = 'active' then 'active' when u.status = 'disabled' then 'disabled' when u.invited_at is not null then 'invited' else 'not_invited' end as login,
           e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id
    from employees e
    left join users u on u.id = e.user_id left join designations d on d.id = e.designation_id
    left join departments dp on dp.id = e.department_id left join locations l on l.id = e.location_id
    left join employees m on m.id = e.manager_id
    where (case ${status} when 'current' then e.status <> 'relieved' when 'all' then true else e.status = ${status} end)
      and (${term}::text is null or e.display_name ilike ${term} or e.employee_number ilike ${term} or e.work_email ilike ${term} or d.title ilike ${term})
      and (${deps}::uuid[] is null or e.department_id = any(${deps}::uuid[]))
      and (${locs}::uuid[] is null or e.location_id = any(${locs}::uuid[]))
      and (${dess}::uuid[] is null or e.designation_id = any(${dess}::uuid[]))
      and (${f.joinedFrom ?? null}::date is null or e.joining_date >= ${f.joinedFrom ?? null}::date)
      and (${f.joinedTo ?? null}::date is null or e.joining_date <= ${f.joinedTo ?? null}::date)
    order by e.display_name limit ${limit}`;
  return rows
    .filter((r) => r.status !== "relieved" || (wantRelieved && reader && (canFor(actor, "employees.read", r) || canFor(actor, "employees.write", r))))
    .map((r) => (canFor(actor, "employees.read", r) || canFor(actor, "employees.write", r) || r.id === actor.employeeId ? r : { ...r, mobile: null }));
}

/** Export is an admin report: only people with employees.read/write, and only rows inside their scope. */
export async function directoryExport(tx: Tx, actor: Actor, f: DirectoryFilters) {
  if (!hasAnyGrant(actor, "employees.read") && !hasAnyGrant(actor, "employees.write")) throw new AppError("forbidden", "You don't have access to export people.");
  const rows = (await directory(tx, actor, f, 10000)).filter((r) => canFor(actor, "employees.read", r) || canFor(actor, "employees.write", r));
  await audit(tx, actor, { entityType: "employee", action: "export", diff: { count: rows.length, filters: f } });
  const header = ["Employee number", "Name", "Work email", "Mobile", "Designation", "Department", "Location", "Reports to", "Status", "Worker type", "Joining date", "Exit date"];
  return { header, rows: rows.map((r) => [r.employee_number, r.display_name, r.work_email, r.mobile ?? "", r.designation ?? "", r.department ?? "", r.location ?? "", r.manager ?? "", r.status, r.worker_type, r.joining_date, r.exit_date ?? ""]) };
}

/** Directory filters from the URL (?department=…&status=…&from=…), with anything malformed dropped. */
export function filtersFrom(sp: Record<string, string | string[] | undefined>): DirectoryFilters {
  const one = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : undefined);
  const date = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const id = (v?: string) => (v && /^[0-9a-f-]{36}$/i.test(v) ? [v] : undefined);
  const status = one(sp.status);
  return {
    q: one(sp.q), departmentIds: id(one(sp.department)), locationIds: id(one(sp.location)), designationIds: id(one(sp.designation)),
    status: (STATUSES as readonly string[]).includes(status ?? "") ? (status as DirectoryFilters["status"]) : "current", joinedFrom: date(one(sp.from)), joinedTo: date(one(sp.to)),
  };
}

export async function filterOptions(tx: Tx) {
  const [departments, locations, designations] = await Promise.all([
    tx<{ id: string; name: string }[]>`select id, name from departments order by name`,
    tx<{ id: string; name: string }[]>`select id, name from locations order by name`,
    tx<{ id: string; name: string }[]>`select id, title as name from designations order by title`,
  ]);
  return { departments, locations, designations };
}

// ---------------------------------------------------------------- org chart

export type OrgNode = { id: string; name: string; title: string | null; department: string | null; location: string | null; manager_id: string | null; reports: number };
const ORG_COLS = (tx: Tx) => tx`e.id, e.display_name as name, d.title, dp.name as department, l.name as location, e.manager_id,
  (select count(*)::int from employees c where c.manager_id = e.id and c.status <> 'relieved') as reports`;
const ORG_FROM = (tx: Tx) => tx`employees e left join designations d on d.id = e.designation_id left join departments dp on dp.id = e.department_id left join locations l on l.id = e.location_id`;

/** Direct reports of a person, or the top of the company (people with no current manager) when managerId is null. */
export async function orgChildren(tx: Tx, managerId: string | null) {
  return managerId
    ? tx<OrgNode[]>`select ${ORG_COLS(tx)} from ${ORG_FROM(tx)} where e.manager_id = ${managerId} and e.status <> 'relieved' order by e.display_name`
    : tx<OrgNode[]>`select ${ORG_COLS(tx)} from ${ORG_FROM(tx)} where e.status <> 'relieved'
        and (e.manager_id is null or not exists (select 1 from employees m where m.id = e.manager_id and m.status <> 'relieved')) order by e.display_name`;
}

/** A person and their chain of managers up to the top (for "start from me"). */
export async function orgChain(tx: Tx, employeeId: string) {
  const rows = await tx<(OrgNode & { depth: number })[]>`
    with recursive up as (select id, manager_id, 0 as depth from employees where id = ${employeeId}
      union all select e.id, e.manager_id, up.depth + 1 from employees e join up on e.id = up.manager_id where up.depth < 30)
    select ${ORG_COLS(tx)}, up.depth from up join ${ORG_FROM(tx)} on e.id = up.id where e.status <> 'relieved' order by up.depth desc`;
  return rows;
}

/** Everyone current, flat (for exports and the PNG). */
export async function orgAll(tx: Tx) {
  return tx<OrgNode[]>`select ${ORG_COLS(tx)} from ${ORG_FROM(tx)} where e.status <> 'relieved' order by e.display_name limit 5000`;
}

export type DeptNode = { id: string; name: string; parent_id: string | null; head: string | null; head_id: string | null; people: number };
export async function departmentsTree(tx: Tx) {
  return tx<DeptNode[]>`select d.id, d.name, d.parent_id, h.display_name as head, d.head_employee_id as head_id,
    (select count(*)::int from employees e where e.department_id = d.id and e.status <> 'relieved') as people
    from departments d left join employees h on h.id = d.head_employee_id order by d.name`;
}
export async function departmentMembers(tx: Tx, departmentId: string | null) {
  return departmentId
    ? tx<OrgNode[]>`select ${ORG_COLS(tx)} from ${ORG_FROM(tx)} where e.department_id = ${departmentId} and e.status <> 'relieved' order by e.display_name`
    : tx<OrgNode[]>`select ${ORG_COLS(tx)} from ${ORG_FROM(tx)} where e.department_id is null and e.status <> 'relieved' order by e.display_name`;
}

// ---------------------------------------------------------------- add-employee wizard

export type WizardInput = NewEmployee & { sendInvite?: boolean; compensation?: { structureId: string; ctcPaise: number } | null };

/**
 * Basic → job → work policies → compensation, in one transaction. HR needs employees.write over the new person's
 * placement; the compensation step additionally needs payroll access there. Custom fields: every published required
 * field must be filled.
 */
export async function addEmployee(tx: Tx, actor: Actor, input: WizardInput) {
  const [le] = input.legalEntityId ? [{ id: input.legalEntityId }] : await tx<{ id: string | null }[]>`select (select id from legal_entities order by created_at limit 1) as id`;
  const [loc] = input.locationId ? [{ id: input.locationId }] : await tx<{ id: string | null }[]>`select (select id from locations order by created_at limit 1) as id`;
  const place: Placement = { department_id: input.departmentId ?? null, location_id: loc.id, legal_entity_id: le.id, business_unit_id: input.businessUnitId ?? null };
  if (!canFor(actor, "employees.write", place)) throw new AppError("forbidden", "You can only add people to departments and locations you manage.");
  if (input.compensation && !canPayrollFor(actor, place)) throw new AppError("forbidden", "You don't have payroll access for this person. Leave the compensation step empty; payroll can add it later.", "structureId");
  const defs = await listDefs(tx, { published: true });
  const { values, errors } = checkValues(defs, "hr_admin", input.custom ?? {}, { requireAll: true });
  if (errors.length) throw new AppError("invalid", errors[0].error, `custom.${errors[0].key}`);
  if (input.joiningDate < addDaysISO(todayIn(), -3650) || input.joiningDate > addDaysISO(todayIn(), 365)) throw new AppError("invalid", "Pick a joining date within the last ten years or the next year.", "joiningDate");
  const created = await createEmployee(tx, actor.tenant.id, { ...input, custom: Object.fromEntries(Object.entries(values).filter(([, v]) => v != null)) }, actor.userId);
  if (input.compensation) {
    await saveSalary(tx, actor, { employeeId: created.employeeId, structureId: input.compensation.structureId, ctcPaise: input.compensation.ctcPaise, effectiveFrom: input.joiningDate, reason: "joining" }, { notify: false });
  }
  const invited = input.sendInvite ? (await invite(tx, actor, [created.employeeId])).sent > 0 : false;
  return { ...created, invited };
}

export async function wizardOptions(tx: Tx, actor: Actor) {
  const year = Number(todayIn().slice(0, 4));
  const q = <T,>(p: Promise<T>) => p;
  const [legalEntities, businessUnits, bands, probation, notice, leavePlans, holidayLists, shifts, weeklyOffs, capture, penalties, payGroups, structures, fields] = await Promise.all([
    q(tx<{ id: string; name: string }[]>`select id, name from legal_entities order by name`),
    q(tx<{ id: string; name: string }[]>`select id, name from business_units order by name`),
    q(tx<{ id: string; name: string }[]>`select id, name from bands order by rank, name`),
    q(tx<{ id: string; name: string; days: number }[]>`select id, name, duration_days as days from probation_policies order by name`),
    q(tx<{ id: string; name: string; days: number }[]>`select id, name, days from notice_period_policies order by days`),
    q(tx<{ id: string; name: string; is_default: boolean }[]>`select id, name, is_default from leave_plans order by is_default desc, name`),
    q(tx<{ id: string; name: string }[]>`select id, name || ' (' || year || ')' as name from holiday_lists where year in (${year}, ${year + 1}) order by year, name`),
    q(tx<{ id: string; name: string }[]>`select id, name || ' · ' || code as name from shifts order by created_at`),
    q(tx<{ id: string; name: string }[]>`select id, name from weekly_off_policies order by created_at`),
    q(tx<{ id: string; name: string }[]>`select id, name from capture_policies order by created_at`),
    q(tx<{ id: string; name: string }[]>`select id, name from penalization_policies order by created_at`),
    q(tx<{ id: string; name: string }[]>`select id, name from pay_groups order by name`),
    hasAnyGrant(actor, "payroll.admin") ? tx<{ id: string; name: string; pay_group_id: string }[]>`select id, name, pay_group_id from salary_structures order by name` : Promise.resolve([]),
    listDefs(tx, { published: true }),
  ]);
  return { legalEntities, businessUnits, bands, probation, notice, leavePlans, holidayLists, shifts, weeklyOffs, capture, penalties, payGroups, structures, fields, canPay: hasAnyGrant(actor, "payroll.admin") };
}

// ---------------------------------------------------------------- rehire

export type RehireInput = {
  mode: "reactivate" | "new_record"; joiningDate: string; workEmail?: string | null; employeeNumber?: string | null;
  departmentId?: string | null; designationId?: string | null; locationId?: string | null; managerId?: string | null;
  overrideNotRehirable?: boolean; sendInvite?: boolean;
};

/**
 * Brings back someone who left. "reactivate" reuses their record (history kept on the timeline, new joining date);
 * "new_record" creates a fresh employment linked to the old one (new number and email). Their exit must be complete,
 * and an exit marked "not OK to rehire" needs an explicit override.
 */
export async function rehire(tx: Tx, actor: Actor, employeeId: string, input: RehireInput) {
  const [e] = await tx<(Placement & { status: string; display_name: string; first_name: string; middle_name: string | null; last_name: string | null; gender: string | null; dob: string | null; personal_email: string | null; mobile: string | null; joining_date: string; exit_date: string | null; user_id: string | null; work_email: string })[]>`
    select department_id, location_id, legal_entity_id, business_unit_id, status, display_name, first_name, middle_name, last_name, gender, dob::text, personal_email, mobile,
      joining_date::text, exit_date::text, user_id, work_email from employees where id = ${employeeId}`;
  if (!e) throw new AppError("not_found", "That person isn't in your company.");
  if (!canFor(actor, "employees.write", e)) throw new AppError("forbidden", "Only HR can rehire people.");
  if (e.status !== "relieved") throw new AppError("invalid", `${e.display_name} hasn't left the company.`);
  if (e.exit_date && input.joiningDate <= e.exit_date) throw new AppError("invalid", `Pick a joining date after their last day (${e.exit_date}).`, "joiningDate");
  if (input.joiningDate > addDaysISO(todayIn(), 365)) throw new AppError("invalid", "Pick a joining date within the next year.", "joiningDate");
  const [x] = await tx<{ ok_to_rehire: boolean | null }[]>`select ok_to_rehire from exit_requests where employee_id = ${employeeId} and status = 'exited' order by updated_at desc limit 1`;
  if (x?.ok_to_rehire === false && !input.overrideNotRehirable) throw new AppError("conflict", `${e.display_name}'s exit was marked “not OK to rehire”. Confirm to go ahead anyway.`, "overrideNotRehirable");
  const target: Placement = { department_id: input.departmentId ?? e.department_id, location_id: input.locationId ?? e.location_id, legal_entity_id: e.legal_entity_id, business_unit_id: e.business_unit_id };
  if (!canFor(actor, "employees.write", target)) throw new AppError("forbidden", "You can only rehire into departments and locations you manage.");
  for (const [table, id, field] of [["departments", input.departmentId, "departmentId"], ["designations", input.designationId, "designationId"], ["locations", input.locationId, "locationId"]] as const) {
    if (id && !(await tx`select 1 from ${tx(table)} where id = ${id}`).length) throw new AppError("invalid", "That option no longer exists.", field);
  }
  if (input.managerId && !(await tx`select 1 from employees where id = ${input.managerId} and status <> 'relieved' and id <> ${employeeId}`).length) throw new AppError("invalid", "Pick a manager who works here.", "managerId");

  let newId = employeeId;
  if (input.mode === "reactivate") {
    const changes: Record<string, unknown> = { status: "active", joining_date: input.joiningDate, exit_date: null, probation_status: "none", probation_end_date: null };
    if (input.departmentId) changes.department_id = input.departmentId;
    if (input.designationId) changes.designation_id = input.designationId;
    if (input.locationId) changes.location_id = input.locationId;
    if (input.managerId !== undefined) changes.manager_id = input.managerId;
    await tx`update employees set ${tx(changes as never)} where id = ${employeeId}`;
    if (e.user_id) await tx`update users set status = case when password_hash is null then 'invited' else 'active' end where id = ${e.user_id} and status = 'disabled'`;
    await tx`insert into timeline_events (tenant_id, employee_id, kind, effective_date, data, actor_user_id)
             values (${actor.tenant.id}, ${employeeId}, 'rehired', ${input.joiningDate}, ${tx.json({ previousJoining: e.joining_date, previousExit: e.exit_date, mode: "reactivate" })}, ${actor.userId})`;
    // a new open-ended shift / weekly-off period from the new joining date (the old one may have been closed)
    for (const [table, col] of [["shift_assignments", "shift_id"], ["weekly_off_assignments", "policy_id"]] as const) {
      const [last] = await tx<{ id: string }[]>`select ${tx(col)} as id from ${tx(table)} where employee_id = ${employeeId} order by lower(period) desc limit 1`;
      const [open] = await tx`select 1 from ${tx(table)} where employee_id = ${employeeId} and upper_inf(period)`;
      if (last && !open) await tx`insert into ${tx(table)} (tenant_id, employee_id, ${tx(col)}, period) values (${actor.tenant.id}, ${employeeId}, ${last.id}, daterange(${input.joiningDate}::date, null))`;
    }
    await creditOnJoining(tx, actor.tenant.id, employeeId, input.joiningDate, actor.userId);
  } else {
    const email = input.workEmail?.trim().toLowerCase();
    if (!email) throw new AppError("invalid", "Enter a work email for the new record.", "workEmail");
    const created = await createEmployee(tx, actor.tenant.id, {
      firstName: e.first_name, middleName: e.middle_name, lastName: e.last_name, workEmail: email, employeeNumber: input.employeeNumber, joiningDate: input.joiningDate,
      gender: e.gender, dob: e.dob, personalEmail: e.personal_email, mobile: e.mobile,
      departmentId: input.departmentId ?? e.department_id, designationId: input.designationId, locationId: input.locationId ?? e.location_id, managerId: input.managerId ?? null,
      legalEntityId: e.legal_entity_id, businessUnitId: e.business_unit_id,
    }, actor.userId);
    newId = created.employeeId;
    await tx`update employees set rehired_from_employee_id = ${employeeId} where id = ${newId}`;
    await tx`insert into timeline_events (tenant_id, employee_id, kind, effective_date, data, actor_user_id)
             values (${actor.tenant.id}, ${newId}, 'rehired', ${input.joiningDate}, ${tx.json({ previousEmployeeId: employeeId, previousExit: e.exit_date, mode: "new_record" })}, ${actor.userId})`;
  }
  await audit(tx, actor, { entityType: "employee", entityId: newId, action: "rehire", diff: { mode: input.mode, from: employeeId, joiningDate: input.joiningDate, override: !!input.overrideNotRehirable } });
  const invited = input.sendInvite ? (await invite(tx, actor, [newId])).sent > 0 : false;
  return { employeeId: newId, invited };
}

// ---------------------------------------------------------------- digital ID card

function cardSecret() {
  // separate from the data key's use for encryption: derived, never the raw key
  return createHash("sha256").update(`idcard:${process.env.ERP_DATA_KEY?.trim() || "erp-local-development-key-do-not-use-in-production"}`).digest("hex");
}
export const verifySecret = cardSecret;

export async function idCard(tx: Tx, actor: Actor, employeeId: string) {
  const a = await accessTo(tx, actor, employeeId);
  if (a === "colleague") return null;
  const [e] = await tx<{ id: string; display_name: string; employee_number: string; designation: string | null; department: string | null; location: string | null; blood_group: string | null; joining_date: string; status: string; mobile: string | null; company: string; work_email: string; subdomain: string }[]>`
    select e.id, e.display_name, e.employee_number, d.title as designation, dp.name as department, l.name as location, e.blood_group, e.joining_date::text, e.status, e.mobile,
      coalesce(le.name, t.name) as company, e.work_email, t.subdomain::text
    from employees e join tenants t on t.id = e.tenant_id left join designations d on d.id = e.designation_id left join departments dp on dp.id = e.department_id
    left join locations l on l.id = e.location_id left join legal_entities le on le.id = e.legal_entity_id where e.id = ${employeeId}`;
  if (!e) return null;
  const url = appUrl(e.subdomain, `/verify/id/${idCardToken(cardSecret(), actor.tenant.id, e.id)}`);
  const qrSvg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } });
  return { ...e, verifyUrl: url, qrSvg };
}

/** What the public verification page may show: no contact details, no ids beyond the employee number. */
export async function verifiedCard(tx: Tx, employeeId: string) {
  const [e] = await tx<{ display_name: string; employee_number: string; designation: string | null; status: string; company: string }[]>`
    select e.display_name, e.employee_number, d.title as designation, e.status, coalesce(le.name, t.name) as company
    from employees e join tenants t on t.id = e.tenant_id left join designations d on d.id = e.designation_id left join legal_entities le on le.id = e.legal_entity_id
    where e.id = ${employeeId}`;
  return e ?? null;
}

// ---------------------------------------------------------------- Time tab

export async function canSeeTime(tx: Tx, actor: Actor, employeeId: string) {
  const a = await accessTo(tx, actor, employeeId);
  if (a !== "colleague") return true;
  const p = await placementOf(tx, employeeId);
  return ["leave.admin", "attendance.admin", "employees.read"].some((perm) => canFor(actor, perm, p));
}

export async function timeTab(tx: Tx, actor: Actor, employeeId: string, month?: string) {
  if (!(await canSeeTime(tx, actor, employeeId))) return null;
  const today = todayIn();
  const first = month && /^\d{4}-\d{2}-01$/.test(month) ? month : today.slice(0, 8) + "01";
  const next = (() => { const d = new Date(first + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10); })();
  const [bal, days, leaves, att] = await Promise.all([
    balances(tx, employeeId),
    tx<{ status: string; n: number; late: number; effective: number; worked: number; lateDays: number }[]>`
      select status, count(*)::int as n, coalesce(sum(late_minutes), 0)::int as late, coalesce(sum(effective_minutes), 0)::int as effective,
        count(*) filter (where effective_minutes > 0)::int as worked, count(*) filter (where late_minutes > 0)::int as "lateDays"
      from attendance_days where employee_id = ${employeeId} and date >= ${first} and date < ${next} and date <= ${today} group by status`,
    leaveRequests(tx, employeeId),
    tx<{ id: string; kind: string; from_date: string; to_date: string; status: string; reason: string | null }[]>`
      select id, kind, from_date::text, to_date::text, status, reason from attendance_requests where employee_id = ${employeeId} order by created_at desc limit 10`,
  ]);
  const count = (s: string) => days.find((d) => d.status === s)?.n ?? 0;
  const worked = days.reduce((a, d) => a + d.worked, 0), effective = days.reduce((a, d) => a + d.effective, 0);
  return {
    month: first,
    balances: bal.map((b) => ({ id: b.id, name: b.name, color: b.color, available: Number.isFinite(b.available) ? b.available : null, used: b.used, pending: b.pending, credited: b.credited })),
    summary: {
      present: count("present") + count("on_duty") + count("wfh"), absent: count("absent"), halfDay: count("half_day"), leave: count("leave") + count("half_leave") * 0.5,
      wfh: count("wfh"), offDays: count("weekly_off") + count("holiday"), lateDays: days.reduce((a, d) => a + d.lateDays, 0), lateMinutes: days.reduce((a, d) => a + d.late, 0),
      avgEffectiveMinutes: worked ? Math.round(effective / worked) : 0,
    },
    leaveRequests: leaves.slice(0, 10).map((l) => ({ id: l.id, type: l.type, color: l.color, from: l.from_date, to: l.to_date, days: Number(l.days), status: l.status })),
    attendanceRequests: att,
  };
}

export { EVERYWHERE };

// ---------------------------------------------------------------- Job tab: assigned policies

/** The policies that apply to someone today (self, managers and HR). */
export async function assignedPolicies(tx: Tx, actor: Actor, employeeId: string) {
  if ((await accessTo(tx, actor, employeeId)) === "colleague") return null;
  const today = todayIn();
  const [p] = await tx<Record<string, string | null>[]>`
    select lp.name as leave_plan, coalesce(hl.name, lhl.name) as holiday_list,
      (select s.name from shift_assignments a join shifts s on s.id = a.shift_id where a.employee_id = e.id and a.period @> ${today}::date limit 1) as shift,
      (select w.name from weekly_off_assignments a join weekly_off_policies w on w.id = a.policy_id where a.employee_id = e.id and a.period @> ${today}::date limit 1) as weekly_off,
      cp.name as capture, pp.name as penalty, pg.name as pay_group, pr.name as probation, np.name as notice, ep.name as expense
    from employees e
    left join leave_plans lp on lp.id = e.leave_plan_id left join holiday_lists hl on hl.id = e.holiday_list_id
    left join locations l on l.id = e.location_id left join holiday_lists lhl on lhl.id = l.default_holiday_list_id
    left join capture_policies cp on cp.id = e.capture_policy_id left join penalization_policies pp on pp.id = e.penalization_policy_id
    left join pay_groups pg on pg.id = e.pay_group_id left join probation_policies pr on pr.id = e.probation_policy_id
    left join notice_period_policies np on np.id = e.notice_period_policy_id left join expense_policies ep on ep.id = e.expense_policy_id
    where e.id = ${employeeId}`;
  const groups = await tx<{ type: string; name: string }[]>`select t.name as type, g.name from employee_groups eg join groups g on g.id = eg.group_id join group_types t on t.id = g.group_type_id where eg.employee_id = ${employeeId} order by t.name, g.name`;
  return { ...(p ?? {}), groups };
}
