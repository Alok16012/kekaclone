import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { audit } from "@/server/modules/audit/service";
import { todayIn, type ISODate } from "@/lib/dates";
import {
  MIN_THRESHOLD, canShow, csvRow, nextRoundStart, displayStatus, dueTransition, schedule as toSchedule, summarize, validateAnswers, validateQuestion, validateSchedule,
  QUESTION_LABEL, STARTERS, type Answer, type Question, type QuestionInput, type QuestionSummary, type Recurrence, type Schedule, type SurveyStatus,
} from "./rules";

export const SURVEYS_PERMISSION = "surveys.manage";
const EVERYWHERE: Placement = { department_id: null, location_id: null, legal_entity_id: null, business_unit_id: null };
/** Surveys go to the whole company or parts of it and their results are company-wide: manage needs an unscoped grant. */
export const canManageSurveys = (actor: Actor) => canFor(actor, SURVEYS_PERMISSION, EVERYWHERE);
const assertManage = (actor: Actor) => { if (!canManageSurveys(actor)) throw new AppError("forbidden", "You don't have access to do this."); };

export type Audience = { type: "org" } | { type: "departments"; ids: string[] } | { type: "locations"; ids: string[] };
type SurveyRow = { id: string; title: string; description: string | null; is_anonymous: boolean; min_responses_to_show: number; audience: Audience; schedule: Partial<Schedule> | null; status: SurveyStatus; created_at: Date };

/** People a survey is for: everyone working (not preboarding or relieved) in the chosen departments / locations. */
function audienceWhere(tx: Tx, a: Audience) {
  const base = tx`e.status in ('active', 'notice')`;
  return a.type === "departments" ? tx`${base} and e.department_id = any(${a.ids}::uuid[])`
    : a.type === "locations" ? tx`${base} and e.location_id = any(${a.ids}::uuid[])` : base;
}

async function loadSurvey(tx: Tx, id: string, lock = false): Promise<SurveyRow> {
  const [s] = await tx<SurveyRow[]>`select id, title, description, is_anonymous, min_responses_to_show, audience, schedule, status, created_at from surveys where id = ${id} ${lock ? tx`for update` : tx``}`;
  if (!s) throw new AppError("not_found", "Survey not found.");
  return s;
}

async function questionsOf(tx: Tx, surveyId: string): Promise<Question[]> {
  return tx<Question[]>`select id, type, prompt, required, options from survey_questions where survey_id = ${surveyId} order by position, created_at`;
}

// ---------------------------------------------------------------- admin: list + builder

export type SurveyListRow = { id: string; title: string; status: SurveyStatus | "scheduled"; anonymous: boolean; round: number; recurrence: Recurrence; startOn: string | null; endOn: string | null; questions: number; responses: number; audience: number; created_at: string };

