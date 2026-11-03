import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { notifyEmployee } from "@/server/modules/approvals/service";
import { appEvent, findDuplicate, saveResume, type Upload } from "./candidates";
import { audit } from "./setup";
import { groupLabel, isEmail, normalizeEmail, normalizePhone, type StageGroup } from "./rules";

export type InternalJob = {
  id: string; title: string; department: string | null; location: string | null; job_type: string; experience_min: number | null; experience_max: number | null;
  description_html: string; internal: boolean; referrals: boolean; published_at: Date | null; on_team: boolean; applied: boolean;
};

/** Open jobs posted internally or for referrals, plus what the person has applied to and who they referred. */
export async function internalJobs(tx: Tx, actor: Actor) {
  const jobs = await tx<InternalJob[]>`
    select j.id, j.title, d.name as department, l.name as location, j.job_type, j.experience_min, j.experience_max, j.description_html,
      coalesce((j.publish->>'internal')::boolean, false) as internal, coalesce((j.publish->>'referrals')::boolean, false) as referrals, j.published_at,
      exists (select 1 from job_team_members t where t.job_id = j.id and t.employee_id = ${actor.employeeId}) as on_team,
      exists (select 1 from applications a join candidates c on c.id = a.candidate_id where a.job_id = j.id and c.employee_id = ${actor.employeeId}) as applied
    from jobs j left join departments d on d.id = j.department_id left join locations l on l.id = j.location_id
    where j.status = 'open' and (coalesce((j.publish->>'internal')::boolean, false) or coalesce((j.publish->>'referrals')::boolean, false))
    order by j.published_at desc nulls last`;
  // what referrers and internal applicants see: the stage group only, never notes, ratings or reasons
  const referrals = await tx<{ id: string; job: string; candidate: string; created_at: Date; status: string; group: StageGroup; bonus_status: string }[]>`
    select r.id, j.title as job, trim(c.first_name || ' ' || coalesce(c.last_name, '')) as candidate, r.created_at, a.status, s.stage_group as group, r.bonus_status
    from referrals r join jobs j on j.id = r.job_id join candidates c on c.id = r.candidate_id
    left join applications a on a.job_id = r.job_id and a.candidate_id = r.candidate_id left join hiring_stages s on s.id = a.stage_id
    where r.referrer_employee_id = ${actor.employeeId} order by r.created_at desc`;
  const mine = await tx<{ id: string; job: string; status: string; group: StageGroup; created_at: Date }[]>`
    select a.id, j.title as job, a.status, s.stage_group as group, a.created_at from applications a join candidates c on c.id = a.candidate_id join jobs j on j.id = a.job_id join hiring_stages s on s.id = a.stage_id
    where c.employee_id = ${actor.employeeId} order by a.created_at desc`;
  const progress = (status: string, group: StageGroup) => status === "hired" ? "Hired" : status === "rejected" ? "Not selected" : status === "withdrawn" ? "Withdrawn" : `In ${groupLabel(group).toLowerCase()}`;
  return {
    jobs: jobs.map((j) => ({ ...j, on_team: j.on_team })),
    referrals: referrals.map((r) => ({ id: r.id, job: r.job, candidate: r.candidate, created_at: r.created_at, progress: r.status ? progress(r.status, r.group) : "Received", bonus_status: r.bonus_status })),
    mine: mine.map((m) => ({ id: m.id, job: m.job, created_at: m.created_at, progress: progress(m.status, m.group) })),
  };
}

async function openJob(tx: Tx, jobId: string, kind: "internal" | "referrals") {
  const [j] = await tx<{ id: string; title: string; hiring_flow_id: string }[]>`
    select id, title, hiring_flow_id from jobs where id = ${jobId} and status = 'open' and coalesce((publish->>${kind})::boolean, false)`;
  if (!j) throw new AppError("not_found", kind === "internal" ? "This job isn't open to internal applicants." : "This job isn't taking referrals.");
  const [stage] = await tx<{ id: string; name: string; stage_group: string }[]>`select id, name, stage_group from hiring_stages where flow_id = ${j.hiring_flow_id} and stage_group not in ('hired','rejected') order by position limit 1`;
  return { ...j, stage };
}

async function tellRecruiters(tx: Tx, tenantId: string, jobId: string, title: string, body: string, skip: string) {
  const team = await tx<{ id: string }[]>`select distinct employee_id as id from job_team_members where job_id = ${jobId} and role in ('recruiter','hiring_manager') and employee_id <> ${skip}`;
  for (const m of team) await notifyEmployee(tx, tenantId, m.id, "hire.applied", title, body, `/hire/jobs/${jobId}`);
}

