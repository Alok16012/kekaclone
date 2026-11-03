import "server-only";
import { emitEvent } from "@/server/modules/automations/service";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { z } from "zod";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { audit } from "@/server/modules/audit/service";
import { notifyEmployee } from "@/server/modules/approvals/service";
import { todayIn } from "@/lib/dates";
import { assertPerfAdmin, hasAnyPerf, isAbove, isPerfAdmin, perfAdminFor, personRow, type PersonRow } from "./access";
import { goalsOf } from "./goals";
import { getSettings } from "./settings";
import {
  autoDue, bandFor, combineRatings, distribution, formProblem, formScore, matchesFilter, missingAnswers, nineBox, reviewersProblem, roundRating, scaleRange, timelinesProblem,
  type Answers, type CycleStatus, type EmployeeFilter, type ReviewerType, type Reviewers, type ScalePoint, type Section, type Timelines,
} from "./rules";

const N = (v: unknown) => (v == null ? null : Number(v));
const bad = (p: z.ZodSafeParseError<unknown>) => new AppError("invalid", p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));

// ------------------------------------------------------------------ forms

const itemSchema = z.object({ id: z.string().min(1).max(64), text: z.string().trim().min(1, "Every item needs text").max(500), rated: z.boolean(), required: z.boolean().optional() });
const sectionSchema = z.object({
  id: z.string().min(1).max(64), type: z.enum(["questions", "goals", "competencies", "core_values", "skills"]),
  title: z.string().trim().min(1, "Every section needs a title").max(120), weight: z.number().min(0).max(100), items: z.array(itemSchema).max(40),
});
const formInput = z.object({ name: z.string().trim().min(2, "Name the form").max(80), ratingScaleId: z.uuid().nullable().optional(), sections: z.array(sectionSchema).max(10) });

export type FormRow = { id: string; name: string; rating_scale_id: string | null; sections: Section[]; in_use: boolean };
export async function listForms(tx: Tx) {
  return tx<FormRow[]>`
    select f.id, f.name, f.rating_scale_id, f.sections, exists (select 1 from review_cycles c where c.form_id = f.id and c.status in ('live','calibration')) as in_use
    from review_forms f order by f.name`;
}

/** Forms are company-wide. Library sections (competencies, core values, skills) may only hold items from the library. */
export async function saveForm(tx: Tx, actor: Actor, id: string | null, raw: unknown) {
  assertPerfAdmin(actor);
  const p = formInput.safeParse(raw);
  if (!p.success) throw bad(p);
  const v = p.data;
  const sections = v.sections.map((s) => s.type === "goals" ? { ...s, items: [] } : s) as Section[];
  const fp = formProblem(sections.map((s) => (s.type === "goals" ? { ...s, items: [{ id: "g", text: "goal", rated: true }] } : s)));
  if (fp) throw new AppError("invalid", fp, "sections");
  for (const s of sections) {
    if (s.type === "questions" || s.type === "goals") continue;
    const kind = s.type === "competencies" ? "competency" : s.type === "core_values" ? "core_value" : "skill";
    const ids = s.items.map((i) => i.id);
    const found = await tx<{ id: string; name: string }[]>`select id::text, name from competencies where kind = ${kind} and id::text = any(${ids})`;
    if (found.length !== ids.length || !ids.length) throw new AppError("invalid", `${s.title}: pick items from the skills and competencies library.`, "sections");
    s.items = s.items.map((i) => ({ ...i, text: found.find((f) => f.id === i.id)!.name, rated: true }));
  }
  if (v.ratingScaleId) { const [sc] = await tx`select 1 from rating_scales where id = ${v.ratingScaleId}`; if (!sc) throw new AppError("invalid", "Pick a rating scale.", "ratingScaleId"); }
  const [dupe] = await tx`select 1 from review_forms where lower(name) = lower(${v.name}) and id is distinct from ${id}`;
  if (dupe) throw new AppError("conflict", `There's already a form called ${v.name}.`, "name");
  let row: { id: string } | undefined;
  if (id) {
    const [used] = await tx`select 1 from review_cycles where form_id = ${id} and status in ('live','calibration','published','closed') limit 1`;
    if (used) throw new AppError("conflict", "A cycle has already used this form. Copy it under a new name to make changes.");
    [row] = await tx<{ id: string }[]>`update review_forms set name = ${v.name}, rating_scale_id = ${v.ratingScaleId ?? null}, sections = ${tx.json(sections as never)} where id = ${id} returning id`;
  } else [row] = await tx<{ id: string }[]>`insert into review_forms (tenant_id, name, rating_scale_id, sections) values (${actor.tenant.id}, ${v.name}, ${v.ratingScaleId ?? null}, ${tx.json(sections as never)}) returning id`;
  if (!row) throw new AppError("not_found", "Form not found.");
  await audit(tx, actor, { entityType: "review_form", entityId: row.id, action: id ? "update" : "create", diff: { name: v.name, sections: sections.length } });
  return row;
}

// ------------------------------------------------------------------ cycles

const peerSchema = z.object({ enabled: z.boolean(), min: z.number().int().min(0).max(10), max: z.number().int().min(1).max(10), nominated_by: z.enum(["employee", "manager"]), needs_approval: z.boolean() });
const date = z.iso.date().nullable().optional();
export const cycleInput = z.object({
  name: z.string().trim().min(3, "Name the cycle").max(80),
  kind: z.enum(["standard", "aggregate", "probation", "new_joiner"]),
  periodStart: z.iso.date("Pick when the review period starts"),
  periodEnd: z.iso.date("Pick when the review period ends"),
  timelines: z.object({ nominate_due: date, self_due: date, peer_due: date, manager_due: date, calibration_due: date, publish_on: date }),
  reviewers: z.object({ self: z.boolean(), manager: z.boolean(), skip_level: z.boolean(), peer: peerSchema }),
  formId: z.uuid().nullable().optional(),
  employeeFilter: z.object({
    department_ids: z.array(z.uuid()).max(200).optional(), location_ids: z.array(z.uuid()).max(200).optional(), joined_before: date,
    include_ids: z.array(z.uuid()).max(2000).optional(), exclude_ids: z.array(z.uuid()).max(2000).optional(),
  }).default({}),
  autoRule: z.object({ trigger: z.enum(["joining", "probation_end"]), days: z.number().int().min(0).max(730) }).nullable().optional(),
  sourceCycleIds: z.array(z.uuid()).max(12).default([]),
});
export type CycleInput = z.input<typeof cycleInput>;

