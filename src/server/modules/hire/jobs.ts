import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { cancelApproval, notifyEmployee, startApproval, timeline, type Level } from "@/server/modules/approvals/service";
import { sanitizeHtml } from "@/server/modules/documents/rules";
import { assertJobAct, assertJobSee, canAdminHire, canRecruit, jobAccess, visibleJobIds, HIRE_ADMIN } from "./access";
import { audit } from "./setup";
import { GROUP_ORDER, JOB_TYPES, jobNext, reqCan, TEAM_ROLES, textToHtml, type JobAction, type StageGroup, type TeamRole } from "./rules";
import { canFor } from "@/server/auth/permissions";

const N = (v: bigint | number | string | null | undefined) => (v == null ? null : Number(v));

async function checkOrg(tx: Tx, input: { departmentId?: string | null; locationId?: string | null }) {
  if (input.departmentId) { const [d] = await tx`select 1 from departments where id = ${input.departmentId}`; if (!d) throw new AppError("invalid", "Pick a department.", "departmentId"); }
  if (input.locationId) { const [l] = await tx`select 1 from locations where id = ${input.locationId}`; if (!l) throw new AppError("invalid", "Pick a location.", "locationId"); }
}

function checkRanges(i: { openings: number; experienceMin?: number | null; experienceMax?: number | null; salaryMinPaise?: number | null; salaryMaxPaise?: number | null; targetDate?: string | null; jobType: string }) {
  if (!Number.isInteger(i.openings) || i.openings < 1 || i.openings > 500) throw new AppError("invalid", "Openings must be between 1 and 500.", "openings");
  if (!JOB_TYPES.some((t) => t.value === i.jobType)) throw new AppError("invalid", "Pick the type of job.", "jobType");
  for (const [k, v] of [["experienceMin", i.experienceMin], ["experienceMax", i.experienceMax]] as const) {
    if (v != null && (!Number.isInteger(v) || v < 0 || v > 50)) throw new AppError("invalid", "Experience is in whole years from 0 to 50.", k);
  }
  if (i.experienceMin != null && i.experienceMax != null && i.experienceMax < i.experienceMin) throw new AppError("invalid", "The most experience can't be below the least.", "experienceMax");
  for (const [k, v] of [["salaryMinPaise", i.salaryMinPaise], ["salaryMaxPaise", i.salaryMaxPaise]] as const) {
    if (v != null && (!Number.isInteger(v) || v < 0 || v > 1e13)) throw new AppError("invalid", "Enter the salary in rupees.", k);
  }
  if (i.salaryMinPaise != null && i.salaryMaxPaise != null && i.salaryMaxPaise < i.salaryMinPaise) throw new AppError("invalid", "The top of the range can't be below the bottom.", "salaryMaxPaise");
  if (i.targetDate && !/^\d{4}-\d{2}-\d{2}$/.test(i.targetDate)) throw new AppError("invalid", "Pick a target date.", "targetDate");
}

// ============================== requisitions ==============================
export type ReqRow = {
  id: string; title: string; openings: number; job_type: string; department: string | null; location: string | null; status: string;
  target_date: string | null; raised_by: string; raised_by_id: string; backfill_for: string | null; created_at: Date; job_id: string | null;
  salary_min_paise: number | null; salary_max_paise: number | null; description: string | null; qualification: string | null;
  experience_min: number | null; experience_max: number | null; department_id: string | null; location_id: string | null; backfill_for_employee_id: string | null;
};

const reqSelect = (tx: Tx) => tx`
  select r.id, r.title, r.openings, r.job_type, d.name as department, l.name as location, r.status, r.target_date::text, e.display_name as raised_by,
    r.raised_by_employee_id as raised_by_id, b.display_name as backfill_for, r.created_at, (select j.id from jobs j where j.requisition_id = r.id limit 1) as job_id,
    r.salary_min_paise, r.salary_max_paise, r.description, r.qualification, r.experience_min, r.experience_max, r.department_id, r.location_id, r.backfill_for_employee_id
  from requisitions r join employees e on e.id = r.raised_by_employee_id left join departments d on d.id = r.department_id
  left join locations l on l.id = r.location_id left join employees b on b.id = r.backfill_for_employee_id`;

