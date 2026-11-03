import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { audit } from "@/server/modules/audit/service";
import { cancelApproval, notifyEmployee, startApproval, timeline, type Level } from "@/server/modules/approvals/service";
import { addDaysISO, todayIn, type ISODate } from "@/lib/dates";
import { assertBilling, assertPsaAdmin, canAdminPsa, canBill, canSeePsa } from "./access";
import { onTimesheetDecided } from "./effects";
import {
  canMoveInvoice, DEFAULT_POLICY, fmtWeek, formatMinutes, invoiceNumber, isWeekLocked, isWeekStart, timesheetActions, tmLines, totals,
  validateClient, validateGrid, validatePolicy, validateProject, validateSubmit, weekDays,
  type BillingModel, type GridRow, type InvoiceLine, type InvoiceStatus, type Policy, type ProjectStatus, type TimesheetStatus,
} from "./rules";

const uuidOk = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const first = (p: { field: string; message: string }[]) => { if (p.length) throw new AppError("invalid", p[0].message, p[0].field); };

// ---------- policy ----------
export async function policy(tx: Tx): Promise<Policy> {
  const [p] = await tx<Policy[]>`select cadence, min_minutes_per_day, min_minutes_per_week, max_minutes_per_day, lock_after_days, approver, allow_future, require_note from timesheet_policies`;
  return p ?? DEFAULT_POLICY;
}

export async function savePolicy(tx: Tx, actor: Actor, input: Policy) {
  assertPsaAdmin(actor);
  first(validatePolicy(input));
  await tx`insert into timesheet_policies (tenant_id, cadence, min_minutes_per_day, min_minutes_per_week, max_minutes_per_day, lock_after_days, approver, allow_future, require_note)
           values (${actor.tenant.id}, ${input.cadence}, ${input.min_minutes_per_day}, ${input.min_minutes_per_week}, ${input.max_minutes_per_day}, ${input.lock_after_days}, ${input.approver}, ${input.allow_future}, ${input.require_note})
           on conflict (tenant_id) do update set cadence = excluded.cadence, min_minutes_per_day = excluded.min_minutes_per_day, min_minutes_per_week = excluded.min_minutes_per_week,
             max_minutes_per_day = excluded.max_minutes_per_day, lock_after_days = excluded.lock_after_days, approver = excluded.approver, allow_future = excluded.allow_future, require_note = excluded.require_note, updated_at = now()`;
  await audit(tx, actor, { entityType: "timesheet_policy", action: "update", diff: input });
}

// ---------- clients ----------
export type ClientRow = { id: string; name: string; gstin: string | null; currency: string; billing_address: Record<string, string>; projects: number; open_invoices: number };

export async function listClients(tx: Tx, actor: Actor): Promise<ClientRow[]> {
  if (!canSeePsa(actor)) throw new AppError("forbidden", "Clients are for project admins and billing.");
  return tx<ClientRow[]>`
    select c.id, c.name, c.gstin, c.currency, c.billing_address,
      (select count(*)::int from projects p where p.client_id = c.id and p.status <> 'archived') as projects,
      (select count(*)::int from psa_invoices i where i.client_id = c.id and i.status in ('draft','sent')) as open_invoices
    from clients c order by c.name`;
}

export type ClientInput = { name: string; gstin: string | null; currency: string; address: { line1?: string; line2?: string; city?: string; state?: string; pincode?: string; email?: string } };
export async function saveClient(tx: Tx, actor: Actor, id: string | null, input: ClientInput) {
  assertPsaAdmin(actor);
  const name = input.name.trim(), gstin = input.gstin?.trim().toUpperCase() || null;
  first(validateClient({ name, gstin }));
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new AppError("invalid", "Currency is a 3-letter code like INR.", "currency");
  const address = Object.fromEntries(Object.entries(input.address ?? {}).filter(([, v]) => typeof v === "string" && v.trim()).map(([k, v]) => [k, String(v).trim().slice(0, 200)]));
  const [dup] = await tx<{ id: string }[]>`select id from clients where lower(name) = lower(${name}) and id is distinct from ${id}`;
  if (dup) throw new AppError("conflict", "A client with this name already exists.", "name");
  if (id) {
    const [r] = await tx<{ id: string }[]>`update clients set name = ${name}, gstin = ${gstin}, currency = ${input.currency}, billing_address = ${tx.json(address)}, updated_at = now() where id = ${id} returning id`;
    if (!r) throw new AppError("not_found", "Client not found.");
    await audit(tx, actor, { entityType: "client", entityId: id, action: "update", diff: { name } });
    return r;
  }
  const [r] = await tx<{ id: string }[]>`insert into clients (tenant_id, name, gstin, currency, billing_address) values (${actor.tenant.id}, ${name}, ${gstin}, ${input.currency}, ${tx.json(address)}) returning id`;
  await audit(tx, actor, { entityType: "client", entityId: r.id, action: "create", diff: { name } });
  return r;
}

export async function deleteClient(tx: Tx, actor: Actor, id: string) {
  assertPsaAdmin(actor);
  const [{ n }] = await tx<{ n: number }[]>`select (select count(*) from projects where client_id = ${id}) + (select count(*) from psa_invoices where client_id = ${id}) as n`;
  if (Number(n)) throw new AppError("invalid", "This client has projects or invoices, so it can't be deleted.");
  const r = await tx`delete from clients where id = ${id}`;
  if (!r.count) throw new AppError("not_found", "Client not found.");
  await audit(tx, actor, { entityType: "client", entityId: id, action: "delete" });
}

// ---------- projects ----------
export type ProjectRow = {
  id: string; name: string; code: string; client_id: string | null; client: string | null; billing_model: BillingModel; status: ProjectStatus;
  retainer_paise: bigint | null; currency: string; start_date: string | null; end_date: string | null; members: number; logged_minutes: number; approved_minutes: number; uninvoiced_minutes: number;
  budget_minutes: number | null; mine: boolean; approver: boolean;
};

