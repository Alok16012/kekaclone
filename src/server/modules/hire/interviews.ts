import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { notifyEmployee } from "@/server/modules/approvals/service";
import { queueEmail } from "@/server/email";
import { actOnApplication, seeApplication } from "./access";
import { appEvent, valuesFor } from "./candidates";
import { audit } from "./setup";
import { candidateMail, emailFromTemplate } from "./mail";
import { findToken, issueToken, publicLink } from "./tokens";
import { calendarStatus } from "./calendar";
import { icsFor, overlaps, safeMeetingUrl, scoreSubmission, slotLabel, validateInterviewTime, validateSlots, type ScalePoint, type Section, type Slot } from "./rules";

const MODES = ["online", "in_person", "phone"] as const;
export const MODE_LABEL: Record<string, string> = { online: "Video call", in_person: "In person", phone: "Phone call" };

export type ScheduleInput = {
  title: string; mode: string; scheduling: "fixed" | "self_schedule"; start?: string | null; end?: string | null; slots?: { start: string; end: string }[];
  meetingUrl?: string | null; location?: string | null; panel: string[]; scorecardId: string | null; notes?: string | null; notifyCandidate: boolean; allowConflict?: boolean;
};

/** Panelists already booked in an overlapping scheduled interview. */
async function conflicts(tx: Tx, panel: string[], slot: Slot, exceptInterviewId: string | null) {
  return tx<{ name: string; starts_at: Date }[]>`
    select e.display_name as name, i.starts_at from interviews i join interview_panelists p on p.interview_id = i.id join employees e on e.id = p.employee_id
    where p.employee_id = any(${panel}::uuid[]) and i.status = 'scheduled' and i.starts_at < ${slot.end} and i.ends_at > ${slot.start} and i.id is distinct from ${exceptInterviewId}`;
}

const rangeLit = (s: Slot) => `[${s.start.toISOString()},${s.end.toISOString()})`;

