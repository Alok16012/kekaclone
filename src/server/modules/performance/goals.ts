import "server-only";
import { z } from "zod";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import type { Placement } from "@/server/auth/permissions";
import { audit } from "@/server/modules/audit/service";
import { notifyEmployee } from "@/server/modules/approvals/service";
import { validateUpload } from "@/server/modules/documents/rules";
import { saveFile } from "@/server/storage";
import { todayIn } from "@/lib/dates";
import { isAbove, isPerfAdmin, oversees, perfAdminFor, personRow, reportIds, EVERYWHERE } from "./access";
import { getSettings } from "./settings";
import { canAlignTo, goalInsights, krProgress, krWeightsProblem, objectiveProgress, wouldCycle, type GoalStatus, type Level, type Metric } from "./rules";

const N = (v: unknown) => (v == null ? 0 : Number(v));

// ------------------------------------------------------------------ periods

export type Period = { id: string; name: string; starts_on: string; ends_on: string };
export async function listPeriods(tx: Tx) {
  return tx<Period[]>`select id, name, starts_on::text, ends_on::text from performance_periods order by starts_on desc`;
}
/** The period that contains today, else the latest one. */
export async function currentPeriod(tx: Tx, today = todayIn()) {
  const ps = await listPeriods(tx);
  return ps.find((p) => p.starts_on <= today && p.ends_on >= today) ?? ps[0] ?? null;
}
const periodInput = z.object({ name: z.string().trim().min(2, "Name the period").max(60), startsOn: z.iso.date("Pick a start date"), endsOn: z.iso.date("Pick an end date") });
export async function savePeriod(tx: Tx, actor: Actor, id: string | null, raw: unknown) {
  if (!isPerfAdmin(actor)) throw new AppError("forbidden", "Only performance admins for the whole company can set goal periods.");
  const p = periodInput.safeParse(raw);
  if (!p.success) throw new AppError("invalid", p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
  if (p.data.endsOn <= p.data.startsOn) throw new AppError("invalid", "The period must end after it starts.", "endsOn");
  const [dupe] = await tx`select 1 from performance_periods where lower(name) = lower(${p.data.name}) and id is distinct from ${id}`;
  if (dupe) throw new AppError("conflict", `There's already a period called ${p.data.name}.`, "name");
  const [r] = id
    ? await tx<{ id: string }[]>`update performance_periods set name = ${p.data.name}, starts_on = ${p.data.startsOn}, ends_on = ${p.data.endsOn} where id = ${id} returning id`
    : await tx<{ id: string }[]>`insert into performance_periods (tenant_id, name, starts_on, ends_on) values (${actor.tenant.id}, ${p.data.name}, ${p.data.startsOn}, ${p.data.endsOn}) returning id`;
  if (!r) throw new AppError("not_found", "Period not found.");
  await audit(tx, actor, { entityType: "performance_period", entityId: r.id, action: id ? "update" : "create", diff: p.data });
  return r;
}

// ------------------------------------------------------------------ access

type ObjRow = {
  id: string; level: Level; owner_employee_id: string | null; department_id: string | null; parent_id: string | null; period_id: string | null;
  title: string; description: string | null; weight: string; progress: string; status: GoalStatus; due_date: string | null; visibility: "public" | "private";
  created_at: Date;
};
async function objRow(tx: Tx, id: string, lock = false) {
  const [o] = lock
    ? await tx<ObjRow[]>`select id, level, owner_employee_id, department_id, parent_id, period_id, title, description, weight, progress, status, due_date::text, visibility, created_at from objectives where id = ${id} for update`
    : await tx<ObjRow[]>`select id, level, owner_employee_id, department_id, parent_id, period_id, title, description, weight, progress, status, due_date::text, visibility, created_at from objectives where id = ${id}`;
  if (!o) throw new AppError("not_found", "Goal not found.");
  return o;
}

/** Company goals: unscoped performance admin. Department goals: an admin covering the department. Individual: the owner, their managers, or an admin covering them. */
async function canEdit(tx: Tx, actor: Actor, o: { level: Level; owner_employee_id: string | null; department_id: string | null }) {
  if (o.level === "company") return isPerfAdmin(actor);
  if (o.level === "department") return perfAdminFor(actor, { ...EVERYWHERE, department_id: o.department_id });
  if (!o.owner_employee_id) return false;
  if (o.owner_employee_id === actor.employeeId) return true;
  return oversees(tx, actor, o.owner_employee_id);
}
async function canSee(tx: Tx, actor: Actor, o: { visibility: string; level: Level; owner_employee_id: string | null; department_id: string | null }) {
  if (o.visibility === "public") return true;
  return canEdit(tx, actor, o);
}

// ------------------------------------------------------------------ roll-up

/** Recompute an objective's progress from its key results / aligned children / last check-in, then walk up the alignment chain. */
export async function recompute(tx: Tx, objectiveId: string) {
  const seen = new Set<string>();
  let id: string | null = objectiveId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const krs = await tx<{ metric: Metric; start_value: string; target_value: string; current_value: string; weight: string }[]>`
      select metric, start_value, target_value, current_value, weight from key_results where objective_id = ${id}`;
    const children = await tx<{ progress: string; weight: string }[]>`select progress, weight from objectives where parent_id = ${id} and status <> 'closed'`;
    const [last] = await tx<{ progress: string | null }[]>`select progress from check_ins where objective_id = ${id} and key_result_id is null and progress is not null order by created_at desc limit 1`;
    const progress = objectiveProgress({
      krs: krs.map((k) => ({ progress: krProgress({ metric: k.metric, start: N(k.start_value), target: N(k.target_value), current: N(k.current_value) }), weight: N(k.weight) })),
      children: children.map((c) => ({ progress: N(c.progress), weight: N(c.weight) })),
      checkedIn: last?.progress == null ? null : N(last.progress),
    });
    const rows: { parent_id: string | null }[] = await tx<{ parent_id: string | null }[]>`update objectives set progress = ${progress} where id = ${id} returning parent_id`;
    const u = rows[0];
    id = u?.parent_id ?? null;
  }
}