type CycleRow = {
  id: string; name: string; kind: "standard" | "aggregate" | "probation" | "new_joiner"; period_start: string; period_end: string; timelines: Timelines; reviewers: Reviewers;
  form_id: string | null; status: CycleStatus; employee_filter: EmployeeFilter; auto_rule: { trigger: "joining" | "probation_end"; days: number } | null; source_cycle_ids: string[];
  launched_at: Date | null; published_at: Date | null;
};
async function cycleRow(tx: Tx, id: string, lock = false) {
  const [c] = lock
    ? await tx<CycleRow[]>`select id, name, kind, period_start::text, period_end::text, timelines, reviewers, form_id, status, employee_filter, auto_rule, source_cycle_ids, launched_at, published_at from review_cycles where id = ${id} for update`
    : await tx<CycleRow[]>`select id, name, kind, period_start::text, period_end::text, timelines, reviewers, form_id, status, employee_filter, auto_rule, source_cycle_ids, launched_at, published_at from review_cycles where id = ${id}`;
  if (!c) throw new AppError("not_found", "Review cycle not found.");
  return c;
}

async function checkCycle(tx: Tx, v: z.infer<typeof cycleInput>, selfId: string | null) {
  const tp = timelinesProblem(v.timelines, v.periodStart, v.periodEnd);
  if (tp) throw new AppError("invalid", tp, "timelines");
  if (v.kind !== "aggregate") {
    const rp = reviewersProblem(v.reviewers);
    if (rp) throw new AppError("invalid", rp, "reviewers");
    if (!v.formId) throw new AppError("invalid", "Pick a review form.", "formId");
    const [f] = await tx`select 1 from review_forms where id = ${v.formId}`;
    if (!f) throw new AppError("invalid", "Pick a review form.", "formId");
  } else {
    if (v.sourceCycleIds.length < 1) throw new AppError("invalid", "Pick the cycles to combine.", "sourceCycleIds");
    if (selfId && v.sourceCycleIds.includes(selfId)) throw new AppError("invalid", "A cycle can't include itself.", "sourceCycleIds");
    const src = await tx<{ id: string }[]>`select id from review_cycles where id = any(${v.sourceCycleIds}::uuid[]) and kind <> 'aggregate'`;
    if (src.length !== new Set(v.sourceCycleIds).size) throw new AppError("invalid", "Pick standard cycles to combine.", "sourceCycleIds");
  }
  if ((v.kind === "probation" || v.kind === "new_joiner") && !v.autoRule) throw new AppError("invalid", "Say when people join this cycle automatically.", "autoRule");
  const ids = [...(v.employeeFilter.include_ids ?? []), ...(v.employeeFilter.exclude_ids ?? [])];
  if (ids.length) {
    const found = await tx<{ n: number }[]>`select count(*)::int as n from employees where id = any(${ids}::uuid[])`;
    if (found[0].n !== new Set(ids).size) throw new AppError("invalid", "Some of the people picked don't exist.", "employeeFilter");
  }
  for (const [col, list] of [["departments", v.employeeFilter.department_ids], ["locations", v.employeeFilter.location_ids]] as const) {
    if (!list?.length) continue;
    const [{ n }] = col === "departments"
      ? await tx<{ n: number }[]>`select count(*)::int as n from departments where id = any(${list}::uuid[])`
      : await tx<{ n: number }[]>`select count(*)::int as n from locations where id = any(${list}::uuid[])`;
    if (n !== new Set(list).size) throw new AppError("invalid", `Some of the ${col} picked don't exist.`, "employeeFilter");
  }
}

export async function createCycle(tx: Tx, actor: Actor, raw: unknown) {
  assertPerfAdmin(actor);
  const p = cycleInput.safeParse(raw);
  if (!p.success) throw bad(p);
  const v = p.data;
  await checkCycle(tx, v, null);
  const [dupe] = await tx`select 1 from review_cycles where lower(name) = lower(${v.name})`;
  if (dupe) throw new AppError("conflict", `There's already a cycle called ${v.name}.`, "name");
  const [c] = await tx<{ id: string }[]>`
    insert into review_cycles (tenant_id, name, kind, period_start, period_end, timelines, reviewers, form_id, employee_filter, auto_rule, source_cycle_ids, created_by)
    values (${actor.tenant.id}, ${v.name}, ${v.kind}, ${v.periodStart}, ${v.periodEnd}, ${tx.json(v.timelines)}, ${tx.json(v.reviewers)}, ${v.kind === "aggregate" ? null : v.formId ?? null},
      ${tx.json(v.employeeFilter as never)}, ${v.autoRule ? tx.json(v.autoRule) : null}, ${v.sourceCycleIds}::uuid[], ${actor.userId}) returning id`;
  await audit(tx, actor, { entityType: "review_cycle", entityId: c.id, action: "create", diff: { name: v.name, kind: v.kind } });
  return c;
}

export async function updateCycle(tx: Tx, actor: Actor, id: string, raw: unknown) {
  assertPerfAdmin(actor);
  const c = await cycleRow(tx, id, true);
  const p = cycleInput.safeParse(raw);
  if (!p.success) throw bad(p);
  const v = p.data;
  if (c.status !== "draft") {
    // a running cycle may only move its dates
    const tp = timelinesProblem(v.timelines, c.period_start, c.period_end);
    if (tp) throw new AppError("invalid", tp, "timelines");
    await tx`update review_cycles set timelines = ${tx.json(v.timelines)} where id = ${id}`;
    await audit(tx, actor, { entityType: "review_cycle", entityId: id, action: "update", diff: { name: c.name, timelines: v.timelines } });
    return;
  }
  await checkCycle(tx, v, id);
  const [dupe] = await tx`select 1 from review_cycles where lower(name) = lower(${v.name}) and id <> ${id}`;
  if (dupe) throw new AppError("conflict", `There's already a cycle called ${v.name}.`, "name");
  await tx`update review_cycles set name = ${v.name}, kind = ${v.kind}, period_start = ${v.periodStart}, period_end = ${v.periodEnd}, timelines = ${tx.json(v.timelines)},
           reviewers = ${tx.json(v.reviewers)}, form_id = ${v.kind === "aggregate" ? null : v.formId ?? null}, employee_filter = ${tx.json(v.employeeFilter as never)},
           auto_rule = ${v.autoRule ? tx.json(v.autoRule) : null}, source_cycle_ids = ${v.sourceCycleIds}::uuid[] where id = ${id}`;
  await audit(tx, actor, { entityType: "review_cycle", entityId: id, action: "update", diff: { name: v.name } });
}

export async function deleteCycle(tx: Tx, actor: Actor, id: string) {
  assertPerfAdmin(actor);
  const c = await cycleRow(tx, id, true);
  if (c.status !== "draft") throw new AppError("conflict", "Only draft cycles can be deleted. Close this one instead.");
  await tx`delete from review_cycles where id = ${id}`;
  await audit(tx, actor, { entityType: "review_cycle", entityId: id, action: "delete", diff: { name: c.name } });
}

type Candidate = { id: string; name: string; department_id: string | null; location_id: string | null; joining_date: string; manager_id: string | null; l2_manager_id: string | null; probation_end_date: string | null };
async function candidates(tx: Tx) {
  return tx<Candidate[]>`
    select id, display_name as name, department_id, location_id, joining_date::text, manager_id, l2_manager_id, probation_end_date::text
    from employees where status in ('active','notice') order by display_name`;
}
/** Who a filter picks, for the wizard's preview. */
export async function previewParticipants(tx: Tx, actor: Actor, filter: EmployeeFilter) {
  assertPerfAdmin(actor);
  return (await candidates(tx)).filter((e) => matchesFilter(e, filter)).map((e) => ({ id: e.id, name: e.name }));
}

