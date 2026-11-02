/** Pure performance + compensation rules: progress roll-up, ratings, bands, calibration curves, 9-box, increments. */

export type Level = "company" | "department" | "individual";
export type GoalStatus = "not_started" | "on_track" | "at_risk" | "behind" | "completed" | "closed";
export type Metric = "percent" | "number" | "currency" | "boolean";
export const LEVELS: Level[] = ["company", "department", "individual"];
export const GOAL_STATUS_LABEL: Record<GoalStatus, string> = {
  not_started: "Not started", on_track: "On track", at_risk: "At risk", behind: "Behind", completed: "Completed", closed: "Closed",
};
export const LEVEL_LABEL: Record<Level, string> = { company: "Company", department: "Department", individual: "Individual" };

const r2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));

/** How far a key result has moved from its start towards its target, 0–100. Works for decreasing targets too. */
export function krProgress(kr: { metric: Metric; start: number; target: number; current: number }) {
  if (kr.metric === "boolean") return kr.current >= 1 ? 100 : 0;
  const span = kr.target - kr.start;
  if (span === 0) return kr.current === kr.target ? 100 : 0;
  return r2(clamp(((kr.current - kr.start) / span) * 100));
}

/** Weighted average of progress values; equal weights when no weights are set. */
export function weightedProgress(items: { progress: number; weight: number }[]) {
  if (!items.length) return 0;
  const w = items.reduce((s, i) => s + Math.max(0, i.weight), 0);
  if (w <= 0) return r2(items.reduce((s, i) => s + i.progress, 0) / items.length);
  return r2(items.reduce((s, i) => s + i.progress * Math.max(0, i.weight), 0) / w);
}

/**
 * An objective's progress: from its key results when it has any, else from the objectives aligned under it,
 * else from the last progress someone checked in.
 */
export function objectiveProgress(o: { krs: { progress: number; weight: number }[]; children: { progress: number; weight: number }[]; checkedIn: number | null }) {
  if (o.krs.length) return weightedProgress(o.krs);
  if (o.children.length) return weightedProgress(o.children);
  return r2(clamp(o.checkedIn ?? 0));
}

const RANK: Record<Level, number> = { company: 0, department: 1, individual: 2 };
/** A goal may align to one at its own level or above (individual → department/company, department → company). */
export const canAlignTo = (level: Level, parentLevel: Level) => RANK[parentLevel] <= RANK[level];

/** True when making `parentId` the parent of `id` would create a loop. `parentOf` maps id → parent id. */
export function wouldCycle(id: string, parentId: string, parentOf: Map<string, string | null>) {
  let cur: string | null | undefined = parentId;
  for (let guard = 0; cur && guard < 10_000; guard++) {
    if (cur === id) return true;
    cur = parentOf.get(cur) ?? null;
  }
  return false;
}

/** Ids on the path from a node up to the root (excluding the node itself), nearest first. */
export function ancestors(id: string, parentOf: Map<string, string | null>) {
  const out: string[] = [];
  let cur = parentOf.get(id) ?? null;
  while (cur && !out.includes(cur) && out.length < 1000) { out.push(cur); cur = parentOf.get(cur) ?? null; }
  return out;
}

/** Key-result weights must add up to 100 when the company asks for it (all-zero means "equal"). */
export function krWeightsProblem(weights: number[], mustTotal: boolean) {
  if (weights.some((w) => w < 0 || w > 100)) return "Each weight must be between 0 and 100.";
  const sum = weights.reduce((s, w) => s + w, 0);
  if (mustTotal && weights.length && sum !== 0 && Math.abs(sum - 100) > 0.001) return `Key result weights add up to ${r2(sum)}; they need to add up to 100.`;
  return null;
}