/** Projects the actor may see: admins and billing see all; others see the ones they're on or approve. */
export async function listProjects(tx: Tx, actor: Actor, includeArchived = false): Promise<ProjectRow[]> {
  const all = canSeePsa(actor);
  return tx<ProjectRow[]>`
    select p.id, p.name, p.code, p.client_id, c.name as client, p.billing_model, p.status, p.retainer_paise, p.currency, p.start_date::text, p.end_date::text, p.budget_minutes,
      (select count(*)::int from project_members m where m.project_id = p.id) as members,
      coalesce((select sum(e.minutes)::int from time_entries e where e.project_id = p.id), 0) as logged_minutes,
      coalesce((select sum(e.minutes)::int from time_entries e join timesheets t on t.id = e.timesheet_id where e.project_id = p.id and t.status = 'approved'), 0) as approved_minutes,
      coalesce((select sum(e.minutes)::int from time_entries e join timesheets t on t.id = e.timesheet_id where e.project_id = p.id and t.status = 'approved' and e.is_billable and e.invoice_id is null), 0) as uninvoiced_minutes,
      exists(select 1 from project_members m where m.project_id = p.id and m.employee_id = ${actor.employeeId}) as mine,
      (${actor.employeeId}::uuid = any(p.approver_employee_ids)) as approver
    from projects p left join clients c on c.id = p.client_id
    where (${includeArchived} or p.status <> 'archived')
      and (${all} or exists(select 1 from project_members m where m.project_id = p.id and m.employee_id = ${actor.employeeId}) or ${actor.employeeId}::uuid = any(p.approver_employee_ids))
    order by (p.status = 'active') desc, p.name`;
}

export type ProjectInput = {
  name: string; code: string; clientId: string | null; billingModel: BillingModel; retainerPaise: number | null; currency: string;
  startDate: string | null; endDate: string | null; description: string | null; approverIds: string[]; budgetMinutes: number | null;
};

async function assertPeople(tx: Tx, ids: string[], field: string) {
  if (!ids.length) return;
  if (!ids.every(uuidOk)) throw new AppError("invalid", "Some of the people you picked don't exist.", field);
  const [{ n }] = await tx<{ n: number }[]>`select count(distinct id)::int as n from employees where id = any(${ids}::uuid[]) and status <> 'relieved'`;
  if (n !== new Set(ids).size) throw new AppError("invalid", "Some of the people you picked have left or don't exist.", field);
}

export async function saveProject(tx: Tx, actor: Actor, id: string | null, input: ProjectInput) {
  assertPsaAdmin(actor);
  const name = input.name.trim(), code = input.code.trim().toUpperCase();
  first(validateProject({ name, code, billingModel: input.billingModel, retainerPaise: input.retainerPaise, startDate: input.startDate, endDate: input.endDate, currency: input.currency }));
  if (input.clientId) {
    if (!uuidOk(input.clientId)) throw new AppError("invalid", "Pick a client.", "clientId");
    const [c] = await tx<{ id: string }[]>`select id from clients where id = ${input.clientId}`;
    if (!c) throw new AppError("invalid", "That client doesn't exist.", "clientId");
  } else if (input.billingModel !== "non_billable") throw new AppError("invalid", "Billable projects need a client to invoice.", "clientId");
  const approverIds = [...new Set(input.approverIds)];
  await assertPeople(tx, approverIds, "approverIds");
  if (input.budgetMinutes != null && (!Number.isInteger(input.budgetMinutes) || input.budgetMinutes < 0)) throw new AppError("invalid", "Budget must be a number of hours.", "budgetMinutes");
  const [dup] = await tx<{ id: string }[]>`select id from projects where code = ${code} and id is distinct from ${id}`;
  if (dup) throw new AppError("conflict", "Another project already uses this code.", "code");
  const retainer = input.billingModel === "retainer" ? input.retainerPaise : null;
  const description = input.description?.trim().slice(0, 2000) || null;
  if (id) {
    const [r] = await tx<{ id: string }[]>`update projects set name = ${name}, code = ${code}, client_id = ${input.clientId}, billing_model = ${input.billingModel}, retainer_paise = ${retainer},
      currency = ${input.currency}, start_date = ${input.startDate}, end_date = ${input.endDate}, description = ${description}, approver_employee_ids = ${approverIds}::uuid[], budget_minutes = ${input.budgetMinutes}, updated_at = now()
      where id = ${id} returning id`;
    if (!r) throw new AppError("not_found", "Project not found.");
    await audit(tx, actor, { entityType: "project", entityId: id, action: "update", diff: { name, code, billing_model: input.billingModel } });
    return r;
  }
  const [r] = await tx<{ id: string }[]>`insert into projects (tenant_id, name, code, client_id, billing_model, retainer_paise, currency, start_date, end_date, description, approver_employee_ids, budget_minutes, created_by)
    values (${actor.tenant.id}, ${name}, ${code}, ${input.clientId}, ${input.billingModel}, ${retainer}, ${input.currency}, ${input.startDate}, ${input.endDate}, ${description}, ${approverIds}::uuid[], ${input.budgetMinutes}, ${actor.userId}) returning id`;
  await audit(tx, actor, { entityType: "project", entityId: r.id, action: "create", diff: { name, code, billing_model: input.billingModel } });
  return r;
}

export async function setProjectStatus(tx: Tx, actor: Actor, id: string, status: ProjectStatus) {
  assertPsaAdmin(actor);
  const [r] = await tx<{ id: string }[]>`update projects set status = ${status}, updated_at = now() where id = ${id} returning id`;
  if (!r) throw new AppError("not_found", "Project not found.");
  await audit(tx, actor, { entityType: "project", entityId: id, action: "status", diff: { status } });
}