async function skipLevelOf(tx: Tx, p: { id: string; manager_id: string | null; l2_manager_id: string | null }) {
  if (p.l2_manager_id && p.l2_manager_id !== p.id) return p.l2_manager_id;
  if (!p.manager_id) return null;
  const [m] = await tx<{ manager_id: string | null }[]>`select manager_id from employees where id = ${p.manager_id}`;
  return m?.manager_id && m.manager_id !== p.id ? m.manager_id : null;
}

/** Puts one person into a live cycle: their outcome row and self / manager / skip-level reviews. Safe to repeat. */
async function addParticipant(tx: Tx, tenantId: string, c: CycleRow, p: Candidate, notify = true) {
  const [o] = await tx<{ id: string }[]>`insert into review_outcomes (tenant_id, cycle_id, employee_id) values (${tenantId}, ${c.id}, ${p.id}) on conflict (cycle_id, employee_id) do nothing returning id`;
  if (!o) return false;
  const pairs: { reviewer: string; type: ReviewerType }[] = [];
  if (c.reviewers.self) pairs.push({ reviewer: p.id, type: "self" });
  if (c.reviewers.manager && p.manager_id) pairs.push({ reviewer: p.manager_id, type: "manager" });
  if (c.reviewers.skip_level) { const s = await skipLevelOf(tx, p); if (s && s !== p.manager_id) pairs.push({ reviewer: s, type: "skip_level" }); }
  for (const x of pairs) {
    await tx`insert into review_assignments (tenant_id, cycle_id, reviewee_employee_id, reviewer_employee_id, reviewer_type)
             values (${tenantId}, ${c.id}, ${p.id}, ${x.reviewer}, ${x.type}) on conflict do nothing`;
    if (notify) await notifyEmployee(tx, tenantId, x.reviewer, "review.assigned", x.type === "self" ? "Time for your self review" : "A review is waiting for you",
      x.type === "self" ? `${c.name} is open.` : `Review ${p.name} in ${c.name}.`, "/me/performance/reviews");
  }
  if (c.reviewers.peer.enabled && notify) {
    const who = c.reviewers.peer.nominated_by === "employee" ? p.id : p.manager_id;
    if (who) await notifyEmployee(tx, tenantId, who, "review.nominate", "Pick peer reviewers", who === p.id ? `Choose colleagues to review you in ${c.name}.` : `Choose peers to review ${p.name} in ${c.name}.`, "/me/performance/reviews");
  }
  return true;
}

/**
 * Launch: standard cycles add everyone the filter picks; automatic cycles start empty and the daily job adds people when due;
 * aggregate cycles combine the source cycles' ratings straight into calibration.
 */
export async function launchCycle(tx: Tx, actor: Actor, id: string) {
  assertPerfAdmin(actor);
  const c = await cycleRow(tx, id, true);
  if (c.status !== "draft") throw new AppError("conflict", "This cycle has already been launched.");
  let added = 0;
  if (c.kind === "aggregate") {
    await tx`update review_cycles set status = 'calibration', launched_at = now() where id = ${id}`;
    added = await computeAggregate(tx, actor.tenant.id, { ...c, status: "calibration" });
  } else {
    await tx`update review_cycles set status = 'live', launched_at = now() where id = ${id}`;
    if (c.kind === "standard") {
      for (const p of (await candidates(tx)).filter((e) => matchesFilter(e, c.employee_filter))) if (await addParticipant(tx, actor.tenant.id, { ...c, status: "live" }, p)) added++;
      if (!added) throw new AppError("invalid", "Nobody matches this cycle's filters. Change who's included first.", "employeeFilter");
    }
  }
  await audit(tx, actor, { entityType: "review_cycle", entityId: id, action: "launch", diff: { name: c.name, participants: added } });
  return { added };
}

/** Daily: adds people who've reached the trigger of a live automatic cycle (joining + N days, or N days before probation ends). */
export async function runAutoCycles(tx: Tx, tenantId: string, today = todayIn()) {
  const cycles = await tx<CycleRow[]>`select id, name, kind, period_start::text, period_end::text, timelines, reviewers, form_id, status, employee_filter, auto_rule, source_cycle_ids, launched_at, published_at
                                      from review_cycles where status = 'live' and auto_rule is not null`;
  let added = 0;
  const people = await candidates(tx);
  for (const c of cycles) {
    for (const p of people) {
      if (!matchesFilter(p, c.employee_filter) || !autoDue(c.auto_rule!, p, today)) continue;
      if (c.kind === "probation" && !p.probation_end_date) continue;
      if (await addParticipant(tx, tenantId, c, p)) added++;
    }
  }
  return added;
}

// ------------------------------------------------------------------ peers

/** Nominate peers for a reviewee: the reviewee (or their manager, per the cycle) picks; the manager approves when the cycle asks for it. */
export async function nominatePeers(tx: Tx, actor: Actor, cycleId: string, revieweeId: string, peerIds: string[]) {
  const c = await cycleRow(tx, cycleId);
  if (c.status !== "live" || !c.reviewers.peer.enabled) throw new AppError("invalid", "This cycle isn't taking peer nominations.");
  const reviewee = await personRow(tx, revieweeId);
  const [inCycle] = await tx`select 1 from review_outcomes where cycle_id = ${cycleId} and employee_id = ${revieweeId}`;
  if (!inCycle) throw new AppError("not_found", "That person isn't in this cycle.");
  const isSelf = revieweeId === actor.employeeId;
  const overseer = !isSelf && ((await isAbove(tx, actor.employeeId, revieweeId)) || perfAdminFor(actor, reviewee));
  if (c.reviewers.peer.nominated_by === "employee" ? !(isSelf || overseer) : !overseer) throw new AppError("forbidden", "You can't pick peers for this person.");
  const ids = [...new Set(peerIds)];
  const existing = await tx<{ id: string; reviewer_employee_id: string; nomination: string | null }[]>`
    select id, reviewer_employee_id, nomination from review_assignments where cycle_id = ${cycleId} and reviewee_employee_id = ${revieweeId} and reviewer_type = 'peer'`;
  const live = existing.filter((e) => e.nomination !== "rejected");
  const fresh = ids.filter((i) => !existing.some((e) => e.reviewer_employee_id === i));
  if (live.length + fresh.length > c.reviewers.peer.max) throw new AppError("invalid", `Pick at most ${c.reviewers.peer.max} peers.`, "peerIds");
  const nomination = isSelf && c.reviewers.peer.needs_approval ? "proposed" : "approved";
  for (const id of fresh) {
    if (id === revieweeId) throw new AppError("invalid", "Someone can't be their own peer reviewer.", "peerIds");
    const p = await personRow(tx, id).catch(() => null);
    if (!p || p.status === "relieved") throw new AppError("invalid", "Pick people who work here.", "peerIds");
    await tx`insert into review_assignments (tenant_id, cycle_id, reviewee_employee_id, reviewer_employee_id, reviewer_type, nomination, nominated_by)
             values (${actor.tenant.id}, ${cycleId}, ${revieweeId}, ${id}, 'peer', ${nomination}, ${actor.employeeId}) on conflict do nothing`;
    if (nomination === "approved") await notifyEmployee(tx, actor.tenant.id, id, "review.assigned", "A peer review is waiting for you", `Review ${reviewee.display_name} in ${c.name}.`, "/me/performance/reviews");
  }
  if (nomination === "proposed" && fresh.length && reviewee.manager_id)
    await notifyEmployee(tx, actor.tenant.id, reviewee.manager_id, "review.nominations", "Peer nominations to approve", `${reviewee.display_name} picked ${fresh.length} peer${fresh.length === 1 ? "" : "s"} for ${c.name}.`, "/me/performance/reviews?tab=team");
  await audit(tx, actor, { entityType: "review_cycle", entityId: cycleId, action: "peers.nominate", diff: { employeeId: revieweeId, peers: fresh, nomination } });
  return { added: fresh.length, nomination };
}

