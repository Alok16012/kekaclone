import "server-only";
import { randomInt } from "node:crypto";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { cancelApproval, notifyEmployee, startApproval, type Level } from "@/server/modules/approvals/service";
import { createEmployee } from "@/server/modules/employees/service";
import { letterDate, mergeTemplate, safeFileName, sanitizeHtml, validateUpload } from "@/server/modules/documents/rules";
import { renderLetterPdf } from "@/server/modules/documents/pdf";
import { saveFile } from "@/server/storage";
import { queueEmail } from "@/server/email";
import { sha256 } from "@/server/auth/password";
import { addDaysISO, todayIn } from "@/lib/dates";
import { actOnApplication, assertCandidateAct, canAdminHire, HIRE_ADMIN, seeApplication, visibleJobIds } from "./access";
import { appEvent, valuesFor } from "./candidates";
import { audit } from "./setup";
import { candidateMail, emailFromTemplate } from "./mail";
import { findToken, issueToken, publicLink } from "./tokens";
import { DEFAULT_PREBOARDING_DOCS, DEFAULT_PREBOARDING_TASKS, isEmail, normalizeEmail, offerNext, OFFER_PLACEHOLDERS, type OfferAction } from "./rules";

const inr0 = (paise: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(paise / 100);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const PORTAL_DAYS = 30, OTP_MINUTES = 10, OTP_TRIES = 5;

export type OfferInput = { templateId: string; designationId: string | null; ctcPaise: number; joiningDate: string; expiresOn: string | null; note: string | null };

async function checkInput(tx: Tx, i: OfferInput) {
  const [t] = await tx`select 1 from letter_templates where id = ${i.templateId} and kind = 'offer'`;
  if (!t) throw new AppError("invalid", "Pick an offer letter template.", "templateId");
  if (i.designationId) { const [d] = await tx`select 1 from designations where id = ${i.designationId}`; if (!d) throw new AppError("invalid", "Pick a designation.", "designationId"); }
  if (!Number.isInteger(i.ctcPaise) || i.ctcPaise <= 0 || i.ctcPaise > 1e13) throw new AppError("invalid", "Enter the annual CTC in rupees.", "ctc");
  const today = todayIn();
  if (!ISO.test(i.joiningDate) || i.joiningDate < today) throw new AppError("invalid", "Pick a joining date from today on.", "joiningDate");
  if (i.expiresOn && (!ISO.test(i.expiresOn) || i.expiresOn < today)) throw new AppError("invalid", "The accept-by date can't be in the past.", "expiresOn");
  if (i.expiresOn && i.expiresOn > i.joiningDate) throw new AppError("invalid", "The accept-by date should be on or before the joining date.", "expiresOn");
}

async function nextVersion(tx: Tx, applicationId: string) {
  const [v] = await tx<{ v: number }[]>`select coalesce(max(version), 0) + 1 as v from offers where application_id = ${applicationId}`;
  return v.v;
}

async function liveOffer(tx: Tx, applicationId: string) {
  const [o] = await tx<{ id: string; status: string }[]>`select id, status from offers where application_id = ${applicationId} and status in ('draft','pending_approval','released','accepted') for update`;
  return o ?? null;
}

/** Drafts an offer for an active application (one live offer at a time; use Revise to change a sent one). */
export async function createOffer(tx: Tx, actor: Actor, applicationId: string, input: OfferInput) {
  const { app } = await actOnApplication(tx, actor, applicationId);
  if (app.status !== "active") throw new AppError("conflict", "This candidate is no longer active on the job.");
  await checkInput(tx, input);
  if (await liveOffer(tx, applicationId)) throw new AppError("conflict", "This candidate already has an offer. Revise or withdraw it instead.");
  const version = await nextVersion(tx, applicationId);
  const [o] = await tx<{ id: string }[]>`
    insert into offers (tenant_id, application_id, version, designation_id, ctc_paise, joining_date, expires_on, status, template_id, note, created_by)
    values (${actor.tenant.id}, ${applicationId}, ${version}, ${input.designationId}, ${input.ctcPaise}, ${input.joiningDate}, ${input.expiresOn}, 'draft', ${input.templateId}, ${input.note?.trim().slice(0, 2000) || null}, ${actor.userId}) returning id`;
  // move to the first Offer stage if the candidate isn't there yet
  const [stage] = await tx<{ id: string; name: string; stage_group: string; current_group: string }[]>`
    select s.id, s.name, s.stage_group, cur.stage_group as current_group from applications a join jobs j on j.id = a.job_id join hiring_stages s on s.flow_id = j.hiring_flow_id and s.stage_group = 'offer'
    join hiring_stages cur on cur.id = a.stage_id where a.id = ${applicationId} order by s.position limit 1`;
  if (stage && stage.current_group !== "offer") {
    await tx`update applications set stage_id = ${stage.id}, stage_entered_at = now() where id = ${applicationId}`;
    await appEvent(tx, actor.tenant.id, applicationId, "stage_change", { to: stage.name, to_group: "offer", reason: "offer drafted" }, actor.employeeId);
  }
  await appEvent(tx, actor.tenant.id, applicationId, "offer", { offer_id: o.id, version, action: "drafted", ctc_paise: input.ctcPaise }, actor.employeeId);
  await audit(tx, actor, actor.tenant.id, "offer", o.id, "create", { application_id: applicationId, version, ctc_paise: input.ctcPaise });
  return { id: o.id, version };
}

type OfferRow = { id: string; application_id: string; status: string; version: number; ctc_paise: bigint; joining_date: string; expires_on: string | null; designation_id: string | null; template_id: string | null; note: string | null; letter_id: string | null; created_by: string | null };

async function offerFor(tx: Tx, actor: Actor, offerId: string) {
  const [o] = await tx<OfferRow[]>`select id, application_id, status, version, ctc_paise, joining_date::text, expires_on::text, designation_id, template_id, note, letter_id, created_by from offers where id = ${offerId} for update`;
  if (!o) throw new AppError("not_found", "Offer not found.");
  const { app } = await actOnApplication(tx, actor, o.application_id);
  return { offer: o, app };
}

function step(o: { status: string }, action: OfferAction) {
  const next = offerNext(o.status, action);
  if (!next) throw new AppError("conflict", "The offer can't do that from its current state.");
  return next;
}

async function approvalState(tx: Tx, offerId: string) {
  const [q] = await tx<{ status: string }[]>`select status from approval_requests where entity_type = 'offer' and entity_id = ${offerId} order by created_at desc limit 1`;
  return q?.status ?? null;
}

/** Resolves the approval chain to named people, leaving out the person asking and the candidate (internal applicants). */
async function offerApprovers(tx: Tx, requesterId: string, candidateEmployeeId: string | null, jobId: string): Promise<Level[]> {
  const [wf] = await tx<{ levels: Level[] }[]>`select levels from approval_workflows where entity_type = 'offer' and is_active order by priority desc limit 1`;
  const skip = new Set([requesterId, candidateEmployeeId].filter(Boolean) as string[]);
  const ids: string[] = [];
  const add = (id: string | null | undefined) => { if (id && !skip.has(id) && !ids.includes(id)) ids.push(id); };
  if (wf) {
    for (const l of wf.levels) {
      if (l.approver === "manager" || l.approver === "l2_manager") {
        const [r] = await tx<{ id: string | null }[]>`select ${tx(l.approver === "manager" ? "manager_id" : "l2_manager_id")} as id from employees where id = ${requesterId}`;
        add(r?.id);
      } else if (l.approver === "employee") add(l.id);
      else {
        const holders = await tx<{ id: string }[]>`select ra.employee_id as id from role_assignments ra join roles ro on ro.id = ra.role_id join employees e on e.id = ra.employee_id and e.status <> 'relieved' where ro.key = ${l.role ?? "global_admin"} order by ra.created_at`;
        add(holders.find((h) => !skip.has(h.id))?.id);
      }
    }
  } else {
    // default: the job's hiring managers, then an HR admin
    for (const m of await tx<{ id: string }[]>`select employee_id as id from job_team_members where job_id = ${jobId} and role = 'hiring_manager' order by employee_id`) add(m.id);
    const holders = await tx<{ id: string }[]>`select ra.employee_id as id from role_assignments ra join roles ro on ro.id = ra.role_id join employees e on e.id = ra.employee_id and e.status <> 'relieved' where ro.key in ('hr_admin','global_admin') order by ro.key = 'hr_admin' desc, ra.created_at`;
    add(holders.find((h) => !skip.has(h.id))?.id);
  }
  return ids.map((id) => ({ approver: "employee", id }));
}

export async function updateOffer(tx: Tx, actor: Actor, offerId: string, input: OfferInput) {
  const { offer } = await offerFor(tx, actor, offerId);
  if (offer.status !== "draft" || (await approvalState(tx, offerId))) throw new AppError("conflict", "This offer was already sent for approval. Revise it to make changes.");
  await checkInput(tx, input);
  await tx`update offers set template_id = ${input.templateId}, designation_id = ${input.designationId}, ctc_paise = ${input.ctcPaise}, joining_date = ${input.joiningDate}, expires_on = ${input.expiresOn}, note = ${input.note?.trim().slice(0, 2000) || null} where id = ${offerId}`;
  await audit(tx, actor, actor.tenant.id, "offer", offerId, "update", { ctc_paise: input.ctcPaise });
}

export async function submitOffer(tx: Tx, actor: Actor, offerId: string) {
  const { offer, app } = await offerFor(tx, actor, offerId);
  const st = await approvalState(tx, offerId);
  if (st === "approved") throw new AppError("conflict", "This offer is already approved. Release it to the candidate.");
  const next = step(offer, "submit");
  const v = await valuesFor(tx, actor.tenant.name, app.id);
  await tx`update offers set status = ${next} where id = ${offerId}`;
  const levels = await offerApprovers(tx, actor.employeeId, app.candidate_employee_id, app.job_id);
  const r = await startApproval(tx, {
    tenantId: actor.tenant.id, entityType: "offer", entityId: offerId, requesterId: actor.employeeId, levels,
    summary: `${actor.name} · Offer: ${v.values["candidate.name"]} for ${v.values["job.title"]}, ${inr0(Number(offer.ctc_paise))} a year`,
  });
  if (r.status === "approved") await onOfferDecided(tx, actor, offerId, "approved");
  await appEvent(tx, actor.tenant.id, app.id, "offer", { offer_id: offerId, version: offer.version, action: "sent_for_approval" }, actor.employeeId);
  await audit(tx, actor, actor.tenant.id, "offer", offerId, "submit", { auto_approved: r.status === "approved", approvers: levels.length });
  return { approved: r.status === "approved" };
}

/** Approval engine callback: back to draft either way; release is allowed once the latest approval is 'approved'. */
export async function onOfferDecided(tx: Tx, _actor: Actor | null, offerId: string, final: "approved" | "rejected") {
  const [o] = await tx<{ application_id: string; created_by: string | null; tenant_id: string }[]>`
    update offers set status = 'draft' where id = ${offerId} and status = 'pending_approval' returning application_id, created_by, tenant_id`;
  if (!o) return;
  await appEvent(tx, o.tenant_id, o.application_id, "offer", { offer_id: offerId, action: final === "approved" ? "approved" : "approval_declined" }, null);
  const [creator] = await tx<{ id: string }[]>`select e.id from employees e where e.user_id = ${o.created_by}`;
  const [c] = await tx<{ candidate_id: string }[]>`select candidate_id from applications where id = ${o.application_id}`;
  if (creator) await notifyEmployee(tx, o.tenant_id, creator.id, `hire.offer_${final}`, final === "approved" ? "Offer approved: ready to release" : "Offer declined by an approver", "", `/hire/candidates/${c.candidate_id}`);
}

function letterValues(base: Record<string, string | null>, o: { ctc_paise: number; joining_date: string; expires_on: string | null }, extra: { designation: string | null; department: string | null; location: string | null }) {
  return {
    ...base, "offer.designation": extra.designation ?? base["job.title"], "offer.department": extra.department, "offer.location": extra.location,
    "offer.ctc": inr0(o.ctc_paise), "offer.joining_date": letterDate(o.joining_date), "offer.expires_on": letterDate(o.expires_on), today: letterDate(todayIn()),
  } as Record<string, string | null>;
}

async function mergedOffer(tx: Tx, company: string, offerId: string) {
  const [o] = await tx<{ application_id: string; ctc_paise: bigint; joining_date: string; expires_on: string | null; body_html: string | null; template: string | null; designation: string | null; department: string | null; location: string | null }[]>`
    select o.application_id, o.ctc_paise, o.joining_date::text, o.expires_on::text, t.body_html, t.name as template, d.title as designation, dp.name as department, l.name as location
    from offers o join applications a on a.id = o.application_id join jobs j on j.id = a.job_id left join letter_templates t on t.id = o.template_id
    left join designations d on d.id = o.designation_id left join departments dp on dp.id = j.department_id left join locations l on l.id = j.location_id where o.id = ${offerId}`;
  if (!o.body_html) throw new AppError("invalid", "The offer's letter template was deleted. Pick another template.");
  const v = await valuesFor(tx, company, o.application_id);
  const values = letterValues(v.values, { ctc_paise: Number(o.ctc_paise), joining_date: o.joining_date, expires_on: o.expires_on }, o);
  const merged = mergeTemplate(sanitizeHtml(o.body_html), values);
  // labels for missing values come from the offer placeholder list
  const html = merged.html.replace(/\[([a-z_.]+)\]/g, (m, k: string) => `[${OFFER_PLACEHOLDERS.find((p) => p.key === k)?.label ?? k}]`);
  return { html, missing: merged.missing, values, template: o.template ?? "Offer letter", email: v.email };
}

export async function previewOffer(tx: Tx, actor: Actor, offerId: string) {
  const [o] = await tx<{ application_id: string }[]>`select application_id from offers where id = ${offerId}`;
  if (!o) throw new AppError("not_found", "Offer not found.");
  await seeApplication(tx, actor, o.application_id);
  const m = await mergedOffer(tx, actor.tenant.name, offerId);
  return { html: m.html, missing: m.missing };
}

/** Sends an approved offer: renders the letter, opens the candidate portal (offer + documents + tasks) and emails the link. */
export async function releaseOffer(tx: Tx, actor: Actor, offerId: string) {
  const { offer, app } = await offerFor(tx, actor, offerId);
  if ((await approvalState(tx, offerId)) !== "approved") throw new AppError("conflict", "The offer needs approval before it can be sent.");
  const next = step(offer, "release");
  const m = await mergedOffer(tx, actor.tenant.name, offerId);
  if (m.missing.length) throw new AppError("invalid", `Fill in ${m.missing.map((k) => OFFER_PLACEHOLDERS.find((p) => p.key === k)?.label ?? k).join(", ")} before sending.`);
  const name = m.values["candidate.name"] ?? "Candidate";
  const pdf = await renderLetterPdf({ html: m.html, title: `${m.template} · ${name}`, company: actor.tenant.name, footer: `${m.template} for ${name} · version ${offer.version}` });
  const fileId = await saveFile(tx, { tenantId: actor.tenant.id, userId: actor.userId, name: safeFileName(`${m.template} - ${name} (v${offer.version}).pdf`), mime: "application/pdf", bytes: pdf, ext: "pdf" });
  const [g] = await tx<{ id: string }[]>`
    insert into generated_letters (tenant_id, template_id, candidate_id, data, file_id, status) values (${actor.tenant.id}, ${offer.template_id}, ${app.candidate_id}, ${tx.json({ html: m.html, values: m.values } as never)}, ${fileId}, 'pending_signature') returning id`;
  await tx`update offers set status = ${next}, letter_id = ${g.id}, released_at = now(), otp_hash = null, otp_attempts = 0 where id = ${offerId}`;
  // preboarding: default document requests and tasks the first time
  const [hasDocs] = await tx`select 1 from document_requests where candidate_id = ${app.candidate_id} limit 1`;
  if (!hasDocs) for (const d of DEFAULT_PREBOARDING_DOCS) await tx`insert into document_requests (tenant_id, candidate_id, doc_type, required) values (${actor.tenant.id}, ${app.candidate_id}, ${d}, ${d !== "Passport-size photo"})`;
  const [hasTasks] = await tx`select 1 from preboarding_tasks where candidate_id = ${app.candidate_id} limit 1`;
  if (!hasTasks) for (const t of DEFAULT_PREBOARDING_TASKS) await tx`insert into preboarding_tasks (tenant_id, candidate_id, title) values (${actor.tenant.id}, ${app.candidate_id}, ${t})`;
  const token = await issueToken(tx, { tenantId: actor.tenant.id, kind: "portal", candidateId: app.candidate_id, days: PORTAL_DAYS });
  const link = publicLink(actor.tenant.subdomain, "portal", token);
  await emailFromTemplate(tx, { tenantId: actor.tenant.id, company: actor.tenant.name, to: m.email, applicationId: app.id, actorEmployeeId: actor.employeeId, key: "offer_released", values: { ...m.values, link } });
  await appEvent(tx, actor.tenant.id, app.id, "offer", { offer_id: offerId, version: offer.version, action: "released" }, actor.employeeId);
  await audit(tx, actor, actor.tenant.id, "offer", offerId, "release", { letter_id: g.id });
  return { link, letterFileId: fileId };
}

/** A new version replacing the current one (draft, waiting or sent). The old one stops working in the portal. */
export async function reviseOffer(tx: Tx, actor: Actor, offerId: string, input: OfferInput) {
  const { offer, app } = await offerFor(tx, actor, offerId);
  const next = step(offer, "revise");
  await checkInput(tx, input);
  if (offer.status === "pending_approval") await cancelApproval(tx, "offer", offerId);
  await tx`update offers set status = ${next} where id = ${offerId}`;
  if (offer.letter_id) await tx`update generated_letters set status = 'void' where id = ${offer.letter_id}`;
  const version = await nextVersion(tx, app.id);
  const [o] = await tx<{ id: string }[]>`
    insert into offers (tenant_id, application_id, version, designation_id, ctc_paise, joining_date, expires_on, status, template_id, note, created_by)
    values (${actor.tenant.id}, ${app.id}, ${version}, ${input.designationId}, ${input.ctcPaise}, ${input.joiningDate}, ${input.expiresOn}, 'draft', ${input.templateId}, ${input.note?.trim().slice(0, 2000) || null}, ${actor.userId}) returning id`;
  await appEvent(tx, actor.tenant.id, app.id, "offer", { offer_id: o.id, version, action: "revised", replaces: offer.version }, actor.employeeId);
  await audit(tx, actor, actor.tenant.id, "offer", o.id, "revise", { replaces: offerId, version });
  return { id: o.id, version };
}

export async function withdrawOffer(tx: Tx, actor: Actor, offerId: string, reason: string | null) {
  const { offer, app } = await offerFor(tx, actor, offerId);
  const next = step(offer, "withdraw");
  if (offer.status === "pending_approval") await cancelApproval(tx, "offer", offerId);
  await tx`update offers set status = ${next} where id = ${offerId}`;
  if (offer.letter_id) await tx`update generated_letters set status = 'void' where id = ${offer.letter_id}`;
  await appEvent(tx, actor.tenant.id, app.id, "offer", { offer_id: offerId, version: offer.version, action: "withdrawn", reason: reason?.slice(0, 500) || null }, actor.employeeId);
  await audit(tx, actor, actor.tenant.id, "offer", offerId, "withdraw");
}

/** Job: released offers past their accept-by date expire. Safe to re-run. */
export async function expireOffers(tx: Tx, today = todayIn()) {
  const rows = await tx<{ id: string; application_id: string; tenant_id: string }[]>`
    update offers set status = 'expired' where status = 'released' and expires_on < ${today} returning id, application_id, tenant_id`;
  for (const r of rows) await appEvent(tx, r.tenant_id, r.application_id, "offer", { offer_id: r.id, action: "expired" }, null);
  return rows.length;
}

// ---------- preboarding (recruiter side) ----------
export async function preboardingBoard(tx: Tx, actor: Actor) {
  const ids = await visibleJobIds(tx, actor);
  const offers = await tx<{ id: string; application_id: string; candidate_id: string; candidate: string; email: string; job: string; job_id: string; version: number; status: string; ctc_paise: bigint;
    joining_date: string; expires_on: string | null; released_at: Date | null; responded_at: Date | null; approval: string | null; docs_total: number; docs_uploaded: number; docs_approved: number;
    tasks_total: number; tasks_done: number; app_status: string; employee_id: string | null }[]>`
    select o.id, a.id as application_id, c.id as candidate_id, trim(c.first_name || ' ' || coalesce(c.last_name, '')) as candidate, c.email::text, j.title as job, j.id as job_id, o.version, o.status, o.ctc_paise,
      o.joining_date::text, o.expires_on::text, o.released_at, o.responded_at,
      (select q.status from approval_requests q where q.entity_type = 'offer' and q.entity_id = o.id order by q.created_at desc limit 1) as approval,
      (select count(*)::int from document_requests r where r.candidate_id = c.id) as docs_total,
      (select count(*)::int from document_requests r where r.candidate_id = c.id and r.status = 'uploaded') as docs_uploaded,
      (select count(*)::int from document_requests r where r.candidate_id = c.id and r.status = 'approved') as docs_approved,
      (select count(*)::int from preboarding_tasks t where t.candidate_id = c.id) as tasks_total,
      (select count(*)::int from preboarding_tasks t where t.candidate_id = c.id and t.done_at is not null) as tasks_done,
      a.status as app_status, c.employee_id
    from offers o join applications a on a.id = o.application_id join candidates c on c.id = a.candidate_id join jobs j on j.id = a.job_id
    where o.status not in ('revised') and (${ids === null} or a.job_id = any(${ids ?? []}::uuid[])) and c.employee_id is distinct from ${actor.employeeId}
      and o.version = (select max(version) from offers o2 where o2.application_id = o.application_id)
    order by case o.status when 'accepted' then 0 when 'released' then 1 when 'pending_approval' then 2 when 'draft' then 3 else 4 end, o.joining_date`;
  return offers.map((o) => ({ ...o, ctc_paise: Number(o.ctc_paise) }));
}

export async function reviewDocument(tx: Tx, actor: Actor, requestId: string, decision: "approved" | "rejected", comment: string | null) {
  const [r] = await tx<{ candidate_id: string | null; status: string; doc_type: string }[]>`select candidate_id, status, doc_type from document_requests where id = ${requestId} for update`;
  if (!r?.candidate_id) throw new AppError("not_found", "Document not found.");
  await assertCandidateAct(tx, actor, r.candidate_id);
  if (r.status !== "uploaded") throw new AppError("conflict", "Only uploaded documents can be reviewed.");
  if (decision === "rejected" && !comment?.trim()) throw new AppError("invalid", "Tell the candidate what to fix.", "comment");
  await tx`update document_requests set status = ${decision}, reviewer_comment = ${comment?.trim().slice(0, 500) || null} where id = ${requestId}`;
  await audit(tx, actor, actor.tenant.id, "document_request", requestId, `review.${decision}`, { doc_type: r.doc_type });
}

export async function addDocumentRequest(tx: Tx, actor: Actor, candidateId: string, docType: string, required: boolean) {
  await assertCandidateAct(tx, actor, candidateId);
  const t = docType.trim().slice(0, 80);
  if (!t) throw new AppError("invalid", "Name the document.", "docType");
  const [dupe] = await tx`select 1 from document_requests where candidate_id = ${candidateId} and lower(doc_type) = lower(${t})`;
  if (dupe) throw new AppError("conflict", "This document is already requested.", "docType");
  await tx`insert into document_requests (tenant_id, candidate_id, doc_type, required) values (${actor.tenant.id}, ${candidateId}, ${t}, ${required})`;
  await audit(tx, actor, actor.tenant.id, "document_request", null, "create", { candidate_id: candidateId, doc_type: t });
}

export async function addTask(tx: Tx, actor: Actor, candidateId: string, title: string, description: string | null) {
  await assertCandidateAct(tx, actor, candidateId);
  const t = title.trim().slice(0, 120);
  if (!t) throw new AppError("invalid", "Name the task.", "title");
  await tx`insert into preboarding_tasks (tenant_id, candidate_id, title, description) values (${actor.tenant.id}, ${candidateId}, ${t}, ${description?.trim().slice(0, 500) || null})`;
  await audit(tx, actor, actor.tenant.id, "preboarding_task", null, "create", { candidate_id: candidateId, title: t });
}

/** Re-sends the portal link (new link; the old one stops working). */
export async function resendPortal(tx: Tx, actor: Actor, applicationId: string) {
  const { app } = await actOnApplication(tx, actor, applicationId);
  const [o] = await tx`select 1 from offers where application_id = ${applicationId} and status in ('released','accepted')`;
  if (!o) throw new AppError("conflict", "Send an offer first.");
  const token = await issueToken(tx, { tenantId: actor.tenant.id, kind: "portal", candidateId: app.candidate_id, days: PORTAL_DAYS });
  const v = await valuesFor(tx, actor.tenant.name, applicationId);
  const link = publicLink(actor.tenant.subdomain, "portal", token);
  await emailFromTemplate(tx, { tenantId: actor.tenant.id, company: actor.tenant.name, to: v.email, applicationId, actorEmployeeId: actor.employeeId, key: "offer_released", values: { ...v.values, link } });
  await audit(tx, actor, actor.tenant.id, "application", applicationId, "portal.resend");
  return { link };
}

// ---------- convert to employee ----------
export type ConvertInput = { workEmail: string; employeeNumber: string | null; departmentId: string | null; designationId: string | null; locationId: string | null; managerId: string | null; joiningDate: string };

export async function convertToEmployee(tx: Tx, actor: Actor, applicationId: string, input: ConvertInput) {
  const { app } = await actOnApplication(tx, actor, applicationId);
  if (app.status === "hired") throw new AppError("conflict", "This candidate is already an employee.");
  if (app.status !== "active") throw new AppError("conflict", "This candidate is no longer active on the job.");
  const [offer] = await tx<{ id: string; letter_id: string | null; designation_id: string | null; joining_date: string }[]>`
    select id, letter_id, designation_id, joining_date::text from offers where application_id = ${applicationId} and status = 'accepted' order by version desc limit 1`;
  if (!offer) throw new AppError("conflict", "The candidate has to accept an offer first.");
  const place: Placement = { department_id: input.departmentId, location_id: input.locationId, legal_entity_id: null, business_unit_id: null };
  const [le] = await tx<{ id: string | null }[]>`select (select id from legal_entities order by created_at limit 1) as id`;
  place.legal_entity_id = le.id;
  if (!canFor(actor, "employees.write", place) && !canFor(actor, HIRE_ADMIN, place)) throw new AppError("forbidden", "Only HR or hiring admins for this department and location can add the new employee.");
  const email = normalizeEmail(input.workEmail);
  if (!isEmail(email)) throw new AppError("invalid", "Enter the new employee's work email.", "workEmail");
  if (!ISO.test(input.joiningDate)) throw new AppError("invalid", "Pick the joining date.", "joiningDate");
  for (const [k, table, id] of [["departmentId", "departments", input.departmentId], ["designationId", "designations", input.designationId], ["locationId", "locations", input.locationId], ["managerId", "employees", input.managerId]] as const) {
    if (id) { const [x] = await tx`select 1 from ${tx(table)} where id = ${id}`; if (!x) throw new AppError("invalid", "Pick from the list.", k); }
  }
  const [c] = await tx<{ id: string; first_name: string; last_name: string | null; mobile: string | null; gender: string | null; employee_id: string | null }[]>`
    select id, first_name, last_name, mobile, gender, employee_id from candidates where id = ${app.candidate_id} for update`;
  let employeeId: string, employeeNumber: string;
  if (c.employee_id) {
    // internal applicant: no new record, the move is recorded as a job change by HR
    employeeId = c.employee_id;
    const [e] = await tx<{ employee_number: string }[]>`select employee_number from employees where id = ${employeeId}`;
    employeeNumber = e.employee_number;
  } else {
    const r = await createEmployee(tx, actor.tenant.id, {
      firstName: c.first_name, lastName: c.last_name, workEmail: email, mobile: c.mobile, gender: c.gender, employeeNumber: input.employeeNumber,
      joiningDate: input.joiningDate, departmentId: input.departmentId, designationId: input.designationId ?? offer.designation_id, locationId: input.locationId, managerId: input.managerId,
    }, actor.userId);
    employeeId = r.employeeId; employeeNumber = r.employeeNumber;
    await tx`update candidates set employee_id = ${employeeId} where id = ${c.id}`;
  }
  const [hired] = await tx<{ id: string; name: string }[]>`select s.id, s.name from jobs j join hiring_stages s on s.flow_id = j.hiring_flow_id where j.id = ${app.job_id} and s.stage_group = 'hired' order by s.position limit 1`;
  await tx`update applications set status = 'hired', hired_at = now(), closed_at = now(), stage_id = coalesce(${hired?.id ?? null}, stage_id), stage_entered_at = now() where id = ${applicationId}`;
  // the signed offer letter and approved joining documents move to the employee's profile
  if (offer.letter_id) {
    const [g] = await tx<{ file_id: string | null }[]>`update generated_letters set employee_id = ${employeeId} where id = ${offer.letter_id} returning file_id`;
    if (g?.file_id) await tx`insert into employee_documents (tenant_id, employee_id, category, doc_type, file_id, status, verified_by, verified_at) values (${actor.tenant.id}, ${employeeId}, 'letter', 'Offer letter', ${g.file_id}, 'verified', ${actor.userId}, now())`;
  }
  const docs = await tx<{ id: string; doc_type: string; file_id: string }[]>`select id, doc_type, file_id from document_requests where candidate_id = ${c.id} and status = 'approved' and file_id is not null and employee_id is null`;
  for (const d of docs) {
    const category = /pan|aadhaar|passport|voter|licen/i.test(d.doc_type) ? "identity" : /degree|certificate|marksheet/i.test(d.doc_type) ? "education" : /payslip|relieving|experience|offer/i.test(d.doc_type) ? "experience" : "other";
    await tx`insert into employee_documents (tenant_id, employee_id, category, doc_type, file_id, status, verified_by, verified_at) values (${actor.tenant.id}, ${employeeId}, ${category}, ${d.doc_type}, ${d.file_id}, 'verified', ${actor.userId}, now())`;
    await tx`update document_requests set employee_id = ${employeeId} where id = ${d.id}`;
  }
  await tx`update referrals set bonus_status = 'eligible' where candidate_id = ${c.id} and job_id = ${app.job_id} and bonus_status = 'none'`;
  const [ref] = await tx<{ referrer_employee_id: string }[]>`select referrer_employee_id from referrals where candidate_id = ${c.id} and job_id = ${app.job_id}`;
  if (ref) await notifyEmployee(tx, actor.tenant.id, ref.referrer_employee_id, "hire.referral_hired", "Your referral was hired", `${c.first_name} is joining on ${letterDate(input.joiningDate)}. Thank you!`, "/me/jobs");
  await tx`update hire_tokens set expires_at = least(expires_at, now() + interval '7 days') where candidate_id = ${c.id} and kind = 'portal'`;
  await appEvent(tx, actor.tenant.id, applicationId, "hired", { employee_id: employeeId, employee_number: employeeNumber, joining_date: input.joiningDate }, actor.employeeId);
  await audit(tx, actor, actor.tenant.id, "application", applicationId, "convert", { employee_id: employeeId, internal: !!c.employee_id });
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${actor.tenant.id}, ${actor.userId}, 'candidate', ${c.id}, 'candidate.hired', ${tx.json({ employee_id: employeeId, job_id: app.job_id })})`;
  return { employeeId, employeeNumber, internal: !!c.employee_id };
}

export async function convertDefaults(tx: Tx, actor: Actor, applicationId: string) {
  const { app } = await seeApplication(tx, actor, applicationId);
  const [d] = await tx<{ department_id: string | null; location_id: string | null; designation_id: string | null; joining_date: string | null; first_name: string; last_name: string | null; hm: string | null }[]>`
    select j.department_id, j.location_id, (select designation_id from offers where application_id = a.id and status = 'accepted' order by version desc limit 1) as designation_id,
      (select joining_date::text from offers where application_id = a.id and status = 'accepted' order by version desc limit 1) as joining_date, c.first_name, c.last_name,
      (select t.employee_id from job_team_members t where t.job_id = j.id and t.role = 'hiring_manager' limit 1) as hm
    from applications a join jobs j on j.id = a.job_id join candidates c on c.id = a.candidate_id where a.id = ${app.id}`;
  const [domain] = await tx<{ d: string | null }[]>`select split_part(work_email::text, '@', 2) as d from employees order by created_at limit 1`;
  const local = [d.first_name, d.last_name].filter(Boolean).join(".").toLowerCase().normalize("NFKD").replace(/[^a-z0-9.]/g, "");
  return { ...d, managerId: d.hm, workEmail: domain?.d ? `${local}@${domain.d}` : "" };
}

// ---------- candidate portal (public, token) ----------
type PortalCandidate = { id: string; first_name: string; last_name: string | null; email: string; employee_id: string | null };

async function portalCandidate(tx: Tx, token: string) {
  const t = await findToken(tx, "portal", token, { allowUsed: true });
  if (!t) return null;
  const [c] = await tx<PortalCandidate[]>`select id, first_name, last_name, email::text, employee_id from candidates where id = ${t.candidate_id}`;
  return c ?? null;
}

async function portalOffer(tx: Tx, candidateId: string) {
  const [o] = await tx<{ id: string; application_id: string; status: string; version: number; ctc_paise: bigint; joining_date: string; expires_on: string | null; job: string; file_id: string | null; signed_name: string | null; signed_at: Date | null; otp_expires_at: Date | null; otp_attempts: number; html: string | null }[]>`
    select o.id, o.application_id, o.status, o.version, o.ctc_paise, o.joining_date::text, o.expires_on::text, j.title as job, g.file_id, o.signed_name, o.signed_at, o.otp_expires_at, o.otp_attempts, g.data->>'html' as html
    from offers o join applications a on a.id = o.application_id join jobs j on j.id = a.job_id left join generated_letters g on g.id = o.letter_id
    where a.candidate_id = ${candidateId} and o.status in ('released','accepted','declined','expired','withdrawn') order by o.released_at desc nulls last, o.created_at desc limit 1`;
  return o ?? null;
}

export async function portalView(tx: Tx, token: string) {
  const c = await portalCandidate(tx, token);
  if (!c) return null;
  const offer = await portalOffer(tx, c.id);
  const [docs, tasks, [t]] = await Promise.all([
    tx<{ id: string; doc_type: string; required: boolean; status: string; file_name: string | null; reviewer_comment: string | null }[]>`
      select r.id, r.doc_type, r.required, r.status, f.name as file_name, r.reviewer_comment from document_requests r left join files f on f.id = r.file_id where r.candidate_id = ${c.id} order by r.created_at`,
    tx<{ id: string; title: string; description: string | null; done: boolean }[]>`select id, title, description, done_at is not null as done from preboarding_tasks where candidate_id = ${c.id} order by created_at`,
    tx<{ name: string }[]>`select name from tenants`,
  ]);
  const maskedEmail = c.email.replace(/^(.{1,2})[^@]*(@.*)$/, "$1•••$2");
  return {
    company: t.name, firstName: c.first_name, name: [c.first_name, c.last_name].filter(Boolean).join(" "), maskedEmail,
    offer: offer ? { id: offer.id, status: offer.status, version: offer.version, ctc_paise: Number(offer.ctc_paise), joining_date: offer.joining_date, expires_on: offer.expires_on, job: offer.job, hasLetter: !!offer.file_id, html: offer.html, signed_name: offer.signed_name, signed_at: offer.signed_at, codeSent: !!offer.otp_expires_at && offer.otp_expires_at > new Date() } : null,
    docs, tasks,
  };
}

/** Emails a 6-digit code to the candidate's address on file; the code signs the offer together with the typed name. */
export async function requestSignCode(tx: Tx, token: string) {
  const c = await portalCandidate(tx, token);
  if (!c) throw new AppError("invalid", "This link has expired. Ask the hiring team for a new one.");
  const o = await portalOffer(tx, c.id);
  if (!o || o.status !== "released") throw new AppError("conflict", "There's no offer waiting for your answer.");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await tx`update offers set otp_hash = ${sha256(`${o.id}:${code}`)}, otp_expires_at = now() + make_interval(mins => ${OTP_MINUTES}), otp_attempts = 0 where id = ${o.id}`;
  const [t] = await tx<{ id: string; name: string }[]>`select id, name from tenants`;
  const mail = candidateMail(t.name, `Your code to sign the offer: ${code}`, `Hi ${c.first_name},\n\nUse this code to sign your offer from ${t.name}: ${code}\n\nIt works for ${OTP_MINUTES} minutes. If you didn't ask for it, you can ignore this email.`);
  await queueEmail(tx, t.id, { kind: "hire.sign_code", to: c.email, ...mail });
  return { sentTo: c.email.replace(/^(.{1,2})[^@]*(@.*)$/, "$1•••$2") };
}

