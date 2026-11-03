import "server-only";
import ExcelJS from "exceljs";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { notifyEmployee } from "@/server/modules/approvals/service";
import { validateUpload } from "@/server/modules/documents/rules";
import { saveFile } from "@/server/storage";
import {
  actOnApplication, assertCandidateAct, assertCandidateSee, assertJobAct, canAdminHire, canRecruit, candidateAccess, jobAccess, seeApplication, visibleJobIds,
} from "./access";
import { audit, candidateFields, cleanCustom } from "./setup";
import { emailCandidate, emailFromTemplate, renderTemplate } from "./mail";
import { parseResume } from "./resume";
import {
  cleanTags, GROUP_ORDER, IMPORT_COLUMNS, isEmail, MAX_IMPORT_ROWS, moveProblem, normalizeEmail, normalizePhone, REJECT_REASONS, SOURCES,
  validateImportRows, type Source, type StageGroup,
} from "./rules";

export type Upload = { name: string; bytes: Uint8Array };
const RESUME_EXTS = new Set(["pdf", "docx", "txt"]);

/** Stores a resume (PDF, Word or text, up to 5 MB, real file signature) and returns its file id and parsed text. */
export async function saveResume(tx: Tx, tenantId: string, userId: string | null, f: Upload) {
  const ext = f.name.toLowerCase().split(".").pop() ?? "";
  if (!RESUME_EXTS.has(ext)) throw new AppError("invalid", "Upload the resume as a PDF, Word (.docx) or text file.", "resume");
  const v = validateUpload({ name: f.name, size: f.bytes.byteLength, head: f.bytes.subarray(0, 512) });
  if (!v.ok) throw new AppError("invalid", v.error, "resume");
  const fileId = await saveFile(tx, { tenantId, userId, name: v.name, mime: v.mime, bytes: f.bytes, ext });
  const parsed = parseResume(v.name, f.bytes);
  return { fileId, parsed };
}

// ---------- list / search ----------
export type CandidateRow = {
  id: string; name: string; email: string; mobile: string | null; current_title: string | null; current_company: string | null; source: string; tags: string[];
  experience_months: number | null; created_at: Date; applications: { job: string; job_id: string; stage: string; group: StageGroup; status: string }[]; employee_id: string | null;
};