/** The reviewee's manager (or a covering admin) approves or rejects a proposed peer. Never the reviewee. */
export async function decideNomination(tx: Tx, actor: Actor, assignmentId: string, approve: boolean) {
  const [a] = await tx<{ id: string; cycle_id: string; reviewee_employee_id: string; reviewer_employee_id: string; nomination: string | null; cycle: string; status: CycleStatus }[]>`
    select a.id, a.cycle_id, a.reviewee_employee_id, a.reviewer_employee_id, a.nomination, c.name as cycle, c.status
    from review_assignments a join review_cycles c on c.id = a.cycle_id where a.id = ${assignmentId} and a.reviewer_type = 'peer' for update of a`;
  if (!a) throw new AppError("not_found", "Nomination not found.");
  if (a.reviewee_employee_id === actor.employeeId) throw new AppError("forbidden", "Your manager approves your peer nominations.");
  const reviewee = await personRow(tx, a.reviewee_employee_id);
  if (!((await isAbove(tx, actor.employeeId, a.reviewee_employee_id)) || perfAdminFor(actor, reviewee))) throw new AppError("forbidden", "Only their manager can approve this.");
  if (a.nomination !== "proposed") throw new AppError("conflict", "This nomination was already decided.");
  if (a.status !== "live") throw new AppError("invalid", "This cycle is no longer taking reviews.");
  await tx`update review_assignments set nomination = ${approve ? "approved" : "rejected"} where id = ${assignmentId}`;
  if (approve) await notifyEmployee(tx, actor.tenant.id, a.reviewer_employee_id, "review.assigned", "A peer review is waiting for you", `Review ${reviewee.display_name} in ${a.cycle}.`, "/me/performance/reviews");
  await audit(tx, actor, { entityType: "review_cycle", entityId: a.cycle_id, action: approve ? "peers.approve" : "peers.reject", diff: { employeeId: a.reviewee_employee_id, peer: a.reviewer_employee_id } });
}

// ------------------------------------------------------------------ filling

type AssignmentRow = {
  id: string; cycle_id: string; reviewee_employee_id: string; reviewer_employee_id: string; reviewer_type: ReviewerType; answers: Answers; rating: string | null;
  status: "not_started" | "draft" | "submitted" | "declined"; nomination: string | null; submitted_at: Date | null;
};
async function assignment(tx: Tx, id: string, lock = false) {
  const [a] = lock
    ? await tx<AssignmentRow[]>`select id, cycle_id, reviewee_employee_id, reviewer_employee_id, reviewer_type, answers, rating, status, nomination, submitted_at from review_assignments where id = ${id} for update`
    : await tx<AssignmentRow[]>`select id, cycle_id, reviewee_employee_id, reviewer_employee_id, reviewer_type, answers, rating, status, nomination, submitted_at from review_assignments where id = ${id}`;
  if (!a) throw new AppError("not_found", "Review not found.");
  return a;
}

async function formFor(tx: Tx, c: CycleRow) {
  if (!c.form_id) throw new AppError("invalid", "This cycle has no form.");
  const [f] = await tx<{ sections: Section[]; points: ScalePoint[] | null }[]>`
    select f.sections, rs.points from review_forms f left join rating_scales rs on rs.id = f.rating_scale_id where f.id = ${c.form_id}`;
  const settings = await getSettings(tx);
  return { sections: f.sections, points: f.points?.length ? f.points : settings.points };
}

/** The form with the goals section filled in from the reviewee's goals in the review period. */
async function resolveSections(tx: Tx, actor: Actor, c: CycleRow, revieweeId: string) {
  const { sections, points } = await formFor(tx, c);
  const out: Section[] = [];
  for (const s of sections) {
    if (s.type !== "goals") { out.push(s); continue; }
    const goals = await goalsOf(tx, actor, revieweeId, c.period_start, c.period_end);   // private goals only for those who may see them
    out.push({ ...s, items: goals.filter((g) => g.status !== "closed" || g.progress > 0).map((g) => ({ id: g.id, text: `${g.title} (${Math.round(g.progress)}% done)`, rated: true })) });
  }
  return { sections: out, points };
}

function cleanAnswers(raw: unknown, sections: Section[], points: ScalePoint[]): Answers {
  const valid = new Set(points.map((p) => p.value));
  const p = z.record(z.string().max(140), z.object({ rating: z.number().nullable().optional(), comment: z.string().max(4000).nullable().optional() })).safeParse(raw ?? {});
  if (!p.success) throw new AppError("invalid", "Some answers couldn't be read. Reload and try again.");
  const keys = new Set(sections.flatMap((s) => s.items.map((i) => `${s.id}:${i.id}`)));
  const out: Answers = {};
  for (const [k, v] of Object.entries(p.data)) {
    if (!keys.has(k)) continue;   // answers to items that aren't on the form are dropped
    if (v.rating != null && !valid.has(v.rating)) throw new AppError("invalid", "Pick a rating from the scale.");
    out[k] = { rating: v.rating ?? null, comment: v.comment?.trim() || null };
  }
  return out;
}

async function editable(tx: Tx, actor: Actor, id: string) {
  const a = await assignment(tx, id, true);
  if (a.reviewer_employee_id !== actor.employeeId) throw new AppError("not_found", "Review not found.");
  if (a.reviewer_type === "peer" && a.nomination !== "approved") throw new AppError("invalid", "This peer review hasn't been approved yet.");
  const c = await cycleRow(tx, a.cycle_id);
  if (c.status !== "live") throw new AppError("invalid", "This cycle is closed for reviews.");
  if (a.status === "submitted") throw new AppError("conflict", "You've already submitted this review.");
  if (a.status === "declined") throw new AppError("invalid", "You declined this review.");
  return { a, c };
}