export async function scheduleInterview(tx: Tx, actor: Actor, applicationId: string, input: ScheduleInput, now = new Date()) {
  const { app } = await actOnApplication(tx, actor, applicationId);
  if (app.status !== "active") throw new AppError("conflict", "This candidate is no longer active on the job.");
  if (!MODES.includes(input.mode as (typeof MODES)[number])) throw new AppError("invalid", "Pick how the interview happens.", "mode");
  const title = input.title.trim().slice(0, 120) || "Interview";
  const panel = [...new Set(input.panel)];
  if (!panel.length) throw new AppError("invalid", "Add at least one interviewer.", "panel");
  if (panel.length > 10) throw new AppError("invalid", "Add at most 10 interviewers.", "panel");
  if (app.candidate_employee_id && panel.includes(app.candidate_employee_id)) throw new AppError("invalid", "The candidate can't interview themselves.", "panel");
  const found = await tx<{ id: string; name: string; work_email: string }[]>`select id, display_name as name, work_email::text from employees where id = any(${panel}::uuid[]) and status <> 'relieved'`;
  if (found.length !== panel.length) throw new AppError("invalid", "Someone on the panel has left or doesn't exist.", "panel");
  if (input.scorecardId) { const [s] = await tx`select 1 from scorecards where id = ${input.scorecardId}`; if (!s) throw new AppError("invalid", "Pick a scorecard.", "scorecardId"); }
  const meetingUrl = input.mode === "online" ? safeMeetingUrl(input.meetingUrl) : null;
  if (input.mode === "online" && input.meetingUrl?.trim() && !meetingUrl) throw new AppError("invalid", "The meeting link must start with https://", "meetingUrl");
  const location = input.mode === "in_person" ? input.location?.trim().slice(0, 200) || null : null;
  if (input.mode === "in_person" && !location) throw new AppError("invalid", "Where will the interview happen?", "location");

  let start: Date | null = null, end: Date | null = null, slots: Slot[] = [];
  if (input.scheduling === "fixed") {
    start = new Date(input.start ?? ""); end = new Date(input.end ?? "");
    const p = validateInterviewTime(start, end, now);
    if (p) throw new AppError("invalid", p, "start");
    const busy = await conflicts(tx, panel, { start, end }, null);
    if (busy.length && !input.allowConflict) throw new AppError("conflict", `${[...new Set(busy.map((b) => b.name))].join(", ")} already ${busy.length === 1 ? "has an interview" : "have interviews"} at that time.`, "conflict");
  } else if (input.scheduling === "self_schedule") {
    slots = (input.slots ?? []).map((s) => ({ start: new Date(s.start), end: new Date(s.end) }));
    const p = validateSlots(slots, now);
    if (p) throw new AppError("invalid", p, "slots");
  } else throw new AppError("invalid", "Pick a time, or let the candidate choose.", "scheduling");

  const [i] = await tx<{ id: string }[]>`
    insert into interviews (tenant_id, application_id, stage_id, mode, scheduling, starts_at, ends_at, slot_options, meeting_url, location, scorecard_id, status, title, notes, created_by)
    values (${actor.tenant.id}, ${applicationId}, ${app.stage_id}, ${input.mode}, ${input.scheduling}, ${start}, ${end},
      ${slots.length ? slots.map(rangeLit) : null}::tstzrange[], ${meetingUrl}, ${location}, ${input.scorecardId}, ${input.scheduling === "fixed" ? "scheduled" : "awaiting_candidate"},
      ${title}, ${input.notes?.trim().slice(0, 2000) || null}, ${actor.userId}) returning id`;
  for (const p of panel) await tx`insert into interview_panelists (interview_id, employee_id, tenant_id) values (${i.id}, ${p}, ${actor.tenant.id})`;
  const v = await valuesFor(tx, actor.tenant.name, applicationId);
  const when = start && end ? slotLabel({ start, end }) : "a time you choose";
  for (const p of found) {
    const token = await issueToken(tx, { tenantId: actor.tenant.id, kind: "scorecard", interviewId: i.id, employeeId: p.id, days: 45 });
    await notifyEmployee(tx, actor.tenant.id, p.id, "hire.interview", `Interview: ${v.values["candidate.name"]}`, `${v.values["job.title"]} · ${when}`, "/hire/interviews");
    const link = publicLink(actor.tenant.subdomain, "scorecard", token);
    const mail = candidateMail(actor.tenant.name, `Interview with ${v.values["candidate.name"]} (${v.values["job.title"]})`,
      `Hi ${p.name.split(" ")[0]},\n\nYou're on the panel for ${v.values["candidate.name"]} (${v.values["job.title"]}), ${when}.\n\nAfter the interview, share your feedback here:\n${link}\n\nYou can also find it under Hiring → My interviews.`);
    await queueEmail(tx, actor.tenant.id, { kind: "hire.panel", to: p.work_email, ...mail });
  }
  if (input.notifyCandidate || input.scheduling === "self_schedule") {
    if (input.scheduling === "self_schedule") {
      const token = await issueToken(tx, { tenantId: actor.tenant.id, kind: "self_schedule", interviewId: i.id, candidateId: app.candidate_id, days: 14 });
      await emailFromTemplate(tx, { tenantId: actor.tenant.id, company: actor.tenant.name, to: v.email, applicationId, actorEmployeeId: actor.employeeId, key: "self_schedule",
        values: { ...v.values, link: publicLink(actor.tenant.subdomain, "self_schedule", token), "interview.mode": MODE_LABEL[input.mode] } });
    } else {
      await emailFromTemplate(tx, { tenantId: actor.tenant.id, company: actor.tenant.name, to: v.email, applicationId, actorEmployeeId: actor.employeeId, key: "interview_scheduled",
        values: { ...v.values, "interview.when": when, "interview.mode": MODE_LABEL[input.mode], "interview.link": meetingUrl ?? location ?? "We'll call you on your mobile number." } });
    }
  }
  await appEvent(tx, actor.tenant.id, applicationId, "interview_scheduled", { interview_id: i.id, title, when: start ? when : null, self_schedule: input.scheduling === "self_schedule", panel: found.map((p) => p.name) }, actor.employeeId);
  await audit(tx, actor, actor.tenant.id, "interview", i.id, "create", { application_id: applicationId, scheduling: input.scheduling });
  return { interviewId: i.id, calendarConfigured: calendarStatus().configured };
}

async function interviewFor(tx: Tx, actor: Actor, interviewId: string, opts: { act: boolean }) {
  const [i] = await tx<{ id: string; application_id: string; status: string }[]>`select id, application_id, status from interviews where id = ${interviewId} for update`;
  if (!i) throw new AppError("not_found", "Interview not found.");
  if (opts.act) await actOnApplication(tx, actor, i.application_id); else await seeApplication(tx, actor, i.application_id);
  return i;
}