/** Who may raise a requisition: people managers, recruiters and hiring admins. */
export async function canRaise(tx: Tx, actor: Actor) {
  if (canRecruit(actor)) return true;
  const [r] = await tx`select 1 from employees where manager_id = ${actor.employeeId} and status <> 'relieved' limit 1`;
  return !!r;
}

export async function listRequisitions(tx: Tx, actor: Actor) {
  const all = canRecruit(actor);
  const rows = (await tx<ReqRow[]>`${reqSelect(tx)} where ${all} or r.raised_by_employee_id = ${actor.employeeId} order by r.created_at desc`).map((r) => ({ ...r, salary_min_paise: N(r.salary_min_paise), salary_max_paise: N(r.salary_max_paise) }));
  return rows;
}

export async function requisitionDetail(tx: Tx, actor: Actor, id: string) {
  const [r] = await tx<ReqRow[]>`${reqSelect(tx)} where r.id = ${id}`;
  if (!r) throw new AppError("not_found", "Requisition not found.");
  const [approver] = await tx`select 1 from approval_requests q join approval_steps s on s.request_id = q.id where q.entity_type = 'requisition' and q.entity_id = ${id} and s.approver_employee_id = ${actor.employeeId}`;
  if (!canRecruit(actor) && r.raised_by_id !== actor.employeeId && !approver) throw new AppError("not_found", "Requisition not found.");
  return { requisition: { ...r, salary_min_paise: N(r.salary_min_paise), salary_max_paise: N(r.salary_max_paise) }, steps: await timeline(tx, "requisition", id) };
}

/** People leaving (or who left in the last six months) with no requisition to replace them yet. */
export async function backfillCandidates(tx: Tx) {
  return tx<{ employee_id: string; name: string; designation: string | null; department_id: string | null; location_id: string | null; last_working_date: string; status: string }[]>`
    select x.employee_id, e.display_name as name, d.title as designation, e.department_id, e.location_id, x.last_working_date::text, x.status
    from exit_requests x join employees e on e.id = x.employee_id left join designations d on d.id = e.designation_id
    where (x.status in ('under_review','in_progress') or (x.status = 'exited' and x.last_working_date >= current_date - 180))
      and not exists (select 1 from requisitions r where r.backfill_for_employee_id = x.employee_id and r.status not in ('rejected','closed'))
    order by x.last_working_date`;
}

export type ReqInput = {
  title: string; openings: number; jobType: string; departmentId: string | null; locationId: string | null; salaryMinPaise: number | null; salaryMaxPaise: number | null;
  targetDate: string | null; description: string | null; qualification: string | null; experienceMin: number | null; experienceMax: number | null; backfillForId: string | null;
};

export async function saveRequisition(tx: Tx, actor: Actor, id: string | null, input: ReqInput) {
  if (!(await canRaise(tx, actor))) throw new AppError("forbidden", "Only managers and recruiters can raise requisitions.");
  const title = input.title.trim().slice(0, 120);
  if (!title) throw new AppError("invalid", "What's the position called?", "title");
  checkRanges({ ...input, jobType: input.jobType });
  await checkOrg(tx, input);
  if (input.backfillForId) {
    const [b] = await tx`select 1 from employees where id = ${input.backfillForId}`;
    if (!b) throw new AppError("invalid", "Pick the person this replaces.", "backfillForId");
    if (input.backfillForId === actor.employeeId) throw new AppError("invalid", "You can't raise a backfill for yourself.", "backfillForId");
  }
  const v = {
    title, openings: input.openings, job_type: input.jobType, department_id: input.departmentId, location_id: input.locationId,
    salary_min_paise: input.salaryMinPaise, salary_max_paise: input.salaryMaxPaise, target_date: input.targetDate || null,
    description: input.description?.trim().slice(0, 5000) || null, qualification: input.qualification?.trim().slice(0, 1000) || null,
    experience_min: input.experienceMin, experience_max: input.experienceMax, backfill_for_employee_id: input.backfillForId,
  };
  if (id) {
    const [r] = await tx<{ status: string; raised_by_employee_id: string }[]>`select status, raised_by_employee_id from requisitions where id = ${id} for update`;
    if (!r || r.raised_by_employee_id !== actor.employeeId) throw new AppError("not_found", "Requisition not found.");
    if (!reqCan(r.status, "edit")) throw new AppError("conflict", "This requisition was already sent for approval.");
    await tx`update requisitions set ${tx(v)} where id = ${id}`;
    await audit(tx, actor, actor.tenant.id, "requisition", id, "update", { title });
    return { id };
  }
  const [r] = await tx<{ id: string }[]>`insert into requisitions ${tx({ ...v, tenant_id: actor.tenant.id, raised_by_employee_id: actor.employeeId, status: "draft" })} returning id`;
  await audit(tx, actor, actor.tenant.id, "requisition", r.id, "create", { title });
  return r;
}