export async function listSurveys(tx: Tx, actor: Actor): Promise<SurveyListRow[]> {
  assertManage(actor);
  const rows = await tx<(SurveyRow & { questions: number; responses: number })[]>`
    select s.id, s.title, s.description, s.is_anonymous, s.min_responses_to_show, s.audience, s.schedule, s.status, s.created_at,
      (select count(*)::int from survey_questions q where q.survey_id = s.id) as questions,
      (select count(*)::int from survey_participations p where p.survey_id = s.id and p.round = coalesce((s.schedule->>'round')::int, 1)) as responses
    from surveys s order by s.created_at desc`;
  const out: SurveyListRow[] = [];
  for (const r of rows) {
    const sc = toSchedule(r.schedule);
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from employees e where ${audienceWhere(tx, r.audience)}`;
    out.push({ id: r.id, title: r.title, status: displayStatus(r.status, sc), anonymous: r.is_anonymous, round: sc.round, recurrence: sc.recurrence, startOn: sc.startOn, endOn: sc.endOn,
      questions: r.questions, responses: r.responses, audience: n, created_at: r.created_at.toISOString() });
  }
  return out;
}

export type SurveyDetail = {
  id: string; title: string; description: string | null; anonymous: boolean; minResponses: number; audience: Audience; schedule: Schedule;
  status: SurveyStatus; questions: Question[]; audienceSize: number; responses: number;
};

export async function surveyDetail(tx: Tx, actor: Actor, id: string): Promise<SurveyDetail | null> {
  assertManage(actor);
  const [s] = await tx<SurveyRow[]>`select id, title, description, is_anonymous, min_responses_to_show, audience, schedule, status, created_at from surveys where id = ${id}`;
  if (!s) return null;
  const sc = toSchedule(s.schedule);
  const [[{ n }], [{ r }], questions] = await Promise.all([
    tx<{ n: number }[]>`select count(*)::int as n from employees e where ${audienceWhere(tx, s.audience)}`,
    tx<{ r: number }[]>`select count(*)::int as r from survey_participations where survey_id = ${id} and round = ${sc.round}`,
    questionsOf(tx, id),
  ]);
  return { id: s.id, title: s.title, description: s.description, anonymous: s.is_anonymous, minResponses: s.min_responses_to_show, audience: s.audience, schedule: sc, status: s.status, questions, audienceSize: n, responses: r };
}

async function checkAudience(tx: Tx, a: Audience): Promise<Audience> {
  if (a.type === "org") return { type: "org" };
  const ids = [...new Set(a.ids)];
  if (!ids.length) throw new AppError("invalid", a.type === "departments" ? "Pick at least one department." : "Pick at least one location.", "audience");
  const [{ n }] = a.type === "departments"
    ? await tx<{ n: number }[]>`select count(*)::int as n from departments where id = any(${ids}::uuid[])`
    : await tx<{ n: number }[]>`select count(*)::int as n from locations where id = any(${ids}::uuid[])`;
  if (n !== ids.length) throw new AppError("invalid", "Some of the picked groups no longer exist.", "audience");
  return { type: a.type, ids };
}

export type SurveySettings = { title: string; description?: string | null; anonymous: boolean; minResponses: number; audience: Audience; startOn: ISODate | null; endOn: ISODate | null; recurrence: Recurrence };

/** Create or edit a survey's settings. Anonymity and audience are fixed once it has gone live. */
export async function saveSurvey(tx: Tx, actor: Actor, id: string | null, input: SurveySettings, today: ISODate = todayIn()) {
  assertManage(actor);
  const title = input.title.trim().slice(0, 160);
  if (!title) throw new AppError("invalid", "Give the survey a title.", "title");
  if (!Number.isInteger(input.minResponses) || input.minResponses < MIN_THRESHOLD || input.minResponses > 50) throw new AppError("invalid", `Use a minimum between ${MIN_THRESHOLD} and 50.`, "minResponses");
  const audience = await checkAudience(tx, input.audience);
  const description = input.description?.trim().slice(0, 2000) || null;
  if (id) {
    const s = await loadSurvey(tx, id, true);
    const sc = toSchedule(s.schedule);
    if (s.status === "closed") throw new AppError("conflict", "This survey is closed.");
    const live = s.status === "live";
    if (live && (input.anonymous !== s.is_anonymous || JSON.stringify(audience) !== JSON.stringify(s.audience))) throw new AppError("invalid", "Anonymity and audience can't change once a survey is live.");
    const startOn = live ? sc.startOn : input.startOn;
    const err = validateSchedule({ startOn: live ? null : startOn, endOn: input.endOn, recurrence: input.recurrence }, today);
    if (err) throw new AppError("invalid", err, "schedule");
    const next: Schedule = { ...sc, startOn, endOn: input.endOn, recurrence: input.recurrence };
    await tx`update surveys set title = ${title}, description = ${description}, is_anonymous = ${input.anonymous}, min_responses_to_show = ${input.minResponses},
             audience = ${tx.json(audience as never)}, schedule = ${tx.json(next as never)} where id = ${id}`;
    await audit(tx, actor, { entityType: "survey", entityId: id, action: "update", diff: { title, anonymous: input.anonymous, audience, schedule: next } });
    return { id };
  }
  const err = validateSchedule(input, today);
  if (err) throw new AppError("invalid", err, "schedule");
  const sc: Schedule = { startOn: input.startOn, endOn: input.endOn, recurrence: input.recurrence, round: 1, roundStartedOn: null };
  const [r] = await tx<{ id: string }[]>`
    insert into surveys (tenant_id, title, description, is_anonymous, min_responses_to_show, audience, schedule, status, created_by)
    values (${actor.tenant.id}, ${title}, ${description}, ${input.anonymous}, ${input.minResponses}, ${tx.json(audience as never)}, ${tx.json(sc as never)}, 'draft', ${actor.employeeId}) returning id`;
  await audit(tx, actor, { entityType: "survey", entityId: r.id, action: "create", diff: { title, anonymous: input.anonymous } });
  return r;
}

async function assertDraft(tx: Tx, surveyId: string) {
  const s = await loadSurvey(tx, surveyId, true);
  if (s.status !== "draft") throw new AppError("conflict", "Questions can't change once a survey is live, so earlier answers stay comparable.");
  return s;
}

export async function saveQuestion(tx: Tx, actor: Actor, surveyId: string, questionId: string | null, q: QuestionInput) {
  assertManage(actor);
  await assertDraft(tx, surveyId);
  const v = validateQuestion(q);
  if (!v.ok) throw new AppError("invalid", v.error, v.field);
  const prompt = q.prompt.trim();
  if (questionId) {
    const [r] = await tx<{ id: string }[]>`update survey_questions set type = ${q.type}, prompt = ${prompt}, required = ${q.required}, options = ${v.options ? tx.json(v.options as never) : null}
      where id = ${questionId} and survey_id = ${surveyId} returning id`;
    if (!r) throw new AppError("not_found", "Question not found.");
    return r;
  }
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from survey_questions where survey_id = ${surveyId}`;
  if (n >= 50) throw new AppError("invalid", "A survey can have up to 50 questions.");
  const [r] = await tx<{ id: string }[]>`
    insert into survey_questions (tenant_id, survey_id, type, prompt, required, options, position)
    values (${actor.tenant.id}, ${surveyId}, ${q.type}, ${prompt}, ${q.required}, ${v.options ? tx.json(v.options as never) : null}, ${n}) returning id`;
  return r;
}

export async function deleteQuestion(tx: Tx, actor: Actor, surveyId: string, questionId: string) {
  assertManage(actor);
  await assertDraft(tx, surveyId);
  const r = await tx`delete from survey_questions where id = ${questionId} and survey_id = ${surveyId}`;
  if (!r.count) throw new AppError("not_found", "Question not found.");
}

export async function moveQuestion(tx: Tx, actor: Actor, surveyId: string, questionId: string, dir: "up" | "down") {
  assertManage(actor);
  await assertDraft(tx, surveyId);
  const rows = await tx<{ id: string }[]>`select id from survey_questions where survey_id = ${surveyId} order by position, created_at`;
  const i = rows.findIndex((r) => r.id === questionId), j = dir === "up" ? i - 1 : i + 1;
  if (i < 0) throw new AppError("not_found", "Question not found.");
  if (j < 0 || j >= rows.length) return;
  [rows[i], rows[j]] = [rows[j], rows[i]];
  for (const [pos, r] of rows.entries()) await tx`update survey_questions set position = ${pos} where id = ${r.id}`;
}

export async function deleteSurvey(tx: Tx, actor: Actor, id: string) {
  assertManage(actor);
  const s = await loadSurvey(tx, id, true);
  if (s.status !== "draft") throw new AppError("conflict", "Only drafts can be deleted. Close a live survey instead; its results are kept.");
  await tx`delete from surveys where id = ${id}`;
  await audit(tx, actor, { entityType: "survey", entityId: id, action: "delete", diff: { title: s.title } });
}

/** Tell everyone in the audience who hasn't answered this round (one set-based insert). */
async function notifyAudience(tx: Tx, s: SurveyRow, round: number, title: string, body: string) {
  await tx`insert into notifications (tenant_id, user_id, kind, title, body, link)
    select e.tenant_id, e.user_id, 'survey.open', ${title}, ${body}, ${"/me/surveys/" + s.id}
    from employees e where e.user_id is not null and ${audienceWhere(tx, s.audience)}
      and not exists (select 1 from survey_participations p where p.survey_id = ${s.id} and p.employee_id = e.id and p.round = ${round})`;
}

/** Open a survey now (or, with a future start date, leave it scheduled for the job). Guarded on status. */
async function goLive(tx: Tx, s: SurveyRow, today: ISODate, actorUserId: string | null) {
  const sc = toSchedule(s.schedule);
  const next: Schedule = { ...sc, startOn: sc.startOn ?? today, round: 1, roundStartedOn: today };
  const [u] = await tx<{ id: string }[]>`update surveys set status = 'live', schedule = ${tx.json(next as never)} where id = ${s.id} and status = 'draft' returning id`;
  if (!u) return false;
  await notifyAudience(tx, s, 1, "New survey", s.title);
  await audit(tx, { tenantId: (await tx<{ t: string }[]>`select tenant_id as t from surveys where id = ${s.id}`)[0].t, userId: actorUserId }, { entityType: "survey", entityId: s.id, action: "launch" });
  return true;
}

export async function launchSurvey(tx: Tx, actor: Actor, id: string, today: ISODate = todayIn()) {
  assertManage(actor);
  const s = await loadSurvey(tx, id, true);
  if (s.status !== "draft") throw new AppError("conflict", "This survey is already live or closed.");
  const qs = await questionsOf(tx, id);
  if (!qs.length) throw new AppError("invalid", "Add at least one question first.");
  const sc = toSchedule(s.schedule);
  if (sc.endOn && sc.endOn < today) throw new AppError("invalid", "The end date has passed. Change it first.");
  if (sc.startOn && sc.startOn > today) return { scheduled: sc.startOn };   // the job opens it on the start date
  await goLive(tx, s, today, actor.userId);
  return { scheduled: null };
}

export async function closeSurvey(tx: Tx, actor: Actor, id: string) {
  assertManage(actor);
  const [u] = await tx<{ id: string }[]>`update surveys set status = 'closed' where id = ${id} and status = 'live' returning id`;
  if (!u) throw new AppError("conflict", "Only live surveys can be closed.");
  await audit(tx, actor, { entityType: "survey", entityId: id, action: "close" });
}

/**
 * Scheduler (job and lazily on page loads): opens scheduled drafts on their start date, starts the next round of
 * pulse surveys, closes surveys past their end date. Idempotent: running it twice the same day does nothing more.
 */
export async function processDueSurveys(tx: Tx, today: ISODate = todayIn()) {
  const rows = await tx<SurveyRow[]>`select id, title, description, is_anonymous, min_responses_to_show, audience, schedule, status, created_at from surveys where status in ('draft', 'live') for update skip locked`;
  const done = { launched: 0, rounds: 0, closed: 0 };
  for (const s of rows) {
    const sc = toSchedule(s.schedule);
    const t = dueTransition(s.status, sc, today);
    if (t === "launch") {
      const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from survey_questions where survey_id = ${s.id}`;
      if (n && (await goLive(tx, s, today, null))) done.launched++;
    } else if (t === "close") {
      await tx`update surveys set status = 'closed' where id = ${s.id} and status = 'live'`;
      done.closed++;
    } else if (t === "next_round") {
      // catch up to the round that covers today (a job that didn't run for a while doesn't open several rounds)
      let start = sc.roundStartedOn!, round = sc.round;
      for (let guard = 0; guard < 200; guard++) {
        const nx = dueTransition("live", { ...sc, roundStartedOn: start }, today) === "next_round" ? nextRoundStart(start, sc.recurrence) : null;
        if (!nx) break;
        start = nx; round++;
      }
      const next: Schedule = { ...sc, round, roundStartedOn: start };
      const [u] = await tx<{ id: string }[]>`update surveys set schedule = ${tx.json(next as never)} where id = ${s.id} and (schedule->>'round')::int = ${sc.round} returning id`;
      if (u) { await notifyAudience(tx, s, round, "Time for a quick pulse", s.title); done.rounds++; }
    }
  }
  return done;
}

// ---------------------------------------------------------------- taking a survey

async function eligible(tx: Tx, s: SurveyRow, employeeId: string) {
  const [r] = await tx<{ ok: boolean }[]>`select exists(select 1 from employees e where e.id = ${employeeId} and ${audienceWhere(tx, s.audience)}) as ok`;
  return r.ok;
}

export type MySurveyRow = { id: string; title: string; description: string | null; anonymous: boolean; questions: number; round: number; recurrence: Recurrence; endOn: string | null; answered: boolean };

/** Live surveys the person is in the audience for, with whether they've answered this round. */
export async function mySurveys(tx: Tx, actor: Actor): Promise<MySurveyRow[]> {
  const rows = await tx<(SurveyRow & { questions: number })[]>`
    select s.id, s.title, s.description, s.is_anonymous, s.min_responses_to_show, s.audience, s.schedule, s.status, s.created_at,
      (select count(*)::int from survey_questions q where q.survey_id = s.id) as questions
    from surveys s where s.status = 'live' order by s.created_at desc`;
  const out: MySurveyRow[] = [];
  for (const s of rows) {
    if (!(await eligible(tx, s, actor.employeeId))) continue;
    const sc = toSchedule(s.schedule);
    const [{ answered }] = await tx<{ answered: boolean }[]>`select exists(select 1 from survey_participations where survey_id = ${s.id} and employee_id = ${actor.employeeId} and round = ${sc.round}) as answered`;
    out.push({ id: s.id, title: s.title, description: s.description, anonymous: s.is_anonymous, questions: s.questions, round: sc.round, recurrence: sc.recurrence, endOn: sc.endOn, answered });
  }
  return out;
}

export type TakeView = { id: string; title: string; description: string | null; anonymous: boolean; questions: Question[]; answered: boolean; round: number; status: SurveyStatus };

export async function takeView(tx: Tx, actor: Actor, id: string): Promise<TakeView | null> {
  const [s] = await tx<SurveyRow[]>`select id, title, description, is_anonymous, min_responses_to_show, audience, schedule, status, created_at from surveys where id = ${id} and status in ('live', 'closed')`;
  if (!s || !(await eligible(tx, s, actor.employeeId))) return null;
  const sc = toSchedule(s.schedule);
  const [{ answered }] = await tx<{ answered: boolean }[]>`select exists(select 1 from survey_participations where survey_id = ${id} and employee_id = ${actor.employeeId} and round = ${sc.round}) as answered`;
  return { id: s.id, title: s.title, description: s.description, anonymous: s.is_anonymous, questions: await questionsOf(tx, id), answered, round: sc.round, status: s.status };
}

/**
 * Submit answers for this round. Participation (who answered) and the answers are stored separately; for an
 * anonymous survey the answer row has no person and only a day-level timestamp, so the two can't be joined.
 * One answer per person per round (the participation key enforces it, even with double submits).
 */
export async function submitResponse(tx: Tx, actor: Actor, id: string, answers: Record<string, Answer>) {
  const s = await loadSurvey(tx, id);
  if (s.status !== "live") throw new AppError("conflict", "This survey isn't open for answers.");
  if (!(await eligible(tx, s, actor.employeeId))) throw new AppError("forbidden", "This survey isn't for you.");
  const qs = await questionsOf(tx, id);
  const v = validateAnswers(qs, answers ?? {});
  if (!v.ok) { const [qid, msg] = Object.entries(v.errors)[0]; throw new AppError("invalid", msg, qid); }
  const sc = toSchedule(s.schedule);
  const [p] = await tx<{ survey_id: string }[]>`
    insert into survey_participations (survey_id, employee_id, tenant_id, round, responded_at)
    values (${id}, ${actor.employeeId}, ${actor.tenant.id}, ${sc.round}, ${s.is_anonymous ? tx`date_trunc('day', now())` : tx`now()`})
    on conflict (survey_id, employee_id, round) do nothing returning survey_id`;
  if (!p) throw new AppError("conflict", "You've already answered this survey.");
  const [me] = await tx<{ department_id: string | null; location_id: string | null }[]>`select department_id, location_id from employees where id = ${actor.employeeId}`;
  await tx`insert into survey_responses (tenant_id, survey_id, employee_id, round, answers, segment, created_at, updated_at)
           values (${actor.tenant.id}, ${id}, ${s.is_anonymous ? null : actor.employeeId}, ${sc.round}, ${tx.json(v.answers as never)},
                   ${tx.json({ department_id: me?.department_id ?? null, location_id: me?.location_id ?? null })},
                   ${s.is_anonymous ? tx`date_trunc('day', now())` : tx`now()`}, ${s.is_anonymous ? tx`date_trunc('day', now())` : tx`now()`})`;
  return { round: sc.round };
}

// ---------------------------------------------------------------- results

export type ResultFilters = { round?: number | null; departmentId?: string | null; locationId?: string | null };
export type Results = {
  survey: { id: string; title: string; anonymous: boolean; minResponses: number; status: SurveyStatus; round: number; recurrence: Recurrence };
  rounds: number[]; filters: { round: number; departmentId: string | null; locationId: string | null };
  departments: { id: string; name: string }[]; locations: { id: string; name: string }[];
  audience: number; participated: number; responses: number; hidden: boolean;
  enps: { score: number | null; promoters: number; passives: number; detractors: number; n: number } | null;
  questions: { id: string; prompt: string; type: string; typeLabel: string; summary: QuestionSummary | null }[];
  trend: { round: number; responses: number; enps: number | null; hidden: boolean }[];
};

type ResponseRow = { answers: Record<string, Answer>; segment: { department_id?: string | null; location_id?: string | null }; round: number };

function filterResponses(rows: ResponseRow[], f: { departmentId: string | null; locationId: string | null }) {
  return rows.filter((r) => (!f.departmentId || r.segment?.department_id === f.departmentId) && (!f.locationId || r.segment?.location_id === f.locationId));
}

/** Results for one round, optionally for one department / location. Anonymous groups under the threshold stay hidden. */
export async function results(tx: Tx, actor: Actor, id: string, f: ResultFilters = {}): Promise<Results | null> {
  assertManage(actor);
  const [s] = await tx<SurveyRow[]>`select id, title, description, is_anonymous, min_responses_to_show, audience, schedule, status, created_at from surveys where id = ${id}`;
  if (!s) return null;
  const sc = toSchedule(s.schedule);
  const round = f.round && Number.isInteger(f.round) && f.round >= 1 && f.round <= sc.round ? f.round : sc.round;
  const filters = { round, departmentId: f.departmentId ?? null, locationId: f.locationId ?? null };
  const [qs, all, departments, locations, [{ n: audienceSize }], [{ p }]] = await Promise.all([
    questionsOf(tx, id),
    tx<ResponseRow[]>`select answers, segment, round from survey_responses where survey_id = ${id}`,
    tx<{ id: string; name: string }[]>`select id, name from departments order by name`,
    tx<{ id: string; name: string }[]>`select id, name from locations order by name`,
    tx<{ n: number }[]>`select count(*)::int as n from employees e where ${audienceWhere(tx, s.audience)}`,
    tx<{ p: number }[]>`select count(*)::int as p from survey_participations where survey_id = ${id} and round = ${round}`,
  ]);
  const inRound = all.filter((r) => r.round === round);
  const rows = filterResponses(inRound, filters);
  const hidden = !canShow(s.is_anonymous, rows.length, s.min_responses_to_show);
  const npsQ = qs.find((q) => q.type === "nps");
  const enpsOf = (rs: ResponseRow[]) => (npsQ ? (summarize(npsQ, rs.map((r) => r.answers?.[npsQ.id] ?? null)) as Extract<QuestionSummary, { kind: "scale" }>).enps ?? null : null);
  const trend = Array.from({ length: sc.round }, (_, i) => {
    const rs = filterResponses(all.filter((r) => r.round === i + 1), filters);
    const h = !canShow(s.is_anonymous, rs.length, s.min_responses_to_show);
    return { round: i + 1, responses: h ? 0 : rs.length, enps: h ? null : enpsOf(rs)?.score ?? null, hidden: h };
  });
  return {
    survey: { id: s.id, title: s.title, anonymous: s.is_anonymous, minResponses: s.min_responses_to_show, status: s.status, round: sc.round, recurrence: sc.recurrence },
    rounds: Array.from({ length: sc.round }, (_, i) => i + 1), filters, departments, locations,
    audience: audienceSize, participated: p, responses: hidden ? 0 : rows.length, hidden,
    enps: hidden ? null : enpsOf(rows),
    questions: qs.map((q) => ({ id: q.id, prompt: q.prompt, type: q.type, typeLabel: QUESTION_LABEL[q.type], summary: hidden ? null : summarize(q, rows.map((r) => r.answers?.[q.id] ?? null)) })),
    trend,
  };
}

/** CSV of one round's answers. Anonymous: no names, no groups, shuffled order, and refused under the threshold. */
export async function exportCsv(tx: Tx, actor: Actor, id: string, round?: number | null) {
  assertManage(actor);
  const s = await loadSurvey(tx, id);
  const sc = toSchedule(s.schedule);
  const r = round && round >= 1 && round <= sc.round ? round : sc.round;
  const qs = await questionsOf(tx, id);
  const rows = await tx<{ answers: Record<string, Answer>; name: string | null; number: string | null; department: string | null; created_at: Date }[]>`
    select x.answers, e.display_name as name, e.employee_number as number, d.name as department, x.created_at
    from survey_responses x left join employees e on e.id = x.employee_id left join departments d on d.id = e.department_id
    where x.survey_id = ${id} and x.round = ${r} order by ${s.is_anonymous ? tx`x.id` : tx`x.created_at`}`;
  if (!canShow(s.is_anonymous, rows.length, s.min_responses_to_show)) throw new AppError("forbidden", `Results show once at least ${Math.max(MIN_THRESHOLD, s.min_responses_to_show)} people have answered.`);
  const head = [...(s.is_anonymous ? [] : ["Employee", "Number", "Department", "Answered at"]), ...qs.map((q) => q.prompt)];
  const lines = [csvRow(head), ...rows.map((x) => csvRow([
    ...(s.is_anonymous ? [] : [x.name, x.number, x.department, x.created_at.toISOString()]),
    ...qs.map((q) => x.answers?.[q.id] ?? ""),
  ]))];
  await audit(tx, actor, { entityType: "survey", entityId: id, action: "export", diff: { round: r, rows: rows.length } });
  return { filename: `${s.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "survey"}-round-${r}.csv`, csv: "﻿" + lines.join("\r\n") + "\r\n" };
}

/** New draft from a starter (blank, pulse, joiner check-in, event). */
export async function createFromStarter(tx: Tx, actor: Actor, key: string) {
  assertManage(actor);
  const st = STARTERS.find((s) => s.key === key);
  if (!st) throw new AppError("invalid", "Pick a starting point.");
  const { id } = await saveSurvey(tx, actor, null, { title: st.title, description: st.description, anonymous: st.anonymous, minResponses: 5, audience: { type: "org" }, startOn: null, endOn: null, recurrence: st.recurrence });
  for (const q of st.questions) await saveQuestion(tx, actor, id, null, q);
  return { id };
}
