import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { appUrl, queueEmail } from "@/server/email";
import { simpleEmail } from "@/server/email/simple";
import { notifyEmployee } from "@/server/modules/approvals/service";
import { DEFAULT_EXIT_QUESTIONS, summarizeExit, validateExitAnswers, validateExitQuestion, type ExitAnswer, type ExitQuestion, type ExitSummary } from "./survey-rules";

/**
 * Exit survey: a per-company set of questions, sent to the person when their exit starts (so they can answer while
 * they still have access), with HR results by question and by person. Answers are tied to the exit, never anonymous:
 * HR reads them to understand why people leave, and the person knows that.
 */
const EVERYWHERE: Placement = { department_id: null, location_id: null, legal_entity_id: null, business_unit_id: null };
export const canSeeExitSurveys = (actor: Actor) => canFor(actor, "exits.manage", EVERYWHERE) || canFor(actor, "settings.org", EVERYWHERE);
const assertManage = (actor: Actor) => { if (!canSeeExitSurveys(actor)) throw new AppError("forbidden", "You don't have access to do this."); };

export async function ensureExitSurveyDefaults(tx: Tx, tenantId: string) {
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from exit_survey_questions`;
  if (n) return;
  for (const [i, q] of DEFAULT_EXIT_QUESTIONS.entries()) {
    await tx`insert into exit_survey_questions (tenant_id, prompt, type, options, required, position) values (${tenantId}, ${q.prompt}, ${q.type}, ${tx.json(q.options ?? [])}, ${q.required !== false}, ${i})`;
  }
}

export async function listExitQuestions(tx: Tx, includeArchived = false): Promise<(ExitQuestion & { archived: boolean })[]> {
  const rows = await tx<{ id: string; prompt: string; type: ExitQuestion["type"]; options: string[]; required: boolean; archived_at: Date | null }[]>`
    select id, prompt, type, options, required, archived_at from exit_survey_questions where ${includeArchived ? tx`true` : tx`archived_at is null`} order by position, created_at`;
  return rows.map((r) => ({ id: r.id, prompt: r.prompt, type: r.type, options: r.options ?? [], required: r.required, archived: !!r.archived_at }));
}

export async function saveExitQuestion(tx: Tx, actor: Actor, id: string | null, input: { prompt: unknown; type: unknown; options?: unknown; required?: unknown }) {
  assertManage(actor);
  const v = validateExitQuestion(input);
  if (!v.ok) throw new AppError("invalid", v.error, v.field);
  if (id) {
    const [r] = await tx<{ id: string }[]>`update exit_survey_questions set prompt = ${v.value.prompt}, type = ${v.value.type}, options = ${tx.json(v.value.options)}, required = ${v.value.required} where id = ${id} and archived_at is null returning id`;
    if (!r) throw new AppError("not_found", "Question not found.");
  } else {
    const [{ n }] = await tx<{ n: number }[]>`select coalesce(max(position), -1) + 1 as n from exit_survey_questions`;
    const [r] = await tx<{ id: string }[]>`insert into exit_survey_questions (tenant_id, prompt, type, options, required, position) values (${actor.tenant.id}, ${v.value.prompt}, ${v.value.type}, ${tx.json(v.value.options)}, ${v.value.required}, ${n}) returning id`;
    id = r.id;
  }
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${actor.tenant.id}, ${actor.userId}, 'exit_survey_question', ${id}, 'save', ${tx.json({ name: v.value.prompt, type: v.value.type })})`;
  return { id };
}

/** Questions with answers are archived (kept for old results); unanswered ones are removed. */
export async function deleteExitQuestion(tx: Tx, actor: Actor, id: string) {
  assertManage(actor);
  const [{ used }] = await tx<{ used: boolean }[]>`select exists(select 1 from exit_survey_responses where answers ? ${id}) as used`;
  const r = used ? await tx`update exit_survey_questions set archived_at = now() where id = ${id} and archived_at is null` : await tx`delete from exit_survey_questions where id = ${id}`;
  if (!r.count) throw new AppError("not_found", "Question not found.");
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${actor.tenant.id}, ${actor.userId}, 'exit_survey_question', ${id}, ${used ? "archive" : "delete"}, null)`;
}

export async function moveExitQuestion(tx: Tx, actor: Actor, id: string, dir: "up" | "down") {
  assertManage(actor);
  const items = await tx<{ id: string }[]>`select id from exit_survey_questions where archived_at is null order by position, created_at`;
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) throw new AppError("not_found", "Question not found.");
  const j = dir === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= items.length) return;
  [items[i], items[j]] = [items[j], items[i]];
  for (const [pos, it] of items.entries()) await tx`update exit_survey_questions set position = ${pos} where id = ${it.id}`;
}

/** Exit started: open a response row for the person and tell them (in-app + email). Idempotent per exit. */
export async function inviteToExitSurvey(tx: Tx, tenantId: string, exitId: string) {
  const [x] = await tx<{ employee_id: string; first_name: string; work_email: string; subdomain: string; company: string }[]>`
    select x.employee_id, e.first_name, e.work_email::text as work_email, t.subdomain::text, t.name as company
    from exit_requests x join employees e on e.id = x.employee_id join tenants t on t.id = x.tenant_id where x.id = ${exitId}`;
  if (!x) return false;
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from exit_survey_questions where archived_at is null`;
  if (!n) return false;
  const [r] = await tx<{ id: string }[]>`insert into exit_survey_responses (tenant_id, exit_request_id, employee_id) values (${tenantId}, ${exitId}, ${x.employee_id}) on conflict (exit_request_id) do nothing returning id`;
  if (!r) return false;
  await notifyEmployee(tx, tenantId, x.employee_id, "exit.survey", "A few questions before you go", "Your answers help us make this a better place to work.", "/me/exit-survey");
  const mail = simpleEmail({ company: x.company, subject: "A few questions before you go", heading: `Thanks for your time with us, ${x.first_name}`,
    paragraphs: ["We'd love to hear how things went and what we could do better. The survey takes about five minutes, and HR reads every answer.", "Please answer before your last working day, while you can still sign in."],
    button: { label: "Answer the exit survey", url: appUrl(x.subdomain, "/me/exit-survey") } });
  await queueEmail(tx, tenantId, { kind: "exit.survey", to: x.work_email, ...mail });
  return true;
}