export async function listCandidates(tx: Tx, actor: Actor, f: { q?: string; tag?: string; jobId?: string; source?: string } = {}) {
  const ids = await visibleJobIds(tx, actor);
  const all = canAdminHire(actor), pool = canRecruit(actor);
  const q = (f.q ?? "").trim().slice(0, 100);
  const like = `%${q.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
  const rows = await tx<CandidateRow[]>`
    select c.id, trim(c.first_name || ' ' || coalesce(c.last_name, '')) as name, c.email::text, c.mobile, c.current_title, c.current_company, c.source, c.tags, c.experience_months, c.created_at, c.employee_id,
      coalesce((select json_agg(json_build_object('job', j.title, 'job_id', j.id, 'stage', s.name, 'group', s.stage_group, 'status', a.status) order by a.created_at desc)
        from applications a join jobs j on j.id = a.job_id join hiring_stages s on s.id = a.stage_id
        where a.candidate_id = c.id and (${ids === null} or a.job_id = any(${ids ?? []}::uuid[]))), '[]') as applications
    from candidates c
    where (c.employee_id is distinct from ${actor.employeeId})
      and (${all}
        or exists (select 1 from applications a where a.candidate_id = c.id and a.job_id = any(${ids ?? []}::uuid[]))
        or (${pool} and not exists (select 1 from applications a where a.candidate_id = c.id)))
      and (${q === ""} or (c.first_name || ' ' || coalesce(c.last_name, '')) ilike ${like} or c.email::text ilike ${like} or c.mobile ilike ${like}
           or c.current_company ilike ${like} or c.current_title ilike ${like} or ${q.toLowerCase()} = any(c.tags))
      and (${!f.tag} or ${f.tag ?? ""} = any(c.tags))
      and (${!f.source} or c.source = ${f.source ?? ""})
      and (${!f.jobId} or exists (select 1 from applications a where a.candidate_id = c.id and a.job_id = ${f.jobId ?? null}))
    order by c.created_at desc limit 500`;
  const tags = await tx<{ tag: string; n: number }[]>`select t as tag, count(*)::int as n from candidates, unnest(tags) t group by t order by n desc, t limit 40`;
  return { rows, tags };
}

// ---------- create / update ----------
export type CandidateInput = {
  firstName: string; lastName: string | null; email: string; mobile: string | null; gender: string | null; currentCompany: string | null; currentTitle: string | null;
  experienceMonths: number | null; source: string; tags: string[]; custom: Record<string, unknown>;
};

function cleanInput(i: CandidateInput) {
  const first = i.firstName.trim().slice(0, 80), email = normalizeEmail(i.email);
  if (!first) throw new AppError("invalid", "Enter the candidate's first name.", "firstName");
  if (!isEmail(email)) throw new AppError("invalid", "Enter a valid email address.", "email");
  if (i.experienceMonths != null && (!Number.isInteger(i.experienceMonths) || i.experienceMonths < 0 || i.experienceMonths > 600)) throw new AppError("invalid", "Experience must be between 0 and 50 years.", "experience");
  if (!SOURCES.some((s) => s.value === i.source)) throw new AppError("invalid", "Pick where this candidate came from.", "source");
  if (i.mobile && !normalizePhone(i.mobile)) throw new AppError("invalid", "Enter a valid mobile number.", "mobile");
  return {
    first_name: first, last_name: i.lastName?.trim().slice(0, 80) || null, email, mobile: i.mobile?.trim().slice(0, 20) || null, gender: i.gender?.trim().slice(0, 30) || null,
    current_company: i.currentCompany?.trim().slice(0, 120) || null, current_title: i.currentTitle?.trim().slice(0, 120) || null, experience_months: i.experienceMonths, source: i.source as Source,
    tags: cleanTags(i.tags),
  };
}

/** Same email, or same mobile number, already in the database. */
export async function findDuplicate(tx: Tx, email: string, mobile: string | null) {
  const phone = normalizePhone(mobile);
  const [d] = await tx<{ id: string; name: string; email: string; by: "email" | "mobile" }[]>`
    select id, trim(first_name || ' ' || coalesce(last_name, '')) as name, email::text, case when email = ${normalizeEmail(email)}::citext then 'email' else 'mobile' end as by
    from candidates where email = ${normalizeEmail(email)}::citext or (${phone}::text is not null and regexp_replace(coalesce(mobile, ''), '\\D', '', 'g') like '%' || ${phone ?? ""})
    order by (email = ${normalizeEmail(email)}::citext) desc limit 1`;
  return d ?? null;
}

/**
 * Adds a candidate (optionally straight onto a job). A duplicate email is refused with the existing record named,
 * unless `useExisting` is set: then the existing candidate is added to the job instead.
 */
export async function createCandidate(tx: Tx, actor: Actor, input: CandidateInput, opts: { jobId?: string | null; resume?: Upload | null; useExisting?: boolean } = {}) {
  if (opts.jobId) await assertJobAct(tx, actor, opts.jobId);
  else if (!canRecruit(actor)) throw new AppError("forbidden", "Only recruiters can add candidates to the database.");
  const v = cleanInput(input);
  const custom = cleanCustom(await candidateFields(tx), input.custom ?? {});
  const dupe = await findDuplicate(tx, v.email, v.mobile);
  if (dupe) {
    if (!opts.useExisting || dupe.by !== "email") throw new AppError("conflict", `${dupe.name} (${dupe.email}) is already in your candidates with this ${dupe.by}.`, dupe.by === "email" ? "email" : "mobile");
    if (!opts.jobId) throw new AppError("conflict", `${dupe.name} is already in your candidates.`, "email");
    const app = await addToJob(tx, actor, dupe.id, opts.jobId, v.source, { skipJobCheck: true });
    return { candidateId: dupe.id, applicationId: app.applicationId, existing: true };
  }
  let resumeFileId: string | null = null, parsed: Record<string, unknown> = {};
  if (opts.resume) { const r = await saveResume(tx, actor.tenant.id, actor.userId, opts.resume); resumeFileId = r.fileId; parsed = r.parsed; }
  const [c] = await tx<{ id: string }[]>`
    insert into candidates ${tx({ ...v, tenant_id: actor.tenant.id, resume_file_id: resumeFileId, parsed: tx.json(parsed as never), custom: tx.json(custom) } as never)} returning id`;
  await audit(tx, actor, actor.tenant.id, "candidate", c.id, "create", { source: v.source, job_id: opts.jobId ?? null });
  let applicationId: string | null = null;
  if (opts.jobId) applicationId = (await addToJob(tx, actor, c.id, opts.jobId, v.source, { skipJobCheck: true })).applicationId;
  return { candidateId: c.id, applicationId, existing: false };
}

export async function updateCandidate(tx: Tx, actor: Actor, id: string, input: CandidateInput) {
  await assertCandidateAct(tx, actor, id);
  const v = cleanInput(input);
  const custom = cleanCustom(await candidateFields(tx), input.custom ?? {});
  const [other] = await tx`select 1 from candidates where email = ${v.email}::citext and id <> ${id}`;
  if (other) throw new AppError("conflict", "Another candidate already uses this email.", "email");
  await tx`update candidates set ${tx({ ...v, custom: tx.json(custom) } as never)} where id = ${id}`;
  await audit(tx, actor, actor.tenant.id, "candidate", id, "update");
}

export async function setTags(tx: Tx, actor: Actor, id: string, tags: string[]) {
  await assertCandidateAct(tx, actor, id);
  const t = cleanTags(tags);
  await tx`update candidates set tags = ${t}::text[] where id = ${id}`;
  await audit(tx, actor, actor.tenant.id, "candidate", id, "tags", { tags: t });
}

export async function replaceResume(tx: Tx, actor: Actor, id: string, f: Upload) {
  await assertCandidateAct(tx, actor, id);
  const r = await saveResume(tx, actor.tenant.id, actor.userId, f);
  await tx`update candidates set resume_file_id = ${r.fileId}, parsed = ${tx.json(r.parsed as never)} where id = ${id}`;
  await audit(tx, actor, actor.tenant.id, "candidate", id, "resume");
  return r;
}

// ---------- applications ----------
async function firstStage(tx: Tx, jobId: string) {
  const [s] = await tx<{ id: string; name: string; stage_group: StageGroup }[]>`
    select s.id, s.name, s.stage_group from jobs j join hiring_stages s on s.flow_id = j.hiring_flow_id where j.id = ${jobId} and s.stage_group not in ('hired','rejected') order by s.position limit 1`;
  if (!s) throw new AppError("invalid", "This job's hiring flow has no stages.");
  return s;
}

async function event(tx: Tx, tenantId: string, applicationId: string, kind: string, data: Record<string, unknown>, actorEmployeeId: string | null) {
  await tx`insert into application_events (tenant_id, application_id, kind, data, actor_employee_id) values (${tenantId}, ${applicationId}, ${kind}, ${tx.json(data as never)}, ${actorEmployeeId})`;
}
export { event as appEvent };

/** Puts a candidate on a job (or brings back a closed application). Recruiters may reopen without waiting for the cooldown. */
export async function addToJob(tx: Tx, actor: Actor, candidateId: string, jobId: string, source: string, opts: { skipJobCheck?: boolean } = {}) {
  if (!opts.skipJobCheck) { await assertJobAct(tx, actor, jobId); await assertCandidateSee(tx, actor, candidateId); }
  const [c] = await tx<{ employee_id: string | null }[]>`select employee_id from candidates where id = ${candidateId}`;
  if (!c) throw new AppError("not_found", "Candidate not found.");
  if (c.employee_id === actor.employeeId) throw new AppError("forbidden", "You can't add yourself to a job's pipeline.");
  const [job] = await tx<{ status: string }[]>`select status from jobs where id = ${jobId}`;
  if (job.status === "closed") throw new AppError("conflict", "This job is closed.");
  const stage = await firstStage(tx, jobId);
  const src = SOURCES.some((s) => s.value === source) ? source : "manual";
  const [prev] = await tx<{ id: string; status: string }[]>`select id, status from applications where job_id = ${jobId} and candidate_id = ${candidateId} for update`;
  if (prev) {
    if (prev.status === "active" || prev.status === "hired") throw new AppError("conflict", "This candidate is already on this job.");
    await tx`update applications set status = 'active', stage_id = ${stage.id}, stage_entered_at = now(), reject_reason = null, closed_at = null where id = ${prev.id}`;
    await event(tx, actor.tenant.id, prev.id, "reopened", { to: stage.name, to_group: stage.stage_group }, actor.employeeId);
    return { applicationId: prev.id, reopened: true };
  }
  const [a] = await tx<{ id: string }[]>`
    insert into applications (tenant_id, job_id, candidate_id, stage_id, owner_employee_id, source) values (${actor.tenant.id}, ${jobId}, ${candidateId}, ${stage.id}, ${actor.employeeId}, ${src}) returning id`;
  await event(tx, actor.tenant.id, a.id, "applied", { to: stage.name, to_group: stage.stage_group, source: src }, actor.employeeId);
  await audit(tx, actor, actor.tenant.id, "application", a.id, "create", { job_id: jobId, candidate_id: candidateId });
  return { applicationId: a.id, reopened: false };
}

type Mover = { tenantId: string; company: string; actorEmployeeId: string | null; actorUserId: string | null };

/** Core stage move shared by the board, bulk moves and automations: event, timestamps, on-enter email. */
async function moveCore(tx: Tx, m: Mover, app: { id: string; job_id: string; candidate_id: string; stage_id: string }, to: { id: string; name: string; stage_group: StageGroup; on_enter_email_key: string | null }) {
  const [from] = await tx<{ name: string; stage_group: StageGroup }[]>`select name, stage_group from hiring_stages where id = ${app.stage_id}`;
  await tx`update applications set stage_id = ${to.id}, stage_entered_at = now() where id = ${app.id}`;
  await event(tx, m.tenantId, app.id, "stage_change", { from: from?.name, from_group: from?.stage_group, to: to.name, to_group: to.stage_group }, m.actorEmployeeId);
  if (to.on_enter_email_key) {
    const v = await valuesFor(tx, m.company, app.id);
    await emailFromTemplate(tx, { tenantId: m.tenantId, company: m.company, to: v.email, applicationId: app.id, actorEmployeeId: m.actorEmployeeId, key: to.on_enter_email_key, values: v.values });
  }
}

/** Placeholder values for a candidate on an application. */
export async function valuesFor(tx: Tx, company: string, applicationId: string) {
  const [r] = await tx<{ first_name: string; last_name: string | null; email: string; title: string }[]>`
    select c.first_name, c.last_name, c.email::text, j.title from applications a join candidates c on c.id = a.candidate_id join jobs j on j.id = a.job_id where a.id = ${applicationId}`;
  return { email: r.email, values: { "candidate.first_name": r.first_name, "candidate.name": [r.first_name, r.last_name].filter(Boolean).join(" "), "job.title": r.title, "company.name": company } as Record<string, string | null> };
}

async function stageOnJob(tx: Tx, jobId: string, stageId: string) {
  const [s] = await tx<{ id: string; name: string; stage_group: StageGroup; on_enter_email_key: string | null }[]>`
    select s.id, s.name, s.stage_group, s.on_enter_email_key from jobs j join hiring_stages s on s.flow_id = j.hiring_flow_id where j.id = ${jobId} and s.id = ${stageId}`;
  if (!s) throw new AppError("invalid", "That stage isn't part of this job's hiring flow.", "stageId");
  return s;
}

export async function moveApplication(tx: Tx, actor: Actor, applicationId: string, stageId: string) {
  const { app } = await actOnApplication(tx, actor, applicationId);
  const to = await stageOnJob(tx, app.job_id, stageId);
  const problem = moveProblem(app.status, to.stage_group);
  if (problem) throw new AppError("invalid", problem, "stageId");
  if (app.stage_id === stageId) return { moved: false };
  await moveCore(tx, { tenantId: actor.tenant.id, company: actor.tenant.name, actorEmployeeId: actor.employeeId, actorUserId: actor.userId }, app, to);
  return { moved: true };
}

/** Moves each application it can; reports the ones it couldn't (and why) instead of failing the whole batch. */
export async function bulkMove(tx: Tx, actor: Actor, applicationIds: string[], stageId: string) {
  const done: string[] = [], failed: { id: string; error: string }[] = [];
  for (const id of applicationIds) {
    try { await tx.savepoint(async (sp) => { await moveApplication(sp, actor, id, stageId); }); done.push(id); }
    catch (e) { if (e instanceof AppError) failed.push({ id, error: e.message }); else throw e; }
  }
  return { moved: done.length, failed };
}

export async function rejectApplications(tx: Tx, actor: Actor, applicationIds: string[], reason: string, opts: { sendEmail: boolean; note?: string | null }) {
  const r = reason.trim().slice(0, 200);
  if (!r) throw new AppError("invalid", "Pick a reason.", "reason");
  if (!REJECT_REASONS.includes(r as (typeof REJECT_REASONS)[number]) && r.length < 3) throw new AppError("invalid", "Pick a reason.", "reason");
  let rejected = 0;
  const failed: { id: string; error: string }[] = [];
  for (const id of applicationIds) {
    try {
      await tx.savepoint(async (sp) => {
        const { app } = await actOnApplication(sp, actor, id);
        if (app.status !== "active") throw new AppError("conflict", "Already out of the process.");
        const [rej] = await sp<{ id: string; name: string }[]>`select s.id, s.name from jobs j join hiring_stages s on s.flow_id = j.hiring_flow_id where j.id = ${app.job_id} and s.stage_group = 'rejected' order by s.position limit 1`;
        const [from] = await sp<{ name: string; stage_group: StageGroup }[]>`select name, stage_group from hiring_stages where id = ${app.stage_id}`;
        await sp`update applications set status = 'rejected', reject_reason = ${r}, closed_at = now(), stage_id = coalesce(${rej?.id ?? null}, stage_id), stage_entered_at = now() where id = ${id}`;
        await event(sp, actor.tenant.id, id, "rejected", { reason: r, note: opts.note?.slice(0, 1000) || null, from: from.name, from_group: from.stage_group, previous_stage_id: app.stage_id }, actor.employeeId);
        await sp`update interviews set status = 'cancelled' where application_id = ${id} and status in ('scheduled','awaiting_candidate')`;
        await sp`update offers set status = 'withdrawn' where application_id = ${id} and status in ('draft','pending_approval','released')`;
        if (opts.sendEmail) {
          const v = await valuesFor(sp, actor.tenant.name, id);
          await emailFromTemplate(sp, { tenantId: actor.tenant.id, company: actor.tenant.name, to: v.email, applicationId: id, actorEmployeeId: actor.employeeId, key: "rejection", values: v.values });
        }
      });
      rejected++;
    } catch (e) { if (e instanceof AppError) failed.push({ id, error: e.message }); else throw e; }
  }
  if (rejected) await audit(tx, actor, actor.tenant.id, "application", null, "reject", { count: rejected, reason: r });
  return { rejected, failed };
}

/** Brings a rejected (or withdrawn) application back to the stage it was in. */
export async function restoreApplication(tx: Tx, actor: Actor, applicationId: string) {
  const { app } = await actOnApplication(tx, actor, applicationId);
  if (app.status !== "rejected" && app.status !== "withdrawn") throw new AppError("conflict", "Only rejected candidates can be brought back.");
  const [last] = await tx<{ data: { previous_stage_id?: string } }[]>`select data from application_events where application_id = ${applicationId} and kind = 'rejected' order by created_at desc limit 1`;
  let stage = last?.data.previous_stage_id ? await tx<{ id: string; name: string; stage_group: StageGroup }[]>`select id, name, stage_group from hiring_stages where id = ${last.data.previous_stage_id}`.then((r) => r[0]) : null;
  if (!stage || stage.stage_group === "rejected" || stage.stage_group === "hired") stage = await firstStage(tx, app.job_id);
  await tx`update applications set status = 'active', reject_reason = null, closed_at = null, stage_id = ${stage.id}, stage_entered_at = now() where id = ${applicationId}`;
  await event(tx, actor.tenant.id, applicationId, "restored", { to: stage.name, to_group: stage.stage_group }, actor.employeeId);
  await audit(tx, actor, actor.tenant.id, "application", applicationId, "restore");
}

// ---------- notes ----------
export async function addNote(tx: Tx, actor: Actor, candidateId: string, input: { body: string; applicationId?: string | null; isPrivate: boolean }) {
  await assertCandidateSee(tx, actor, candidateId);    // panelists may add notes too
  const body = input.body.trim().slice(0, 4000);
  if (!body) throw new AppError("invalid", "Write a note.", "body");
  if (input.applicationId) {
    const { app } = await seeApplication(tx, actor, input.applicationId);
    if (app.candidate_id !== candidateId) throw new AppError("invalid", "That application belongs to someone else.");
  }
  const [n] = await tx<{ id: string }[]>`
    insert into candidate_notes (tenant_id, candidate_id, application_id, author_employee_id, body, is_private) values (${actor.tenant.id}, ${candidateId}, ${input.applicationId ?? null}, ${actor.employeeId}, ${body}, ${input.isPrivate}) returning id`;
  // mentions: @Name of a teammate on one of the candidate's jobs gets a notification
  const mentioned = [...body.matchAll(/@([A-Z][a-z]+(?: [A-Z][a-z-]+)?)/g)].map((m) => m[1]);
  if (mentioned.length && !input.isPrivate) {
    const team = await tx<{ id: string; name: string }[]>`select distinct e.id, e.display_name as name from applications a join job_team_members t on t.job_id = a.job_id join employees e on e.id = t.employee_id where a.candidate_id = ${candidateId}`;
    for (const p of team) if (p.id !== actor.employeeId && mentioned.some((m) => p.name.startsWith(m))) {
      await notifyEmployee(tx, actor.tenant.id, p.id, "hire.mention", `${actor.name} mentioned you`, body.slice(0, 140), `/hire/candidates/${candidateId}`);
    }
  }
  await audit(tx, actor, actor.tenant.id, "candidate_note", n.id, "create", { candidate_id: candidateId });
  return n;
}

export async function deleteNote(tx: Tx, actor: Actor, noteId: string) {
  const r = await tx`delete from candidate_notes where id = ${noteId} and author_employee_id = ${actor.employeeId}`;
  if (!r.count) throw new AppError("not_found", "You can only delete your own notes.");
  await audit(tx, actor, actor.tenant.id, "candidate_note", noteId, "delete");
}

// ---------- emails ----------
export async function sendEmail(tx: Tx, actor: Actor, applicationId: string, input: { templateKey?: string | null; subject: string; body: string }) {
  const { app } = await actOnApplication(tx, actor, applicationId);
  const subject = input.subject.trim().slice(0, 200), body = input.body.trim().slice(0, 8000);
  if (!subject) throw new AppError("invalid", "Write a subject.", "subject");
  if (!body) throw new AppError("invalid", "Write the email.", "body");
  const v = await valuesFor(tx, actor.tenant.name, app.id);
  const { mergeText } = await import("./rules");
  await emailCandidate(tx, { tenantId: actor.tenant.id, company: actor.tenant.name, to: v.email, applicationId, actorEmployeeId: actor.employeeId, subject: mergeText(subject, v.values), body: mergeText(body, v.values), kind: input.templateKey || "custom" });
  await audit(tx, actor, actor.tenant.id, "application", applicationId, "email", { subject });
}

export async function emailDraft(tx: Tx, actor: Actor, applicationId: string, key: string) {
  const { app } = await seeApplication(tx, actor, applicationId);
  const v = await valuesFor(tx, actor.tenant.name, app.id);
  return renderTemplate(tx, key, v.values);
}

// ---------- import ----------
export async function importTemplate() {
  const wb = new ExcelJS.Workbook();
  wb.creator = "erp";
  const ws = wb.addWorksheet("Candidates", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = IMPORT_COLUMNS.map((c) => ({ header: c.required ? `${c.header} *` : c.header, key: c.key, width: c.width }));
  ws.getRow(1).font = { bold: true };
  ws.addRow(Object.fromEntries(IMPORT_COLUMNS.map((c) => [c.key, c.example])));
  ws.getRow(2).font = { italic: true, color: { argb: "FF6B7480" } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Reads the sheet and adds new candidates (skipping emails already in the database, which are reported). */
export async function importCandidates(tx: Tx, actor: Actor, bytes: ArrayBuffer, jobId: string | null) {
  if (jobId) await assertJobAct(tx, actor, jobId);
  else if (!canRecruit(actor)) throw new AppError("forbidden", "Only recruiters can import candidates.");
  if (bytes.byteLength > 5 * 1024 * 1024) throw new AppError("invalid", "The file is larger than 5 MB.");
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(bytes); } catch { throw new AppError("invalid", "This isn't an Excel (.xlsx) file. Download the template and fill that in."); }
  const ws = wb.getWorksheet("Candidates") ?? wb.worksheets[0];
  if (!ws) throw new AppError("invalid", "The file has no sheets.");
  const norm = (s: unknown) => String(s ?? "").replace(/\*/g, "").trim().toLowerCase();
  const colOf = new Map<string, number>();
  ws.getRow(1).eachCell((cell, i) => { const c = IMPORT_COLUMNS.find((x) => x.header.toLowerCase() === norm(cell.value)); if (c) colOf.set(c.key, i); });
  if (!colOf.has("firstName") || !colOf.has("email")) throw new AppError("invalid", "The sheet needs First name and Email columns. Use the template.");
  const raw: { row: number; values: Record<string, string> }[] = [];
  ws.eachRow({ includeEmpty: false }, (r, n) => {
    if (n === 1) return;
    const cell = (i: number) => { const v = r.getCell(i).value as unknown; return v && typeof v === "object" && "text" in (v as object) ? String((v as { text: string }).text) : String(v ?? ""); };
    raw.push({ row: n, values: Object.fromEntries([...colOf].map(([k, i]) => [k, cell(i)])) });
  });
  const example = IMPORT_COLUMNS.find((c) => c.key === "email")!.example;
  const v = validateImportRows(raw.filter((r) => r.values.email?.trim().toLowerCase() !== example));
  if (v.rows.length > MAX_IMPORT_ROWS) throw new AppError("invalid", `Import at most ${MAX_IMPORT_ROWS} candidates at a time.`);
  let added = 0;
  const skipped: { row: number; error: string }[] = [...v.errors];
  for (const r of v.rows) {
    const [dupe] = await tx<{ id: string }[]>`select id from candidates where email = ${r.email}::citext`;
    if (dupe) {
      if (jobId) {
        try { await tx.savepoint((sp) => addToJob(sp, actor, dupe.id, jobId, "import", { skipJobCheck: true })); added++; }
        catch (e) { if (e instanceof AppError) skipped.push({ row: r.row, error: e.message }); else throw e; }
      } else skipped.push({ row: r.row, error: "Already in your candidates." });
      continue;
    }
    const [c] = await tx<{ id: string }[]>`
      insert into candidates (tenant_id, first_name, last_name, email, mobile, current_company, current_title, experience_months, source, tags)
      values (${actor.tenant.id}, ${r.firstName}, ${r.lastName}, ${r.email}, ${r.mobile}, ${r.currentCompany}, ${r.currentTitle}, ${r.experienceMonths}, 'import', ${r.tags}::text[]) returning id`;
    if (jobId) await addToJob(tx, actor, c.id, jobId, "import", { skipJobCheck: true });
    added++;
  }
  await audit(tx, actor, actor.tenant.id, "candidate", null, "import", { added, skipped: skipped.length, job_id: jobId });
  return { added, skipped: skipped.sort((a, b) => a.row - b.row) };
}

// ---------- profile ----------
export async function candidateProfile(tx: Tx, actor: Actor, id: string) {
  const access = await assertCandidateSee(tx, actor, id);
  const [c] = await tx<{
    id: string; first_name: string; last_name: string | null; email: string; mobile: string | null; gender: string | null; current_company: string | null; current_title: string | null;
    experience_months: number | null; source: string; tags: string[]; custom: Record<string, string | number>; parsed: { skills?: string[]; text?: string; linkedin?: string | null };
    resume_file_id: string | null; resume_name: string | null; employee_id: string | null; consent_at: Date | null; created_at: Date;
  }[]>`
    select c.id, c.first_name, c.last_name, c.email::text, c.mobile, c.gender, c.current_company, c.current_title, c.experience_months, c.source, c.tags, c.custom,
      c.parsed - 'text' || jsonb_build_object('text', left(c.parsed->>'text', 3000)) as parsed, c.resume_file_id, f.name as resume_name, c.employee_id, c.consent_at, c.created_at
    from candidates c left join files f on f.id = c.resume_file_id where c.id = ${id}`;
  const ids = await visibleJobIds(tx, actor);
  const apps = await tx<{ id: string; job_id: string; job: string; job_status: string; stage_id: string; stage: string; group: StageGroup; status: string; source: string; reject_reason: string | null;
    created_at: Date; stage_entered_at: Date; referred_by: string | null; flow_id: string }[]>`
    select a.id, a.job_id, j.title as job, j.status as job_status, a.stage_id, s.name as stage, s.stage_group as group, a.status, a.source, a.reject_reason, a.created_at, a.stage_entered_at,
      r.display_name as referred_by, j.hiring_flow_id as flow_id
    from applications a join jobs j on j.id = a.job_id join hiring_stages s on s.id = a.stage_id left join employees r on r.id = a.referred_by_employee_id
    where a.candidate_id = ${id} and (${ids === null} or a.job_id = any(${ids ?? []}::uuid[])) order by a.created_at desc`;
  const appIds = apps.map((a) => a.id);
  const actable: string[] = [];
  for (const a of apps) if ((await jobAccess(tx, actor, a.job_id)).act) actable.push(a.id);
  const [stages, interviews, feedback, notes, events, offers, docs, tasks, fields, scorecards] = await Promise.all([
    tx<{ id: string; flow_id: string; name: string; stage_group: StageGroup; position: number }[]>`select id, flow_id, name, stage_group, position from hiring_stages where flow_id = any(${[...new Set(apps.map((a) => a.flow_id))]}::uuid[]) order by position`,
    tx<{ id: string; application_id: string; title: string | null; mode: string; scheduling: string; starts_at: Date | null; ends_at: Date | null; meeting_url: string | null; location: string | null; status: string;
      scorecard_id: string | null; scorecard: string | null; panel: { id: string; name: string; submitted: boolean }[]; slots: number }[]>`
      select i.id, i.application_id, i.title, i.mode, i.scheduling, i.starts_at, i.ends_at, i.meeting_url, i.location, i.status, i.scorecard_id, sc.name as scorecard,
        coalesce((select json_agg(json_build_object('id', e.id, 'name', e.display_name, 'submitted', exists (select 1 from scorecard_submissions x where x.interview_id = i.id and x.interviewer_employee_id = e.id and x.submitted_at is not null)) order by e.display_name)
          from interview_panelists p join employees e on e.id = p.employee_id where p.interview_id = i.id), '[]') as panel,
        coalesce(cardinality(i.slot_options), 0) as slots
      from interviews i left join scorecards sc on sc.id = i.scorecard_id where i.application_id = any(${appIds}::uuid[]) order by i.starts_at desc nulls first, i.created_at desc`,
    tx<{ id: string; application_id: string; interview_id: string | null; interviewer: string; interviewer_id: string; overall: number | null; recommendation: string | null; comments: string | null; ratings: Record<string, number>; submitted_at: Date | null; scorecard_id: string; sections: { title: string; criteria: { id: string; label: string }[] }[]; points: { value: number; label: string }[] }[]>`
      select x.id, x.application_id, x.interview_id, e.display_name as interviewer, e.id as interviewer_id, x.overall::float, x.recommendation, x.comments, x.ratings, x.submitted_at, x.scorecard_id, sc.sections, rs.points
      from scorecard_submissions x join employees e on e.id = x.interviewer_employee_id join scorecards sc on sc.id = x.scorecard_id join rating_scales rs on rs.id = sc.rating_scale_id
      where x.application_id = any(${appIds}::uuid[]) and x.submitted_at is not null order by x.submitted_at desc`,
    tx<{ id: string; body: string; is_private: boolean; author: string; author_id: string; created_at: Date; application_id: string | null }[]>`
      select n.id, n.body, n.is_private, e.display_name as author, e.id as author_id, n.created_at, n.application_id from candidate_notes n join employees e on e.id = n.author_employee_id
      where n.candidate_id = ${id} and (not n.is_private or n.author_employee_id = ${actor.employeeId}) order by n.created_at desc`,
    tx<{ id: string; application_id: string; kind: string; data: Record<string, unknown>; actor: string | null; created_at: Date }[]>`
      select ev.id, ev.application_id, ev.kind, ev.data, e.display_name as actor, ev.created_at from application_events ev left join employees e on e.id = ev.actor_employee_id
      where ev.application_id = any(${appIds}::uuid[]) order by ev.created_at desc limit 300`,
    tx<{ id: string; application_id: string; version: number; status: string; ctc_paise: bigint; joining_date: string; expires_on: string | null; designation: string | null; letter_file_id: string | null; created_at: Date; released_at: Date | null; responded_at: Date | null; signed_name: string | null; decline_reason: string | null; template: string | null; approval: string | null }[]>`
      select o.id, o.application_id, o.version, o.status, o.ctc_paise, o.joining_date::text, o.expires_on::text, d.title as designation, g.file_id as letter_file_id, o.created_at, o.released_at, o.responded_at, o.signed_name, o.decline_reason, t.name as template,
        (select q.status from approval_requests q where q.entity_type = 'offer' and q.entity_id = o.id order by q.created_at desc limit 1) as approval
      from offers o left join designations d on d.id = o.designation_id left join generated_letters g on g.id = o.letter_id left join letter_templates t on t.id = o.template_id
      where o.application_id = any(${appIds}::uuid[]) order by o.version desc`,
    tx<{ id: string; doc_type: string; required: boolean; status: string; file_id: string | null; file_name: string | null; reviewer_comment: string | null; updated_at: Date }[]>`
      select r.id, r.doc_type, r.required, r.status, r.file_id, f.name as file_name, r.reviewer_comment, r.updated_at from document_requests r left join files f on f.id = r.file_id where r.candidate_id = ${id} order by r.created_at`,
    tx<{ id: string; title: string; description: string | null; done_at: Date | null }[]>`select id, title, description, done_at from preboarding_tasks where candidate_id = ${id} order by created_at`,
    candidateFields(tx),
    tx<{ id: string; name: string }[]>`select id, name from scorecards order by name`,
  ]);
  return {
    candidate: c, access, apps, actable, stages, interviews, feedback, notes, events, docs, tasks, fields, scorecards,
    offers: offers.map((o) => ({ ...o, ctc_paise: Number(o.ctc_paise) })),
    canAdmin: canAdminHire(actor),
  };
}

export async function parseOnly(f: Upload) {
  const ext = f.name.toLowerCase().split(".").pop() ?? "";
  if (!RESUME_EXTS.has(ext)) throw new AppError("invalid", "Upload the resume as a PDF, Word (.docx) or text file.", "resume");
  const v = validateUpload({ name: f.name, size: f.bytes.byteLength, head: f.bytes.subarray(0, 512) });
  if (!v.ok) throw new AppError("invalid", v.error, "resume");
  const { text: _t, ...p } = parseResume(v.name, f.bytes);
  void _t;
  return p;
}

// ---------- files ----------
/**
 * May the actor open a hiring file? Resumes and preboarding documents of candidates they can see, and offer letters
 * of applications they can see. Same null for "missing" and "not yours".
 */
export async function hireFileFor(tx: Tx, actor: Actor, fileId: string) {
  const [f] = await tx<{ id: string; storage_key: string; name: string; mime: string; candidate_id: string | null }[]>`
    select f.id, f.storage_key, f.name, f.mime,
      coalesce((select c.id from candidates c where c.resume_file_id = f.id limit 1),
               (select r.candidate_id from document_requests r where r.file_id = f.id limit 1),
               (select g.candidate_id from generated_letters g where g.file_id = f.id limit 1)) as candidate_id
    from files f where f.id = ${fileId}`;
  if (!f?.candidate_id) return null;
  const a = await candidateAccess(tx, actor, f.candidate_id);
  return a.see ? f : null;
}

export const STAGE_ORDER = GROUP_ORDER;