async function checkParent(tx: Tx, actor: Actor, level: Level, parentId: string | null, selfId: string | null) {
  if (!parentId) return null;
  const parent = await objRow(tx, parentId).catch(() => null);
  if (!parent || !(await canSee(tx, actor, parent))) throw new AppError("invalid", "Pick a goal to align to.", "parentId");
  if (!canAlignTo(level, parent.level)) throw new AppError("invalid", `A ${level} goal can only align to a goal at its own level or above.`, "parentId");
  if (parent.status === "closed") throw new AppError("invalid", "That goal is closed.", "parentId");
  if (selfId) {
    const rows = await tx<{ id: string; parent_id: string | null }[]>`select id, parent_id from objectives`;
    if (wouldCycle(selfId, parentId, new Map(rows.map((r) => [r.id, r.parent_id])))) throw new AppError("invalid", "That would make the goal align to itself.", "parentId");
  }
  return parent;
}

// ------------------------------------------------------------------ objectives

const krInput = z.object({
  id: z.uuid().optional(),
  title: z.string().trim().min(2, "Describe the key result").max(200),
  metric: z.enum(["percent", "number", "currency", "boolean"]),
  start: z.number().finite().default(0),
  target: z.number().finite(),
  current: z.number().finite().optional(),
  weight: z.number().min(0).max(100).default(0),
});
export const objectiveInput = z.object({
  level: z.enum(["company", "department", "individual"]),
  ownerId: z.uuid().nullable().optional(),
  departmentId: z.uuid().nullable().optional(),
  periodId: z.uuid().nullable().optional(),
  parentId: z.uuid().nullable().optional(),
  title: z.string().trim().min(3, "Give the goal a title").max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  weight: z.number().min(0).max(100).default(0),
  dueDate: z.iso.date().nullable().optional(),
  visibility: z.enum(["public", "private"]).default("public"),
  keyResults: z.array(krInput).max(10).default([]),
});
export type ObjectiveInput = z.input<typeof objectiveInput>;