export async function setInterviewStatus(tx: Tx, actor: Actor, interviewId: string, status: "completed" | "no_show" | "cancelled", reason?: string | null) {
  const i = await interviewFor(tx, actor, interviewId, { act: true });
  const allowed = status === "cancelled" ? ["scheduled", "awaiting_candidate"] : ["scheduled"];
  if (!allowed.includes(i.status)) throw new AppError("conflict", "The interview can't change to that now.");
  await tx`update interviews set status = ${status} where id = ${interviewId}`;
  if (status === "cancelled") await tx`update hire_tokens set expires_at = least(expires_at, now()) where interview_id = ${interviewId} and kind = 'self_schedule'`;
  await appEvent(tx, actor.tenant.id, i.application_id, `interview_${status}`, { interview_id: interviewId, reason: reason?.slice(0, 500) || null }, actor.employeeId);
  await audit(tx, actor, actor.tenant.id, "interview", interviewId, `status.${status}`);
}

/** Interviews where the actor is on the panel: upcoming, waiting for a slot, and recent ones still needing feedback. */
export async function myInterviews(tx: Tx, actor: Actor) {
  return tx<{ id: string; title: string | null; candidate: string; candidate_id: string; job: string; mode: string; starts_at: Date | null; ends_at: Date | null; status: string; meeting_url: string | null; location: string | null; submitted: boolean; has_scorecard: boolean }[]>`
    select i.id, i.title, trim(c.first_name || ' ' || coalesce(c.last_name, '')) as candidate, c.id as candidate_id, j.title as job, i.mode, i.starts_at, i.ends_at, i.status, i.meeting_url, i.location,
      exists (select 1 from scorecard_submissions x where x.interview_id = i.id and x.interviewer_employee_id = ${actor.employeeId} and x.submitted_at is not null) as submitted,
      i.scorecard_id is not null as has_scorecard
    from interview_panelists p join interviews i on i.id = p.interview_id join applications a on a.id = i.application_id join candidates c on c.id = a.candidate_id join jobs j on j.id = a.job_id
    where p.employee_id = ${actor.employeeId} and c.employee_id is distinct from ${actor.employeeId}
      and (i.status in ('scheduled','awaiting_candidate') or (i.status in ('completed') and i.starts_at > now() - interval '45 days'))
    order by i.starts_at nulls last`;
}

// ---------- scorecards ----------
type CardForm = { interviewId: string; applicationId: string; candidate: string; job: string; title: string | null; startsAt: Date | null; scorecard: { id: string; name: string; sections: Section[]; points: ScalePoint[]; overall_rating: boolean }; submitted: boolean; interviewer: string };

async function cardCore(tx: Tx, interviewId: string, employeeId: string): Promise<CardForm> {
  const [i] = await tx<{ id: string; application_id: string; status: string; title: string | null; starts_at: Date | null; scorecard_id: string | null; candidate: string; job: string; candidate_employee_id: string | null; on_panel: boolean; interviewer: string }[]>`
    select i.id, i.application_id, i.status, i.title, i.starts_at, i.scorecard_id, trim(c.first_name || ' ' || coalesce(c.last_name, '')) as candidate, j.title as job, c.employee_id as candidate_employee_id,
      exists (select 1 from interview_panelists p where p.interview_id = i.id and p.employee_id = ${employeeId}) as on_panel, (select display_name from employees where id = ${employeeId}) as interviewer
    from interviews i join applications a on a.id = i.application_id join candidates c on c.id = a.candidate_id join jobs j on j.id = a.job_id where i.id = ${interviewId}`;
  if (!i || !i.on_panel || i.candidate_employee_id === employeeId) throw new AppError("not_found", "Interview not found.");
  if (i.status === "cancelled") throw new AppError("conflict", "This interview was cancelled.");
  const [sc] = await tx<CardForm["scorecard"][]>`
    select s.id, s.name, s.sections, r.points, s.overall_rating from scorecards s join rating_scales r on r.id = s.rating_scale_id
    where s.id = coalesce(${i.scorecard_id}, (select id from scorecards order by created_at limit 1))`;
  if (!sc) throw new AppError("invalid", "No scorecard is set up yet. Ask a hiring admin to add one.");
  const [sub] = await tx`select 1 from scorecard_submissions where interview_id = ${interviewId} and interviewer_employee_id = ${employeeId} and submitted_at is not null`;
  return { interviewId, applicationId: i.application_id, candidate: i.candidate, job: i.job, title: i.title, startsAt: i.starts_at, scorecard: { ...sc, points: [...sc.points].sort((a, b) => a.value - b.value) }, submitted: !!sub, interviewer: i.interviewer };
}

export type ScoreInput = { ratings: Record<string, number>; overall: number | null; recommendation: string | null; comments: string | null };