export type Member = { employee_id: string; name: string; title: string | null; role: string | null; bill_rate_paise: bigint | null; allocation_pct: number | null; logged_minutes: number };
export type Task = { id: string; name: string; is_billable: boolean; phase: string | null; start_date: string | null; end_date: string | null; logged_minutes: number };
export type Milestone = { id: string; name: string; phase: string | null; due_date: string | null; amount_paise: bigint; status: "planned" | "done"; done_at: string | null; invoice_id: string | null; invoice_number: string | null; position: number };
export type ProjectDetail = {
  project: ProjectRow & { description: string | null; approver_employee_ids: string[]; approvers: { id: string; name: string }[]; invoiced_paise: bigint };
  members: Member[]; tasks: Task[]; milestones: Milestone[]; canEdit: boolean; canBill: boolean;
};

export async function projectDetail(tx: Tx, actor: Actor, id: string): Promise<ProjectDetail | null> {
  const [project] = (await listProjects(tx, actor, true)).filter((p) => p.id === id);
  if (!project) return null;
  const [extra] = await tx<{ description: string | null; approver_employee_ids: string[]; invoiced_paise: bigint }[]>`
    select p.description, p.approver_employee_ids, coalesce((select sum(i.subtotal_paise + i.tax_paise) from psa_invoices i where i.project_id = p.id and i.status <> 'void'), 0)::bigint as invoiced_paise from projects p where p.id = ${id}`;
  const [approvers, members, tasks, milestones] = await Promise.all([
    extra.approver_employee_ids.length ? tx<{ id: string; name: string }[]>`select id, display_name as name from employees where id = any(${extra.approver_employee_ids}::uuid[]) order by display_name` : Promise.resolve([]),
    tx<Member[]>`select m.employee_id, e.display_name as name, d.title, m.role, m.bill_rate_paise, m.allocation_pct,
        coalesce((select sum(t.minutes)::int from time_entries t join timesheets s on s.id = t.timesheet_id where t.project_id = m.project_id and s.employee_id = m.employee_id), 0) as logged_minutes
      from project_members m join employees e on e.id = m.employee_id left join designations d on d.id = e.designation_id where m.project_id = ${id} order by e.display_name`,
    tx<Task[]>`select t.id, t.name, t.is_billable, t.phase, t.start_date::text, t.end_date::text, coalesce((select sum(e.minutes)::int from time_entries e where e.task_id = t.id), 0) as logged_minutes
      from project_tasks t where t.project_id = ${id} order by t.phase nulls last, t.created_at`,
    tx<Milestone[]>`select m.id, m.name, m.phase, m.due_date::text, m.amount_paise, m.status, m.done_at::text, m.invoice_id, i.number as invoice_number, m.position
      from project_milestones m left join psa_invoices i on i.id = m.invoice_id where m.project_id = ${id} order by m.position, m.created_at`,
  ]);
  return { project: { ...project, ...extra, approvers }, members, tasks, milestones, canEdit: canAdminPsa(actor), canBill: canBill(actor) };
}

export async function saveMember(tx: Tx, actor: Actor, projectId: string, input: { employeeId: string; role: string | null; billRatePaise: number | null; allocationPct: number | null }) {
  assertPsaAdmin(actor);
  await assertPeople(tx, [input.employeeId], "employeeId");
  if (input.billRatePaise != null && (!Number.isInteger(input.billRatePaise) || input.billRatePaise < 0)) throw new AppError("invalid", "The bill rate must be an amount per hour.", "billRatePaise");
  if (input.allocationPct != null && (!Number.isInteger(input.allocationPct) || input.allocationPct < 0 || input.allocationPct > 100)) throw new AppError("invalid", "Allocation is 0–100%.", "allocationPct");
  const [p] = await tx<{ id: string }[]>`select id from projects where id = ${projectId}`;
  if (!p) throw new AppError("not_found", "Project not found.");
  await tx`insert into project_members (project_id, employee_id, tenant_id, role, bill_rate_paise, allocation_pct) values (${projectId}, ${input.employeeId}, ${actor.tenant.id}, ${input.role?.trim().slice(0, 80) || null}, ${input.billRatePaise}, ${input.allocationPct})
           on conflict (project_id, employee_id) do update set role = excluded.role, bill_rate_paise = excluded.bill_rate_paise, allocation_pct = excluded.allocation_pct`;
  await audit(tx, actor, { entityType: "project", entityId: projectId, action: "member.save", diff: { employeeId: input.employeeId, bill_rate_paise: input.billRatePaise, allocation_pct: input.allocationPct } });
}

export async function removeMember(tx: Tx, actor: Actor, projectId: string, employeeId: string) {
  assertPsaAdmin(actor);
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from time_entries e join timesheets t on t.id = e.timesheet_id where e.project_id = ${projectId} and t.employee_id = ${employeeId}`;
  if (n) throw new AppError("invalid", "This person has logged time on the project, so they can't be removed. Set their allocation to 0 instead.");
  const r = await tx`delete from project_members where project_id = ${projectId} and employee_id = ${employeeId}`;
  if (!r.count) throw new AppError("not_found", "Not on this project.");
  await audit(tx, actor, { entityType: "project", entityId: projectId, action: "member.remove", diff: { employeeId } });
}

export async function saveTask(tx: Tx, actor: Actor, projectId: string, id: string | null, input: { name: string; isBillable: boolean; phase: string | null; startDate: string | null; endDate: string | null }) {
  assertPsaAdmin(actor);
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new AppError("invalid", "Give the task a name.", "name");
  if (input.startDate && input.endDate && input.endDate < input.startDate) throw new AppError("invalid", "The end date can't be before the start.", "endDate");
  const [p] = await tx<{ id: string; billing_model: BillingModel }[]>`select id, billing_model from projects where id = ${projectId}`;
  if (!p) throw new AppError("not_found", "Project not found.");
  const billable = p.billing_model !== "non_billable" && input.isBillable;
  const phase = input.phase?.trim().slice(0, 80) || null;
  if (id) {
    const [r] = await tx<{ id: string }[]>`update project_tasks set name = ${name}, is_billable = ${billable}, phase = ${phase}, start_date = ${input.startDate}, end_date = ${input.endDate}, updated_at = now() where id = ${id} and project_id = ${projectId} returning id`;
    if (!r) throw new AppError("not_found", "Task not found.");
    return r;
  }
  const [r] = await tx<{ id: string }[]>`insert into project_tasks (tenant_id, project_id, name, is_billable, phase, start_date, end_date) values (${actor.tenant.id}, ${projectId}, ${name}, ${billable}, ${phase}, ${input.startDate}, ${input.endDate}) returning id`;
  return r;
}

export async function deleteTask(tx: Tx, actor: Actor, projectId: string, id: string) {
  assertPsaAdmin(actor);
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from time_entries where task_id = ${id}`;
  if (n) throw new AppError("invalid", "Time has been logged on this task, so it can't be deleted.");
  const r = await tx`delete from project_tasks where id = ${id} and project_id = ${projectId}`;
  if (!r.count) throw new AppError("not_found", "Task not found.");
}