export async function saveDraft(tx: Tx, actor: Actor, id: string, raw: unknown) {
  const { a, c } = await editable(tx, actor, id);
  const { sections, points } = await resolveSections(tx, actor, c, a.reviewee_employee_id);
  const answers = cleanAnswers(raw, sections, points);
  await tx`update review_assignments set answers = ${tx.json(answers as never)}, status = 'draft' where id = ${id}`;
}

/** Submit: every rated item needs a rating; the form score becomes this review's rating and feeds the person's overall rating. */
export async function submitReview(tx: Tx, actor: Actor, id: string, raw: unknown) {
  const { a, c } = await editable(tx, actor, id);
  const { sections, points } = await resolveSections(tx, actor, c, a.reviewee_employee_id);
  const answers = cleanAnswers(raw, sections, points);
  const missing = missingAnswers(sections, answers);
  if (missing.length) throw new AppError("invalid", `Answer everything before submitting. Still open: ${missing.slice(0, 3).join("; ")}${missing.length > 3 ? ` and ${missing.length - 3} more` : ""}.`);
  const score = formScore(sections, answers);
  await tx`update review_assignments set answers = ${tx.json(answers as never)}, status = 'submitted', submitted_at = now(), rating = ${score} where id = ${id}`;
  await computeOutcomes(tx, c.id, a.reviewee_employee_id);
  await audit(tx, actor, { entityType: "review_assignment", entityId: id, action: "submit", diff: { employeeId: a.reviewee_employee_id, type: a.reviewer_type, rating: score } });
  if (a.reviewer_type === "self") {
    const p = await personRow(tx, a.reviewee_employee_id);
    if (p.manager_id) await notifyEmployee(tx, actor.tenant.id, p.manager_id, "review.self_done", "Self review submitted", `${p.display_name} finished their self review in ${c.name}.`, "/me/performance/reviews");
  }
  return { rating: score };
}

export async function declineReview(tx: Tx, actor: Actor, id: string) {
  const { a } = await editable(tx, actor, id);
  if (a.reviewer_type !== "peer") throw new AppError("invalid", "Only peer reviews can be declined.");
  await tx`update review_assignments set status = 'declined' where id = ${id}`;
  await audit(tx, actor, { entityType: "review_assignment", entityId: id, action: "decline", diff: { employeeId: a.reviewee_employee_id } });
}

/** Reviews the actor writes, plus nominations they owe and team nominations waiting on them. */
export async function myReviews(tx: Tx, actor: Actor) {
  const toWrite = await tx<{ id: string; cycle_id: string; cycle: string; status: string; reviewer_type: ReviewerType; reviewee_id: string; reviewee: string; due: string | null; cycle_status: CycleStatus; rating: string | null }[]>`
    select a.id, a.cycle_id, c.name as cycle, a.status, a.reviewer_type, a.reviewee_employee_id as reviewee_id, e.display_name as reviewee, c.status as cycle_status, a.rating,
      case a.reviewer_type when 'self' then c.timelines->>'self_due' when 'peer' then c.timelines->>'peer_due' else c.timelines->>'manager_due' end as due
    from review_assignments a join review_cycles c on c.id = a.cycle_id join employees e on e.id = a.reviewee_employee_id
    where a.reviewer_employee_id = ${actor.employeeId} and (a.nomination is null or a.nomination = 'approved') and c.status in ('live','calibration','published')
    order by (a.status = 'submitted'), c.created_at desc, e.display_name`;
  // cycles where the actor (or their reports, when managers nominate) still needs to pick peers
  const nominate = await tx<{ cycle_id: string; cycle: string; reviewee_id: string; reviewee: string; min: number; max: number; picked: number; due: string | null }[]>`
    select c.id as cycle_id, c.name as cycle, o.employee_id as reviewee_id, e.display_name as reviewee, (c.reviewers->'peer'->>'min')::int as min, (c.reviewers->'peer'->>'max')::int as max,
      (select count(*)::int from review_assignments a where a.cycle_id = c.id and a.reviewee_employee_id = o.employee_id and a.reviewer_type = 'peer' and a.nomination <> 'rejected') as picked,
      c.timelines->>'nominate_due' as due
    from review_cycles c join review_outcomes o on o.cycle_id = c.id join employees e on e.id = o.employee_id
    where c.status = 'live' and (c.reviewers->'peer'->>'enabled')::boolean
      and ((c.reviewers->'peer'->>'nominated_by' = 'employee' and o.employee_id = ${actor.employeeId})
        or (c.reviewers->'peer'->>'nominated_by' = 'manager' and e.manager_id = ${actor.employeeId}))
    order by c.created_at desc, e.display_name`;
  const approvals = await tx<{ id: string; cycle: string; reviewee: string; peer: string }[]>`
    select a.id, c.name as cycle, e.display_name as reviewee, p.display_name as peer
    from review_assignments a join review_cycles c on c.id = a.cycle_id join employees e on e.id = a.reviewee_employee_id join employees p on p.id = a.reviewer_employee_id
    where a.nomination = 'proposed' and c.status = 'live' and e.manager_id = ${actor.employeeId} order by c.created_at desc, e.display_name`;
  const results = await myResults(tx, actor);
  return { toWrite: toWrite.map((r) => ({ ...r, rating: N(r.rating) })), nominate, approvals, results };
}

/** One review to fill (the reviewer) or read (the reviewee's managers / admins once submitted). */
export async function reviewDetail(tx: Tx, actor: Actor, id: string) {
  const a = await assignment(tx, id).catch(() => null);
  if (!a) return null;
  const isReviewer = a.reviewer_employee_id === actor.employeeId;
  const reviewee = await personRow(tx, a.reviewee_employee_id);
  const overseer = a.reviewee_employee_id !== actor.employeeId && ((await isAbove(tx, actor.employeeId, a.reviewee_employee_id)) || perfAdminFor(actor, reviewee));
  if (!isReviewer && !(overseer && a.status === "submitted")) return null;
  if (isReviewer && a.reviewer_type === "peer" && a.nomination !== "approved") return null;
  const c = await cycleRow(tx, a.cycle_id);
  const { sections, points } = await resolveSections(tx, actor, c, a.reviewee_employee_id);
  // a manager writing their review sees the person's own self review alongside
  let selfAnswers: Answers | null = null;
  if (isReviewer && (a.reviewer_type === "manager" || a.reviewer_type === "skip_level")) {
    const [s] = await tx<{ answers: Answers }[]>`select answers from review_assignments where cycle_id = ${a.cycle_id} and reviewee_employee_id = ${a.reviewee_employee_id} and reviewer_type = 'self' and status = 'submitted'`;
    selfAnswers = s?.answers ?? null;
  }
  const [reviewer] = await tx<{ name: string }[]>`select display_name as name from employees where id = ${a.reviewer_employee_id}`;
  return {
    id: a.id, cycle: { id: c.id, name: c.name, status: c.status, periodStart: c.period_start, periodEnd: c.period_end, timelines: c.timelines },
    reviewee: { id: reviewee.id, name: reviewee.display_name }, reviewer: reviewer.name, type: a.reviewer_type, status: a.status, rating: N(a.rating),
    answers: a.answers, selfAnswers, sections, points, canEdit: isReviewer && c.status === "live" && a.status !== "submitted" && a.status !== "declined",
  };
}

