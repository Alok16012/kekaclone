import "server-only";
import { AppError, type Tx } from "@/server/db";
import { notifyEmployee } from "@/server/modules/approvals/service";
import { appEvent, findDuplicate, saveResume, valuesFor } from "./candidates";
import { emailFromTemplate } from "./mail";
import { isEmail, jobTypeLabel, normalizeEmail, normalizePhone, reapplyCheck } from "./rules";

export type PublicJob = {
  id: string; title: string; department: string | null; location: string | null; job_type: string; experience_min: number | null; experience_max: number | null;
  salary_min_paise: number | null; salary_max_paise: number | null; show_salary: boolean; published_at: Date | null; description_html: string;
};

/** Careers page: the site's text and open jobs published there. Public fields only. */
export async function careersHome(tx: Tx) {
  const [site] = await tx<{ title: string; about_html: string | null; branding: { tagline?: string } }[]>`select title, about_html, branding from career_sites order by created_at limit 1`;
  const [t] = await tx<{ name: string }[]>`select name from tenants`;
  const jobs = await tx<PublicJob[]>`
    select j.id, j.title, d.name as department, l.name as location, j.job_type, j.experience_min, j.experience_max, j.salary_min_paise, j.salary_max_paise, j.show_salary, j.published_at, ''::text as description_html
    from jobs j left join departments d on d.id = j.department_id left join locations l on l.id = j.location_id
    where j.status = 'open' and coalesce((j.publish->>'career_site')::boolean, false) order by j.published_at desc nulls last, j.title`;
  return { company: t?.name ?? "", site: site ?? { title: `Careers at ${t?.name ?? ""}`, about_html: null, branding: {} }, jobs: jobs.map(clean) };
}

const clean = (j: PublicJob): PublicJob => ({ ...j, salary_min_paise: j.show_salary && j.salary_min_paise != null ? Number(j.salary_min_paise) : null, salary_max_paise: j.show_salary && j.salary_max_paise != null ? Number(j.salary_max_paise) : null });

export async function careersJob(tx: Tx, jobId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return null;
  const [j] = await tx<PublicJob[]>`
    select j.id, j.title, d.name as department, l.name as location, j.job_type, j.experience_min, j.experience_max, j.salary_min_paise, j.salary_max_paise, j.show_salary, j.published_at, j.description_html
    from jobs j left join departments d on d.id = j.department_id left join locations l on l.id = j.location_id
    where j.id = ${jobId} and j.status = 'open' and coalesce((j.publish->>'career_site')::boolean, false)`;
  const [t] = await tx<{ name: string }[]>`select name from tenants`;
  return j ? { job: clean(j), company: t?.name ?? "", typeLabel: jobTypeLabel(j.job_type) } : null;
}

export type ApplyInput = {
  jobId: string; firstName: string; lastName: string; email: string; mobile: string; currentCompany: string; currentTitle: string; experienceYears: string;
  consent: boolean; resume: { name: string; bytes: Uint8Array } | null; website?: string;
};

/**
 * A careers-page application. Same email = same candidate (no duplicate records); applying again to the same job
 * follows the job's reapply cooldown. Answers are generic so the form can't be used to look up who applied.
 */