/** An employee applies for an internal job. People on the job's hiring team can't apply to it. */
export async function applyInternal(tx: Tx, actor: Actor, jobId: string, note: string | null) {
  const j = await openJob(tx, jobId, "internal");
  const [team] = await tx`select 1 from job_team_members where job_id = ${jobId} and employee_id = ${actor.employeeId}`;
  if (team) throw new AppError("conflict", "You're on this job's hiring team, so you can't apply for it.");
  const [e] = await tx<{ first_name: string; last_name: string | null; work_email: string; mobile: string | null; title: string | null; company: string }[]>`
    select e.first_name, e.last_name, e.work_email::text, e.mobile, d.title, (select name from tenants) as company from employees e left join designations d on d.id = e.designation_id where e.id = ${actor.employeeId}`;
  let [c] = await tx<{ id: string }[]>`select id from candidates where employee_id = ${actor.employeeId} or email = ${e.work_email}::citext order by (employee_id = ${actor.employeeId}) desc nulls last limit 1`;
  if (!c) {
    [c] = await tx<{ id: string }[]>`
      insert into candidates (tenant_id, first_name, last_name, email, mobile, current_company, current_title, source, employee_id, consent_at)
      values (${actor.tenant.id}, ${e.first_name}, ${e.last_name}, ${e.work_email}, ${e.mobile}, ${e.company}, ${e.title}, 'internal', ${actor.employeeId}, now()) returning id`;
  } else await tx`update candidates set employee_id = ${actor.employeeId} where id = ${c.id} and employee_id is null`;
  const [prev] = await tx`select 1 from applications where job_id = ${jobId} and candidate_id = ${c.id}`;
  if (prev) throw new AppError("conflict", "You've already applied for this job.");
  const [a] = await tx<{ id: string }[]>`insert into applications (tenant_id, job_id, candidate_id, stage_id, source, answers) values (${actor.tenant.id}, ${jobId}, ${c.id}, ${j.stage.id}, 'internal', ${tx.json({ note: note?.trim().slice(0, 2000) || null })}) returning id`;
  await appEvent(tx, actor.tenant.id, a.id, "applied", { to: j.stage.name, to_group: j.stage.stage_group, source: "internal" }, actor.employeeId);
  await tellRecruiters(tx, actor.tenant.id, jobId, `${actor.name} applied internally`, j.title, actor.employeeId);
  await audit(tx, actor, actor.tenant.id, "application", a.id, "internal.apply", { job_id: jobId });
  return { applicationId: a.id };
}

export type ReferralInput = { firstName: string; lastName: string | null; email: string; mobile: string | null; note: string | null; resume: Upload | null };

/** Refer someone for a job. A person already in the process for that job can't be referred again. */
export async function refer(tx: Tx, actor: Actor, jobId: string, input: ReferralInput) {
  const j = await openJob(tx, jobId, "referrals");
  const first = input.firstName.trim().slice(0, 80), email = normalizeEmail(input.email);
  if (!first) throw new AppError("invalid", "Enter their first name.", "firstName");
  if (!isEmail(email)) throw new AppError("invalid", "Enter a valid email address.", "email");
  if (input.mobile?.trim() && !normalizePhone(input.mobile)) throw new AppError("invalid", "Enter a valid mobile number.", "mobile");
  const [me] = await tx<{ work_email: string }[]>`select work_email::text from employees where id = ${actor.employeeId}`;
  if (email === me.work_email.toLowerCase()) throw new AppError("invalid", "You can't refer yourself. Apply from the Internal jobs tab instead.", "email");
  const [colleague] = await tx`select 1 from employees where work_email = ${email}::citext and status <> 'relieved'`;
  if (colleague) throw new AppError("invalid", "This person already works here. They can apply internally.", "email");
  if (!input.resume) throw new AppError("invalid", "Attach their resume.", "resume");
  const dupe = await findDuplicate(tx, email, null);
  let candidateId: string;
  if (dupe) {
    candidateId = dupe.id;
    const [prev] = await tx<{ status: string }[]>`select status from applications where job_id = ${jobId} and candidate_id = ${candidateId}`;
    if (prev) throw new AppError("conflict", "This person is already being considered for this job.", "email");
  } else {
    const { fileId, parsed } = await saveResume(tx, actor.tenant.id, actor.userId, input.resume);
    const [c] = await tx<{ id: string }[]>`
      insert into candidates (tenant_id, first_name, last_name, email, mobile, source, resume_file_id, parsed)
      values (${actor.tenant.id}, ${first}, ${input.lastName?.trim().slice(0, 80) || null}, ${email}, ${input.mobile?.trim().slice(0, 20) || null}, 'referral', ${fileId}, ${tx.json(parsed as never)}) returning id`;
    candidateId = c.id;
  }
  const [a] = await tx<{ id: string }[]>`
    insert into applications (tenant_id, job_id, candidate_id, stage_id, source, referred_by_employee_id) values (${actor.tenant.id}, ${jobId}, ${candidateId}, ${j.stage.id}, 'referral', ${actor.employeeId}) returning id`;
  await tx`insert into referrals (tenant_id, job_id, referrer_employee_id, candidate_id, note) values (${actor.tenant.id}, ${jobId}, ${actor.employeeId}, ${candidateId}, ${input.note?.trim().slice(0, 1000) || null})`;
  await appEvent(tx, actor.tenant.id, a.id, "applied", { to: j.stage.name, to_group: j.stage.stage_group, source: "referral", referred_by: actor.name, note: input.note?.trim().slice(0, 1000) || null }, actor.employeeId);
  await tellRecruiters(tx, actor.tenant.id, jobId, `${actor.name} referred ${first}`, j.title, actor.employeeId);
  await audit(tx, actor, actor.tenant.id, "referral", a.id, "create", { job_id: jobId });
  return { applicationId: a.id };
}