export async function saveMilestone(tx: Tx, actor: Actor, projectId: string, id: string | null, input: { name: string; phase: string | null; dueDate: string | null; amountPaise: number; status: "planned" | "done" }) {
  assertPsaAdmin(actor);
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new AppError("invalid", "Give the milestone a name.", "name");
  if (!Number.isInteger(input.amountPaise) || input.amountPaise < 0) throw new AppError("invalid", "Amount must be zero or more.", "amountPaise");
  const [p] = await tx<{ id: string }[]>`select id from projects where id = ${projectId}`;
  if (!p) throw new AppError("not_found", "Project not found.");
  const phase = input.phase?.trim().slice(0, 80) || null;
  const doneAt = input.status === "done" ? todayIn() : null;
  if (id) {
    const [cur] = await tx<{ invoice_id: string | null; status: string; done_at: string | null }[]>`select invoice_id, status, done_at::text from project_milestones where id = ${id} and project_id = ${projectId}`;
    if (!cur) throw new AppError("not_found", "Milestone not found.");
    if (cur.invoice_id) throw new AppError("invalid", "This milestone is on an invoice and can't be changed.");
    await tx`update project_milestones set name = ${name}, phase = ${phase}, due_date = ${input.dueDate}, amount_paise = ${input.amountPaise}, status = ${input.status},
             done_at = ${input.status === "done" ? (cur.status === "done" ? cur.done_at : doneAt) : null}, updated_at = now() where id = ${id}`;
    return { id };
  }
  const [{ pos }] = await tx<{ pos: number }[]>`select coalesce(max(position), 0) + 1 as pos from project_milestones where project_id = ${projectId}`;
  const [r] = await tx<{ id: string }[]>`insert into project_milestones (tenant_id, project_id, name, phase, due_date, amount_paise, status, done_at, position)
    values (${actor.tenant.id}, ${projectId}, ${name}, ${phase}, ${input.dueDate}, ${input.amountPaise}, ${input.status}, ${doneAt}, ${pos}) returning id`;
  return r;
}

export async function deleteMilestone(tx: Tx, actor: Actor, projectId: string, id: string) {
  assertPsaAdmin(actor);
  const r = await tx`delete from project_milestones where id = ${id} and project_id = ${projectId} and invoice_id is null`;
  if (!r.count) throw new AppError("not_found", "Milestone not found, or it's already invoiced.");
}

/** People who could be added to a project (active, with a name). */
export async function people(tx: Tx) {
  return tx<{ id: string; name: string; title: string | null; department: string | null }[]>`
    select e.id, e.display_name as name, d.title, dp.name as department from employees e left join designations d on d.id = e.designation_id
    left join departments dp on dp.id = e.department_id where e.status <> 'relieved' order by e.display_name`;
}

// ---------- my timesheet ----------
export type WeekProject = { id: string; name: string; code: string; billable: boolean; tasks: { id: string; name: string; is_billable: boolean }[] };
export type WeekView = {
  weekStart: ISODate; days: ISODate[]; status: TimesheetStatus | null; timesheetId: string | null; rows: GridRow[]; projects: WeekProject[];
  locked: boolean; actions: ReturnType<typeof timesheetActions>; policy: Policy; comment: string | null; submittedAt: string | null; invoiced: boolean;
  steps: { level: number; status: string; approver: string; title: string | null; comment: string | null; acted_at: string | null }[];
};

async function assignableProjects(tx: Tx, employeeId: string): Promise<WeekProject[]> {
  const rows = await tx<{ id: string; name: string; code: string; billing_model: BillingModel; tasks: { id: string; name: string; is_billable: boolean }[] | null }[]>`
    select p.id, p.name, p.code, p.billing_model,
      (select json_agg(json_build_object('id', t.id, 'name', t.name, 'is_billable', t.is_billable) order by t.phase nulls last, t.created_at) from project_tasks t where t.project_id = p.id) as tasks
    from projects p join project_members m on m.project_id = p.id and m.employee_id = ${employeeId}
    where p.status = 'active' order by p.name`;
  return rows.map((r) => ({ id: r.id, name: r.name, code: r.code, billable: r.billing_model !== "non_billable", tasks: r.tasks ?? [] }));
}

async function rowsFor(tx: Tx, timesheetId: string, weekStart: ISODate): Promise<GridRow[]> {
  const days = weekDays(weekStart);
  const entries = await tx<{ project_id: string; task_id: string | null; date: string; minutes: number; is_billable: boolean; note: string | null }[]>`
    select project_id, task_id, date::text, minutes, is_billable, note from time_entries where timesheet_id = ${timesheetId} order by created_at`;
  const rows = new Map<string, GridRow>();
  for (const e of entries) {
    const key = `${e.project_id}:${e.task_id ?? ""}`;
    const row = rows.get(key) ?? { projectId: e.project_id, taskId: e.task_id, billable: e.is_billable, note: e.note ?? "", minutes: [0, 0, 0, 0, 0, 0, 0] };
    const d = days.indexOf(e.date);
    if (d >= 0) row.minutes[d] += e.minutes;
    if (e.note && !row.note) row.note = e.note;
    rows.set(key, row);
  }
  return [...rows.values()];
}

