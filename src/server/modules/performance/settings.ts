import "server-only";
import { z } from "zod";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { audit } from "@/server/modules/audit/service";
import { assertPerfAdmin } from "./access";
import { bandsProblem, distributionProblem, type Band, type ReviewerType, type Rounding, type ScalePoint } from "./rules";

export const DEFAULT_POINTS: ScalePoint[] = [
  { value: 1, label: "Needs improvement" }, { value: 2, label: "Developing" }, { value: 3, label: "Meets expectations" },
  { value: 4, label: "Exceeds expectations" }, { value: 5, label: "Outstanding" },
];
export const DEFAULT_BANDS: Band[] = [
  { min: 1, max: 1.99, label: "Needs improvement" }, { min: 2, max: 2.99, label: "Developing" }, { min: 3, max: 3.74, label: "Meets expectations" },
  { min: 3.75, max: 4.49, label: "Exceeds expectations" }, { min: 4.5, max: 5, label: "Outstanding" },
];
export const DEFAULT_DISTRIBUTION = [
  { label: "Needs improvement", pct: 5 }, { label: "Developing", pct: 15 }, { label: "Meets expectations", pct: 50 },
  { label: "Exceeds expectations", pct: 20 }, { label: "Outstanding", pct: 10 },
];
const SCALE_NAME = "Performance (1–5)";

export type PerfSettings = {
  goalMode: "okr" | "kra"; ratingScaleId: string | null; points: ScalePoint[]; bands: Band[]; idealDistribution: { label: string; pct: number }[];
  rounding: Rounding; reviewerWeights: Record<ReviewerType, number>; checkinReminder: "off" | "weekly" | "biweekly" | "monthly"; krWeightsMustTotal: boolean;
};

/** Rating scale, bands, ideal curve and the settings row for a tenant. Safe to call again. */
export async function ensurePerformanceDefaults(tx: Tx, tenantId: string) {
  await tx`insert into rating_scales (tenant_id, name, usage, points) values (${tenantId}, ${SCALE_NAME}, 'performance', ${tx.json(DEFAULT_POINTS)}) on conflict (tenant_id, name) do nothing`;
  const [s] = await tx<{ id: string }[]>`select id from rating_scales where name = ${SCALE_NAME}`;
  await tx`insert into performance_settings (tenant_id, rating_scale_id, bands, ideal_distribution)
           values (${tenantId}, ${s.id}, ${tx.json(DEFAULT_BANDS)}, ${tx.json(DEFAULT_DISTRIBUTION)}) on conflict (tenant_id) do nothing`;
  const core = [
    { kind: "core_value", name: "Ownership", description: "Takes responsibility for outcomes and follows through." },
    { kind: "core_value", name: "Customer first", description: "Starts from what the customer needs." },
    { kind: "core_value", name: "Candour", description: "Says what needs saying, kindly and early." },
    { kind: "competency", name: "Communication", description: "Explains clearly in writing and in person." },
    { kind: "competency", name: "Problem solving", description: "Breaks problems down and finds workable answers." },
    { kind: "competency", name: "Collaboration", description: "Works well across teams and shares credit." },
  ];
  for (const c of core) await tx`insert into competencies (tenant_id, kind, name, description) values (${tenantId}, ${c.kind}, ${c.name}, ${c.description}) on conflict do nothing`;
}

export async function getSettings(tx: Tx): Promise<PerfSettings> {
  const [r] = await tx<{ goal_mode: "okr" | "kra"; rating_scale_id: string | null; points: ScalePoint[] | null; bands: Band[]; ideal_distribution: { label: string; pct: number }[]; rounding: Rounding; reviewer_weights: Record<ReviewerType, number>; checkin_reminder: PerfSettings["checkinReminder"]; kr_weights_must_total: boolean }[]>`
    select s.goal_mode, s.rating_scale_id, rs.points, s.bands, s.ideal_distribution, s.rounding, s.reviewer_weights, s.checkin_reminder, s.kr_weights_must_total
    from performance_settings s left join rating_scales rs on rs.id = s.rating_scale_id`;
  if (!r) return { goalMode: "okr", ratingScaleId: null, points: DEFAULT_POINTS, bands: DEFAULT_BANDS, idealDistribution: DEFAULT_DISTRIBUTION, rounding: "one_decimal", reviewerWeights: { self: 0, manager: 100, peer: 0, skip_level: 0 }, checkinReminder: "weekly", krWeightsMustTotal: true };
  return {
    goalMode: r.goal_mode, ratingScaleId: r.rating_scale_id, points: r.points?.length ? r.points : DEFAULT_POINTS, bands: r.bands, idealDistribution: r.ideal_distribution,
    rounding: r.rounding, reviewerWeights: { ...{ self: 0, manager: 0, peer: 0, skip_level: 0 }, ...r.reviewer_weights }, checkinReminder: r.checkin_reminder, krWeightsMustTotal: r.kr_weights_must_total,
  };
}

