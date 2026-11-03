import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { audit } from "@/server/modules/audit/service";
import { notifyEmployee } from "@/server/modules/approvals/service";
import { oversees, perfAdminFor, reportIds } from "./access";
import { pipOpen, pipTransition, PIP_STATUS_LABEL, type PipStatus } from "./rules";

type PipGoal = { id: string; title: string; measure: string | null; met: boolean | null };
type PipRow = { id: string; employee_id: string; owner_employee_id: string | null; reason: string; goals: PipGoal[]; starts_on: string; ends_on: string; status: PipStatus; outcome_note: string | null; closed_at: Date | null; created_at: Date };

const bad = (p: z.ZodSafeParseError<unknown>) => new AppError("invalid", p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));

async function pipRow(tx: Tx, id: string, lock = false) {
  const [p] = lock
    ? await tx<PipRow[]>`select id, employee_id, owner_employee_id, reason, goals, starts_on::text, ends_on::text, status, outcome_note, closed_at, created_at from pips where id = ${id} for update`
    : await tx<PipRow[]>`select id, employee_id, owner_employee_id, reason, goals, starts_on::text, ends_on::text, status, outcome_note, closed_at, created_at from pips where id = ${id}`;
  if (!p) throw new AppError("not_found", "Plan not found.");
  return p;
}
async function asOverseer(tx: Tx, actor: Actor, p: PipRow) {
  if (p.employee_id === actor.employeeId || !(await oversees(tx, actor, p.employee_id))) throw new AppError("forbidden", "Only their manager or HR can change this plan.");
}

export const pipInput = z.object({
  employeeId: z.uuid("Pick the person"),
  reason: z.string().trim().min(10, "Explain why the plan is needed").max(4000),
  goals: z.array(z.object({ title: z.string().trim().min(3, "Describe each goal").max(300), measure: z.string().trim().max(300).nullable().optional() })).min(1, "Add at least one goal").max(10),
  startsOn: z.iso.date("Pick a start date"),
  endsOn: z.iso.date("Pick an end date"),
});

/** Start a PIP for someone you manage (or cover as performance admin). Never for yourself; one open plan per person. */
export async function createPip(tx: Tx, actor: Actor, raw: unknown) {
  const p = pipInput.safeParse(raw);
  if (!p.success) throw bad(p);
  const v = p.data;
  if (v.employeeId === actor.employeeId) throw new AppError("forbidden", "You can't put yourself on a plan.");
  if (!(await oversees(tx, actor, v.employeeId))) throw new AppError("forbidden", "You can start a plan only for people in your team.");
  if (v.endsOn <= v.startsOn) throw new AppError("invalid", "The plan must end after it starts.", "endsOn");
  const [open] = await tx`select 1 from pips where employee_id = ${v.employeeId} and status in ('active','extended')`;
  if (open) throw new AppError("conflict", "This person already has an open plan.");
  const goals: PipGoal[] = v.goals.map((g) => ({ id: randomUUID().slice(0, 8), title: g.title, measure: g.measure || null, met: null }));
  const [r] = await tx<{ id: string }[]>`
    insert into pips (tenant_id, employee_id, owner_employee_id, created_by, reason, goals, starts_on, ends_on)
    values (${actor.tenant.id}, ${v.employeeId}, ${actor.employeeId}, ${actor.userId}, ${v.reason}, ${tx.json(goals)}, ${v.startsOn}, ${v.endsOn}) returning id`;
  await audit(tx, actor, { entityType: "pip", entityId: r.id, action: "create", diff: { employeeId: v.employeeId, startsOn: v.startsOn, endsOn: v.endsOn, goals: goals.length } });
  await notifyEmployee(tx, actor.tenant.id, v.employeeId, "pip.started", "A performance improvement plan was shared with you", `${actor.name} set up a plan running to ${v.endsOn}. Read it and talk it through with them.`, `/me/performance/pip?open=${r.id}`);
  return r;
}

const checkInInput = z.object({ status: z.enum(["on_track", "at_risk", "off_track"]), note: z.string().trim().min(2, "Write a short update").max(4000) });
/** The person and their managers can both add check-ins while the plan is open. */
export async function pipCheckIn(tx: Tx, actor: Actor, pipId: string, raw: unknown) {
  const p = checkInInput.safeParse(raw);
  if (!p.success) throw bad(p);
  const pip = await pipRow(tx, pipId);
  const self = pip.employee_id === actor.employeeId;
  if (!self && !(await oversees(tx, actor, pip.employee_id))) throw new AppError("not_found", "Plan not found.");
  if (!pipOpen(pip.status)) throw new AppError("invalid", "This plan is closed.");
  await tx`insert into pip_check_ins (tenant_id, pip_id, author_employee_id, status, note) values (${actor.tenant.id}, ${pipId}, ${actor.employeeId}, ${p.data.status}, ${p.data.note})`;
  await audit(tx, actor, { entityType: "pip", entityId: pipId, action: "check_in", diff: { employeeId: pip.employee_id, status: p.data.status } });
  const tell = self ? pip.owner_employee_id : pip.employee_id;
  if (tell && tell !== actor.employeeId) await notifyEmployee(tx, actor.tenant.id, tell, "pip.check_in", "New update on a plan", `${actor.name} added a check-in.`, `/me/performance/pip?open=${pipId}`);
}