function parseObj(raw: unknown) {
  const p = objectiveInput.safeParse(raw);
  if (!p.success) throw new AppError("invalid", p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
  return p.data;
}

export async function createObjective(tx: Tx, actor: Actor, raw: unknown) {
  const v = parseObj(raw);
  const settings = await getSettings(tx);
  const owner = v.level === "individual" ? (v.ownerId ?? actor.employeeId) : null;
  const dept = v.level === "department" ? v.departmentId ?? null : null;
  if (v.level === "department") {
    if (!dept) throw new AppError("invalid", "Pick the department.", "departmentId");
    const [d] = await tx`select 1 from departments where id = ${dept}`;
    if (!d) throw new AppError("invalid", "Pick the department.", "departmentId");
  }
  if (owner) {
    const p = await personRow(tx, owner).catch(() => null);
    if (!p || p.status === "relieved") throw new AppError("invalid", "Pick someone who works here.", "ownerId");
  }
  if (!(await canEdit(tx, actor, { level: v.level, owner_employee_id: owner, department_id: dept })))
    throw new AppError("forbidden", v.level === "individual" ? "You can set goals for yourself and the people who report to you." : `Only performance admins can set ${v.level} goals.`);
  if (v.periodId) { const [pp] = await tx`select 1 from performance_periods where id = ${v.periodId}`; if (!pp) throw new AppError("invalid", "Pick a period.", "periodId"); }
  await checkParent(tx, actor, v.level, v.parentId ?? null, null);
  const wp = krWeightsProblem(v.keyResults.map((k) => k.weight), settings.krWeightsMustTotal);
  if (wp) throw new AppError("invalid", wp, "keyResults");
  const [o] = await tx<{ id: string }[]>`
    insert into objectives (tenant_id, period_id, level, owner_employee_id, department_id, parent_id, title, description, weight, due_date, visibility, created_by)
    values (${actor.tenant.id}, ${v.periodId ?? null}, ${v.level}, ${owner}, ${dept}, ${v.parentId ?? null}, ${v.title}, ${v.description || null}, ${v.weight}, ${v.dueDate ?? null}, ${v.visibility}, ${actor.userId})
    returning id`;
  for (const k of v.keyResults) {
    await tx`insert into key_results (tenant_id, objective_id, title, metric, start_value, target_value, current_value, weight)
             values (${actor.tenant.id}, ${o.id}, ${k.title}, ${k.metric}, ${k.metric === "boolean" ? 0 : k.start}, ${k.metric === "boolean" ? 1 : k.target}, ${k.current ?? (k.metric === "boolean" ? 0 : k.start)}, ${k.weight})`;
  }
  await recompute(tx, o.id);
  await audit(tx, actor, { entityType: "objective", entityId: o.id, action: "create", diff: { title: v.title, level: v.level, employeeId: owner, parentId: v.parentId ?? null } });
  if (owner && owner !== actor.employeeId) await notifyEmployee(tx, actor.tenant.id, owner, "goal.assigned", "A goal was set for you", `${actor.name}: ${v.title}`, "/me/performance");
  return o;
}

/** Edit the goal itself and replace its key results (kept by id, new ones added, missing ones removed). */
export async function updateObjective(tx: Tx, actor: Actor, id: string, raw: unknown) {
  const o = await objRow(tx, id, true);
  if (!(await canEdit(tx, actor, o))) throw new AppError("forbidden", "You can't edit this goal.");
  const v = parseObj({ ...(raw as object), level: o.level });
  const settings = await getSettings(tx);
  await checkParent(tx, actor, o.level, v.parentId ?? null, id);
  const wp = krWeightsProblem(v.keyResults.map((k) => k.weight), settings.krWeightsMustTotal);
  if (wp) throw new AppError("invalid", wp, "keyResults");
  await tx`update objectives set title = ${v.title}, description = ${v.description || null}, weight = ${v.weight}, due_date = ${v.dueDate ?? null},
           visibility = ${v.visibility}, parent_id = ${v.parentId ?? null}, period_id = ${v.periodId ?? o.period_id} where id = ${id}`;
  const existing = (await tx<{ id: string }[]>`select id from key_results where objective_id = ${id}`).map((r) => r.id);
  const keep = v.keyResults.filter((k) => k.id && existing.includes(k.id)).map((k) => k.id!);
  await tx`delete from key_results where objective_id = ${id} and not (id = any(${keep}::uuid[]))`;
  for (const k of v.keyResults) {
    const start = k.metric === "boolean" ? 0 : k.start, target = k.metric === "boolean" ? 1 : k.target;
    if (k.id && existing.includes(k.id)) await tx`update key_results set title = ${k.title}, metric = ${k.metric}, start_value = ${start}, target_value = ${target}, weight = ${k.weight} where id = ${k.id}`;
    else await tx`insert into key_results (tenant_id, objective_id, title, metric, start_value, target_value, current_value, weight) values (${actor.tenant.id}, ${id}, ${k.title}, ${k.metric}, ${start}, ${target}, ${k.current ?? start}, ${k.weight})`;
  }
  await recompute(tx, id);
  if (o.parent_id && o.parent_id !== (v.parentId ?? null)) await recompute(tx, o.parent_id);
  await audit(tx, actor, { entityType: "objective", entityId: id, action: "update", diff: { title: v.title, parentId: v.parentId ?? null, keyResults: v.keyResults.length } });
}

export async function deleteObjective(tx: Tx, actor: Actor, id: string) {
  const o = await objRow(tx, id, true);
  if (!(await canEdit(tx, actor, o))) throw new AppError("forbidden", "You can't delete this goal.");
  await tx`delete from objectives where id = ${id}`;
  if (o.parent_id) await recompute(tx, o.parent_id);
  await audit(tx, actor, { entityType: "objective", entityId: id, action: "delete", diff: { name: o.title, employeeId: o.owner_employee_id } });
}

/** Close (or reopen) a goal; closed goals drop out of their parent's roll-up. */
export async function setClosed(tx: Tx, actor: Actor, id: string, closed: boolean) {
  const o = await objRow(tx, id, true);
  if (!(await canEdit(tx, actor, o))) throw new AppError("forbidden", "You can't change this goal.");
  if (closed === (o.status === "closed")) return;
  const status: GoalStatus = closed ? "closed" : N(o.progress) >= 100 ? "completed" : "on_track";
  await tx`update objectives set status = ${status}, closed_at = ${closed ? tx`now()` : null} where id = ${id}`;
  if (o.parent_id) await recompute(tx, o.parent_id);
  await audit(tx, actor, { entityType: "objective", entityId: id, action: closed ? "close" : "reopen", diff: { name: o.title } });
}

// ------------------------------------------------------------------ check-ins

export type Upload = { name: string; bytes: Uint8Array };
export const checkInInput = z.object({
  status: z.enum(["on_track", "at_risk", "behind", "completed"]),
  comment: z.string().trim().max(2000).nullable().optional(),
  progress: z.number().min(0).max(100).nullable().optional(),       // only for goals without key results
  keyResults: z.array(z.object({ id: z.uuid(), current: z.number().finite() })).max(10).default([]),
});
const MAX_FILES = 3;

/** Record progress: key result values (or a direct %), a status, a comment and up to 3 files. The owner, their managers or an admin may check in. */
export async function checkIn(tx: Tx, actor: Actor, objectiveId: string, raw: unknown, files: Upload[] = []) {
  const p = checkInInput.safeParse(raw);
  if (!p.success) throw new AppError("invalid", p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
  const v = p.data;
  const o = await objRow(tx, objectiveId, true);
  if (!(await canEdit(tx, actor, o))) throw new AppError("forbidden", "You can't check in on this goal.");
  if (o.status === "closed") throw new AppError("invalid", "This goal is closed. Reopen it to check in.");
  if (files.length > MAX_FILES) throw new AppError("invalid", `Attach up to ${MAX_FILES} files.`, "files");
  const krs = await tx<{ id: string; title: string; current_value: string }[]>`select id, title, current_value from key_results where objective_id = ${objectiveId}`;
  for (const k of v.keyResults) if (!krs.some((x) => x.id === k.id)) throw new AppError("invalid", "That key result belongs to another goal.", "keyResults");
  if (!krs.length && v.progress == null && !v.comment) throw new AppError("invalid", "Enter the progress or a comment.", "progress");
  const fileIds: string[] = [];
  for (const f of files) {
    const ok = validateUpload({ name: f.name, size: f.bytes.byteLength, head: f.bytes.subarray(0, 512) });
    if (!ok.ok) throw new AppError("invalid", ok.error, "files");
    fileIds.push(await saveFile(tx, { tenantId: actor.tenant.id, userId: actor.userId, name: ok.name, mime: ok.mime, bytes: f.bytes, ext: ok.name.split(".").pop() ?? "" }));
  }
  for (const k of v.keyResults) {
    const cur = krs.find((x) => x.id === k.id)!;
    if (N(cur.current_value) === k.current) continue;
    await tx`update key_results set current_value = ${k.current} where id = ${k.id}`;
    await tx`insert into check_ins (tenant_id, key_result_id, author_employee_id, value) values (${actor.tenant.id}, ${k.id}, ${actor.employeeId}, ${k.current})`;
  }
  await tx`update objectives set status = ${v.status} where id = ${objectiveId}`;
  const directProgress = krs.length ? null : v.progress ?? null;
  const [ci] = await tx<{ id: string }[]>`
    insert into check_ins (tenant_id, objective_id, author_employee_id, progress, status, comment, file_ids)
    values (${actor.tenant.id}, ${objectiveId}, ${actor.employeeId}, ${directProgress}, ${v.status}, ${v.comment || null}, ${fileIds}::uuid[]) returning id`;
  await recompute(tx, objectiveId);
  // the check-in row remembers the progress it led to
  const [after] = await tx<{ progress: string }[]>`select progress from objectives where id = ${objectiveId}`;
  if (krs.length) await tx`update check_ins set progress = ${after.progress} where id = ${ci.id}`;
  if (v.status === "completed" && N(after.progress) < 100 && !krs.length) await tx`update objectives set progress = 100 where id = ${objectiveId}`;
  await audit(tx, actor, { entityType: "objective", entityId: objectiveId, action: "check_in", diff: { status: v.status, progress: N(after.progress), employeeId: o.owner_employee_id, files: fileIds.length } });
  if (o.owner_employee_id && o.owner_employee_id !== actor.employeeId)
    await notifyEmployee(tx, actor.tenant.id, o.owner_employee_id, "goal.check_in", "New check-in on your goal", `${actor.name} updated "${o.title}".`, "/me/performance");
  return { id: ci.id, progress: N(after.progress) };
}

/** A check-in attachment, if the actor can see the goal it belongs to. */
export async function checkInFile(tx: Tx, actor: Actor, fileId: string) {
  const [f] = await tx<{ id: string; storage_key: string; name: string; mime: string; objective_id: string }[]>`
    select f.id, f.storage_key, f.name, f.mime, c.objective_id from check_ins c join files f on f.id = any(c.file_ids) where f.id = ${fileId} and c.objective_id is not null limit 1`;
  if (!f) return null;
  const o = await objRow(tx, f.objective_id);
  return (await canSee(tx, actor, o)) ? f : null;
}

// ------------------------------------------------------------------ reading

export type Goal = {
  id: string; level: Level; title: string; description: string | null; owner_id: string | null; owner: string | null; department_id: string | null; department: string | null;
  parent_id: string | null; parent_title: string | null; period_id: string | null; weight: number; progress: number; status: GoalStatus; due_date: string | null;
  visibility: "public" | "private"; last_check_in: string | null; created_on: string; children: number;
  key_results: { id: string; title: string; metric: Metric; start: number; target: number; current: number; weight: number; progress: number }[];
  can_edit: boolean;
};

async function hydrate(tx: Tx, actor: Actor, rows: (ObjRow & { owner: string | null; department: string | null; parent_title: string | null; last_check_in: string | null; children: number })[]): Promise<Goal[]> {
  const ids = rows.map((r) => r.id);
  const krs = ids.length ? await tx<{ id: string; objective_id: string; title: string; metric: Metric; start_value: string; target_value: string; current_value: string; weight: string }[]>`
    select id, objective_id, title, metric, start_value, target_value, current_value, weight from key_results where objective_id = any(${ids}::uuid[]) order by created_at` : [];
  const out: Goal[] = [];
  const admin = isPerfAdmin(actor);
  const reports = new Set(await reportIds(tx, actor.employeeId));
  const owners = [...new Set(rows.map((r) => r.owner_employee_id).filter((x): x is string => !!x))];
  const placements = new Map((owners.length ? await tx<(Placement & { id: string })[]>`
    select id, department_id, location_id, legal_entity_id, business_unit_id from employees where id = any(${owners}::uuid[])` : []).map((p) => [p.id, p]));
  for (const r of rows) {
    const pl = r.owner_employee_id ? placements.get(r.owner_employee_id) : undefined;
    const canE = r.level === "company" ? admin
      : r.level === "department" ? perfAdminFor(actor, { ...EVERYWHERE, department_id: r.department_id })
      : r.owner_employee_id === actor.employeeId || reports.has(r.owner_employee_id ?? "") || (!!pl && perfAdminFor(actor, pl));
    if (r.visibility === "private" && !canE) continue;
    out.push({
      id: r.id, level: r.level, title: r.title, description: r.description, owner_id: r.owner_employee_id, owner: r.owner, department_id: r.department_id, department: r.department,
      parent_id: r.parent_id, parent_title: r.parent_title, period_id: r.period_id, weight: N(r.weight), progress: N(r.progress), status: r.status, due_date: r.due_date,
      visibility: r.visibility, last_check_in: r.last_check_in, created_on: r.created_at.toISOString().slice(0, 10), children: r.children, can_edit: canE,
      key_results: krs.filter((k) => k.objective_id === r.id).map((k) => {
        const kr = { metric: k.metric, start: N(k.start_value), target: N(k.target_value), current: N(k.current_value) };
        return { id: k.id, title: k.title, ...kr, weight: N(k.weight), progress: krProgress(kr) };
      }),
    });
  }
  return out;
}

const goalSelect = (tx: Tx) => tx`
  o.id, o.level, o.owner_employee_id, o.department_id, o.parent_id, o.period_id, o.title, o.description, o.weight, o.progress, o.status, o.due_date::text, o.visibility, o.created_at,
  e.display_name as owner, d.name as department, p.title as parent_title,
  (select max(c.created_at)::date::text from check_ins c where c.objective_id = o.id or c.key_result_id in (select k.id from key_results k where k.objective_id = o.id)) as last_check_in,
  (select count(*)::int from objectives x where x.parent_id = o.id) as children`;

export type GoalScope = "mine" | "team" | "department" | "company" | "all";

/** Goals for one tab: mine, my reports', department, company, or everything visible (for the tree). */
export async function listGoals(tx: Tx, actor: Actor, scope: GoalScope, periodId: string | null, opts: { employeeId?: string } = {}) {
  const me = await personRow(tx, actor.employeeId);
  const team = scope === "team" ? await reportIds(tx, actor.employeeId) : [];
  const rows = await tx<(ObjRow & { owner: string | null; department: string | null; parent_title: string | null; last_check_in: string | null; children: number })[]>`
    select ${goalSelect(tx)}
    from objectives o left join employees e on e.id = o.owner_employee_id left join departments d on d.id = o.department_id left join objectives p on p.id = o.parent_id
    where (${periodId}::uuid is null or o.period_id = ${periodId} or o.period_id is null)
      ${scope === "mine" ? tx`and o.level = 'individual' and o.owner_employee_id = ${opts.employeeId ?? actor.employeeId}` : tx``}
      ${scope === "team" ? tx`and o.level = 'individual' and o.owner_employee_id = any(${team}::uuid[])` : tx``}
      ${scope === "department" ? tx`and o.level = 'department' and o.department_id is not distinct from ${me.department_id}` : tx``}
      ${scope === "company" ? tx`and o.level = 'company'` : tx``}
    order by case o.level when 'company' then 0 when 'department' then 1 else 2 end, o.created_at`;
  return hydrate(tx, actor, rows);
}

/** Goals of one person (profile tab, reviews). Private goals only for those who may edit them. */
export async function goalsOf(tx: Tx, actor: Actor, employeeId: string, periodStart?: string, periodEnd?: string) {
  const rows = await tx<(ObjRow & { owner: string | null; department: string | null; parent_title: string | null; last_check_in: string | null; children: number })[]>`
    select ${goalSelect(tx)}
    from objectives o left join employees e on e.id = o.owner_employee_id left join departments d on d.id = o.department_id left join objectives p on p.id = o.parent_id
    left join performance_periods pp on pp.id = o.period_id
    where o.level = 'individual' and o.owner_employee_id = ${employeeId}
      ${periodStart && periodEnd ? tx`and (pp.id is null or (pp.starts_on <= ${periodEnd} and pp.ends_on >= ${periodStart}))` : tx``}
    order by o.created_at`;
  return hydrate(tx, actor, rows);
}

export async function goalDetail(tx: Tx, actor: Actor, id: string) {
  const o = await objRow(tx, id).catch(() => null);
  if (!o || !(await canSee(tx, actor, o))) return null;
  const checkIns = await tx<{ id: string; author: string; created_at: Date; status: string | null; progress: string | null; comment: string | null; value: string | null; kr: string | null; files: { id: string; name: string }[] }[]>`
    select c.id, e.display_name as author, c.created_at, c.status, c.progress, c.comment, c.value, k.title as kr,
      coalesce((select json_agg(json_build_object('id', f.id, 'name', f.name)) from files f where f.id = any(c.file_ids)), '[]') as files
    from check_ins c join employees e on e.id = c.author_employee_id left join key_results k on k.id = c.key_result_id
    where c.objective_id = ${id} or c.key_result_id in (select id from key_results where objective_id = ${id})
    order by c.created_at desc limit 100`;
  const aligned = await tx<{ id: string; title: string; owner: string | null; progress: string; status: GoalStatus }[]>`
    select o.id, o.title, e.display_name as owner, o.progress, o.status from objectives o left join employees e on e.id = o.owner_employee_id
    where o.parent_id = ${id} and o.visibility = 'public' order by o.created_at`;
  return {
    checkIns: checkIns.map((c) => ({ ...c, created_at: c.created_at.toISOString(), progress: c.progress == null ? null : N(c.progress), value: c.value == null ? null : N(c.value) })),
    aligned: aligned.map((a) => ({ ...a, progress: N(a.progress) })),
  };
}

/** Goals people can align to: every visible company / department goal, plus the actor's and their manager's own. */
export async function alignableGoals(tx: Tx, actor: Actor, periodId: string | null) {
  const me = await personRow(tx, actor.employeeId);
  const rows = await tx<{ id: string; title: string; level: Level; owner: string | null; department: string | null }[]>`
    select o.id, o.title, o.level, e.display_name as owner, d.name as department from objectives o
    left join employees e on e.id = o.owner_employee_id left join departments d on d.id = o.department_id
    where o.status <> 'closed' and o.visibility = 'public' and (${periodId}::uuid is null or o.period_id = ${periodId} or o.period_id is null)
      and (o.level in ('company','department') or o.owner_employee_id in (${actor.employeeId}, ${me.manager_id ?? actor.employeeId}))
    order by case o.level when 'company' then 0 when 'department' then 1 else 2 end, o.title`;
  return rows;
}

/** Everything the actor can see, as a flat list with parent ids (the client nests it). */
export async function okrTree(tx: Tx, actor: Actor, periodId: string | null) {
  return listGoals(tx, actor, "all", periodId);
}

/** Manager analytics: per report and overall. Admins see everyone they cover; managers their reports (all levels). */
export async function insights(tx: Tx, actor: Actor, periodId: string | null, today = todayIn()) {
  const admin = isPerfAdmin(actor);
  let people: { id: string; name: string; department: string | null }[];
  if (admin) people = await tx`select e.id, e.display_name as name, d.name as department from employees e left join departments d on d.id = e.department_id where e.status <> 'relieved' and e.id <> ${actor.employeeId} order by e.display_name`;
  else {
    const ids = await reportIds(tx, actor.employeeId);
    people = ids.length ? await tx`select e.id, e.display_name as name, d.name as department from employees e left join departments d on d.id = e.department_id where e.id = any(${ids}::uuid[]) order by e.display_name` : [];
  }
  const all = await listGoals(tx, actor, "all", periodId);
  const ids = new Set(people.map((p) => p.id));
  const goals = all.filter((g) => g.level === "individual" && g.owner_id && ids.has(g.owner_id));
  const perPerson = people.map((p) => {
    const mine = goals.filter((g) => g.owner_id === p.id);
    return { ...p, ...goalInsights(mine, today), goals: mine.length };
  });
  return { overall: goalInsights(goals, today), people: perPerson, isAdmin: admin };
}

/** For a reviews goal section: may this reviewer see / rate this person's goals? */
export async function canSeePersonGoals(tx: Tx, actor: Actor, employeeId: string) {
  return employeeId === actor.employeeId || (await isAbove(tx, actor.employeeId, employeeId)) || perfAdminFor(actor, await personRow(tx, employeeId));
}

/**
 * Check-in reminders per the company setting (weekly / every two weeks / monthly): owners of open individual goals with no
 * check-in in that window get one reminder, at most once per window, so the job can run daily.
 */
export async function checkInReminders(tx: Tx, tenantId: string) {
  const s = await getSettings(tx);
  if (s.checkinReminder === "off") return 0;
  const days = s.checkinReminder === "weekly" ? 7 : s.checkinReminder === "biweekly" ? 14 : 30;
  const rows = await tx<{ owner: string; n: number }[]>`
    select o.owner_employee_id as owner, count(*)::int as n from objectives o join employees e on e.id = o.owner_employee_id and e.status in ('active','notice')
    where o.level = 'individual' and o.status not in ('completed','closed') and o.created_at < now() - make_interval(days => ${days})
      and not exists (select 1 from check_ins c where (c.objective_id = o.id or c.key_result_id in (select k.id from key_results k where k.objective_id = o.id)) and c.created_at > now() - make_interval(days => ${days}))
      and not exists (select 1 from notifications n where n.user_id = e.user_id and n.kind = 'goal.reminder' and n.created_at > now() - make_interval(days => ${days}))
    group by o.owner_employee_id`;
  for (const r of rows) await notifyEmployee(tx, tenantId, r.owner, "goal.reminder", "Time for a goal check-in", `${r.n} of your goals ${r.n === 1 ? "hasn't" : "haven't"} had an update in a while.`, "/me/performance");
  return rows.length;
}