async function chainFor(tx: Tx, entity: "requisition" | "offer"): Promise<Level[] | undefined> {
  const [wf] = await tx<{ levels: Level[] }[]>`select levels from approval_workflows where entity_type = ${entity} and is_active order by priority desc limit 1`;
  return wf?.levels;
}

export async function submitRequisition(tx: Tx, actor: Actor, id: string) {
  const [r] = await tx<{ status: string; raised_by_employee_id: string; title: string; openings: number }[]>`select status, raised_by_employee_id, title, openings from requisitions where id = ${id} for update`;
  if (!r || r.raised_by_employee_id !== actor.employeeId) throw new AppError("not_found", "Requisition not found.");
  if (!reqCan(r.status, "submit")) throw new AppError("conflict", "This requisition was already sent.");
  await tx`update requisitions set status = 'pending' where id = ${id}`;
  const res = await startApproval(tx, {
    tenantId: actor.tenant.id, entityType: "requisition", entityId: id, requesterId: actor.employeeId,
    summary: `${actor.name} · Requisition: ${r.title} (${r.openings} ${r.openings === 1 ? "opening" : "openings"})`, levels: await chainFor(tx, "requisition"),
  });
  if (res.status === "approved") await onRequisitionDecided(tx, actor, id, "approved");
  await audit(tx, actor, actor.tenant.id, "requisition", id, "submit", { auto_approved: res.status === "approved" });
  return { status: res.status === "approved" ? "approved" : "pending" };
}

export async function withdrawRequisition(tx: Tx, actor: Actor, id: string) {
  const [r] = await tx<{ status: string; raised_by_employee_id: string }[]>`select status, raised_by_employee_id from requisitions where id = ${id} for update`;
  if (!r || r.raised_by_employee_id !== actor.employeeId) throw new AppError("not_found", "Requisition not found.");
  if (!reqCan(r.status, "withdraw")) throw new AppError("conflict", "Only requisitions waiting for approval can be pulled back.");
  await cancelApproval(tx, "requisition", id);
  await tx`update requisitions set status = 'draft' where id = ${id}`;
  await audit(tx, actor, actor.tenant.id, "requisition", id, "withdraw");
}

export async function closeRequisition(tx: Tx, actor: Actor, id: string) {
  const [r] = await tx<{ status: string; raised_by_employee_id: string }[]>`select status, raised_by_employee_id from requisitions where id = ${id} for update`;
  if (!r || (r.raised_by_employee_id !== actor.employeeId && !canRecruit(actor))) throw new AppError("not_found", "Requisition not found.");
  if (!reqCan(r.status, "close")) throw new AppError("conflict", "This requisition can't be closed now.");
  if (r.status === "pending") await cancelApproval(tx, "requisition", id);
  await tx`update requisitions set status = 'closed' where id = ${id}`;
  await audit(tx, actor, actor.tenant.id, "requisition", id, "close");
}

/** Called by the approval engine. Guarded on status, so repeats do nothing. */
export async function onRequisitionDecided(tx: Tx, _actor: Actor | null, id: string, final: "approved" | "rejected") {
  const [r] = await tx<{ raised_by_employee_id: string; title: string; tenant_id: string }[]>`
    update requisitions set status = ${final} where id = ${id} and status = 'pending' returning raised_by_employee_id, title, tenant_id`;
  if (!r) return;
  if (final === "approved") {
    // tell recruiters there's an approved requisition to turn into a job
    const recs = await tx<{ id: string }[]>`select distinct ra.employee_id as id from role_assignments ra join roles ro on ro.id = ra.role_id
      where ('hire.recruit' = any(ro.permissions) or 'hire.admin' = any(ro.permissions)) and ra.employee_id <> ${r.raised_by_employee_id}`;
    for (const x of recs) await notifyEmployee(tx, r.tenant_id, x.id, "hire.requisition_approved", "Requisition approved", `${r.title} is ready to become a job`, "/hire/requisitions");
  }
}

