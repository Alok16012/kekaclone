"use server";
import { z } from "zod";
import { runAction as runGated } from "@/server/action";
import type { Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";

/** Every mutation here needs the hire feature on the plan (Settings → Billing). */
const runAction = <T,>(fn: (tx: Tx, actor: Actor) => Promise<T>, opts: { refresh?: boolean } = { refresh: true }) => runGated(fn, { ...opts, feature: "hire" });
import * as setup from "@/server/modules/hire/setup";
import * as jobs from "@/server/modules/hire/jobs";
import * as cands from "@/server/modules/hire/candidates";
import * as iv from "@/server/modules/hire/interviews";
import * as offers from "@/server/modules/hire/offers";
import * as internal from "@/server/modules/hire/internal";

const uuid = z.uuid();
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });
const isId = (v: unknown): v is string => uuid.safeParse(v).success;
const optId = (v: unknown) => (v == null || v === "" ? null : isId(v) ? v : undefined);
const str = (v: unknown, max = 5000) => (typeof v === "string" ? v.slice(0, max) : "");
const intOrNull = (v: unknown) => (v == null || v === "" ? null : Number.isInteger(Number(v)) ? Number(v) : NaN);
const ids = z.array(uuid).min(1).max(500);

async function fileFrom(form: FormData, key: string) {
  const f = form.get(key);
  if (!(f instanceof File) || f.size === 0) return null;
  if (f.size > 5 * 1024 * 1024) return "too_big" as const;
  return { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
}

// ============================== requisitions ==============================
type ReqForm = { title: string; openings: string; jobType: string; departmentId: string; locationId: string; salaryMin: string; salaryMax: string; targetDate: string; description: string; qualification: string; experienceMin: string; experienceMax: string; backfillForId: string };
const rupees = (v: string) => { const s = (v ?? "").replace(/[₹,\s]/g, ""); if (!s) return null; const n = Number(s); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN; };

function reqInput(f: ReqForm) {
  const dep = optId(f.departmentId), loc = optId(f.locationId), back = optId(f.backfillForId);
  if (dep === undefined || loc === undefined || back === undefined) return null;
  return {
    title: str(f.title, 200), openings: Number(f.openings), jobType: str(f.jobType, 20), departmentId: dep, locationId: loc,
    salaryMinPaise: rupees(f.salaryMin), salaryMaxPaise: rupees(f.salaryMax), targetDate: str(f.targetDate, 10) || null, description: str(f.description) || null,
    qualification: str(f.qualification, 1000) || null, experienceMin: intOrNull(f.experienceMin), experienceMax: intOrNull(f.experienceMax), backfillForId: back,
  };
}

export async function saveRequisitionAction(id: string | null, form: ReqForm, submit: boolean) {
  if (id && !isId(id)) return bad("Requisition not found.");
  const input = reqInput(form ?? ({} as ReqForm));
  if (!input) return bad("Check the requisition details.");
  if (Number.isNaN(input.salaryMinPaise) || Number.isNaN(input.salaryMaxPaise)) return bad("Enter the salary in rupees.", "salaryMinPaise");
  return runAction(async (tx, actor) => {
    const r = await jobs.saveRequisition(tx, actor, id, input as jobs.ReqInput);
    return submit ? { id: r.id, ...(await jobs.submitRequisition(tx, actor, r.id)) } : { id: r.id, status: "draft" };
  });
}

export async function requisitionAction(id: string, action: string) {
  if (!isId(id)) return bad("Requisition not found.");
  return runAction(async (tx, actor) => {
    if (action === "submit") return jobs.submitRequisition(tx, actor, id);
    if (action === "withdraw") { await jobs.withdrawRequisition(tx, actor, id); return { status: "draft" }; }
    if (action === "close") { await jobs.closeRequisition(tx, actor, id); return { status: "closed" }; }
    if (action === "convert") return { status: "converted", ...(await jobs.convertRequisition(tx, actor, id)) };
    throw new Error("unknown action");
  });
}

export async function requisitionDetailAction(id: string) {
  if (!isId(id)) return bad("Requisition not found.");
  return runAction((tx, actor) => jobs.requisitionDetail(tx, actor, id), { refresh: false });
}

// ============================== jobs ==============================
const jobSchema = z.object({
  title: z.string().max(200), departmentId: z.string().nullable(), locationId: z.string().nullable(), descriptionHtml: z.string().max(60_000), openings: z.number(),
  targetDate: z.string().max(10).nullable(), jobType: z.string().max(20), experienceMin: z.number().nullable(), experienceMax: z.number().nullable(),
  salaryMinPaise: z.number().nullable(), salaryMaxPaise: z.number().nullable(), showSalary: z.boolean(), hiringFlowId: z.string(), reapplyAfterDays: z.number().nullable(),
  team: z.array(z.object({ employeeId: uuid, role: z.string().max(30) })).max(80),
  publish: z.object({ careerSite: z.boolean(), internal: z.boolean(), referrals: z.boolean() }), requisitionId: z.string().nullable().optional(),
});

export async function saveJobAction(id: string | null, raw: unknown, publish: boolean) {
  if (id && !isId(id)) return bad("Job not found.");
  const p = jobSchema.safeParse(raw);
  if (!p.success) return bad("Check the job details.");
  const v = p.data;
  for (const k of ["departmentId", "locationId", "requisitionId"] as const) if (v[k] && !isId(v[k])) return bad("Pick from the list.", k);
  if (!isId(v.hiringFlowId)) return bad("Pick a hiring flow.", "hiringFlowId");
  return runAction(async (tx, actor) => {
    const r = await jobs.saveJob(tx, actor, id, { ...v, departmentId: v.departmentId || null, locationId: v.locationId || null, requisitionId: v.requisitionId || null });
    if (publish) {
      const [j] = await tx<{ status: string }[]>`select status from jobs where id = ${r.id}`;
      if (j.status === "draft") await jobs.setJobStatus(tx, actor, r.id, "publish");
    }
    return r;
  });
}

export async function jobStatusAction(id: string, action: string) {
  const a = z.enum(["publish", "hold", "reopen", "close"]).safeParse(action);
  if (!isId(id) || !a.success) return bad("Job not found.");
  return runAction((tx, actor) => jobs.setJobStatus(tx, actor, id, a.data));
}

// ============================== pipeline ==============================
export async function moveAction(applicationId: string, stageId: string) {
  if (!isId(applicationId) || !isId(stageId)) return bad("Candidate not found.");
  return runAction((tx, actor) => cands.moveApplication(tx, actor, applicationId, stageId));
}

export async function bulkMoveAction(applicationIds: string[], stageId: string) {
  const p = ids.safeParse(applicationIds);
  if (!p.success || !isId(stageId)) return bad("Pick candidates and a stage.");
  return runAction((tx, actor) => cands.bulkMove(tx, actor, p.data, stageId));
}

export async function rejectAction(applicationIds: string[], reason: string, sendEmail: boolean, note: string) {
  const p = ids.safeParse(applicationIds);
  if (!p.success) return bad("Pick candidates to reject.");
  return runAction((tx, actor) => cands.rejectApplications(tx, actor, p.data, str(reason, 200), { sendEmail: !!sendEmail, note: str(note, 1000) || null }));
}

export async function restoreAction(applicationId: string) {
  if (!isId(applicationId)) return bad("Candidate not found.");
  return runAction((tx, actor) => cands.restoreApplication(tx, actor, applicationId));
}

// ============================== candidates ==============================
function candidateInput(form: FormData): cands.CandidateInput {
  const exp = str(form.get("experienceYears"), 10).trim();
  const custom: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (k.startsWith("custom.") && typeof v === "string") custom[k.slice(7)] = v.slice(0, 500);
  return {
    firstName: str(form.get("firstName"), 100), lastName: str(form.get("lastName"), 100) || null, email: str(form.get("email"), 254), mobile: str(form.get("mobile"), 30) || null,
    gender: str(form.get("gender"), 30) || null, currentCompany: str(form.get("currentCompany"), 150) || null, currentTitle: str(form.get("currentTitle"), 150) || null,
    experienceMonths: exp === "" ? null : Number.isFinite(Number(exp)) ? Math.round(Number(exp) * 12) : -1, source: str(form.get("source"), 30) || "manual",
    tags: str(form.get("tags"), 600).split(","), custom,
  };
}

export async function addCandidateAction(form: FormData) {
  if (!(form instanceof FormData)) return bad("Check the candidate's details.");
  const jobId = optId(form.get("jobId"));
  if (jobId === undefined) return bad("Job not found.");
  const resume = await fileFrom(form, "resume");
  if (resume === "too_big") return bad("The resume is larger than 5 MB.", "resume");
  return runAction((tx, actor) => cands.createCandidate(tx, actor, candidateInput(form), { jobId, resume, useExisting: form.get("useExisting") === "1" }));
}

export async function updateCandidateAction(id: string, form: FormData) {
  if (!isId(id) || !(form instanceof FormData)) return bad("Candidate not found.");
  return runAction((tx, actor) => cands.updateCandidate(tx, actor, id, candidateInput(form)));
}

export async function setTagsAction(id: string, tags: string[]) {
  if (!isId(id) || !Array.isArray(tags)) return bad("Candidate not found.");
  return runAction((tx, actor) => cands.setTags(tx, actor, id, tags.slice(0, 30).map((t) => str(t, 40))));
}

export async function parseResumeAction(form: FormData) {
  if (!(form instanceof FormData)) return bad("Upload a resume.");
  const f = await fileFrom(form, "resume");
  if (!f) return bad("Upload a resume.", "resume");
  if (f === "too_big") return bad("The resume is larger than 5 MB.", "resume");
  return runAction(async () => cands.parseOnly(f), { refresh: false });
}

export async function replaceResumeAction(id: string, form: FormData) {
  if (!isId(id) || !(form instanceof FormData)) return bad("Candidate not found.");
  const f = await fileFrom(form, "resume");
  if (!f) return bad("Upload a resume.", "resume");
  if (f === "too_big") return bad("The resume is larger than 5 MB.", "resume");
  return runAction(async (tx, actor) => { await cands.replaceResume(tx, actor, id, f); });
}

export async function addToJobAction(candidateId: string, jobId: string) {
  if (!isId(candidateId) || !isId(jobId)) return bad("Pick a job.");
  return runAction((tx, actor) => cands.addToJob(tx, actor, candidateId, jobId, "manual"));
}

export async function importCandidatesAction(form: FormData) {
  if (!(form instanceof FormData)) return bad("Upload the filled-in template.");
  const f = form.get("file");
  if (!(f instanceof File) || !f.size) return bad("Upload the filled-in template.", "file");
  if (f.size > 5 * 1024 * 1024) return bad("The file is larger than 5 MB.", "file");
  const jobId = optId(form.get("jobId"));
  if (jobId === undefined) return bad("Job not found.");
  const bytes = await f.arrayBuffer();
  return runAction((tx, actor) => cands.importCandidates(tx, actor, bytes, jobId));
}

export async function addNoteAction(candidateId: string, body: string, applicationId: string | null, isPrivate: boolean) {
  if (!isId(candidateId) || (applicationId && !isId(applicationId))) return bad("Candidate not found.");
  return runAction(async (tx, actor) => { await cands.addNote(tx, actor, candidateId, { body: str(body, 5000), applicationId, isPrivate: !!isPrivate }); });
}

export async function deleteNoteAction(noteId: string) {
  if (!isId(noteId)) return bad("Note not found.");
  return runAction((tx, actor) => cands.deleteNote(tx, actor, noteId));
}

export async function emailDraftAction(applicationId: string, key: string) {
  if (!isId(applicationId) || typeof key !== "string") return bad("Template not found.");
  return runAction((tx, actor) => cands.emailDraft(tx, actor, applicationId, key.slice(0, 40)), { refresh: false });
}

export async function sendEmailAction(applicationId: string, input: { templateKey: string | null; subject: string; body: string }) {
  if (!isId(applicationId) || !input) return bad("Candidate not found.");
  return runAction((tx, actor) => cands.sendEmail(tx, actor, applicationId, { templateKey: input.templateKey ? str(input.templateKey, 40) : null, subject: str(input.subject, 300), body: str(input.body, 9000) }));
}

// ============================== interviews ==============================
const scheduleSchema = z.object({
  title: z.string().max(200), mode: z.string().max(20), scheduling: z.enum(["fixed", "self_schedule"]), start: z.string().max(40).nullable().optional(), end: z.string().max(40).nullable().optional(),
  slots: z.array(z.object({ start: z.string().max(40), end: z.string().max(40) })).max(12).optional(), meetingUrl: z.string().max(600).nullable().optional(), location: z.string().max(300).nullable().optional(),
  panel: z.array(uuid).max(12), scorecardId: uuid.nullable(), notes: z.string().max(3000).nullable().optional(), notifyCandidate: z.boolean(), allowConflict: z.boolean().optional(),
});

export async function scheduleAction(applicationId: string, raw: unknown) {
  const p = scheduleSchema.safeParse(raw);
  if (!isId(applicationId) || !p.success) return bad("Check the interview details.");
  return runAction((tx, actor) => iv.scheduleInterview(tx, actor, applicationId, p.data));
}

export async function interviewStatusAction(interviewId: string, status: string, reason?: string) {
  const s = z.enum(["completed", "no_show", "cancelled"]).safeParse(status);
  if (!isId(interviewId) || !s.success) return bad("Interview not found.");
  return runAction((tx, actor) => iv.setInterviewStatus(tx, actor, interviewId, s.data, str(reason, 500) || null));
}

export async function scorecardFormAction(interviewId: string) {
  if (!isId(interviewId)) return bad("Interview not found.");
  return runAction((tx, actor) => iv.scorecardForm(tx, actor, interviewId), { refresh: false });
}

const scoreSchema = z.object({ ratings: z.record(z.string().max(40), z.number()), overall: z.number().nullable(), recommendation: z.string().max(20).nullable(), comments: z.string().max(5000).nullable() });
export async function submitScorecardAction(interviewId: string, raw: unknown) {
  const p = scoreSchema.safeParse(raw);
  if (!isId(interviewId) || !p.success) return bad("Check your ratings.");
  return runAction((tx, actor) => iv.submitScorecard(tx, actor, interviewId, p.data));
}

// ============================== offers ==============================
const offerSchema = z.object({ templateId: uuid, designationId: uuid.nullable(), ctc: z.string().max(30), joiningDate: z.string().max(10), expiresOn: z.string().max(10).nullable(), note: z.string().max(3000).nullable() });
function offerInput(raw: unknown): offers.OfferInput | null {
  const p = offerSchema.safeParse(raw);
  if (!p.success) return null;
  const ctc = rupees(p.data.ctc);
  return { templateId: p.data.templateId, designationId: p.data.designationId, ctcPaise: ctc == null || Number.isNaN(ctc) ? 0 : ctc, joiningDate: p.data.joiningDate, expiresOn: p.data.expiresOn || null, note: p.data.note };
}

export async function createOfferAction(applicationId: string, raw: unknown, submit: boolean) {
  const input = offerInput(raw);
  if (!isId(applicationId) || !input) return bad("Check the offer details.");
  return runAction(async (tx, actor) => {
    const o = await offers.createOffer(tx, actor, applicationId, input);
    return submit ? { ...o, ...(await offers.submitOffer(tx, actor, o.id)) } : { ...o, approved: false };
  });
}

export async function reviseOfferAction(offerId: string, raw: unknown) {
  const input = offerInput(raw);
  if (!isId(offerId) || !input) return bad("Check the offer details.");
  return runAction((tx, actor) => offers.reviseOffer(tx, actor, offerId, input));
}

export async function offerAction(offerId: string, action: string, reason?: string) {
  if (!isId(offerId)) return bad("Offer not found.");
  return runAction(async (tx, actor) => {
    if (action === "submit") return offers.submitOffer(tx, actor, offerId);
    if (action === "release") return offers.releaseOffer(tx, actor, offerId);
    if (action === "withdraw") { await offers.withdrawOffer(tx, actor, offerId, str(reason, 500) || null); return {}; }
    throw new Error("unknown action");
  });
}

export async function offerDetailAction(offerId: string) {
  if (!isId(offerId)) return bad("Offer not found.");
  return runAction((tx, actor) => offers.offerDetail(tx, actor, offerId), { refresh: false });
}

export async function previewOfferAction(offerId: string) {
  if (!isId(offerId)) return bad("Offer not found.");
  return runAction((tx, actor) => offers.previewOffer(tx, actor, offerId), { refresh: false });
}

export async function reviewDocumentAction(requestId: string, decision: string, comment: string) {
  const d = z.enum(["approved", "rejected"]).safeParse(decision);
  if (!isId(requestId) || !d.success) return bad("Document not found.");
  return runAction((tx, actor) => offers.reviewDocument(tx, actor, requestId, d.data, str(comment, 500) || null));
}

export async function addDocRequestAction(candidateId: string, docType: string, required: boolean) {
  if (!isId(candidateId)) return bad("Candidate not found.");
  return runAction((tx, actor) => offers.addDocumentRequest(tx, actor, candidateId, str(docType, 100), !!required));
}

export async function addTaskAction(candidateId: string, title: string, description: string) {
  if (!isId(candidateId)) return bad("Candidate not found.");
  return runAction((tx, actor) => offers.addTask(tx, actor, candidateId, str(title, 150), str(description, 600) || null));
}

export async function resendPortalAction(applicationId: string) {
  if (!isId(applicationId)) return bad("Candidate not found.");
  return runAction((tx, actor) => offers.resendPortal(tx, actor, applicationId));
}

export async function convertDefaultsAction(applicationId: string) {
  if (!isId(applicationId)) return bad("Candidate not found.");
  return runAction(async (tx, actor) => {
    const [d, departments, designations, locations, people] = await Promise.all([
      offers.convertDefaults(tx, actor, applicationId),
      tx<{ id: string; name: string }[]>`select id, name from departments order by name`,
      tx<{ id: string; name: string }[]>`select id, title as name from designations order by title`,
      tx<{ id: string; name: string }[]>`select id, name from locations order by name`,
      tx<{ id: string; name: string }[]>`select id, display_name as name from employees where status <> 'relieved' order by display_name`,
    ]);
    return { defaults: d, departments, designations, locations, people };
  }, { refresh: false });
}

export async function convertAction(applicationId: string, raw: unknown) {
  const p = z.object({ workEmail: z.string().max(254), employeeNumber: z.string().max(40).nullable(), departmentId: z.string().nullable(), designationId: z.string().nullable(), locationId: z.string().nullable(), managerId: z.string().nullable(), joiningDate: z.string().max(10) }).safeParse(raw);
  if (!isId(applicationId) || !p.success) return bad("Check the new employee's details.");
  for (const k of ["departmentId", "designationId", "locationId", "managerId"] as const) if (p.data[k] && !isId(p.data[k])) return bad("Pick from the list.", k);
  return runAction((tx, actor) => offers.convertToEmployee(tx, actor, applicationId, { ...p.data, employeeNumber: p.data.employeeNumber?.trim() || null, departmentId: p.data.departmentId || null, designationId: p.data.designationId || null, locationId: p.data.locationId || null, managerId: p.data.managerId || null }));
}

// ============================== settings ==============================
const flowSchema = z.object({ name: z.string().max(100), description: z.string().max(500).nullable(), isDefault: z.boolean(), stages: z.array(z.object({ id: z.string().nullable().optional(), name: z.string().max(80), group: z.string().max(20), onEnterEmailKey: z.string().max(40).nullable().optional() })).max(25) });
export async function saveFlowAction(id: string | null, raw: unknown) {
  const p = flowSchema.safeParse(raw);
  if ((id && !isId(id)) || !p.success) return bad("Check the flow.");
  if (p.data.stages.some((s) => s.id && !isId(s.id))) return bad("Check the flow.");
  return runAction((tx, actor) => setup.saveFlow(tx, actor, id, p.data));
}
export async function deleteFlowAction(id: string) {
  if (!isId(id)) return bad("Flow not found.");
  return runAction((tx, actor) => setup.deleteFlow(tx, actor, id));
}

export async function saveScaleAction(id: string | null, raw: unknown) {
  const p = z.object({ name: z.string().max(100), points: z.array(z.object({ value: z.number(), label: z.string().max(60) })).max(12) }).safeParse(raw);
  if ((id && !isId(id)) || !p.success) return bad("Check the scale.");
  return runAction((tx, actor) => setup.saveScale(tx, actor, id, p.data));
}
export async function deleteScaleAction(id: string) {
  if (!isId(id)) return bad("Scale not found.");
  return runAction((tx, actor) => setup.deleteScale(tx, actor, id));
}

export async function saveScorecardAction(id: string | null, raw: unknown) {
  const p = z.object({ name: z.string().max(100), ratingScaleId: z.string(), overallRating: z.boolean(), sections: z.array(z.object({ title: z.string().max(100), criteria: z.array(z.object({ id: z.string().max(40).nullable().optional(), label: z.string().max(150) })).max(20) })).max(15) }).safeParse(raw);
  if ((id && !isId(id)) || !p.success || !isId(p.data.ratingScaleId)) return bad("Check the scorecard.");
  return runAction((tx, actor) => setup.saveScorecard(tx, actor, id, p.data));
}
export async function deleteScorecardAction(id: string) {
  if (!isId(id)) return bad("Scorecard not found.");
  return runAction((tx, actor) => setup.deleteScorecard(tx, actor, id));
}

export async function saveJdTemplateAction(id: string | null, name: string, html: string) {
  if (id && !isId(id)) return bad("Template not found.");
  return runAction((tx, actor) => setup.saveJdTemplate(tx, actor, id, { name: str(name, 100), html: str(html, 60_000) }));
}
export async function deleteJdTemplateAction(id: string) {
  if (!isId(id)) return bad("Template not found.");
  return runAction((tx, actor) => setup.deleteJdTemplate(tx, actor, id));
}

export async function saveEmailTemplateAction(key: string, subject: string, body: string) {
  return runAction((tx, actor) => setup.saveEmailTemplate(tx, actor, str(key, 40), { subject: str(subject, 300), body: str(body, 6000) }));
}

export async function saveOfferTemplateAction(id: string | null, name: string, html: string) {
  if (id && !isId(id)) return bad("Template not found.");
  return runAction((tx, actor) => setup.saveOfferTemplate(tx, actor, id, { name: str(name, 150), html: str(html, 60_000) }));
}
export async function deleteOfferTemplateAction(id: string) {
  if (!isId(id)) return bad("Template not found.");
  return runAction((tx, actor) => setup.deleteOfferTemplate(tx, actor, id));
}

export async function saveCareerSiteAction(title: string, about: string, tagline: string) {
  return runAction((tx, actor) => setup.saveCareerSite(tx, actor, { title: str(title, 200), about: str(about, 5000), tagline: str(tagline, 200) }));
}

export async function saveChainAction(entity: string, levels: unknown) {
  const e = z.enum(["requisition", "offer"]).safeParse(entity);
  const l = z.array(z.object({ approver: z.enum(["manager", "l2_manager", "role", "employee"]), role: z.string().max(60).optional(), id: z.string().optional() })).max(6).safeParse(levels);
  if (!e.success || !l.success) return bad("Check the approval levels.");
  return runAction((tx, actor) => setup.saveApprovalChain(tx, actor, e.data, l.data));
}

export async function saveFieldAction(id: string | null, raw: unknown) {
  const p = z.object({ label: z.string().max(80), type: z.string().max(20), options: z.array(z.string().max(80)).max(40), required: z.boolean() }).safeParse(raw);
  if ((id && !isId(id)) || !p.success) return bad("Check the field.");
  return runAction((tx, actor) => setup.saveCandidateField(tx, actor, id, p.data));
}
export async function deleteFieldAction(id: string) {
  if (!isId(id)) return bad("Field not found.");
  return runAction((tx, actor) => setup.deleteCandidateField(tx, actor, id));
}

// ============================== me: internal jobs and referrals ==============================
export async function applyInternalAction(jobId: string, note: string) {
  if (!isId(jobId)) return bad("Job not found.");
  return runAction((tx, actor) => internal.applyInternal(tx, actor, jobId, str(note, 2000) || null));
}

export async function referAction(form: FormData) {
  if (!(form instanceof FormData)) return bad("Check the details.");
  const jobId = form.get("jobId");
  if (!isId(jobId)) return bad("Pick a job.", "jobId");
  const resume = await fileFrom(form, "resume");
  if (resume === "too_big") return bad("The resume is larger than 5 MB.", "resume");
  return runAction((tx, actor) => internal.refer(tx, actor, jobId, {
    firstName: str(form.get("firstName"), 100), lastName: str(form.get("lastName"), 100) || null, email: str(form.get("email"), 254), mobile: str(form.get("mobile"), 30) || null,
    note: str(form.get("note"), 1000) || null, resume,
  }));
}