const norm = (s: string) => s.normalize("NFKD").replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Accept with a typed full name + the emailed code. A wrong code is returned (not thrown) so the attempt counter is
 * saved; after 5 wrong codes a new code is needed.
 */
export async function acceptOffer(tx: Tx, token: string, input: { typedName: string; code: string; ip: string | null }): Promise<{ ok: true } | { ok: false; error: string; field?: string }> {
  const c = await portalCandidate(tx, token);
  if (!c) return { ok: false, error: "This link has expired. Ask the hiring team for a new one." };
  const o = await portalOffer(tx, c.id);
  if (!o || o.status !== "released") return { ok: false, error: "There's no offer waiting for your answer." };
  const [t] = await tx<{ id: string; name: string }[]>`select id, name from tenants`;
  const full = [c.first_name, c.last_name].filter(Boolean).join(" ");
  if (norm(input.typedName) !== norm(full)) return { ok: false, error: `Type your full name exactly as shown: ${full}.`, field: "typedName" };
  const [row] = await tx<{ otp_hash: string | null; otp_expires_at: Date | null; otp_attempts: number }[]>`select otp_hash, otp_expires_at, otp_attempts from offers where id = ${o.id} for update`;
  if (!row.otp_hash || !row.otp_expires_at || row.otp_expires_at <= new Date() || row.otp_attempts >= OTP_TRIES) return { ok: false, error: "Ask for a new code first.", field: "code" };
  if (!/^\d{6}$/.test(input.code.trim()) || sha256(`${o.id}:${input.code.trim()}`) !== row.otp_hash) {
    await tx`update offers set otp_attempts = otp_attempts + 1 where id = ${o.id}`;
    const left = OTP_TRIES - row.otp_attempts - 1;
    return { ok: false, error: left > 0 ? `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong codes. Ask for a new code.", field: "code" };
  }
  const signedName = input.typedName.trim().slice(0, 120);
  const [done] = await tx<{ id: string }[]>`
    update offers set status = 'accepted', responded_at = now(), signed_name = ${signedName}, signed_at = now(), signed_ip = ${input.ip?.slice(0, 64) ?? null}, otp_hash = null
    where id = ${o.id} and status = 'released' returning id`;
  if (!done) return { ok: false, error: "This offer was already answered." };
  // the signed copy: the same letter with an acceptance block
  const stamp = new Date().toLocaleString("en-IN", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Kolkata" });
  const signedHtml = `${o.html ?? ""}<h3>Acceptance</h3><p>I accept this offer.</p><p><strong>${signedName.replace(/[<>&"]/g, "")}</strong></p><p>Signed electronically on ${stamp} IST after confirming a one-time code sent to ${c.email.replace(/[<>&"]/g, "")}.</p>`;
  const pdf = await renderLetterPdf({ html: signedHtml, title: `Offer letter · ${full}`, company: t.name, footer: `Offer letter for ${full} · version ${o.version} · signed ${stamp} IST` });
  const fileId = await saveFile(tx, { tenantId: t.id, userId: null, name: safeFileName(`Offer letter - ${full} (signed).pdf`), mime: "application/pdf", bytes: pdf, ext: "pdf" });
  await tx`update generated_letters set status = 'signed', file_id = ${fileId}, data = data || ${tx.json({ signed_name: signedName, signed_at: new Date().toISOString() })} where id = (select letter_id from offers where id = ${o.id})`;
  await appEvent(tx, t.id, o.application_id, "offer", { offer_id: o.id, version: o.version, action: "accepted", signed_name: signedName }, null);
  await notifyTeam(tx, t.id, o.application_id, "hire.offer_accepted", `${full} accepted the offer`, `${o.job} · joining ${letterDate(o.joining_date)}`);
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${t.id}, null, 'offer', ${o.id}, 'accept', ${tx.json({ signed_name: signedName, ip: input.ip ?? null })})`;
  return { ok: true };
}

export async function declineOffer(tx: Tx, token: string, reason: string) {
  const c = await portalCandidate(tx, token);
  if (!c) throw new AppError("invalid", "This link has expired. Ask the hiring team for a new one.");
  const o = await portalOffer(tx, c.id);
  if (!o || o.status !== "released") throw new AppError("conflict", "There's no offer waiting for your answer.");
  const r = reason.trim().slice(0, 500);
  await tx`update offers set status = 'declined', responded_at = now(), decline_reason = ${r || null} where id = ${o.id} and status = 'released'`;
  const [t] = await tx<{ id: string }[]>`select id from tenants`;
  await appEvent(tx, t.id, o.application_id, "offer", { offer_id: o.id, version: o.version, action: "declined", reason: r || null }, null);
  await notifyTeam(tx, t.id, o.application_id, "hire.offer_declined", `${c.first_name} declined the offer`, r || o.job);
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${t.id}, null, 'offer', ${o.id}, 'decline', ${tx.json({ reason: r || null })})`;
}

async function notifyTeam(tx: Tx, tenantId: string, applicationId: string, kind: string, title: string, body: string) {
  const [a] = await tx<{ candidate_id: string }[]>`select candidate_id from applications where id = ${applicationId}`;
  const team = await tx<{ id: string }[]>`select distinct t.employee_id as id from applications a join job_team_members t on t.job_id = a.job_id where a.id = ${applicationId} and t.role in ('recruiter','hiring_manager')`;
  for (const m of team) await notifyEmployee(tx, tenantId, m.id, kind, title, body, `/hire/candidates/${a.candidate_id}`);
}

export async function portalUpload(tx: Tx, token: string, requestId: string, f: { name: string; bytes: Uint8Array }) {
  const c = await portalCandidate(tx, token);
  if (!c) throw new AppError("invalid", "This link has expired. Ask the hiring team for a new one.");
  const [r] = await tx<{ id: string; status: string; doc_type: string }[]>`select id, status, doc_type from document_requests where id = ${requestId} and candidate_id = ${c.id} for update`;
  if (!r) throw new AppError("not_found", "Document not found.");
  if (r.status === "approved") throw new AppError("conflict", "This document was already approved.");
  const ext = f.name.toLowerCase().split(".").pop() ?? "";
  if (!["pdf", "png", "jpg", "jpeg"].includes(ext)) throw new AppError("invalid", "Upload a PDF, PNG or JPG.", "file");
  const v = validateUpload({ name: f.name, size: f.bytes.byteLength, head: f.bytes.subarray(0, 512) });
  if (!v.ok) throw new AppError("invalid", v.error, "file");
  const [t] = await tx<{ id: string }[]>`select id from tenants`;
  const fileId = await saveFile(tx, { tenantId: t.id, userId: null, name: v.name, mime: v.mime, bytes: f.bytes, ext });
  await tx`update document_requests set file_id = ${fileId}, status = 'uploaded', reviewer_comment = null where id = ${r.id}`;
  const [a] = await tx<{ id: string }[]>`select id from applications where candidate_id = ${c.id} and status in ('active','hired') order by created_at desc limit 1`;
  if (a) await appEvent(tx, t.id, a.id, "document", { doc_type: r.doc_type, action: "uploaded" }, null);
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${t.id}, null, 'document_request', ${r.id}, 'portal.upload', ${tx.json({ doc_type: r.doc_type })})`;
}

export async function portalTask(tx: Tx, token: string, taskId: string, done: boolean) {
  const c = await portalCandidate(tx, token);
  if (!c) throw new AppError("invalid", "This link has expired. Ask the hiring team for a new one.");
  const r = await tx`update preboarding_tasks set done_at = ${done ? new Date() : null} where id = ${taskId} and candidate_id = ${c.id}`;
  if (!r.count) throw new AppError("not_found", "Task not found.");
}

/** Files the candidate may open from the portal: their current offer letter and the documents they uploaded. */
export async function portalFile(tx: Tx, token: string, which: "offer" | string) {
  const c = await portalCandidate(tx, token);
  if (!c) return null;
  if (which === "offer") {
    const o = await portalOffer(tx, c.id);
    if (!o?.file_id || o.status === "withdrawn") return null;
    const [f] = await tx<{ storage_key: string; name: string; mime: string }[]>`select storage_key, name, mime from files where id = ${o.file_id}`;
    return f ?? null;
  }
  const [f] = await tx<{ storage_key: string; name: string; mime: string }[]>`
    select f.storage_key, f.name, f.mime from document_requests r join files f on f.id = r.file_id where r.id = ${which} and r.candidate_id = ${c.id}`;
  return f ?? null;
}

export const canSeeAllOffers = canAdminHire;
export const addDays = addDaysISO;