export async function myWeek(tx: Tx, actor: Actor, weekStart: ISODate, today = todayIn()): Promise<WeekView> {
  if (!isWeekStart(weekStart)) throw new AppError("invalid", "Weeks start on a Monday.");
  const pol = await policy(tx);
  const [ts] = await tx<{ id: string; status: TimesheetStatus; decision_comment: string | null; submitted_at: Date | null; invoiced: boolean }[]>`
    select t.id, t.status, t.decision_comment, t.submitted_at, exists(select 1 from time_entries e where e.timesheet_id = t.id and e.invoice_id is not null) as invoiced
    from timesheets t where t.employee_id = ${actor.employeeId} and t.week_start = ${weekStart}`;
  const [projects, rows, steps] = await Promise.all([assignableProjects(tx, actor.employeeId), ts ? rowsFor(tx, ts.id, weekStart) : Promise.resolve([]), ts ? timeline(tx, "timesheet", ts.id) : Promise.resolve([])]);
  const locked = isWeekLocked(weekStart, today, pol.lock_after_days);
  return {
    weekStart, days: weekDays(weekStart), status: ts?.status ?? null, timesheetId: ts?.id ?? null, rows, projects, locked, policy: pol,
    actions: timesheetActions({ status: ts?.status ?? "draft", locked, invoiced: ts?.invoiced ?? false }, { owner: true, admin: canAdminPsa(actor) }),
    comment: ts?.decision_comment ?? null, submittedAt: ts?.submitted_at?.toISOString() ?? null, invoiced: ts?.invoiced ?? false,
    steps: steps.map((s) => ({ level: s.level, status: s.status, approver: s.approver, title: s.title, comment: s.comment, acted_at: s.acted_at?.toISOString() ?? null })),
  };
}

async function writeWeek(tx: Tx, actor: Actor, weekStart: ISODate, rows: GridRow[], today: ISODate) {
  if (!isWeekStart(weekStart)) throw new AppError("invalid", "Weeks start on a Monday.");
  const pol = await policy(tx);
  if (isWeekLocked(weekStart, today, pol.lock_after_days)) throw new AppError("invalid", "This week is locked and can't be changed any more.");
  const clean: GridRow[] = rows.map((r) => ({ projectId: r.projectId, taskId: r.taskId || null, billable: !!r.billable, note: (r.note ?? "").trim(), minutes: r.minutes.map((m) => Number(m) || 0) }))
    .filter((r) => r.minutes.some((m) => m > 0) || r.note);
  first(validateGrid(clean, pol, { weekStart, today }));
  const projects = await assignableProjects(tx, actor.employeeId);
  for (const r of clean) {
    const p = projects.find((x) => x.id === r.projectId);
    if (!p) throw new AppError("invalid", "You're not on one of these projects any more. Remove that row.", "rows");
    if (r.taskId && !p.tasks.some((t) => t.id === r.taskId)) throw new AppError("invalid", "That task isn't on this project.", "rows");
    if (!p.billable) r.billable = false;
  }
  const [ts] = await tx<{ id: string; status: TimesheetStatus }[]>`
    insert into timesheets (tenant_id, employee_id, week_start) values (${actor.tenant.id}, ${actor.employeeId}, ${weekStart})
    on conflict (employee_id, week_start) do update set updated_at = now() returning id, status`;
  if (ts.status === "submitted" || ts.status === "approved") throw new AppError("conflict", ts.status === "approved" ? "This week is approved and can't be edited." : "Withdraw the submission before editing.");
  await tx`delete from time_entries where timesheet_id = ${ts.id}`;
  const days = weekDays(weekStart);
  let total = 0, billable = 0;
  for (const r of clean) {
    for (let d = 0; d < 7; d++) {
      if (r.minutes[d] <= 0) continue;
      total += r.minutes[d]; if (r.billable) billable += r.minutes[d];
      await tx`insert into time_entries (tenant_id, timesheet_id, project_id, task_id, date, minutes, is_billable, note)
               values (${actor.tenant.id}, ${ts.id}, ${r.projectId}, ${r.taskId}, ${days[d]}, ${r.minutes[d]}, ${r.billable}, ${r.note || null})`;
    }
  }
  await tx`update timesheets set total_minutes = ${total}, billable_minutes = ${billable}, status = 'draft', decision_comment = null, updated_at = now() where id = ${ts.id}`;
  return { id: ts.id, rows: clean, policy: pol, total };
}

export async function saveWeek(tx: Tx, actor: Actor, weekStart: ISODate, rows: GridRow[], today = todayIn()) {
  const r = await writeWeek(tx, actor, weekStart, rows, today);
  await audit(tx, actor, { entityType: "timesheet", entityId: r.id, action: "save", diff: { week_start: weekStart, total_minutes: r.total } });
  return { id: r.id };
}

export async function submitWeek(tx: Tx, actor: Actor, weekStart: ISODate, rows: GridRow[], today = todayIn()) {
  const w = await writeWeek(tx, actor, weekStart, rows, today);
  first(validateSubmit(w.rows, w.policy, { weekStart, today }));
  const projectIds = [...new Set(w.rows.map((r) => r.projectId))];
  let levels: Level[] = [{ approver: "manager" }];
  if (w.policy.approver === "project") {
    const ps = await tx<{ approver_employee_ids: string[] }[]>`select approver_employee_ids from projects where id = any(${projectIds}::uuid[])`;
    const approvers = [...new Set(ps.flatMap((p) => p.approver_employee_ids))].filter((id) => id !== actor.employeeId);
    if (approvers.length) levels = approvers.map((id) => ({ approver: "employee" as const, id }));
  }
  await cancelApproval(tx, "timesheet", w.id);
  await tx`delete from approval_requests where entity_type = 'timesheet' and entity_id = ${w.id}`;   // a resubmission starts a fresh chain
  const summary = `${actor.name} · Timesheet · ${fmtWeek(weekStart)} · ${formatMinutes(w.total)}`;
  const { status } = await startApproval(tx, { tenantId: actor.tenant.id, entityType: "timesheet", entityId: w.id, requesterId: actor.employeeId, summary, levels });
  await tx`update timesheets set status = 'submitted', submitted_at = now(), decided_at = null, updated_at = now() where id = ${w.id}`;
  if (status === "approved") await onTimesheetDecided(tx, actor, w.id, "approved");
  await audit(tx, actor, { entityType: "timesheet", entityId: w.id, action: "submit", diff: { week_start: weekStart, total_minutes: w.total, auto_approved: status === "approved" } });
  return { id: w.id, status: status === "approved" ? "approved" : "submitted" };
}

