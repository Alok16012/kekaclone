import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { ACTING_ROLES, type TeamRole } from "./rules";

export const HIRE_ADMIN = "hire.admin";
export const HIRE_RECRUIT = "hire.recruit";
export const EVERYWHERE: Placement = { department_id: null, location_id: null, legal_entity_id: null, business_unit_id: null };

const anywhere = (actor: Actor, p: string) => (actor.grants ?? []).some((g) => g.permissions.includes("*") || g.permissions.includes(p));

/** Company-wide hiring setup (flows, scorecards, templates, careers page): hire.admin with no scope. */
export const canAdminHire = (actor: Actor) => canFor(actor, HIRE_ADMIN, EVERYWHERE);
export function assertHireAdmin(actor: Actor) {
  if (!canAdminHire(actor)) throw new AppError("forbidden", "Only hiring admins for the whole company can change hiring settings.");
}
/** May post jobs and keep a talent pool (recruiter role, or a hiring admin anywhere). */
export const canRecruit = (actor: Actor) => anywhere(actor, HIRE_RECRUIT) || anywhere(actor, HIRE_ADMIN);
/** Opens the hiring area at all: recruiters, hiring admins, and anyone on a job's hiring team. */
export async function hasHireAccess(tx: Tx, actor: Actor) {
  if (canRecruit(actor)) return true;
  const [r] = await tx`select 1 from job_team_members where employee_id = ${actor.employeeId} limit 1`;
  return !!r;
}

export type JobAccess = { see: boolean; act: boolean; admin: boolean; roles: TeamRole[] };
type JobRow = Placement & { id: string };

/**
 * What the actor may do on a job: hiring admins whose scope covers the job's department / location see and act on
 * everything; team members see it, and recruiters, hiring managers and coordinators on the team may act.
 */
export async function jobAccess(tx: Tx, actor: Actor, jobId: string): Promise<JobAccess & { job: JobRow }> {
  const [job] = await tx<JobRow[]>`select id, department_id, location_id, null::uuid as legal_entity_id, null::uuid as business_unit_id from jobs where id = ${jobId}`;
  if (!job) throw new AppError("not_found", "Job not found.");
  const roles = (await tx<{ role: TeamRole }[]>`select role from job_team_members where job_id = ${jobId} and employee_id = ${actor.employeeId}`).map((r) => r.role);
  const admin = canFor(actor, HIRE_ADMIN, job);
  return { job, roles, admin, see: admin || roles.length > 0, act: admin || roles.some((r) => ACTING_ROLES.includes(r)) };
}

export async function assertJobSee(tx: Tx, actor: Actor, jobId: string) {
  const a = await jobAccess(tx, actor, jobId);
  if (!a.see) throw new AppError("not_found", "Job not found.");
  return a;
}
export async function assertJobAct(tx: Tx, actor: Actor, jobId: string) {
  const a = await assertJobSee(tx, actor, jobId);
  if (!a.act) throw new AppError("forbidden", "Only the job's recruiters, hiring managers and coordinators can do this.");
  return a;
}

/** Jobs the actor can see (ids), for list filtering. Admins with no scope: null = all. */
export async function visibleJobIds(tx: Tx, actor: Actor): Promise<string[] | null> {
  if (canAdminHire(actor)) return null;
  const rows = await tx<{ id: string; department_id: string | null; location_id: string | null; on_team: boolean }[]>`
    select j.id, j.department_id, j.location_id,
      exists (select 1 from job_team_members t where t.job_id = j.id and t.employee_id = ${actor.employeeId}) as on_team
    from jobs j`;
  return rows.filter((r) => r.on_team || canFor(actor, HIRE_ADMIN, { department_id: r.department_id, location_id: r.location_id, legal_entity_id: null, business_unit_id: null })).map((r) => r.id);
}

type AppRow = { id: string; job_id: string; candidate_id: string; status: string; stage_id: string; candidate_employee_id: string | null };

/** An application the actor may act on. Internal applicants never act on their own application. */
export async function actOnApplication(tx: Tx, actor: Actor, applicationId: string) {
  const [a] = await tx<AppRow[]>`
    select a.id, a.job_id, a.candidate_id, a.status, a.stage_id, c.employee_id as candidate_employee_id
    from applications a join candidates c on c.id = a.candidate_id where a.id = ${applicationId} for update of a`;
  if (!a) throw new AppError("not_found", "Application not found.");
  if (a.candidate_employee_id === actor.employeeId) throw new AppError("forbidden", "You can't work on your own application.");
  const access = await assertJobAct(tx, actor, a.job_id);
  return { app: a, access };
}

export async function seeApplication(tx: Tx, actor: Actor, applicationId: string) {
  const [a] = await tx<AppRow[]>`
    select a.id, a.job_id, a.candidate_id, a.status, a.stage_id, c.employee_id as candidate_employee_id
    from applications a join candidates c on c.id = a.candidate_id where a.id = ${applicationId}`;
  if (!a || a.candidate_employee_id === actor.employeeId) throw new AppError("not_found", "Application not found.");
  const access = await assertJobSee(tx, actor, a.job_id);
  return { app: a, access };
}

/**
 * May the actor open this candidate? Hiring admins (no scope): everyone. Others: candidates with an application on a
 * job they can see, or (recruiters) candidates in the talent pool with no application yet. Never their own record.
 */
export async function candidateAccess(tx: Tx, actor: Actor, candidateId: string): Promise<{ see: boolean; act: boolean }> {
  const [c] = await tx<{ id: string; employee_id: string | null }[]>`select id, employee_id from candidates where id = ${candidateId}`;
  if (!c || c.employee_id === actor.employeeId) return { see: false, act: false };
  if (canAdminHire(actor)) return { see: true, act: true };
  const apps = await tx<{ job_id: string }[]>`select job_id from applications where candidate_id = ${candidateId}`;
  if (!apps.length) return canRecruit(actor) ? { see: true, act: true } : { see: false, act: false };
  let see = false, act = false;
  for (const a of apps) {
    const j = await jobAccess(tx, actor, a.job_id);
    see ||= j.see; act ||= j.act;
  }
  return { see, act };
}

export async function assertCandidateSee(tx: Tx, actor: Actor, candidateId: string) {
  const a = await candidateAccess(tx, actor, candidateId);
  if (!a.see) throw new AppError("not_found", "Candidate not found.");
  return a;
}
export async function assertCandidateAct(tx: Tx, actor: Actor, candidateId: string) {
  const a = await assertCandidateSee(tx, actor, candidateId);
  if (!a.act) throw new AppError("forbidden", "You can only view this candidate.");
  return a;
}