export async function setPipGoal(tx: Tx, actor: Actor, pipId: string, goalId: string, met: boolean | null) {
  const pip = await pipRow(tx, pipId, true);
  await asOverseer(tx, actor, pip);
  if (!pipOpen(pip.status)) throw new AppError("invalid", "This plan is closed.");
  if (!pip.goals.some((g) => g.id === goalId)) throw new AppError("not_found", "Goal not found.");
  const goals = pip.goals.map((g) => (g.id === goalId ? { ...g, met } : g));
  await tx`update pips set goals = ${tx.json(goals)} where id = ${pipId}`;
  await audit(tx, actor, { entityType: "pip", entityId: pipId, action: "goal", diff: { employeeId: pip.employee_id, goalId, met } });
}

export async function extendPip(tx: Tx, actor: Actor, pipId: string, endsOn: string, note: string) {
  const pip = await pipRow(tx, pipId, true);
  await asOverseer(tx, actor, pip);
  if (!pipTransition(pip.status, "extended")) throw new AppError("invalid", "This plan is closed.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endsOn) || endsOn <= pip.ends_on) throw new AppError("invalid", `Pick a date after ${pip.ends_on}.`, "endsOn");
  if (!note.trim()) throw new AppError("invalid", "Say why the plan is extended.", "note");
  await tx`update pips set status = 'extended', ends_on = ${endsOn} where id = ${pipId}`;
  await tx`insert into pip_check_ins (tenant_id, pip_id, author_employee_id, status, note) values (${actor.tenant.id}, ${pipId}, ${actor.employeeId}, 'at_risk', ${"Extended to " + endsOn + ": " + note.trim().slice(0, 3800)})`;
  await audit(tx, actor, { entityType: "pip", entityId: pipId, action: "extend", diff: { employeeId: pip.employee_id, from: pip.ends_on, to: endsOn } });
  await notifyEmployee(tx, actor.tenant.id, pip.employee_id, "pip.extended", "Your plan was extended", `It now runs to ${endsOn}.`, `/me/performance/pip?open=${pipId}`);
}

/** Close with an outcome. Needs a note; the person is told. */
export async function closePip(tx: Tx, actor: Actor, pipId: string, outcome: "passed" | "failed" | "cancelled", note: string) {
  const pip = await pipRow(tx, pipId, true);
  await asOverseer(tx, actor, pip);
  if (!pipTransition(pip.status, outcome)) throw new AppError("conflict", "This plan is already closed.");
  if (!note.trim()) throw new AppError("invalid", "Write the outcome note.", "note");
  await tx`update pips set status = ${outcome}, outcome_note = ${note.trim().slice(0, 4000)}, closed_at = now() where id = ${pipId}`;
  await audit(tx, actor, { entityType: "pip", entityId: pipId, action: "close", diff: { employeeId: pip.employee_id, outcome } });
  await notifyEmployee(tx, actor.tenant.id, pip.employee_id, "pip.closed", "Your plan has closed", `Outcome: ${PIP_STATUS_LABEL[outcome]}.`, `/me/performance/pip?open=${pipId}`);
}

export type PipSummary = { id: string; employee_id: string; employee: string; owner: string | null; starts_on: string; ends_on: string; status: PipStatus; goals_met: number; goals: number; mine: boolean };

/** Plans the actor is on, runs, or oversees. */
export async function listPips(tx: Tx, actor: Actor) {
  const team = await reportIds(tx, actor.employeeId);
  const rows = await tx<(PipSummary & { goals_json: PipGoal[]; department_id: string | null; location_id: string | null; legal_entity_id: string | null; business_unit_id: string | null })[]>`
    select p.id, p.employee_id, e.display_name as employee, o.display_name as owner, p.starts_on::text, p.ends_on::text, p.status, p.goals as goals_json,
      e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id, p.employee_id = ${actor.employeeId} as mine
    from pips p join employees e on e.id = p.employee_id left join employees o on o.id = p.owner_employee_id
    order by (p.status in ('active','extended')) desc, p.ends_on`;
  return rows
    .filter((r) => r.mine || team.includes(r.employee_id) || (r.employee_id !== actor.employeeId && perfAdminFor(actor, r)))
    .map((r) => ({ id: r.id, employee_id: r.employee_id, employee: r.employee, owner: r.owner, starts_on: r.starts_on, ends_on: r.ends_on, status: r.status, mine: r.mine,
      goals: r.goals_json.length, goals_met: r.goals_json.filter((g) => g.met === true).length }));
}

export async function pipDetail(tx: Tx, actor: Actor, id: string) {
  const pip = await pipRow(tx, id).catch(() => null);
  if (!pip) return null;
  const self = pip.employee_id === actor.employeeId;
  const manage = !self && (await oversees(tx, actor, pip.employee_id));
  if (!self && !manage) return null;
  const [names] = await tx<{ employee: string; owner: string | null }[]>`select e.display_name as employee, o.display_name as owner from employees e left join employees o on o.id = ${pip.owner_employee_id} where e.id = ${pip.employee_id}`;
  const checkIns = await tx<{ id: string; author: string; status: string; note: string; created_at: Date }[]>`
    select c.id, e.display_name as author, c.status, c.note, c.created_at from pip_check_ins c join employees e on e.id = c.author_employee_id where c.pip_id = ${id} order by c.created_at desc`;
  return {
    id: pip.id, employeeId: pip.employee_id, employee: names.employee, owner: names.owner, reason: pip.reason, goals: pip.goals, startsOn: pip.starts_on, endsOn: pip.ends_on,
    status: pip.status, outcomeNote: pip.outcome_note, closedAt: pip.closed_at?.toISOString() ?? null, canManage: manage, isSelf: self,
    checkIns: checkIns.map((c) => ({ ...c, created_at: c.created_at.toISOString() })),
  };
}