// ------------------------------------------------------------------ outcomes, progress, nudges

/** Recompute the overall (pre-calibration) rating for one person or everyone in a cycle. */
export async function computeOutcomes(tx: Tx, cycleId: string, employeeId?: string) {
  const settings = await getSettings(tx);
  const rows = await tx<{ reviewee: string; type: ReviewerType; rating: string }[]>`
    select reviewee_employee_id as reviewee, reviewer_type as type, rating from review_assignments
    where cycle_id = ${cycleId} and status = 'submitted' and rating is not null ${employeeId ? tx`and reviewee_employee_id = ${employeeId}` : tx``}`;
  const outcomes = await tx<{ employee_id: string }[]>`select employee_id from review_outcomes where cycle_id = ${cycleId} ${employeeId ? tx`and employee_id = ${employeeId}` : tx``}`;
  for (const o of outcomes) {
    const by: Partial<Record<ReviewerType, number[]>> = {};
    for (const r of rows.filter((x) => x.reviewee === o.employee_id)) (by[r.type] ??= []).push(Number(r.rating));
    const raw = combineRatings(by, settings.reviewerWeights);
    const v = raw == null ? null : roundRating(raw, settings.rounding);
    await tx`update review_outcomes set computed_rating = ${v} where cycle_id = ${cycleId} and employee_id = ${o.employee_id}`;
  }
}

async function computeAggregate(tx: Tx, tenantId: string, c: CycleRow) {
  const settings = await getSettings(tx);
  const rows = await tx<{ employee_id: string; r: string }[]>`
    select employee_id, avg(coalesce(final_rating, computed_rating)) as r from review_outcomes
    where cycle_id = any(${c.source_cycle_ids}::uuid[]) and coalesce(final_rating, computed_rating) is not null group by employee_id`;
  for (const r of rows) {
    const v = roundRating(Number(r.r), settings.rounding);
    await tx`insert into review_outcomes (tenant_id, cycle_id, employee_id, computed_rating) values (${tenantId}, ${c.id}, ${r.employee_id}, ${v})
             on conflict (cycle_id, employee_id) do update set computed_rating = excluded.computed_rating`;
  }
  return rows.length;
}

const STAGES: ReviewerType[] = ["self", "peer", "manager", "skip_level"];
/** Completion per stage and per person, with who's overdue. Admins (any scope) see the people they cover. */
export async function cycleProgress(tx: Tx, actor: Actor, cycleId: string, today = todayIn()) {
  if (!hasAnyPerf(actor)) throw new AppError("forbidden", "You don't have access to review cycles.");
  const c = await cycleRow(tx, cycleId);
  const rows = await tx<(PersonRow & { a_id: string | null; type: ReviewerType | null; status: string | null; nomination: string | null; reviewer: string | null; reviewer_id: string | null })[]>`
    select e.id, e.display_name, e.first_name, e.manager_id, e.l2_manager_id, e.status, e.joining_date::text, e.probation_end_date::text, e.user_id,
      e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id,
      a.id as a_id, a.reviewer_type as type, a.status as status, a.nomination, r.display_name as reviewer, a.reviewer_employee_id as reviewer_id
    from review_outcomes o join employees e on e.id = o.employee_id
    left join review_assignments a on a.cycle_id = o.cycle_id and a.reviewee_employee_id = o.employee_id and (a.nomination is null or a.nomination <> 'rejected')
    left join employees r on r.id = a.reviewer_employee_id
    where o.cycle_id = ${cycleId} order by e.display_name`;
  // never your own row: an admin inside the cycle must not see their own pre-release rating, potential or calibration note
  const visible = rows.filter((r) => r.id !== actor.employeeId && perfAdminFor(actor, r));
  const due = (t: ReviewerType) => (t === "self" ? c.timelines.self_due : t === "peer" ? c.timelines.peer_due : c.timelines.manager_due) ?? null;
  const stages = STAGES.map((t) => {
    const xs = visible.filter((r) => r.type === t && r.nomination !== "proposed");
    const submitted = xs.filter((r) => r.status === "submitted").length;
    const d = due(t);
    return { type: t, total: xs.length, submitted, draft: xs.filter((r) => r.status === "draft").length, declined: xs.filter((r) => r.status === "declined").length,
      overdue: d && d < today ? xs.filter((r) => r.status === "not_started" || r.status === "draft").length : 0, due: d };
  }).filter((s) => s.total > 0);
  const people = new Map<string, { id: string; name: string; reviews: { id: string; type: ReviewerType; status: string; reviewer: string; proposed: boolean }[] }>();
  for (const r of visible) {
    const p = people.get(r.id) ?? { id: r.id, name: r.display_name, reviews: [] };
    if (r.a_id) p.reviews.push({ id: r.a_id, type: r.type!, status: r.status!, reviewer: r.reviewer!, proposed: r.nomination === "proposed" });
    people.set(r.id, p);
  }
  return { cycle: { ...c, launched_at: c.launched_at?.toISOString() ?? null, published_at: c.published_at?.toISOString() ?? null }, stages, people: [...people.values()] };
}

/** Remind everyone with an unfinished review (optionally one stage). At most once a day per review, so it's safe to click twice. */
export async function nudge(tx: Tx, actor: Actor, cycleId: string, type?: ReviewerType) {
  assertPerfAdmin(actor);
  const c = await cycleRow(tx, cycleId);
  if (c.status !== "live") throw new AppError("invalid", "Reminders go out only while reviews are open.");
  const rows = await tx<{ id: string; reviewer: string; reviewee: string; type: ReviewerType }[]>`
    update review_assignments a set nudged_at = now() from employees e
    where a.cycle_id = ${cycleId} and e.id = a.reviewee_employee_id and a.status in ('not_started','draft') and (a.nomination is null or a.nomination = 'approved')
      and (a.nudged_at is null or a.nudged_at < now() - interval '20 hours') ${type ? tx`and a.reviewer_type = ${type}` : tx``}
    returning a.id, a.reviewer_employee_id as reviewer, e.display_name as reviewee, a.reviewer_type as type`;
  for (const r of rows) await notifyEmployee(tx, actor.tenant.id, r.reviewer, "review.nudge", "Reminder: a review is waiting",
    r.type === "self" ? `Your self review in ${c.name} isn't finished yet.` : `Your review of ${r.reviewee} in ${c.name} isn't finished yet.`, "/me/performance/reviews");
  await audit(tx, actor, { entityType: "review_cycle", entityId: cycleId, action: "nudge", diff: { name: c.name, sent: rows.length, type: type ?? null } });
  return { sent: rows.length };
}