export async function applyPublic(tx: Tx, tenant: { id: string; name: string }, input: ApplyInput, now = new Date()) {
  if (input.website) return { ok: true as const };   // honeypot: bots fill every field; pretend it worked
  if (!input.consent) throw new AppError("invalid", "Please agree to us storing your details so we can consider your application.", "consent");
  const first = input.firstName.trim().slice(0, 80), email = normalizeEmail(input.email);
  if (!first) throw new AppError("invalid", "Enter your first name.", "firstName");
  if (!isEmail(email)) throw new AppError("invalid", "Enter a valid email address.", "email");
  const mobile = input.mobile.trim() ? normalizePhone(input.mobile) : null;
  if (input.mobile.trim() && !mobile) throw new AppError("invalid", "Enter a valid mobile number.", "mobile");
  const expRaw = input.experienceYears.trim();
  const exp = expRaw === "" ? null : Number(expRaw);
  if (exp != null && (!Number.isFinite(exp) || exp < 0 || exp > 50)) throw new AppError("invalid", "Enter your experience in years (0 to 50).", "experienceYears");
  if (!input.resume) throw new AppError("invalid", "Attach your resume.", "resume");
  const [job] = await tx<{ id: string; status: string; allow_reapply_after_days: number | null; hiring_flow_id: string; title: string }[]>`
    select id, status, allow_reapply_after_days, hiring_flow_id, title from jobs where id = ${input.jobId} and status = 'open' and coalesce((publish->>'career_site')::boolean, false) for share`;
  if (!job) throw new AppError("not_found", "This job isn't open for applications any more.");
  const [stage] = await tx<{ id: string; name: string; stage_group: string }[]>`select id, name, stage_group from hiring_stages where flow_id = ${job.hiring_flow_id} and stage_group not in ('hired','rejected') order by position limit 1`;

  const dupe = await findDuplicate(tx, email, null);
  let candidateId: string, resumeEvent: Record<string, string> = {};
  if (dupe) {
    // The form proves nothing about who is typing, so an existing record is never rewritten from it. Someone who
    // works here (or whose record is tied to an employee) applies from the internal jobs page instead.
    const [existing] = await tx<{ employee_id: string | null; in_process: boolean }[]>`
      select c.employee_id, exists (select 1 from applications a where a.candidate_id = c.id and a.status in ('active','hired')) as in_process
      from candidates c where c.id = ${dupe.id} for update`;
    if (existing?.employee_id) throw new AppError("conflict", "This email address belongs to someone at the company. Please sign in and apply from the internal jobs page.");
    candidateId = dupe.id;
    const [prev] = await tx<{ id: string; status: string; closed_at: Date | null }[]>`select id, status, closed_at from applications where job_id = ${job.id} and candidate_id = ${candidateId} for update`;
    const r = reapplyCheck(prev ? { status: prev.status, closedAt: prev.closed_at } : null, job.allow_reapply_after_days, now);
    if (!r.ok) {
      if (r.reason === "cooldown" && r.until) throw new AppError("conflict", `You applied for this job recently. You can apply again from ${r.until.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" })}.`);
      throw new AppError("conflict", "You've already applied for this job. We'll be in touch.");
    }
    const { fileId, parsed } = await saveResume(tx, tenant.id, null, input.resume);
    // a candidate with nothing in progress gets the fresh resume and details; one mid-process keeps theirs (the new
    // file is kept on the application's timeline for the team)
    if (!existing?.in_process) {
      await tx`update candidates set resume_file_id = ${fileId}, parsed = ${tx.json(parsed as never)}, consent_at = now(), mobile = coalesce(mobile, ${mobile}),
               current_company = coalesce(${input.currentCompany.trim().slice(0, 120) || null}, current_company), current_title = coalesce(${input.currentTitle.trim().slice(0, 120) || null}, current_title)
               where id = ${candidateId}`;
    }
    if (existing?.in_process) resumeEvent = { resume_file_id: fileId, resume_name: input.resume.name.slice(0, 120) };
    if (prev) {
      await tx`update applications set status = 'active', stage_id = ${stage.id}, stage_entered_at = now(), reject_reason = null, closed_at = null, source = 'career_site' where id = ${prev.id}`;
      await appEvent(tx, tenant.id, prev.id, "reapplied", { to: stage.name, to_group: stage.stage_group, source: "career_site", ...resumeEvent }, null);
      await afterApply(tx, tenant, prev.id, job.id, `${first} applied again`);
      return { ok: true as const };
    }
  } else {
    const { fileId, parsed } = await saveResume(tx, tenant.id, null, input.resume);
    const [c] = await tx<{ id: string }[]>`
      insert into candidates (tenant_id, first_name, last_name, email, mobile, current_company, current_title, experience_months, source, resume_file_id, parsed, consent_at)
      values (${tenant.id}, ${first}, ${input.lastName.trim().slice(0, 80) || null}, ${email}, ${mobile}, ${input.currentCompany.trim().slice(0, 120) || null}, ${input.currentTitle.trim().slice(0, 120) || null},
        ${exp == null ? null : Math.round(exp * 12)}, 'career_site', ${fileId}, ${tx.json(parsed as never)}, now()) returning id`;
    candidateId = c.id;
  }
  const [a] = await tx<{ id: string }[]>`
    insert into applications (tenant_id, job_id, candidate_id, stage_id, source) values (${tenant.id}, ${job.id}, ${candidateId}, ${stage.id}, 'career_site') returning id`;
  await appEvent(tx, tenant.id, a.id, "applied", { to: stage.name, to_group: stage.stage_group, source: "career_site", ...resumeEvent }, null);
  await afterApply(tx, tenant, a.id, job.id, `${first} applied`);
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${tenant.id}, null, 'application', ${a.id}, 'careers.apply', ${tx.json({ job_id: job.id })})`;
  return { ok: true as const };
}

async function afterApply(tx: Tx, tenant: { id: string; name: string }, applicationId: string, jobId: string, title: string) {
  const v = await valuesFor(tx, tenant.name, applicationId);
  await emailFromTemplate(tx, { tenantId: tenant.id, company: tenant.name, to: v.email, applicationId, actorEmployeeId: null, key: "application_received", values: v.values });
  const team = await tx<{ id: string }[]>`select distinct employee_id as id from job_team_members where job_id = ${jobId} and role in ('recruiter','coordinator')`;
  for (const m of team) await notifyEmployee(tx, tenant.id, m.id, "hire.applied", title, v.values["job.title"] ?? "", `/hire/jobs/${jobId}`);
}