export async function ratingScales(tx: Tx) {
  return tx<{ id: string; name: string; points: ScalePoint[] }[]>`select id, name, points from rating_scales where usage in ('performance','any') order by name`;
}

const pointSchema = z.object({ value: z.number().min(0).max(10), label: z.string().trim().min(1, "Every point needs a label").max(40) });
export const settingsInput = z.object({
  goalMode: z.enum(["okr", "kra"]),
  ratingScaleId: z.uuid().nullable(),
  points: z.array(pointSchema).min(2, "A scale needs at least two points").max(10).optional(),
  bands: z.array(z.object({ min: z.number(), max: z.number(), label: z.string().trim().min(1).max(40) })).max(10),
  idealDistribution: z.array(z.object({ label: z.string(), pct: z.number() })).max(10),
  rounding: z.enum(["none", "one_decimal", "half", "whole"]),
  reviewerWeights: z.object({ self: z.number().min(0).max(100), manager: z.number().min(0).max(100), peer: z.number().min(0).max(100), skip_level: z.number().min(0).max(100) }),
  checkinReminder: z.enum(["off", "weekly", "biweekly", "monthly"]),
  krWeightsMustTotal: z.boolean(),
});

/** Company performance settings. Points edit the chosen scale in place (only when no review has been submitted on it). */
export async function saveSettings(tx: Tx, actor: Actor, raw: unknown) {
  assertPerfAdmin(actor);
  const p = settingsInput.safeParse(raw);
  if (!p.success) throw new AppError("invalid", p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
  const v = p.data;
  await ensurePerformanceDefaults(tx, actor.tenant.id);
  let scaleId = v.ratingScaleId;
  if (!scaleId) scaleId = (await tx<{ id: string }[]>`select rating_scale_id as id from performance_settings`)[0].id;
  const [scale] = await tx<{ id: string; points: ScalePoint[] }[]>`select id, points from rating_scales where id = ${scaleId}`;
  if (!scale) throw new AppError("invalid", "Pick a rating scale.", "ratingScaleId");
  let points = scale.points;
  if (v.points && JSON.stringify(v.points) !== JSON.stringify(scale.points)) {
    const values = v.points.map((x) => x.value);
    if (new Set(values).size !== values.length) throw new AppError("invalid", "Two points on the scale have the same value.", "points");
    const [used] = await tx`select 1 from review_assignments a join review_cycles c on c.id = a.cycle_id join review_forms f on f.id = c.form_id
                            where a.status = 'submitted' and coalesce(f.rating_scale_id, ${scale.id}) = ${scale.id} limit 1`;
    if (used) throw new AppError("conflict", "Reviews have already been submitted on this scale, so its points can't change. Create a new scale instead.", "points");
    points = [...v.points].sort((a, b) => a.value - b.value);
    await tx`update rating_scales set points = ${tx.json(points)} where id = ${scale.id}`;
  }
  const bp = bandsProblem(v.bands, points);
  if (v.bands.length && bp) throw new AppError("invalid", bp, "bands");
  const dp = distributionProblem(v.idealDistribution, v.bands);
  if (dp) throw new AppError("invalid", dp, "idealDistribution");
  const w = v.reviewerWeights;
  if (w.self + w.manager + w.peer + w.skip_level !== 100) throw new AppError("invalid", "Reviewer weights need to add up to 100.", "reviewerWeights");
  await tx`update performance_settings set goal_mode = ${v.goalMode}, rating_scale_id = ${scale.id}, bands = ${tx.json(v.bands)}, ideal_distribution = ${tx.json(v.idealDistribution)},
           rounding = ${v.rounding}, reviewer_weights = ${tx.json(w)}, checkin_reminder = ${v.checkinReminder}, kr_weights_must_total = ${v.krWeightsMustTotal}`;
  await audit(tx, actor, { entityType: "performance_settings", entityId: actor.tenant.id, action: "update", diff: { ...v, points } });
}

// ------------------------------------------------------------------ skills & competencies library

export type CompetencyKind = "competency" | "core_value" | "skill";
export const KIND_LABEL: Record<CompetencyKind, string> = { competency: "Competency", core_value: "Core value", skill: "Skill" };
export type Competency = { id: string; kind: CompetencyKind; name: string; description: string | null; levels: { level: number; description: string }[] | null; people: number };

export async function listCompetencies(tx: Tx, kind?: CompetencyKind) {
  return tx<Competency[]>`
    select c.id, c.kind, c.name, c.description, c.levels, (select count(*)::int from employee_skills s where s.competency_id = c.id) as people
    from competencies c where (${kind ?? null}::text is null or c.kind = ${kind ?? null}) order by c.kind, lower(c.name)`;
}

const competencyInput = z.object({
  kind: z.enum(["competency", "core_value", "skill"]),
  name: z.string().trim().min(2, "Give it a name").max(80),
  description: z.string().trim().max(500).nullable().optional(),
  levels: z.array(z.object({ level: z.number().int().min(1).max(5), description: z.string().trim().min(1).max(200) })).max(5).nullable().optional(),
});
export async function saveCompetency(tx: Tx, actor: Actor, id: string | null, raw: unknown) {
  assertPerfAdmin(actor);
  const p = competencyInput.safeParse(raw);
  if (!p.success) throw new AppError("invalid", p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
  const v = p.data;
  const [dupe] = await tx`select 1 from competencies where kind = ${v.kind} and lower(name) = lower(${v.name}) and id is distinct from ${id}`;
  if (dupe) throw new AppError("conflict", `There's already a ${KIND_LABEL[v.kind].toLowerCase()} called ${v.name}.`, "name");
  let row: { id: string } | undefined;
  if (id) [row] = await tx<{ id: string }[]>`update competencies set kind = ${v.kind}, name = ${v.name}, description = ${v.description || null}, levels = ${v.levels?.length ? tx.json(v.levels) : null} where id = ${id} returning id`;
  else [row] = await tx<{ id: string }[]>`insert into competencies (tenant_id, kind, name, description, levels) values (${actor.tenant.id}, ${v.kind}, ${v.name}, ${v.description || null}, ${v.levels?.length ? tx.json(v.levels) : null}) returning id`;
  if (!row) throw new AppError("not_found", "That item no longer exists.");
  await audit(tx, actor, { entityType: "competency", entityId: row.id, action: id ? "update" : "create", diff: { name: v.name, kind: v.kind } });
  return row;
}
export async function deleteCompetency(tx: Tx, actor: Actor, id: string) {
  assertPerfAdmin(actor);
  const [used] = await tx`select 1 from review_forms f join review_cycles c on c.form_id = f.id and c.status in ('live','calibration')
                          where exists (select 1 from jsonb_array_elements(f.sections) s, jsonb_array_elements(s->'items') i where i->>'id' = ${id}) limit 1`;
  if (used) throw new AppError("conflict", "A review cycle that's running uses this. Remove it after the cycle closes.");
  const [r] = await tx<{ name: string }[]>`delete from competencies where id = ${id} returning name`;
  if (!r) throw new AppError("not_found", "That item no longer exists.");
  await audit(tx, actor, { entityType: "competency", entityId: id, action: "delete", diff: { name: r.name } });
}

// ------------------------------------------------------------------ employee skills

export async function skillsOf(tx: Tx, employeeId: string) {
  return tx<{ competency_id: string; name: string; kind: CompetencyKind; proficiency: number }[]>`
    select s.competency_id, c.name, c.kind, s.proficiency from employee_skills s join competencies c on c.id = s.competency_id
    where s.employee_id = ${employeeId} order by s.proficiency desc, c.name`;
}

/** People keep their own skills list (proficiency 1–5); only library skills can be added. */
export async function setMySkill(tx: Tx, actor: Actor, competencyId: string, proficiency: number | null) {
  const [c] = await tx<{ id: string; name: string }[]>`select id, name from competencies where id = ${competencyId} and kind = 'skill'`;
  if (!c) throw new AppError("invalid", "Pick a skill from the company's list.", "competencyId");
  if (proficiency == null) {
    await tx`delete from employee_skills where employee_id = ${actor.employeeId} and competency_id = ${c.id}`;
  } else {
    if (!Number.isInteger(proficiency) || proficiency < 1 || proficiency > 5) throw new AppError("invalid", "Rate yourself from 1 to 5.", "proficiency");
    await tx`insert into employee_skills (tenant_id, employee_id, competency_id, proficiency) values (${actor.tenant.id}, ${actor.employeeId}, ${c.id}, ${proficiency})
             on conflict (employee_id, competency_id) do update set proficiency = excluded.proficiency`;
  }
  await audit(tx, actor, { entityType: "employee_skill", entityId: c.id, action: proficiency == null ? "delete" : "set", diff: { employeeId: actor.employeeId, name: c.name, proficiency } });
}