async function submitCore(tx: Tx, tenantId: string, employeeId: string, userId: string | null, interviewId: string, input: ScoreInput) {
  const f = await cardCore(tx, interviewId, employeeId);
  if (f.submitted) throw new AppError("conflict", "You've already sent feedback for this interview.");
  const s = scoreSubmission({ sections: f.scorecard.sections, points: f.scorecard.points, overallRating: f.scorecard.overall_rating }, input);
  if (!s.ok) throw new AppError("invalid", s.error);
  const comments = input.comments?.trim().slice(0, 4000) || null;
  const [x] = await tx<{ id: string }[]>`
    insert into scorecard_submissions (tenant_id, interview_id, application_id, scorecard_id, interviewer_employee_id, ratings, overall, recommendation, comments, submitted_at)
    values (${tenantId}, ${interviewId}, ${f.applicationId}, ${f.scorecard.id}, ${employeeId}, ${tx.json(s.ratings)}, ${s.overall}, ${input.recommendation}, ${comments}, now())
    on conflict (interview_id, interviewer_employee_id) do update set ratings = excluded.ratings, overall = excluded.overall, recommendation = excluded.recommendation,
      comments = excluded.comments, submitted_at = now(), scorecard_id = excluded.scorecard_id
      where scorecard_submissions.submitted_at is null
    returning id`;
  if (!x) throw new AppError("conflict", "You've already sent feedback for this interview.");
  await tx`update interviews set status = 'completed' where id = ${interviewId} and status = 'scheduled' and ends_at < now()`;
  await appEvent(tx, tenantId, f.applicationId, "feedback", { interview_id: interviewId, overall: s.overall, recommendation: input.recommendation, by: f.interviewer }, employeeId);
  const team = await tx<{ id: string }[]>`select distinct t.employee_id as id from applications a join job_team_members t on t.job_id = a.job_id where a.id = ${f.applicationId} and t.role in ('recruiter','hiring_manager') and t.employee_id <> ${employeeId}`;
  for (const m of team) await notifyEmployee(tx, tenantId, m.id, "hire.feedback", `Feedback on ${f.candidate}`, `${f.interviewer} sent their scorecard`, "/hire/jobs");
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${tenantId}, ${userId}, 'scorecard_submission', ${x.id}, 'submit', ${tx.json({ interview_id: interviewId, overall: s.overall })})`;
  return { id: x.id, overall: s.overall };
}

export const scorecardForm = (tx: Tx, actor: Actor, interviewId: string) => cardCore(tx, interviewId, actor.employeeId);
export const submitScorecard = (tx: Tx, actor: Actor, interviewId: string, input: ScoreInput) => submitCore(tx, actor.tenant.id, actor.employeeId, actor.userId, interviewId, input);

/** Scorecard link sent to an interviewer: works without signing in, for that interviewer and interview only. */
export async function scorecardByToken(tx: Tx, token: string) {
  const t = await findToken(tx, "scorecard", token);
  if (!t) return null;
  try { return await cardCore(tx, t.interview_id!, t.employee_id!); } catch (e) { if (e instanceof AppError) return null; throw e; }
}
export async function submitScorecardByToken(tx: Tx, tenantId: string, token: string, input: ScoreInput) {
  const t = await findToken(tx, "scorecard", token);
  if (!t) throw new AppError("invalid", "This feedback link has expired. Open the interview from erp instead.");
  const [u] = await tx<{ user_id: string | null }[]>`select user_id from employees where id = ${t.employee_id}`;
  const r = await submitCore(tx, tenantId, t.employee_id!, u?.user_id ?? null, t.interview_id!, input);
  await tx`update hire_tokens set used_at = now() where id = ${t.id}`;
  return r;
}

// ---------- self-scheduling (public) ----------
type RawSlot = { s: string; e: string };
const toSlot = (r: RawSlot | undefined): Slot | null => (r ? { start: new Date(r.s), end: new Date(r.e) } : null);
const SLOTS_JSON = "coalesce((select json_agg(json_build_object('s', lower(r), 'e', upper(r)) order by n) from unnest(i.slot_options) with ordinality as u(r, n)), '[]')";

export async function selfScheduleView(tx: Tx, token: string, now = new Date()) {
  const t = await findToken(tx, "self_schedule", token, { allowUsed: true });
  if (!t) return null;
  const [i] = await tx<{ id: string; status: string; mode: string; title: string | null; slot_options: RawSlot[]; starts_at: Date | null; ends_at: Date | null; first_name: string; job: string; company: string; meeting_url: string | null; location: string | null }[]>`
    select i.id, i.status, i.mode, i.title, ${tx.unsafe(SLOTS_JSON)} as slot_options, i.starts_at, i.ends_at, c.first_name, j.title as job, (select name from tenants) as company, i.meeting_url, i.location
    from interviews i join applications a on a.id = i.application_id join candidates c on c.id = a.candidate_id join jobs j on j.id = a.job_id where i.id = ${t.interview_id}`;
  if (!i || i.status === "cancelled") return null;
  const slots = i.slot_options.map(toSlot).filter((s): s is Slot => !!s).map((s, idx) => ({ index: idx, start: s.start, end: s.end, label: slotLabel(s), past: s.start <= now }));
  return { ...i, slots, picked: i.status === "scheduled" && i.starts_at ? slotLabel({ start: i.starts_at, end: i.ends_at! }) : null, modeLabel: MODE_LABEL[i.mode] };
}

export async function pickSlot(tx: Tx, tenant: { id: string; name: string }, token: string, index: number, now = new Date()) {
  const t = await findToken(tx, "self_schedule", token);
  if (!t) throw new AppError("invalid", "This link has expired or a time was already picked.");
  const [i] = await tx<{ id: string; status: string; slot_options: RawSlot[]; application_id: string; mode: string; meeting_url: string | null; location: string | null }[]>`
    select i.id, i.status, ${tx.unsafe(SLOTS_JSON)} as slot_options, i.application_id, i.mode, i.meeting_url, i.location from interviews i where i.id = ${t.interview_id} for update`;
  if (!i || i.status !== "awaiting_candidate") throw new AppError("conflict", "This interview isn't waiting for a time any more.");
  const slot = Number.isInteger(index) ? toSlot(i.slot_options[index]) : null;
  if (!slot) throw new AppError("invalid", "Pick one of the times shown.");
  if (slot.start <= now) throw new AppError("invalid", "That time has passed. Pick another.");
  const panel = (await tx<{ employee_id: string }[]>`select employee_id from interview_panelists where interview_id = ${i.id}`).map((p) => p.employee_id);
  const busy = await conflicts(tx, panel, slot, i.id);
  if (busy.length) throw new AppError("conflict", "That time was just taken. Pick another.");
  await tx`update interviews set starts_at = ${slot.start}, ends_at = ${slot.end}, status = 'scheduled' where id = ${i.id}`;
  await tx`update hire_tokens set used_at = now() where id = ${t.id}`;
  const v = await valuesFor(tx, tenant.name, i.application_id);
  const when = slotLabel(slot);
  await appEvent(tx, tenant.id, i.application_id, "slot_picked", { interview_id: i.id, when }, null);
  for (const p of panel) await notifyEmployee(tx, tenant.id, p, "hire.interview", `Interview booked: ${v.values["candidate.name"]}`, when, "/hire/interviews");
  await emailFromTemplate(tx, { tenantId: tenant.id, company: tenant.name, to: v.email, applicationId: i.application_id, actorEmployeeId: null, key: "interview_scheduled",
    values: { ...v.values, "interview.when": when, "interview.mode": MODE_LABEL[i.mode], "interview.link": i.meeting_url ?? i.location ?? "We'll call you on your mobile number." } });
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${tenant.id}, null, 'interview', ${i.id}, 'slot_picked', ${tx.json({ when })})`;
  return { when };
}

/** Calendar file for an interview the actor can see. */
export async function interviewIcs(tx: Tx, actor: Actor, interviewId: string) {
  const [i] = await tx<{ application_id: string; starts_at: Date | null; ends_at: Date | null; title: string | null; mode: string; meeting_url: string | null; location: string | null }[]>`
    select application_id, starts_at, ends_at, title, mode, meeting_url, location from interviews where id = ${interviewId}`;
  if (!i || !i.starts_at || !i.ends_at) return null;
  try { await seeApplication(tx, actor, i.application_id); } catch { return null; }
  const v = await valuesFor(tx, actor.tenant.name, i.application_id);
  return icsFor({ uid: interviewId, start: i.starts_at, end: i.ends_at, title: `${i.title ?? "Interview"}: ${v.values["candidate.name"]}`, description: `${v.values["job.title"]} · ${MODE_LABEL[i.mode]}${i.meeting_url ? `\n${i.meeting_url}` : ""}`, location: i.meeting_url ?? i.location, now: new Date() });
}

export { overlaps };