export async function withdrawWeek(tx: Tx, actor: Actor, weekStart: ISODate) {
  const [ts] = await tx<{ id: string }[]>`update timesheets set status = 'draft', submitted_at = null, updated_at = now() where employee_id = ${actor.employeeId} and week_start = ${weekStart} and status = 'submitted' returning id`;
  if (!ts) throw new AppError("conflict", "This week isn't waiting for approval.");
  await cancelApproval(tx, "timesheet", ts.id);
  await audit(tx, actor, { entityType: "timesheet", entityId: ts.id, action: "withdraw", diff: { week_start: weekStart } });
}

/** Admins can send an approved (not yet invoiced) week back to draft so it can be corrected. */
export async function reopenTimesheet(tx: Tx, actor: Actor, id: string, reason: string) {
  assertPsaAdmin(actor);
  const [ts] = await tx<{ id: string; employee_id: string; week_start: string; invoiced: boolean }[]>`
    select t.id, t.employee_id, t.week_start::text, exists(select 1 from time_entries e where e.timesheet_id = t.id and e.invoice_id is not null) as invoiced from timesheets t where t.id = ${id} and t.status = 'approved'`;
  if (!ts) throw new AppError("conflict", "Only approved weeks can be reopened.");
  if (ts.invoiced) throw new AppError("invalid", "Hours from this week are on an invoice. Void the invoice first.");
  await tx`update timesheets set status = 'draft', decision_comment = ${reason.trim().slice(0, 500) || null}, decided_at = null, updated_at = now() where id = ${id}`;
  await tx`delete from approval_requests where entity_type = 'timesheet' and entity_id = ${id}`;
  await notifyEmployee(tx, actor.tenant.id, ts.employee_id, "timesheet.reopened", "Your timesheet was reopened", `${fmtWeek(ts.week_start)}: ${reason.trim() || "please review and resubmit"}`, `/me/timesheet?week=${ts.week_start}`);
  await audit(tx, actor, { entityType: "timesheet", entityId: id, action: "reopen", diff: { employeeId: ts.employee_id, reason } });
}

// ---------- approvals (S128) + detail for the inbox ----------
export type TimesheetListRow = {
  id: string; employee_id: string; employee: string; title: string | null; week_start: string; total_minutes: number; billable_minutes: number; status: TimesheetStatus;
  submitted_at: Date | null; step_id: string | null; projects: string[];
};

/** Weeks waiting on the actor (their pending step), plus every submitted week for project admins. */
export async function approvalQueue(tx: Tx, actor: Actor, status: "submitted" | "approved" | "rejected" | "all" = "submitted"): Promise<TimesheetListRow[]> {
  const admin = canAdminPsa(actor);
  return tx<TimesheetListRow[]>`
    select t.id, t.employee_id, e.display_name as employee, d.title, t.week_start::text, t.total_minutes, t.billable_minutes, t.status, t.submitted_at,
      (select s.id from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_type = 'timesheet' and r.entity_id = t.id and s.approver_employee_id = ${actor.employeeId} and s.status = 'pending' limit 1) as step_id,
      coalesce((select array_agg(distinct p.name order by p.name) from time_entries x join projects p on p.id = x.project_id where x.timesheet_id = t.id), '{}') as projects
    from timesheets t join employees e on e.id = t.employee_id left join designations d on d.id = e.designation_id
    where t.employee_id <> ${actor.employeeId}
      and (${status === "all"} or t.status = ${status === "all" ? "submitted" : status})
      and (${admin} or e.manager_id = ${actor.employeeId}
           or exists(select 1 from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_type = 'timesheet' and r.entity_id = t.id and s.approver_employee_id = ${actor.employeeId}))
    order by t.submitted_at desc nulls last, t.week_start desc limit 300`;
}

export type TimesheetDetail = {
  id: string; employee: string; employee_id: string; week_start: string; days: ISODate[]; status: TimesheetStatus; total_minutes: number; billable_minutes: number;
  rows: { project: string; code: string; task: string | null; billable: boolean; note: string; minutes: number[] }[];
  steps: { level: number; status: string; approver: string; title: string | null; comment: string | null; acted_at: string | null }[];
  can: { decide: string | null; reopen: boolean };
};