/** Approved requisition → a draft job with its details filled in. */
export async function convertRequisition(tx: Tx, actor: Actor, id: string) {
  if (!canRecruit(actor)) throw new AppError("forbidden", "Only recruiters can create jobs.");
  const [r] = await tx<{ status: string; title: string; openings: number; job_type: string; department_id: string | null; location_id: string | null; salary_min_paise: bigint | null; salary_max_paise: bigint | null; target_date: string | null; description: string | null; qualification: string | null; experience_min: number | null; experience_max: number | null; raised_by_employee_id: string }[]>`
    select status, title, openings, job_type, department_id, location_id, salary_min_paise, salary_max_paise, target_date::text, description, qualification, experience_min, experience_max, raised_by_employee_id
    from requisitions where id = ${id} for update`;
  if (!r) throw new AppError("not_found", "Requisition not found.");
  if (!reqCan(r.status, "convert")) throw new AppError("conflict", r.status === "converted" ? "A job was already created from this requisition." : "Only approved requisitions can become jobs.");
  const [flow] = await tx<{ id: string }[]>`select id from hiring_flows order by is_default desc, created_at limit 1`;
  if (!flow) throw new AppError("invalid", "Set up a hiring flow first.");
  const text = [r.description, r.qualification ? `Qualifications\n${r.qualification}` : null].filter(Boolean).join("\n\n");
  const html = text ? textToHtml(text) : "";
  const [j] = await tx<{ id: string }[]>`
    insert into jobs (tenant_id, requisition_id, title, department_id, location_id, description_html, openings, target_date, job_type, experience_min, experience_max, salary_min_paise, salary_max_paise, hiring_flow_id, created_by)
    values (${actor.tenant.id}, ${id}, ${r.title}, ${r.department_id}, ${r.location_id}, ${html},
      ${r.openings}, ${r.target_date}, ${r.job_type}, ${r.experience_min}, ${r.experience_max}, ${N(r.salary_min_paise)}, ${N(r.salary_max_paise)}, ${flow.id}, ${actor.userId}) returning id`;
  await tx`insert into job_team_members (job_id, employee_id, tenant_id, role) values (${j.id}, ${actor.employeeId}, ${actor.tenant.id}, 'recruiter') on conflict do nothing`;
  if (r.raised_by_employee_id !== actor.employeeId) await tx`insert into job_team_members (job_id, employee_id, tenant_id, role) values (${j.id}, ${r.raised_by_employee_id}, ${actor.tenant.id}, 'hiring_manager') on conflict do nothing`;
  await tx`update requisitions set status = 'converted' where id = ${id}`;
  await audit(tx, actor, actor.tenant.id, "requisition", id, "convert", { job_id: j.id });
  return { jobId: j.id };
}

// ============================== jobs ==============================
export type JobListRow = {
  id: string; title: string; status: string; department: string | null; location: string | null; job_type: string; openings: number;
  created_at: Date; published_at: Date | null; target_date: string | null; publish: { career_site?: boolean; internal?: boolean; referrals?: boolean };
  counts: Record<StageGroup, number>; total: number; hired: number; team: string[];
};

export async function listJobs(tx: Tx, actor: Actor): Promise<JobListRow[]> {
  const ids = await visibleJobIds(tx, actor);
  const rows = await tx<(Omit<JobListRow, "counts" | "team"> & { counts: { g: StageGroup; n: number }[] | null; team: string[] | null })[]>`
    select j.id, j.title, j.status, d.name as department, l.name as location, j.job_type, j.openings, j.created_at, j.published_at, j.target_date::text, j.publish,
      (select json_agg(json_build_object('g', x.g, 'n', x.n)) from (select s.stage_group as g, count(*)::int as n from applications a join hiring_stages s on s.id = a.stage_id
         where a.job_id = j.id and a.status in ('active','hired') group by s.stage_group) x) as counts,
      (select count(*)::int from applications a where a.job_id = j.id) as total,
      (select count(*)::int from applications a where a.job_id = j.id and a.status = 'hired') as hired,
      (select array_agg(e.display_name order by t.role, e.display_name) from job_team_members t join employees e on e.id = t.employee_id where t.job_id = j.id and t.role in ('recruiter','hiring_manager')) as team
    from jobs j left join departments d on d.id = j.department_id left join locations l on l.id = j.location_id
    where ${ids === null} or j.id = any(${ids ?? []}::uuid[])
    order by case j.status when 'open' then 0 when 'draft' then 1 when 'on_hold' then 2 else 3 end, j.created_at desc`;
  return rows.map((r) => {
    const counts = { sourced: 0, screening: 0, interview: 0, offer: 0, hired: 0, rejected: 0 } as Record<StageGroup, number>;
    for (const c of r.counts ?? []) counts[c.g] = c.n;
    return { ...r, counts, team: [...new Set(r.team ?? [])] };
  });
}