/** live → calibration (ratings computed) → published → closed. Publishing goes through publishResults. */
export async function advanceCycle(tx: Tx, actor: Actor, cycleId: string, to: "calibration" | "closed") {
  assertPerfAdmin(actor);
  const c = await cycleRow(tx, cycleId, true);
  if (to === "calibration" && c.status !== "live") throw new AppError("conflict", "Only an open cycle can move to calibration.");
  if (to === "closed" && c.status !== "published") throw new AppError("conflict", "Publish the results before closing the cycle.");
  if (to === "calibration") await computeOutcomes(tx, cycleId);
  await tx`update review_cycles set status = ${to} where id = ${cycleId}`;
  await audit(tx, actor, { entityType: "review_cycle", entityId: cycleId, action: to === "calibration" ? "calibrate" : "close", diff: { name: c.name } });
}

// ------------------------------------------------------------------ calibration

export async function calibration(tx: Tx, actor: Actor, cycleId: string) {
  if (!hasAnyPerf(actor)) throw new AppError("forbidden", "You don't have access to calibration.");
  const c = await cycleRow(tx, cycleId);
  const settings = await getSettings(tx);
  let points = settings.points;
  if (c.form_id) points = (await formFor(tx, c)).points;
  const rows = await tx<(PersonRow & { outcome_id: string; computed: string | null; final: string | null; potential: number | null; note: string | null; released: boolean; department: string | null; designation: string | null; employee_number: string })[]>`
    select e.id, e.display_name, e.first_name, e.manager_id, e.l2_manager_id, e.status, e.joining_date::text, e.probation_end_date::text, e.user_id, e.employee_number,
      e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id, d.name as department, g.title as designation,
      o.id as outcome_id, o.computed_rating as computed, o.final_rating as final, o.potential, o.calibration_note as note, o.released
    from review_outcomes o join employees e on e.id = o.employee_id left join departments d on d.id = e.department_id left join designations g on g.id = e.designation_id
    where o.cycle_id = ${cycleId} order by e.display_name`;
  // never your own row: an admin inside the cycle must not see their own pre-release rating, potential or calibration note
  const visible = rows.filter((r) => r.id !== actor.employeeId && perfAdminFor(actor, r));
  const people = visible.map((r) => {
    const computed = N(r.computed), final = N(r.final), effective = final ?? computed;
    return {
      outcomeId: r.outcome_id, id: r.id, name: r.display_name, number: r.employee_number, department: r.department, designation: r.designation, computed, final, effective,
      potential: r.potential, note: r.note, released: r.released, band: bandFor(effective, settings.bands), box: nineBox(effective, r.potential, points), self: r.id === actor.employeeId,
    };
  });
  return {
    cycle: { id: c.id, name: c.name, status: c.status, kind: c.kind }, points, bands: settings.bands, ideal: settings.idealDistribution, people,
    pre: distribution(people.map((p) => p.computed), settings.bands), post: distribution(people.map((p) => p.effective), settings.bands),
    canPublish: isPerfAdmin(actor),
  };
}

const finalInput = z.object({ finalRating: z.number().nullable(), potential: z.number().int().min(1).max(3).nullable(), note: z.string().trim().max(1000).nullable().optional() });
/** Set a person's final rating / potential during calibration, with a note when it differs. Covering admins only; never your own. */
export async function setFinalRating(tx: Tx, actor: Actor, outcomeId: string, raw: unknown) {
  const p = finalInput.safeParse(raw);
  if (!p.success) throw bad(p);
  const v = p.data;
  const [o] = await tx<{ id: string; cycle_id: string; employee_id: string; computed_rating: string | null; final_rating: string | null }[]>`
    select id, cycle_id, employee_id, computed_rating, final_rating from review_outcomes where id = ${outcomeId} for update`;
  if (!o) throw new AppError("not_found", "Rating not found.");
  const person = await personRow(tx, o.employee_id);
  if (!perfAdminFor(actor, person)) throw new AppError("forbidden", "You don't calibrate ratings for this person.");
  if (o.employee_id === actor.employeeId) throw new AppError("forbidden", "You can't calibrate your own rating.");
  const c = await cycleRow(tx, o.cycle_id);
  if (c.status !== "calibration") throw new AppError("invalid", "Ratings can be changed only while the cycle is in calibration.");
  const settings = await getSettings(tx);
  const points = c.form_id ? (await formFor(tx, c)).points : settings.points;
  const { min, max } = scaleRange(points);
  if (v.finalRating != null && (v.finalRating < min || v.finalRating > max)) throw new AppError("invalid", `Ratings go from ${min} to ${max}.`, "finalRating");
  const finalR = v.finalRating == null ? null : roundRating(v.finalRating, "none");
  const changed = finalR != null && finalR !== N(o.computed_rating);
  if (changed && !v.note) throw new AppError("invalid", "Add a note explaining the change.", "note");
  await tx`update review_outcomes set final_rating = ${finalR}, potential = ${v.potential}, calibration_note = ${v.note || null}, calibrated_by = ${actor.userId},
           band = ${bandFor(finalR ?? N(o.computed_rating), settings.bands)} where id = ${outcomeId}`;
  await audit(tx, actor, { entityType: "review_outcome", entityId: outcomeId, action: "calibrate", diff: { employeeId: o.employee_id, from: N(o.final_rating) ?? N(o.computed_rating), to: finalR, potential: v.potential, note: v.note ?? null } });
}