/** Who may read a week: its owner, their manager, anyone in its approval chain, project admins and billing. */
export async function timesheetDetail(tx: Tx, actor: Actor, id: string): Promise<TimesheetDetail | null> {
  const [ts] = await tx<{ id: string; employee_id: string; employee: string; manager_id: string | null; week_start: string; status: TimesheetStatus; total_minutes: number; billable_minutes: number; in_chain: boolean; step_id: string | null; invoiced: boolean }[]>`
    select t.id, t.employee_id, e.display_name as employee, e.manager_id, t.week_start::text, t.status, t.total_minutes, t.billable_minutes,
      exists(select 1 from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_type = 'timesheet' and r.entity_id = t.id and s.approver_employee_id = ${actor.employeeId}) as in_chain,
      (select s.id from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_type = 'timesheet' and r.entity_id = t.id and s.approver_employee_id = ${actor.employeeId} and s.status = 'pending' limit 1) as step_id,
      exists(select 1 from time_entries x where x.timesheet_id = t.id and x.invoice_id is not null) as invoiced
    from timesheets t join employees e on e.id = t.employee_id where t.id = ${id}`;
  if (!ts) return null;
  const owner = ts.employee_id === actor.employeeId;
  if (!(owner || ts.manager_id === actor.employeeId || ts.in_chain || canSeePsa(actor))) return null;
  const [rows, steps] = await Promise.all([rowsFor(tx, ts.id, ts.week_start), timeline(tx, "timesheet", ts.id)]);
  const ids = [...new Set(rows.map((r) => r.projectId))];
  const projects = ids.length ? await tx<{ id: string; name: string; code: string }[]>`select id, name, code from projects where id = any(${ids}::uuid[])` : [];
  const taskIds = rows.map((r) => r.taskId).filter((x): x is string => !!x);
  const tasks = taskIds.length ? await tx<{ id: string; name: string }[]>`select id, name from project_tasks where id = any(${taskIds}::uuid[])` : [];
  return {
    id: ts.id, employee: ts.employee, employee_id: ts.employee_id, week_start: ts.week_start, days: weekDays(ts.week_start), status: ts.status, total_minutes: ts.total_minutes, billable_minutes: ts.billable_minutes,
    rows: rows.map((r) => { const p = projects.find((x) => x.id === r.projectId); return { project: p?.name ?? "Project", code: p?.code ?? "", task: tasks.find((t) => t.id === r.taskId)?.name ?? null, billable: r.billable, note: r.note, minutes: r.minutes }; }),
    steps: steps.map((s) => ({ level: s.level, status: s.status, approver: s.approver, title: s.title, comment: s.comment, acted_at: s.acted_at?.toISOString() ?? null })),
    can: { decide: owner ? null : ts.step_id, reopen: !owner && canAdminPsa(actor) && ts.status === "approved" && !ts.invoiced },
  };
}

/** The actor's own recent weeks, newest first. */
export async function myWeeks(tx: Tx, actor: Actor, limit = 12) {
  return tx<{ id: string; week_start: string; status: TimesheetStatus; total_minutes: number; billable_minutes: number }[]>`
    select id, week_start::text, status, total_minutes, billable_minutes from timesheets where employee_id = ${actor.employeeId} order by week_start desc limit ${limit}`;
}

export async function pendingForMe(tx: Tx, actor: Actor) {
  const [{ n }] = await tx<{ n: number }[]>`
    select count(*)::int as n from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_type = 'timesheet' and s.approver_employee_id = ${actor.employeeId} and s.status = 'pending'`;
  return n;
}

// ---------- invoices ----------
export type InvoiceRow = {
  id: string; number: string; client_id: string; client: string; project_id: string | null; project: string | null; period_from: string; period_to: string;
  subtotal_paise: bigint; tax_paise: bigint; tax_rate_bp: number; currency: string; status: InvoiceStatus; issued_on: string | null; due_on: string | null; paid_on: string | null; created_at: Date;
};

export async function listInvoices(tx: Tx, actor: Actor): Promise<InvoiceRow[]> {
  if (!canSeePsa(actor)) throw new AppError("forbidden", "Invoices are for billing and project admins.");
  return tx<InvoiceRow[]>`
    select i.id, i.number, i.client_id, c.name as client, i.project_id, p.name as project, lower(i.period)::text as period_from, (upper(i.period) - 1)::text as period_to,
      i.subtotal_paise, i.tax_paise, i.tax_rate_bp, i.currency, i.status, i.issued_on::text, i.due_on::text, i.paid_on::text, i.created_at
    from psa_invoices i join clients c on c.id = i.client_id left join projects p on p.id = i.project_id order by i.created_at desc limit 500`;
}

export type InvoiceCandidate = {
  project: { id: string; name: string; code: string; billing_model: BillingModel; retainer_paise: bigint | null; currency: string; client: string };
  entries: { employee_id: string; employee: string; minutes: number; bill_rate_paise: number | null }[];
  milestones: { id: string; name: string; amount_paise: bigint; done_at: string | null }[];
  preview: { lines: InvoiceLine[]; missingRates: string[]; subtotal: number; tax: number; total: number };
};

/** What an invoice for this project and period would contain. */
export async function invoiceCandidate(tx: Tx, actor: Actor, projectId: string, from: ISODate, to: ISODate, taxRateBp = 1800, milestoneIds: string[] = []): Promise<InvoiceCandidate> {
  assertBilling(actor);
  if (to < from) throw new AppError("invalid", "The period end is before its start.", "to");
  const [project] = await tx<InvoiceCandidate["project"][]>`select p.id, p.name, p.code, p.billing_model, p.retainer_paise, p.currency, c.name as client from projects p join clients c on c.id = p.client_id where p.id = ${projectId}`;
  if (!project) throw new AppError("not_found", "Project not found, or it has no client.");
  if (project.billing_model === "non_billable") throw new AppError("invalid", "This project isn't billable.");
  const entries = project.billing_model === "time_and_materials" ? await tx<InvoiceCandidate["entries"][number][]>`
    select t.employee_id, e.display_name as employee, sum(x.minutes)::int as minutes, (select m.bill_rate_paise from project_members m where m.project_id = x.project_id and m.employee_id = t.employee_id)::int as bill_rate_paise
    from time_entries x join timesheets t on t.id = x.timesheet_id join employees e on e.id = t.employee_id
    where x.project_id = ${projectId} and x.is_billable and x.invoice_id is null and t.status = 'approved' and x.date between ${from} and ${to}
    group by t.employee_id, e.display_name, x.project_id order by e.display_name` : [];
  const milestones = project.billing_model === "fixed" ? await tx<InvoiceCandidate["milestones"][number][]>`
    select id, name, amount_paise, done_at::text from project_milestones where project_id = ${projectId} and status = 'done' and invoice_id is null order by position` : [];
  let lines: InvoiceLine[] = [], missingRates: string[] = [];
  if (project.billing_model === "time_and_materials") ({ lines, missingRates } = tmLines(entries));
  else if (project.billing_model === "retainer") lines = [{ description: `Retainer · ${project.name} · ${from} to ${to}`, quantity: 1, unit_paise: Number(project.retainer_paise ?? 0), amount_paise: Number(project.retainer_paise ?? 0) }];
  else lines = milestones.filter((m) => !milestoneIds.length || milestoneIds.includes(m.id)).map((m) => ({ description: `Milestone · ${m.name}`, quantity: 1, unit_paise: Number(m.amount_paise), amount_paise: Number(m.amount_paise), milestone_id: m.id }));
  return { project, entries, milestones, preview: { lines, missingRates, ...totals(lines, taxRateBp) } };
}