export type JobInput = {
  title: string; departmentId: string | null; locationId: string | null; descriptionHtml: string; openings: number; targetDate: string | null; jobType: string;
  experienceMin: number | null; experienceMax: number | null; salaryMinPaise: number | null; salaryMaxPaise: number | null; showSalary: boolean;
  hiringFlowId: string; reapplyAfterDays: number | null; team: { employeeId: string; role: string }[];
  publish: { careerSite: boolean; internal: boolean; referrals: boolean }; requisitionId?: string | null;
};

export type JobFull = {
  id: string; title: string; status: string; department_id: string | null; location_id: string | null; description_html: string; openings: number; target_date: string | null;
  job_type: string; experience_min: number | null; experience_max: number | null; salary_min_paise: number | null; salary_max_paise: number | null; show_salary: boolean;
  hiring_flow_id: string; allow_reapply_after_days: number | null; publish: { career_site?: boolean; internal?: boolean; referrals?: boolean }; requisition_id: string | null;
  department: string | null; location: string | null; published_at: Date | null; team: { employee_id: string; name: string; role: TeamRole }[]; applications: number;
};

export async function getJob(tx: Tx, actor: Actor, id: string): Promise<JobFull> {
  await assertJobSee(tx, actor, id);
  const [j] = await tx<JobFull[]>`
    select j.id, j.title, j.status, j.department_id, j.location_id, j.description_html, j.openings, j.target_date::text, j.job_type, j.experience_min, j.experience_max,
      j.salary_min_paise, j.salary_max_paise, j.show_salary, j.hiring_flow_id, j.allow_reapply_after_days, j.publish, j.requisition_id, d.name as department, l.name as location, j.published_at,
      (select count(*)::int from applications a where a.job_id = j.id) as applications
    from jobs j left join departments d on d.id = j.department_id left join locations l on l.id = j.location_id where j.id = ${id}`;
  const team = await tx<JobFull["team"]>`select t.employee_id, e.display_name as name, t.role from job_team_members t join employees e on e.id = t.employee_id where t.job_id = ${id} order by t.role, e.display_name`;
  return { ...j, salary_min_paise: N(j.salary_min_paise), salary_max_paise: N(j.salary_max_paise), team };
}