export type MyExitSurvey = { exitId: string; questions: ExitQuestion[]; answers: Record<string, ExitAnswer>; submittedAt: string | null; lastWorkingDate: string };

/** The person's own survey (null when no exit is under way or nothing was sent). */
export async function myExitSurvey(tx: Tx, actor: Actor): Promise<MyExitSurvey | null> {
  const [r] = await tx<{ exit_request_id: string; answers: Record<string, ExitAnswer>; submitted_at: Date | null; last_working_date: string }[]>`
    select r.exit_request_id, r.answers, r.submitted_at, x.last_working_date::text from exit_survey_responses r join exit_requests x on x.id = r.exit_request_id
    where r.employee_id = ${actor.employeeId} and x.status in ('in_progress','exited') order by r.created_at desc limit 1`;
  if (!r) return null;
  const questions = await listExitQuestions(tx);
  return { exitId: r.exit_request_id, questions, answers: r.answers ?? {}, submittedAt: r.submitted_at?.toISOString() ?? null, lastWorkingDate: r.last_working_date };
}

export async function submitExitSurvey(tx: Tx, actor: Actor, answers: Record<string, ExitAnswer>) {
  const [r] = await tx<{ id: string; submitted_at: Date | null; status: string }[]>`
    select r.id, r.submitted_at, x.status from exit_survey_responses r join exit_requests x on x.id = r.exit_request_id
    where r.employee_id = ${actor.employeeId} order by r.created_at desc limit 1 for update of r`;
  if (!r) throw new AppError("not_found", "There's no exit survey for you right now.");
  if (r.submitted_at) throw new AppError("conflict", "You've already sent your answers. Thank you!");
  if (r.status !== "in_progress" && r.status !== "exited") throw new AppError("conflict", "This exit is closed.");
  const questions = await listExitQuestions(tx);
  const v = validateExitAnswers(questions, answers ?? {});
  if (!v.ok) { const first = questions.find((q) => v.errors[q.id])!; throw new AppError("invalid", v.errors[first.id], first.id); }
  await tx`update exit_survey_responses set answers = ${tx.json(v.clean as never)}, submitted_at = now() where id = ${r.id}`;
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action) values (${actor.tenant.id}, ${actor.userId}, 'exit_survey_response', ${r.id}, 'submit')`;
  return { answered: Object.keys(v.clean).length };
}

export type ExitSurveyResults = {
  sent: number; answered: number;
  questions: (ExitQuestion & { archived: boolean; summary: ExitSummary })[];
  people: { exit_id: string; employee_id: string; name: string; department: string | null; last_working_date: string; submitted_at: string | null; answers: Record<string, ExitAnswer> }[];
};

export async function exitSurveyResults(tx: Tx, actor: Actor, f: { from?: string | null; to?: string | null; departmentId?: string | null } = {}): Promise<ExitSurveyResults> {
  assertManage(actor);
  const rows = await tx<(Omit<ExitSurveyResults["people"][number], "submitted_at"> & { submitted_at_ts: Date | null })[]>`
    select x.id as exit_id, e.id as employee_id, e.display_name as name, d.name as department, x.last_working_date::text, r.submitted_at as submitted_at_ts, r.answers
    from exit_survey_responses r join exit_requests x on x.id = r.exit_request_id join employees e on e.id = r.employee_id left join departments d on d.id = e.department_id
    where (${f.from ?? null}::date is null or x.last_working_date >= ${f.from ?? null}::date) and (${f.to ?? null}::date is null or x.last_working_date <= ${f.to ?? null}::date)
      and (${f.departmentId ?? null}::uuid is null or e.department_id = ${f.departmentId ?? null}::uuid)
    order by x.last_working_date desc`;
  const people = rows.map((r) => ({ exit_id: r.exit_id, employee_id: r.employee_id, name: r.name, department: r.department, last_working_date: r.last_working_date, submitted_at: r.submitted_at_ts?.toISOString() ?? null, answers: r.answers ?? {} }));
  const answered = people.filter((p) => p.submitted_at);
  const questions = (await listExitQuestions(tx, true)).filter((q) => !q.archived || answered.some((p) => q.id in p.answers));
  return {
    sent: people.length, answered: answered.length,
    questions: questions.map((q) => ({ ...q, summary: summarizeExit(q, answered.map((p) => p.answers[q.id] ?? null)) })),
    people,
  };
}