export async function createInvoice(tx: Tx, actor: Actor, input: { projectId: string; from: ISODate; to: ISODate; taxRateBp: number; milestoneIds: string[]; notes: string | null; dueInDays: number }) {
  assertBilling(actor);
  if (!Number.isInteger(input.taxRateBp) || input.taxRateBp < 0 || input.taxRateBp > 10000) throw new AppError("invalid", "GST rate must be 0–100%.", "taxRateBp");
  const c = await invoiceCandidate(tx, actor, input.projectId, input.from, input.to, input.taxRateBp, input.milestoneIds);
  if (!c.preview.lines.length || c.preview.subtotal <= 0) throw new AppError("invalid", "There's nothing to invoice for this period.");
  const [{ value }] = await tx<{ value: string }[]>`insert into counters (tenant_id, key, value) values (${actor.tenant.id}, 'psa_invoice', 1) on conflict (tenant_id, key) do update set value = counters.value + 1 returning value`;
  const number = invoiceNumber(Number(value));
  const today = todayIn();
  const [client] = await tx<{ client_id: string }[]>`select client_id from projects where id = ${input.projectId}`;
  const [inv] = await tx<{ id: string }[]>`
    insert into psa_invoices (tenant_id, client_id, project_id, number, period, lines, subtotal_paise, tax_paise, tax_rate_bp, currency, status, issued_on, due_on, notes, created_by)
    values (${actor.tenant.id}, ${client.client_id}, ${input.projectId}, ${number}, daterange(${input.from}, ${input.to}, '[]'), ${tx.json(c.preview.lines as never)}, ${c.preview.subtotal}, ${c.preview.tax}, ${input.taxRateBp},
      ${c.project.currency}, 'draft', ${today}, ${addDaysISO(today, Math.max(0, Math.min(180, input.dueInDays || 0)))}, ${input.notes?.trim().slice(0, 1000) || null}, ${actor.userId}) returning id`;
  if (c.project.billing_model === "time_and_materials") {
    await tx`update time_entries x set invoice_id = ${inv.id} from timesheets t where t.id = x.timesheet_id and x.project_id = ${input.projectId} and x.is_billable and x.invoice_id is null and t.status = 'approved' and x.date between ${input.from} and ${input.to}`;
  }
  if (c.project.billing_model === "fixed") {
    const ids = c.preview.lines.map((l) => l.milestone_id!).filter(Boolean);
    await tx`update project_milestones set invoice_id = ${inv.id} where id = any(${ids}::uuid[]) and invoice_id is null`;
  }
  await audit(tx, actor, { entityType: "psa_invoice", entityId: inv.id, action: "create", diff: { number, project_id: input.projectId, subtotal_paise: c.preview.subtotal, tax_paise: c.preview.tax } });
  return { id: inv.id, number };
}

export async function setInvoiceStatus(tx: Tx, actor: Actor, id: string, to: InvoiceStatus) {
  assertBilling(actor);
  const [inv] = await tx<{ status: InvoiceStatus; number: string }[]>`select status, number from psa_invoices where id = ${id} for update`;
  if (!inv) throw new AppError("not_found", "Invoice not found.");
  if (!canMoveInvoice(inv.status, to)) throw new AppError("conflict", `A ${inv.status} invoice can't be marked ${to}.`);
  await tx`update psa_invoices set status = ${to}, paid_on = ${to === "paid" ? todayIn() : null}, updated_at = now() where id = ${id}`;
  if (to === "void") {
    await tx`update time_entries set invoice_id = null where invoice_id = ${id}`;
    await tx`update project_milestones set invoice_id = null where invoice_id = ${id}`;
  }
  await audit(tx, actor, { entityType: "psa_invoice", entityId: id, action: "status", diff: { from: inv.status, to, number: inv.number } });
}

export type InvoiceDetail = InvoiceRow & { lines: InvoiceLine[]; notes: string | null; client_gstin: string | null; client_address: Record<string, string>; company: string; company_gstin: string | null; company_address: Record<string, string> };

export async function invoiceDetail(tx: Tx, actor: Actor, id: string): Promise<InvoiceDetail | null> {
  if (!canSeePsa(actor)) return null;
  const [i] = await tx<InvoiceDetail[]>`
    select i.id, i.number, i.client_id, c.name as client, c.gstin as client_gstin, c.billing_address as client_address, i.project_id, p.name as project, lower(i.period)::text as period_from, (upper(i.period) - 1)::text as period_to,
      i.subtotal_paise, i.tax_paise, i.tax_rate_bp, i.currency, i.status, i.issued_on::text, i.due_on::text, i.paid_on::text, i.created_at, i.lines, i.notes,
      coalesce(le.name, (select name from tenants where id = i.tenant_id)) as company, le.gstin as company_gstin, coalesce(le.address, '{}') as company_address
    from psa_invoices i join clients c on c.id = i.client_id left join projects p on p.id = i.project_id
    left join legal_entities le on le.id = (select id from legal_entities order by created_at limit 1)
    where i.id = ${id}`;
  return i ?? null;
}