export async function saveJob(tx: Tx, actor: Actor, id: string | null, input: JobInput) {
  if (id) await assertJobAct(tx, actor, id);
  else if (!canRecruit(actor)) throw new AppError("forbidden", "Only recruiters can create jobs.");
  const title = input.title.trim().slice(0, 120);
  if (!title) throw new AppError("invalid", "Give the job a title.", "title");
  checkRanges(input);
  await checkOrg(tx, input);
  if (!id && !canFor(actor, HIRE_ADMIN, { department_id: input.departmentId, location_id: input.locationId, legal_entity_id: null, business_unit_id: null }) && !(actor.grants ?? []).some((g) => g.permissions.includes("hire.recruit") || g.permissions.includes("*"))) {
    throw new AppError("forbidden", "You can't post jobs for this department or location.");
  }
  const html = sanitizeHtml(input.descriptionHtml ?? "");
  if (input.reapplyAfterDays != null && (!Number.isInteger(input.reapplyAfterDays) || input.reapplyAfterDays < 0 || input.reapplyAfterDays > 730)) throw new AppError("invalid", "Use 0 to 730 days.", "reapplyAfterDays");
  const [flow] = await tx`select 1 from hiring_flows where id = ${input.hiringFlowId}`;
  if (!flow) throw new AppError("invalid", "Pick a hiring flow.", "hiringFlowId");
  // team: real people, known roles, no duplicates; the creator stays on as a recruiter
  const team = new Map<string, { employeeId: string; role: TeamRole }>();
  for (const m of input.team) {
    if (!TEAM_ROLES.some((r) => r.value === m.role)) throw new AppError("invalid", "Pick a role for everyone on the hiring team.", "team");
    team.set(`${m.employeeId}:${m.role}`, { employeeId: m.employeeId, role: m.role as TeamRole });
  }
  const people = [...new Set([...team.values()].map((m) => m.employeeId))];
  if (people.length > 40) throw new AppError("invalid", "A hiring team can have at most 40 people.", "team");
  if (people.length) {
    const found = await tx<{ id: string }[]>`select id from employees where id = any(${people}::uuid[]) and status <> 'relieved'`;
    if (found.length !== people.length) throw new AppError("invalid", "Someone on the hiring team has left or doesn't exist.", "team");
  }
  if (![...team.values()].some((m) => m.role === "recruiter")) team.set(`${actor.employeeId}:recruiter`, { employeeId: actor.employeeId, role: "recruiter" });
  const publish = { career_site: !!input.publish.careerSite, internal: !!input.publish.internal, referrals: !!input.publish.referrals };
  const v = {
    title, department_id: input.departmentId, location_id: input.locationId, description_html: html, openings: input.openings, target_date: input.targetDate || null,
    job_type: input.jobType, experience_min: input.experienceMin, experience_max: input.experienceMax, salary_min_paise: input.salaryMinPaise, salary_max_paise: input.salaryMaxPaise,
    show_salary: !!input.showSalary, hiring_flow_id: input.hiringFlowId, allow_reapply_after_days: input.reapplyAfterDays, publish: tx.json(publish),
  };
  let jobId = id;
  if (id) {
    const [j] = await tx<{ status: string; hiring_flow_id: string; apps: number }[]>`select status, hiring_flow_id, (select count(*)::int from applications where job_id = ${id}) as apps from jobs where id = ${id} for update`;
    if (!jobNext(j.status, "edit")) throw new AppError("conflict", "Reopen the job before editing it.");
    if (j.apps && j.hiring_flow_id !== input.hiringFlowId) throw new AppError("conflict", "This job already has candidates, so its hiring flow can't change.", "hiringFlowId");
    await tx`update jobs set ${tx(v as never)} where id = ${id}`;
    await tx`delete from job_team_members where job_id = ${id}`;
  } else {
    let reqId: string | null = null;
    if (input.requisitionId) {
      const [r] = await tx<{ status: string }[]>`select status from requisitions where id = ${input.requisitionId} for update`;
      if (!r || !reqCan(r.status, "convert")) throw new AppError("invalid", "That requisition isn't approved.", "requisitionId");
      reqId = input.requisitionId;
      await tx`update requisitions set status = 'converted' where id = ${reqId}`;
    }
    const [j] = await tx<{ id: string }[]>`insert into jobs ${tx({ ...v, tenant_id: actor.tenant.id, requisition_id: reqId, created_by: actor.userId } as never)} returning id`;
    jobId = j.id;
  }
  for (const m of team.values()) await tx`insert into job_team_members (job_id, employee_id, tenant_id, role) values (${jobId}, ${m.employeeId}, ${actor.tenant.id}, ${m.role}) on conflict do nothing`;
  await audit(tx, actor, actor.tenant.id, "job", jobId, id ? "update" : "create", { title, team: [...team.values()] });
  return { id: jobId! };
}

export async function setJobStatus(tx: Tx, actor: Actor, id: string, action: JobAction) {
  await assertJobAct(tx, actor, id);
  const [j] = await tx<{ status: string; title: string; description_html: string }[]>`select status, title, description_html from jobs where id = ${id} for update`;
  const next = jobNext(j.status, action);
  if (!next || action === "edit") throw new AppError("conflict", "The job can't do that from its current state.");
  if (action === "publish" && !j.description_html.replace(/<[^>]+>/g, "").trim()) throw new AppError("invalid", "Add a job description before publishing.");
  await tx`update jobs set status = ${next}, published_at = case when ${action === "publish"} then now() else published_at end,
           closed_at = case when ${next === "closed"} then now() else null end where id = ${id}`;
  await audit(tx, actor, actor.tenant.id, "job", id, `status.${action}`, { from: j.status, to: next });
  return { status: next };
}