const IMPORT_HEADERS = ["Employee number", "Name", "Computed rating", "Final rating", "Potential (1-3)", "Note"] as const;
export async function calibrationTemplate(tx: Tx, actor: Actor, cycleId: string) {
  const d = await calibration(tx, actor, cycleId);
  const wb = new ExcelJS.Workbook();
  wb.creator = "erp";
  const ws = wb.addWorksheet("Calibration", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = IMPORT_HEADERS.map((h) => ({ header: h, width: h === "Name" || h === "Note" ? 30 : 18 }));
  ws.getRow(1).font = { bold: true };
  for (const p of d.people) if (!p.self) ws.addRow([p.number, p.name, p.computed, p.final, p.potential, p.note]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Bulk calibration from the template. Every row is checked first; nothing changes unless all rows are fine. */
export async function importCalibration(tx: Tx, actor: Actor, cycleId: string, bytes: ArrayBuffer) {
  if (bytes.byteLength > 5 * 1024 * 1024) throw new AppError("invalid", "The file is larger than 5 MB.");
  const d = await calibration(tx, actor, cycleId);
  if (d.cycle.status !== "calibration") throw new AppError("invalid", "Ratings can be imported only while the cycle is in calibration.");
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(bytes); } catch { throw new AppError("invalid", "This isn't an Excel (.xlsx) file erp can read. Download the template and fill that in."); }
  const ws = wb.getWorksheet("Calibration") ?? wb.worksheets[0];
  if (!ws) throw new AppError("invalid", "The file has no sheets.");
  const col = new Map<string, number>();
  ws.getRow(1).eachCell((c, i) => { const h = IMPORT_HEADERS.find((x) => x.toLowerCase() === String(c.value ?? "").trim().toLowerCase()); if (h) col.set(h, i); });
  if (!col.has("Employee number") || !col.has("Final rating")) throw new AppError("invalid", "Missing the Employee number or Final rating column. Use the erp template.");
  const { min, max } = scaleRange(d.points);
  const errors: string[] = [];
  const updates: { outcomeId: string; finalRating: number | null; potential: number | null; note: string | null }[] = [];
  ws.eachRow({ includeEmpty: false }, (r, n) => {
    if (n === 1) return;
    const cell = (h: string) => { const i = col.get(h); if (!i) return null; const v = r.getCell(i).value; return (v as { result?: unknown })?.result ?? v; };
    const num = String(cell("Employee number") ?? "").trim();
    if (!num) return;
    const p = d.people.find((x) => x.number.toLowerCase() === num.toLowerCase());
    const fr = cell("Final rating"), pot = cell("Potential (1-3)"), note = String(cell("Note") ?? "").trim() || null;
    if (!p) { errors.push(`Row ${n}: ${num} isn't in this cycle (or isn't someone you calibrate).`); return; }
    if (p.self) { errors.push(`Row ${n}: you can't calibrate your own rating.`); return; }
    const f = fr == null || fr === "" ? null : Number(fr);
    const pt = pot == null || pot === "" ? null : Number(pot);
    if (f != null && (!Number.isFinite(f) || f < min || f > max)) { errors.push(`Row ${n}: final rating must be between ${min} and ${max}.`); return; }
    if (pt != null && (!Number.isInteger(pt) || pt < 1 || pt > 3)) { errors.push(`Row ${n}: potential must be 1, 2 or 3.`); return; }
    if (f != null && f !== p.computed && !note) { errors.push(`Row ${n}: add a note for a changed rating.`); return; }
    updates.push({ outcomeId: p.outcomeId, finalRating: f, potential: pt, note });
  });
  if (errors.length) return { applied: 0, errors };
  for (const u of updates) await setFinalRating(tx, actor, u.outcomeId, { finalRating: u.finalRating, potential: u.potential, note: u.note });
  return { applied: updates.length, errors: [] as string[] };
}

/** Release results to employees: everyone, or the people picked. The cycle is published once everyone has theirs. */
export async function publishResults(tx: Tx, actor: Actor, cycleId: string, employeeIds: string[] | null) {
  assertPerfAdmin(actor);
  const c = await cycleRow(tx, cycleId, true);
  if (c.status !== "calibration" && c.status !== "published") throw new AppError("invalid", "Move the cycle to calibration before publishing.");
  const settings = await getSettings(tx);
  const rows = await tx<{ id: string; employee_id: string; r: string | null }[]>`
    update review_outcomes set released = true, published_at = now() where cycle_id = ${cycleId} and not released
      ${employeeIds ? tx`and employee_id = any(${employeeIds}::uuid[])` : tx``}
    returning id, employee_id, coalesce(final_rating, computed_rating) as r`;
  for (const r of rows) {
    await tx`update review_outcomes set band = ${bandFor(N(r.r), settings.bands)} where id = ${r.id}`;
    await notifyEmployee(tx, actor.tenant.id, r.employee_id, "review.published", "Your review results are ready", `${c.name}: see your rating and feedback.`, "/me/performance/reviews?tab=results");
    await emitEvent(tx, actor.tenant.id, "review.published", { employeeId: r.employee_id, occurrence: r.id, link: "/me/performance/reviews?tab=results", vars: { "review.cycle": c.name } });
  }
  const [{ left }] = await tx<{ left: number }[]>`select count(*)::int as left from review_outcomes where cycle_id = ${cycleId} and not released`;
  if (!left && c.status !== "published") await tx`update review_cycles set status = 'published', published_at = now() where id = ${cycleId}`;
  await audit(tx, actor, { entityType: "review_cycle", entityId: cycleId, action: "publish", diff: { name: c.name, released: rows.length, remaining: left } });
  return { released: rows.length, remaining: left };
}

/** The actor's released results with their manager's comments (peer names are never shown). */
export async function myResults(tx: Tx, actor: Actor) {
  const rows = await tx<{ cycle_id: string; cycle: string; final: string | null; computed: string | null; band: string | null; published_at: Date | null }[]>`
    select o.cycle_id, c.name as cycle, o.final_rating as final, o.computed_rating as computed, o.band, o.published_at
    from review_outcomes o join review_cycles c on c.id = o.cycle_id where o.employee_id = ${actor.employeeId} and o.released order by o.published_at desc`;
  const out = [];
  for (const r of rows) {
    const comments = await tx<{ type: ReviewerType; answers: Answers }[]>`
      select reviewer_type as type, answers from review_assignments where cycle_id = ${r.cycle_id} and reviewee_employee_id = ${actor.employeeId} and status = 'submitted' and reviewer_type in ('manager','peer','skip_level')`;
    out.push({
      cycleId: r.cycle_id, cycle: r.cycle, rating: N(r.final) ?? N(r.computed), band: r.band, publishedAt: r.published_at?.toISOString() ?? null,
      comments: comments.flatMap((c) => Object.values(c.answers).map((a) => a.comment).filter((x): x is string => !!x).map((text) => ({ from: c.type === "peer" ? "A peer" : c.type === "manager" ? "Your manager" : "Skip-level manager", text }))),
    });
  }
  return out;
}

/** Final (else computed) rating of each person in a cycle, for compensation planning. */
export async function ratingsFor(tx: Tx, cycleId: string) {
  const rows = await tx<{ employee_id: string; r: string | null }[]>`select employee_id, coalesce(final_rating, computed_rating) as r from review_outcomes where cycle_id = ${cycleId}`;
  return new Map(rows.map((r) => [r.employee_id, N(r.r)]));
}

export async function listCycles(tx: Tx, actor: Actor) {
  if (!hasAnyPerf(actor)) throw new AppError("forbidden", "You don't have access to review cycles.");
  const rows = await tx<{ id: string; name: string; kind: string; status: CycleStatus; period_start: string; period_end: string; participants: number; submitted: number; total: number; created_at: Date }[]>`
    select c.id, c.name, c.kind, c.status, c.period_start::text, c.period_end::text,
      (select count(*)::int from review_outcomes o where o.cycle_id = c.id) as participants,
      (select count(*)::int from review_assignments a where a.cycle_id = c.id and a.status = 'submitted') as submitted,
      (select count(*)::int from review_assignments a where a.cycle_id = c.id and (a.nomination is null or a.nomination = 'approved') and a.status <> 'declined') as total,
      c.created_at
    from review_cycles c order by c.created_at desc`;
  return rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() }));
}

export async function cycleForEdit(tx: Tx, actor: Actor, id: string) {
  assertPerfAdmin(actor);
  const c = await cycleRow(tx, id);
  return { ...c, launched_at: c.launched_at?.toISOString() ?? null, published_at: c.published_at?.toISOString() ?? null };
}

/** For the wizard: a fresh id for sections and items. */
export const newId = () => randomUUID().slice(0, 8);