export type Insight = { total: number; byStatus: Record<GoalStatus, number>; overdue: number; stagnant: number; avgProgress: number };
/** Manager view of goals: status mix, past due date and not done, no check-in for `stagnantDays`. */
export function goalInsights(goals: { status: GoalStatus; progress: number; due_date: string | null; last_check_in: string | null; created_on: string }[], today: string, stagnantDays = 14): Insight {
  const byStatus = { not_started: 0, on_track: 0, at_risk: 0, behind: 0, completed: 0, closed: 0 } as Record<GoalStatus, number>;
  let overdue = 0, stagnant = 0;
  const cutoff = addDays(today, -stagnantDays);
  for (const g of goals) {
    byStatus[g.status]++;
    const open = g.status !== "completed" && g.status !== "closed";
    if (open && g.due_date && g.due_date < today && g.progress < 100) overdue++;
    if (open && (g.last_check_in ?? g.created_on) < cutoff) stagnant++;
  }
  const avg = goals.length ? r2(goals.reduce((s, g) => s + g.progress, 0) / goals.length) : 0;
  return { total: goals.length, byStatus, overdue, stagnant, avgProgress: avg };
}

function addDays(iso: string, n: number) { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

// ------------------------------------------------------------------ ratings

export type ScalePoint = { value: number; label: string };
export type Band = { min: number; max: number; label: string };
export type Rounding = "none" | "one_decimal" | "half" | "whole";
export type ReviewerType = "self" | "manager" | "peer" | "skip_level";
export const REVIEWER_LABEL: Record<ReviewerType | "direct_report", string> = { self: "Self", manager: "Manager", peer: "Peer", skip_level: "Skip-level manager", direct_report: "Direct report" };

export function roundRating(v: number, mode: Rounding) {
  if (mode === "whole") return Math.round(v);
  if (mode === "half") return Math.round(v * 2) / 2;
  if (mode === "one_decimal") return Math.round(v * 10) / 10;
  return r2(v);
}

export const scaleRange = (points: ScalePoint[]) => ({ min: Math.min(...points.map((p) => p.value)), max: Math.max(...points.map((p) => p.value)) });

/** The band a rating falls in (inclusive ranges; the first match wins), or null. */
export function bandFor(rating: number | null, bands: Band[]) {
  if (rating == null) return null;
  return bands.find((b) => rating >= b.min && rating <= b.max)?.label ?? null;
}

/** Bands must sit inside the scale, not overlap, and have names. Distribution must add up to 100 and name real bands. */
export function bandsProblem(bands: Band[], points: ScalePoint[]) {
  if (!points.length) return "Pick a rating scale first.";
  const { min, max } = scaleRange(points);
  const sorted = [...bands].sort((a, b) => a.min - b.min);
  const names = new Set<string>();
  for (const [i, b] of sorted.entries()) {
    if (!b.label.trim()) return "Every band needs a name.";
    if (names.has(b.label.trim().toLowerCase())) return `Two bands are called ${b.label}.`;
    names.add(b.label.trim().toLowerCase());
    if (b.min > b.max) return `${b.label}: the lower end is above the upper end.`;
    if (b.min < min || b.max > max) return `${b.label} goes outside the rating scale (${min}–${max}).`;
    if (i > 0 && b.min <= sorted[i - 1].max) return `${b.label} overlaps ${sorted[i - 1].label}.`;
  }
  return null;
}
export function distributionProblem(dist: { label: string; pct: number }[], bands: Band[]) {
  if (!dist.length) return null;
  const labels = new Set(bands.map((b) => b.label));
  for (const d of dist) {
    if (!labels.has(d.label)) return `${d.label} isn't one of the bands.`;
    if (d.pct < 0 || d.pct > 100) return "Each share must be between 0 and 100.";
  }
  const sum = dist.reduce((s, d) => s + d.pct, 0);
  if (Math.abs(sum - 100) > 0.001) return `The ideal shares add up to ${r2(sum)}%; they need to add up to 100%.`;
  return null;
}

// review forms
export type SectionType = "questions" | "goals" | "competencies" | "core_values" | "skills";
export const SECTION_LABEL: Record<SectionType, string> = { questions: "Questions", goals: "Goals", competencies: "Competencies", core_values: "Core values", skills: "Skills" };
export type FormItem = { id: string; text: string; rated: boolean; required?: boolean };
export type Section = { id: string; type: SectionType; title: string; weight: number; items: FormItem[] };
export type Answer = { rating?: number | null; comment?: string | null };
export type Answers = Record<string, Answer>;   // key = `${sectionId}:${itemId}`

export function formProblem(sections: Section[]) {
  if (!sections.length) return "Add at least one section.";
  const sum = sections.reduce((s, x) => s + x.weight, 0);
  if (sections.some((s) => s.weight < 0 || s.weight > 100)) return "Section weights must be between 0 and 100.";
  if (sum !== 0 && Math.abs(sum - 100) > 0.001) return `Section weights add up to ${r2(sum)}; they need to add up to 100 (or leave them all at 0 for equal weight).`;
  for (const s of sections) {
    if (!s.title.trim()) return "Every section needs a title.";
    if (s.type === "questions" && !s.items.length) return `${s.title} has no questions.`;
    if (s.items.some((i) => !i.text.trim())) return `${s.title} has an empty item.`;
  }
  return null;
}

/** Items that still need an answer before a review can be submitted. */
export function missingAnswers(sections: Section[], answers: Answers) {
  const out: string[] = [];
  for (const s of sections) for (const i of s.items) {
    const a = answers[`${s.id}:${i.id}`];
    if (i.rated && (a?.rating == null)) out.push(`${s.title}: ${i.text}`);
    else if (!i.rated && i.required && !a?.comment?.trim()) out.push(`${s.title}: ${i.text}`);
  }
  return out;
}

/** Score of a filled form: each section is the average of its rated items, sections combined by weight (equal if none). */
export function formScore(sections: Section[], answers: Answers) {
  const parts: { progress: number; weight: number }[] = [];
  for (const s of sections) {
    const rs = s.items.filter((i) => i.rated).map((i) => answers[`${s.id}:${i.id}`]?.rating).filter((v): v is number => typeof v === "number");
    if (rs.length) parts.push({ progress: rs.reduce((a, b) => a + b, 0) / rs.length, weight: s.weight });
  }
  return parts.length ? weightedProgress(parts) : null;
}

/** Overall rating from each reviewer type's ratings, weighted by company settings; types with no submitted review drop out. */
export function combineRatings(byType: Partial<Record<ReviewerType, number[]>>, weights: Record<ReviewerType, number>) {
  const parts: { progress: number; weight: number }[] = [];
  for (const t of ["self", "manager", "peer", "skip_level"] as ReviewerType[]) {
    const v = byType[t];
    if (v?.length && (weights[t] ?? 0) > 0) parts.push({ progress: v.reduce((a, b) => a + b, 0) / v.length, weight: weights[t] });
  }
  if (parts.length) return weightedProgress(parts);
  // nobody with a weight reviewed: fall back to the manager, then everyone
  const fallback = byType.manager?.length ? byType.manager : Object.values(byType).flat();
  return fallback && fallback.length ? r2(fallback.reduce((a, b) => a + b, 0) / fallback.length) : null;
}

/** Share of people per band (for the bell curve). Ratings outside every band are counted as "Unbanded". */
export function distribution(ratings: (number | null)[], bands: Band[]) {
  const rated = ratings.filter((r): r is number => r != null);
  const counts = bands.map((b) => ({ label: b.label, count: rated.filter((r) => bandFor(r, [b])).length }));
  const banded = counts.reduce((s, c) => s + c.count, 0);
  const total = rated.length;
  return { total, unbanded: total - banded, bands: counts.map((c) => ({ ...c, pct: total ? r2((c.count / total) * 100) : 0 })) };
}

/** 9-box: performance third of the scale (1 low – 3 high) × potential (1–3). */
export function nineBox(rating: number | null, potential: number | null, points: ScalePoint[]) {
  if (rating == null || potential == null || !points.length) return null;
  const { min, max } = scaleRange(points);
  const third = (max - min) / 3;
  const perf = rating >= max - third ? 3 : rating >= min + third ? 2 : 1;
  return { perf, potential: Math.min(3, Math.max(1, Math.round(potential))) };
}
export const NINE_BOX_LABEL: Record<string, string> = {
  "1-1": "Talent risk", "2-1": "Effective", "3-1": "Trusted professional",
  "1-2": "Inconsistent", "2-2": "Core player", "3-2": "High performer",
  "1-3": "Rough diamond", "2-3": "Growth potential", "3-3": "Future leader",
};

// ------------------------------------------------------------------ cycles

export type Timelines = { self_due?: string | null; nominate_due?: string | null; peer_due?: string | null; manager_due?: string | null; calibration_due?: string | null; publish_on?: string | null };
export type Reviewers = { self: boolean; manager: boolean; skip_level: boolean; peer: { enabled: boolean; min: number; max: number; nominated_by: "employee" | "manager"; needs_approval: boolean } };
export type EmployeeFilter = { department_ids?: string[]; location_ids?: string[]; joined_before?: string | null; include_ids?: string[]; exclude_ids?: string[] };
export type CycleStatus = "draft" | "live" | "calibration" | "published" | "closed";
export const CYCLE_STATUS_LABEL: Record<CycleStatus, string> = { draft: "Draft", live: "Reviews open", calibration: "Calibrating", published: "Published", closed: "Closed" };
export const NEXT_STATUS: Partial<Record<CycleStatus, CycleStatus>> = { draft: "live", live: "calibration", calibration: "published", published: "closed" };

export function timelinesProblem(t: Timelines, periodStart: string, periodEnd: string) {
  if (periodEnd <= periodStart) return "The review period must end after it starts.";
  const order: (keyof Timelines)[] = ["nominate_due", "self_due", "peer_due", "manager_due", "calibration_due", "publish_on"];
  let prev: string | null = null, prevKey = "";
  for (const k of order) {
    const v = t[k];
    if (!v) continue;
    if (prev && v < prev) return `${STAGE_LABEL[k]} can't be before ${STAGE_LABEL[prevKey as keyof Timelines]}.`;
    prev = v; prevKey = k;
  }
  return null;
}
export const STAGE_LABEL: Record<keyof Timelines, string> = {
  nominate_due: "Peer nominations due", self_due: "Self reviews due", peer_due: "Peer reviews due", manager_due: "Manager reviews due", calibration_due: "Calibration due", publish_on: "Publish date",
};

export function reviewersProblem(r: Reviewers) {
  if (!r.self && !r.manager && !r.skip_level && !r.peer.enabled) return "Pick at least one kind of reviewer.";
  if (r.peer.enabled && (r.peer.min < 0 || r.peer.max < 1 || r.peer.min > r.peer.max || r.peer.max > 10)) return "Peers: the minimum must be no more than the maximum, and at most 10.";
  return null;
}

export function matchesFilter(e: { id: string; department_id: string | null; location_id: string | null; joining_date: string }, f: EmployeeFilter) {
  if (f.exclude_ids?.includes(e.id)) return false;
  if (f.include_ids?.includes(e.id)) return true;
  if (f.department_ids?.length && !f.department_ids.includes(e.department_id ?? "")) return false;
  if (f.location_ids?.length && !f.location_ids.includes(e.location_id ?? "")) return false;
  if (f.joined_before && e.joining_date > f.joined_before) return false;
  return true;
}

/** Automatic cycles: is the person due today (or overdue, within a 30-day catch-up window) for this rule? */
export function autoDue(rule: { trigger: "joining" | "probation_end"; days: number }, p: { joining_date: string; probation_end_date: string | null }, today: string) {
  const anchor = rule.trigger === "joining" ? p.joining_date : p.probation_end_date;
  if (!anchor) return false;
  const due = addDays(anchor, rule.trigger === "joining" ? rule.days : -rule.days);
  return due <= today && due >= addDays(today, -30);
}

// ------------------------------------------------------------------ 1:1s

export type Recurrence = "weekly" | "biweekly" | "monthly";
export function nextOccurrence(start: Date, recurrence: Recurrence) {
  const d = new Date(start.getTime());
  if (recurrence === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else if (recurrence === "biweekly") d.setUTCDate(d.getUTCDate() + 14);
  else {
    const day = d.getUTCDate();
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  }
  return d;
}

// ------------------------------------------------------------------ compensation

export type MatrixRow = { rating_min: number; rating_max: number; increment_pct_min: number; increment_pct_max: number; increment_pct_default?: number };
export type CompStatus = "draft" | "recommending" | "approving" | "approved" | "applied";
export const COMP_STATUS_LABEL: Record<CompStatus, string> = { draft: "Draft", recommending: "Managers recommending", approving: "In approval", approved: "Approved", applied: "Applied to payroll" };

export function matrixProblem(rows: MatrixRow[]) {
  const sorted = [...rows].sort((a, b) => a.rating_min - b.rating_min);
  for (const [i, r] of sorted.entries()) {
    if (r.rating_min > r.rating_max) return "A rating range starts above where it ends.";
    if (r.increment_pct_min < 0 || r.increment_pct_max > 100 || r.increment_pct_min > r.increment_pct_max) return "Increments must be between 0% and 100%, lowest first.";
    const def = r.increment_pct_default;
    if (def != null && (def < r.increment_pct_min || def > r.increment_pct_max)) return "The suggested increment must sit inside its range.";
    if (i > 0 && r.rating_min <= sorted[i - 1].rating_max) return "Two rating ranges overlap.";
  }
  return null;
}

export function matrixRowFor(rating: number | null, rows: MatrixRow[]) {
  if (rating == null) return null;
  return rows.find((r) => rating >= r.rating_min && rating <= r.rating_max) ?? null;
}
/** Suggested increment in basis points: the row's default, else the middle of its range. 0 when the rating has no row. */
export function suggestedBp(row: MatrixRow | null) {
  if (!row) return 0;
  const pct = row.increment_pct_default ?? (row.increment_pct_min + row.increment_pct_max) / 2;
  return Math.round(pct * 100);
}
export const bpInRange = (bp: number, row: MatrixRow | null) => (row ? bp >= Math.round(row.increment_pct_min * 100) && bp <= Math.round(row.increment_pct_max * 100) : bp === 0);
/** New CTC after a raise of `bp` basis points, rounded to whole rupees (in paise). */
export const proposedCtc = (currentPaise: number, bp: number) => Math.round((currentPaise * (10_000 + bp)) / 10_000 / 100) * 100;

/** A manager's share of the budget: the company pool split in proportion to the current pay of the people they recommend for. */
export function teamPool(budgetPaise: number, teamCurrentPaise: number, totalCurrentPaise: number) {
  if (totalCurrentPaise <= 0) return 0;
  return Math.floor((budgetPaise * teamCurrentPaise) / totalCurrentPaise);
}
export function budgetUse(rows: { current: number; proposed: number }[]) {
  return rows.reduce((s, r) => s + Math.max(0, r.proposed - r.current), 0);
}
export const pctText = (bp: number) => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : bp % 10 === 0 ? 1 : 2)}%`;

// ------------------------------------------------------------------ PIP

export type PipStatus = "active" | "extended" | "passed" | "failed" | "cancelled";
export const PIP_STATUS_LABEL: Record<PipStatus, string> = { active: "Active", extended: "Extended", passed: "Completed successfully", failed: "Not met", cancelled: "Cancelled" };
export const pipOpen = (s: PipStatus) => s === "active" || s === "extended";
export function pipTransition(from: PipStatus, to: PipStatus) {
  if (!pipOpen(from)) return false;
  return to === "extended" || to === "passed" || to === "failed" || to === "cancelled";
}