// ============================== pipeline ==============================
export type Stage = { id: string; name: string; stage_group: StageGroup; position: number };
export type Card = {
  id: string; candidate_id: string; name: string; email: string; source: string; stage_id: string; status: string; days_in_stage: number;
  rating: number | null; ratings: number; tags: string[]; current_title: string | null; current_company: string | null; next_interview: Date | null; offer_status: string | null; referred_by: string | null;
};

export async function pipeline(tx: Tx, actor: Actor, jobId: string) {
  const access = await jobAccess(tx, actor, jobId);
  if (!access.see) throw new AppError("not_found", "Job not found.");
  const job = await getJob(tx, actor, jobId);
  const stages = await tx<Stage[]>`select id, name, stage_group, position from hiring_stages where flow_id = ${job.hiring_flow_id} order by position`;
  const cards = await tx<Card[]>`
    select a.id, c.id as candidate_id, trim(c.first_name || ' ' || coalesce(c.last_name, '')) as name, c.email::text, a.source, a.stage_id, a.status,
      greatest(0, floor(extract(epoch from now() - a.stage_entered_at) / 86400))::int as days_in_stage,
      (select round(avg(x.overall), 1)::float from scorecard_submissions x where x.application_id = a.id and x.submitted_at is not null) as rating,
      (select count(*)::int from scorecard_submissions x where x.application_id = a.id and x.submitted_at is not null) as ratings,
      c.tags, c.current_title, c.current_company,
      (select min(i.starts_at) from interviews i where i.application_id = a.id and i.status = 'scheduled' and i.starts_at > now()) as next_interview,
      (select o.status from offers o where o.application_id = a.id order by o.version desc limit 1) as offer_status,
      r.display_name as referred_by
    from applications a join candidates c on c.id = a.candidate_id left join employees r on r.id = a.referred_by_employee_id
    where a.job_id = ${jobId} and (c.employee_id is distinct from ${actor.employeeId})
    order by a.stage_entered_at`;
  const [scorecards, people, templates] = await Promise.all([
    tx<{ id: string; name: string }[]>`select id, name from scorecards order by name`,
    tx<{ id: string; name: string; title: string | null }[]>`select e.id, e.display_name as name, d.title from employees e left join designations d on d.id = e.designation_id where e.status <> 'relieved' order by e.display_name`,
    tx<{ id: string; name: string }[]>`select id, name from letter_templates where kind = 'offer' order by name`,
  ]);
  return { job, stages, cards, access: { act: access.act, admin: access.admin, roles: access.roles }, scorecards, people, offerTemplates: templates, groupOrder: GROUP_ORDER };
}

export async function jobFormData(tx: Tx) {
  const [departments, locations, flows, jds, people] = await Promise.all([
    tx<{ id: string; name: string }[]>`select id, name from departments order by name`,
    tx<{ id: string; name: string }[]>`select id, name from locations order by name`,
    tx<{ id: string; name: string; is_default: boolean; stages: string[] }[]>`select f.id, f.name, f.is_default, (select array_agg(s.name order by s.position) from hiring_stages s where s.flow_id = f.id) as stages from hiring_flows f order by f.is_default desc, f.name`,
    tx<{ id: string; name: string; description_html: string }[]>`select id, name, description_html from jd_templates order by name`,
    tx<{ id: string; name: string; title: string | null; department: string | null }[]>`select e.id, e.display_name as name, d.title, dp.name as department from employees e left join designations d on d.id = e.designation_id left join departments dp on dp.id = e.department_id where e.status <> 'relieved' order by e.display_name`,
  ]);
  return { departments, locations, flows, jds, people };
}

export const hireAdminEverywhere = canAdminHire;

/** Headline numbers for the jobs page, over the jobs the actor can see. */
export async function jobStats(tx: Tx, actor: Actor) {
  const ids = await visibleJobIds(tx, actor);
  const [s] = await tx<{ interviews: number; offers: number; active: number }[]>`
    select (select count(*)::int from interviews i join applications a on a.id = i.application_id
              where i.status = 'scheduled' and i.starts_at between now() and now() + interval '7 days' and (${ids === null} or a.job_id = any(${ids ?? []}::uuid[]))) as interviews,
           (select count(*)::int from offers o join applications a on a.id = o.application_id where o.status = 'released' and (${ids === null} or a.job_id = any(${ids ?? []}::uuid[]))) as offers,
           (select count(*)::int from applications a where a.status = 'active' and (${ids === null} or a.job_id = any(${ids ?? []}::uuid[]))) as active`;
  return s;
}
