import "server-only";
import { z } from "zod";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor } from "@/server/auth/permissions";
import { audit } from "@/server/modules/audit/service";
import { cancelApproval, notifyEmployee, startApproval, type Level as ApprovalLevel } from "@/server/modules/approvals/service";
import { getActiveSalary, saveSalary } from "@/server/modules/payroll/salary";
import { addDaysISO } from "@/lib/dates";
import { assertCompAdmin, COMP, isCompAdmin, personRow } from "./access";
import { ratingsFor } from "./reviews";
import { bpInRange, budgetUse, matrixProblem, matrixRowFor, pctText, proposedCtc, suggestedBp, teamPool, type CompStatus, type MatrixRow } from "./rules";

const N = (v: unknown) => (v == null ? 0 : Number(v));
const bad = (p: z.ZodSafeParseError<unknown>) => new AppError("invalid", p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
const inr = (p: number) => `₹${Math.round(p / 100).toLocaleString("en-IN")}`;

type CycleRow = { id: string; name: string; review_cycle_id: string | null; effective_from: string; budget_paise: bigint | null; matrix: MatrixRow[]; status: CompStatus; applied_at: Date | null };
async function cycleRow(tx: Tx, id: string, lock = false) {
  const [c] = lock
    ? await tx<CycleRow[]>`select id, name, review_cycle_id, effective_from::text, budget_paise, matrix, status, applied_at from comp_cycles where id = ${id} for update`
    : await tx<CycleRow[]>`select id, name, review_cycle_id, effective_from::text, budget_paise, matrix, status, applied_at from comp_cycles where id = ${id}`;
  if (!c) throw new AppError("not_found", "Compensation cycle not found.");
  return c;
}

const matrixRow = z.object({ rating_min: z.number(), rating_max: z.number(), increment_pct_min: z.number(), increment_pct_max: z.number(), increment_pct_default: z.number().nullable().optional() });
export const compCycleInput = z.object({
  name: z.string().trim().min(3, "Name the cycle").max(80),
  reviewCycleId: z.uuid().nullable().optional(),
  effectiveFrom: z.iso.date("Pick when the new pay starts"),
  budgetPaise: z.number().int().min(0, "The budget can't be negative").max(1e15).nullable(),
  matrix: z.array(matrixRow).max(10),
});

async function check(tx: Tx, v: z.infer<typeof compCycleInput>) {
  const m = v.matrix.map((r) => ({ ...r, increment_pct_default: r.increment_pct_default ?? undefined }));
  const mp = matrixProblem(m);
  if (mp) throw new AppError("invalid", mp, "matrix");
  if (v.reviewCycleId) {
    const [rc] = await tx<{ status: string }[]>`select status from review_cycles where id = ${v.reviewCycleId}`;
    if (!rc) throw new AppError("invalid", "Pick a review cycle.", "reviewCycleId");
  }
  return m;
}

export async function createCompCycle(tx: Tx, actor: Actor, raw: unknown) {
  assertCompAdmin(actor);
  const p = compCycleInput.safeParse(raw);
  if (!p.success) throw bad(p);
  const m = await check(tx, p.data);
  const [dupe] = await tx`select 1 from comp_cycles where lower(name) = lower(${p.data.name})`;
  if (dupe) throw new AppError("conflict", `There's already a cycle called ${p.data.name}.`, "name");
  const [c] = await tx<{ id: string }[]>`
    insert into comp_cycles (tenant_id, name, review_cycle_id, effective_from, budget_paise, matrix, created_by)
    values (${actor.tenant.id}, ${p.data.name}, ${p.data.reviewCycleId ?? null}, ${p.data.effectiveFrom}, ${p.data.budgetPaise}, ${tx.json(m as never)}, ${actor.userId}) returning id`;
  await audit(tx, actor, { entityType: "comp_cycle", entityId: c.id, action: "create", diff: { name: p.data.name, budgetPaise: p.data.budgetPaise } });
  return c;
}

/** Budget and matrix can change until approvals start; the review cycle and date only while in draft. */
export async function updateCompCycle(tx: Tx, actor: Actor, id: string, raw: unknown) {
  assertCompAdmin(actor);
  const c = await cycleRow(tx, id, true);
  const p = compCycleInput.safeParse(raw);
  if (!p.success) throw bad(p);
  const m = await check(tx, p.data);
  if (c.status !== "draft" && c.status !== "recommending") throw new AppError("conflict", "This cycle is past recommendations and can't be edited.");
  if (c.status === "recommending" && (p.data.reviewCycleId ?? null) !== c.review_cycle_id) throw new AppError("conflict", "The review cycle can't change once managers are recommending.", "reviewCycleId");
  if (c.status === "recommending" && p.data.effectiveFrom !== c.effective_from) throw new AppError("conflict", "The effective date can't change once managers are recommending.", "effectiveFrom");
  const [dupe] = await tx`select 1 from comp_cycles where lower(name) = lower(${p.data.name}) and id <> ${id}`;
  if (dupe) throw new AppError("conflict", `There's already a cycle called ${p.data.name}.`, "name");
  await tx`update comp_cycles set name = ${p.data.name}, review_cycle_id = ${p.data.reviewCycleId ?? null}, effective_from = ${p.data.effectiveFrom}, budget_paise = ${p.data.budgetPaise}, matrix = ${tx.json(m as never)} where id = ${id}`;
  await audit(tx, actor, { entityType: "comp_cycle", entityId: id, action: "update", diff: { name: p.data.name, budgetPaise: p.data.budgetPaise } });
}

export async function deleteCompCycle(tx: Tx, actor: Actor, id: string) {
  assertCompAdmin(actor);
  const c = await cycleRow(tx, id, true);
  if (c.status !== "draft") throw new AppError("conflict", "Only draft cycles can be deleted.");
  await tx`delete from comp_cycles where id = ${id}`;
  await audit(tx, actor, { entityType: "comp_cycle", entityId: id, action: "delete", diff: { name: c.name } });
}

/**
 * Open recommendations: one proposal per active person with a salary, pre-filled from the rating → increment matrix.
 * Each person's manager recommends; people without a manager go to compensation admins. Safe to repeat (new joiners are added).
 */
export async function openRecommendations(tx: Tx, actor: Actor, id: string) {
  assertCompAdmin(actor);
  const c = await cycleRow(tx, id, true);
  if (c.status !== "draft" && c.status !== "recommending") throw new AppError("conflict", "Recommendations are already closed.");
  const ratings = c.review_cycle_id ? await ratingsFor(tx, c.review_cycle_id) : new Map<string, number | null>();
  const people = await tx<{ id: string; manager_id: string | null }[]>`select id, manager_id from employees where status = 'active' and joining_date < ${c.effective_from} order by display_name`;
  const asOf = addDaysISO(c.effective_from, -1);
  let added = 0;
  const managers = new Set<string>();
  for (const p of people) {
    const s = (await getActiveSalary(tx, p.id, asOf)) ?? null;
    if (!s) continue;
    const rating = ratings.get(p.id) ?? null;
    const bp = suggestedBp(matrixRowFor(rating, c.matrix));
    const [r] = await tx<{ id: string }[]>`
      insert into comp_proposals (tenant_id, cycle_id, employee_id, current_ctc_paise, proposed_ctc_paise, rating, increment_bp, recommended_by)
      values (${actor.tenant.id}, ${id}, ${p.id}, ${s.ctcPaise}, ${proposedCtc(s.ctcPaise, bp)}, ${rating}, ${bp}, ${p.manager_id})
      on conflict (cycle_id, employee_id) do nothing returning id`;
    if (r) { added++; if (p.manager_id) managers.add(p.manager_id); }
  }
  if (c.status === "draft") await tx`update comp_cycles set status = 'recommending' where id = ${id}`;
  for (const m of managers) await notifyEmployee(tx, actor.tenant.id, m, "comp.recommend", "Recommend increments for your team", `${c.name} is open for recommendations.`, `/compensation/${id}`);
  await audit(tx, actor, { entityType: "comp_cycle", entityId: id, action: "open", diff: { name: c.name, added } });
  return { added };
}

type ProposalRow = { id: string; cycle_id: string; employee_id: string; current_ctc_paise: bigint; proposed_ctc_paise: bigint; rating: string | null; increment_bp: number; recommended_by: string | null; status: "draft" | "submitted" | "approved" | "rejected" | "applied"; note: string | null };
async function proposalRow(tx: Tx, id: string) {
  const [p] = await tx<ProposalRow[]>`select id, cycle_id, employee_id, current_ctc_paise, proposed_ctc_paise, rating, increment_bp, recommended_by, status, note from comp_proposals where id = ${id} for update`;
  if (!p) throw new AppError("not_found", "Proposal not found.");
  return p;
}
/** Who may recommend for this person: the recommending manager, or a compensation admin covering them. Never for yourself. */
async function mayRecommend(tx: Tx, actor: Actor, p: ProposalRow) {
  if (p.employee_id === actor.employeeId) return false;
  if (p.recommended_by === actor.employeeId) return true;
  return canFor(actor, COMP, await personRow(tx, p.employee_id));
}

const recommendInput = z.object({ incrementBp: z.number().int().min(0).max(10_000), note: z.string().trim().max(1000).nullable().optional() });
export async function recommend(tx: Tx, actor: Actor, proposalId: string, raw: unknown) {
  const v = recommendInput.safeParse(raw);
  if (!v.success) throw bad(v);
  const p = await proposalRow(tx, proposalId);
  if (!(await mayRecommend(tx, actor, p))) throw new AppError("forbidden", p.employee_id === actor.employeeId ? "You can't recommend your own increment." : "You don't recommend increments for this person.");
  const c = await cycleRow(tx, p.cycle_id);
  if (c.status !== "recommending") throw new AppError("invalid", "This cycle isn't taking recommendations.");
  if (p.status !== "draft" && p.status !== "rejected") throw new AppError("conflict", "This recommendation was already sent for approval.");
  const row = matrixRowFor(p.rating == null ? null : Number(p.rating), c.matrix);
  const maxBp = Math.round(Math.max(0, ...c.matrix.map((r) => r.increment_pct_max)) * 100);
  const ok = p.rating == null ? v.data.incrementBp <= maxBp : bpInRange(v.data.incrementBp, row);
  if (!ok) throw new AppError("invalid", row ? `For a rating of ${Number(p.rating)} the increment must be between ${row.increment_pct_min}% and ${row.increment_pct_max}%.` : `The increment can be at most ${pctText(maxBp)}.`, "incrementBp");
  const proposed = proposedCtc(N(p.current_ctc_paise), v.data.incrementBp);
  await tx`update comp_proposals set increment_bp = ${v.data.incrementBp}, proposed_ctc_paise = ${proposed}, note = ${v.data.note || null}, status = 'draft' where id = ${proposalId}`;
  await audit(tx, actor, { entityType: "comp_proposal", entityId: proposalId, action: "recommend", diff: { employeeId: p.employee_id, incrementBp: v.data.incrementBp } });
  return { proposedPaise: proposed };
}

/** Approvers for a proposal: the recommender's manager, then a compensation admin; never the person or the recommender. */
async function approversFor(tx: Tx, employeeId: string, recommender: string) {
  const out: string[] = [];
  const [m] = await tx<{ manager_id: string | null }[]>`select manager_id from employees where id = ${recommender}`;
  if (m?.manager_id && m.manager_id !== employeeId && m.manager_id !== recommender) out.push(m.manager_id);
  const admins = await tx<{ id: string }[]>`
    select distinct ra.employee_id as id from role_assignments ra join roles r on r.id = ra.role_id join employees e on e.id = ra.employee_id and e.status <> 'relieved'
    where (${COMP} = any(r.permissions) or '*' = any(r.permissions)) and coalesce(jsonb_array_length(ra.scopes), 0) = 0
      and ra.employee_id not in (${employeeId}, ${recommender}) order by ra.employee_id`;
  const admin = admins.find((a) => !out.includes(a.id));
  if (admin) out.push(admin.id);
  return out;
}

/**
 * Send the actor's recommendations for approval. Each manager must stay within their share of the budget
 * (the pool split by their team's current pay); the whole cycle must stay within the total.
 */
export async function submitRecommendations(tx: Tx, actor: Actor, cycleId: string) {
  const c = await cycleRow(tx, cycleId);
  if (c.status !== "recommending") throw new AppError("invalid", "This cycle isn't taking recommendations.");
  const all = await tx<(ProposalRow & { name: string })[]>`
    select p.id, p.cycle_id, p.employee_id, p.current_ctc_paise, p.proposed_ctc_paise, p.rating, p.increment_bp, p.recommended_by, p.status, p.note, e.display_name as name
    from comp_proposals p join employees e on e.id = p.employee_id where p.cycle_id = ${cycleId} for update of p`;
  const admin = isCompAdmin(actor);
  const mine = all.filter((p) => p.employee_id !== actor.employeeId && (p.recommended_by === actor.employeeId || (admin && !p.recommended_by)));
  const toSend = mine.filter((p) => p.status === "draft" || p.status === "rejected");
  if (!toSend.length) throw new AppError("invalid", "There's nothing new to send.");
  if (c.budget_paise != null) {
    const total = all.reduce((s, p) => s + N(p.current_ctc_paise), 0);
    const pool = teamPool(N(c.budget_paise), mine.reduce((s, p) => s + N(p.current_ctc_paise), 0), total);
    const used = budgetUse(mine.map((p) => ({ current: N(p.current_ctc_paise), proposed: N(p.proposed_ctc_paise) })));
    if (used > pool) throw new AppError("invalid", `Your recommendations use ${inr(used)} a year, ${inr(used - pool)} more than your team's share of the budget (${inr(pool)}). Lower some increments first.`);
    const usedAll = budgetUse(all.filter((p) => p.status !== "rejected" || mine.includes(p)).map((p) => ({ current: N(p.current_ctc_paise), proposed: N(p.proposed_ctc_paise) })));
    if (usedAll > N(c.budget_paise)) throw new AppError("invalid", `Together the recommendations would go ${inr(usedAll - N(c.budget_paise))} over the cycle's budget.`);
  }
  let autoApproved = 0;
  for (const p of toSend) {
    await tx`delete from approval_requests where entity_type = 'comp_proposal' and entity_id = ${p.id} and status <> 'pending'`;   // a re-send after a rejection starts over
    await tx`update comp_proposals set status = 'submitted', recommended_by = coalesce(recommended_by, ${actor.employeeId}) where id = ${p.id}`;
    const levels: ApprovalLevel[] = (await approversFor(tx, p.employee_id, p.recommended_by ?? actor.employeeId)).map((id) => ({ approver: "employee", id }));
    const r = await startApproval(tx, { tenantId: actor.tenant.id, entityType: "comp_proposal", entityId: p.id, requesterId: actor.employeeId,
      summary: `${c.name}: ${pctText(p.increment_bp)} increment for ${p.name} (${inr(N(p.current_ctc_paise))} → ${inr(N(p.proposed_ctc_paise))} a year)`, levels });
    if (r.status === "approved") { await tx`update comp_proposals set status = 'approved' where id = ${p.id}`; autoApproved++; }
  }
  await audit(tx, actor, { entityType: "comp_cycle", entityId: cycleId, action: "submit", diff: { name: c.name, sent: toSend.length, autoApproved } });
  return { sent: toSend.length, autoApproved };
}

/** Approval engine hook: an approved / rejected proposal. */
export async function onCompProposalDecided(tx: Tx, actor: Actor, id: string, final: "approved" | "rejected") {
  const [p] = await tx<{ recommended_by: string | null; cycle_id: string; name: string }[]>`
    update comp_proposals p set status = ${final} from employees e where p.id = ${id} and p.status = 'submitted' and e.id = p.employee_id
    returning p.recommended_by, p.cycle_id, e.display_name as name`;
  if (p && final === "rejected" && p.recommended_by)
    await notifyEmployee(tx, actor.tenant.id, p.recommended_by, "comp.rejected", "An increment recommendation was declined", `Your recommendation for ${p.name} was declined. You can revise and send it again.`, `/compensation/${p.cycle_id}`);
}

/** Close recommendations (compensation admin). Unsent ones must be sent or are left out at 0%. */
export async function closeRecommendations(tx: Tx, actor: Actor, cycleId: string) {
  assertCompAdmin(actor);
  const c = await cycleRow(tx, cycleId, true);
  if (c.status !== "recommending") throw new AppError("conflict", "This cycle isn't taking recommendations.");
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from comp_proposals where cycle_id = ${cycleId} and status in ('draft','rejected') and increment_bp > 0`;
  if (n) throw new AppError("invalid", `${n} recommendation${n === 1 ? " hasn't" : "s haven't"} been sent for approval yet.`);
  await tx`update comp_cycles set status = 'approving' where id = ${cycleId}`;
  await audit(tx, actor, { entityType: "comp_cycle", entityId: cycleId, action: "close_recommendations", diff: { name: c.name } });
}

/** Everything decided → approved. */
export async function markApproved(tx: Tx, actor: Actor, cycleId: string) {
  assertCompAdmin(actor);
  const c = await cycleRow(tx, cycleId, true);
  if (c.status !== "approving") throw new AppError("conflict", "Close recommendations first.");
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from comp_proposals where cycle_id = ${cycleId} and status = 'submitted'`;
  if (n) throw new AppError("invalid", `${n} recommendation${n === 1 ? " is" : "s are"} still waiting for approval.`);
  await tx`update comp_cycles set status = 'approved' where id = ${cycleId}`;
  await audit(tx, actor, { entityType: "comp_cycle", entityId: cycleId, action: "approve", diff: { name: c.name } });
}

/**
 * Apply: each approved raise becomes an effective-dated salary revision through payroll (same structure, new CTC).
 * A date in an already-paid month is flagged for arrears. Rows that fail (e.g. your own salary) are reported and can be retried; repeating is safe.
 */
export async function applyCycle(tx: Tx, actor: Actor, cycleId: string) {
  assertCompAdmin(actor);
  const c = await cycleRow(tx, cycleId, true);
  if (c.status !== "approved" && c.status !== "applied") throw new AppError("conflict", "Approve the cycle before applying it.");
  const rows = await tx<{ id: string; employee_id: string; proposed_ctc_paise: bigint; increment_bp: number; name: string }[]>`
    select p.id, p.employee_id, p.proposed_ctc_paise, p.increment_bp, e.display_name as name from comp_proposals p join employees e on e.id = p.employee_id
    where p.cycle_id = ${cycleId} and p.status = 'approved' and p.increment_bp > 0 order by e.display_name`;
  let applied = 0, arrears = 0;
  const failed: { name: string; error: string }[] = [];
  for (const r of rows) {
    try {
      const res = await tx.savepoint(async (sp) => {
        const cur = await getActiveSalary(sp, r.employee_id, c.effective_from);
        if (!cur) throw new AppError("invalid", "They have no salary on the effective date.");
        return saveSalary(sp, actor, { employeeId: r.employee_id, structureId: cur.structureId, ctcPaise: N(r.proposed_ctc_paise), effectiveFrom: c.effective_from, reason: "revision" });
      });
      await tx`update comp_proposals set status = 'applied', salary_id = ${res.id}, arrears_from_month = ${res.arrearsFromMonth}, applied_at = now(), apply_error = null where id = ${r.id}`;
      applied++;
      if (res.arrearsFromMonth) arrears++;
    } catch (e) {
      const msg = e instanceof AppError ? e.message : "Couldn't save the revision.";
      await tx`update comp_proposals set apply_error = ${msg} where id = ${r.id}`;
      failed.push({ name: r.name, error: msg });
    }
  }
  // approved at 0% need no revision
  await tx`update comp_proposals set status = 'applied', applied_at = now() where cycle_id = ${cycleId} and status = 'approved' and increment_bp = 0`;
  const [{ left }] = await tx<{ left: number }[]>`select count(*)::int as left from comp_proposals where cycle_id = ${cycleId} and status = 'approved'`;
  if (!left) await tx`update comp_cycles set status = 'applied', applied_at = coalesce(applied_at, now()) where id = ${cycleId}`;
  await audit(tx, actor, { entityType: "comp_cycle", entityId: cycleId, action: "apply", diff: { name: c.name, applied, arrears, failed: failed.length } });
  return { applied, arrears, failed };
}

// ------------------------------------------------------------------ reading

export async function listCompCycles(tx: Tx, actor: Actor) {
  const admin = isCompAdmin(actor);
  const rows = await tx<{ id: string; name: string; effective_from: string; budget_paise: bigint | null; status: CompStatus; people: number; used: bigint; mine: number; review_cycle: string | null }[]>`
    select c.id, c.name, c.effective_from::text, c.budget_paise, c.status, r.name as review_cycle,
      (select count(*)::int from comp_proposals p where p.cycle_id = c.id) as people,
      (select coalesce(sum(p.proposed_ctc_paise - p.current_ctc_paise), 0) from comp_proposals p where p.cycle_id = c.id and p.status <> 'rejected') as used,
      (select count(*)::int from comp_proposals p where p.cycle_id = c.id and p.recommended_by = ${actor.employeeId} and p.employee_id <> ${actor.employeeId}) as mine
    from comp_cycles c left join review_cycles r on r.id = c.review_cycle_id order by c.created_at desc`;
  return rows.filter((r) => admin || (r.mine > 0 && r.status !== "draft")).map((r) => ({ ...r, budget_paise: r.budget_paise == null ? null : N(r.budget_paise), used: N(r.used) }));
}

/** One cycle: admins see everyone; a recommending manager sees only the people they recommend for. Nobody sees their own row here. */
export async function compCycleDetail(tx: Tx, actor: Actor, id: string) {
  const c = await cycleRow(tx, id).catch(() => null);
  if (!c) return null;
  const admin = isCompAdmin(actor);
  const rows = await tx<{ id: string; employee_id: string; name: string; department: string | null; designation: string | null; current: bigint; proposed: bigint; rating: string | null; increment_bp: number; status: ProposalRow["status"]; recommended_by: string | null; recommender: string | null; note: string | null; arrears_from_month: string | null; apply_error: string | null }[]>`
    select p.id, p.employee_id, e.display_name as name, d.name as department, g.title as designation, p.current_ctc_paise as current, p.proposed_ctc_paise as proposed, p.rating, p.increment_bp,
      p.status, p.recommended_by, r.display_name as recommender, p.note, p.arrears_from_month::text, p.apply_error
    from comp_proposals p join employees e on e.id = p.employee_id left join departments d on d.id = e.department_id left join designations g on g.id = e.designation_id
    left join employees r on r.id = p.recommended_by where p.cycle_id = ${id} order by e.display_name`;
  const visible = rows.filter((r) => r.employee_id !== actor.employeeId && (admin || r.recommended_by === actor.employeeId));
  if (!admin && !visible.length) return null;
  if (!admin && c.status === "draft") return null;
  const totalCurrent = rows.reduce((s, r) => s + N(r.current), 0);
  const mine = rows.filter((r) => r.recommended_by === actor.employeeId && r.employee_id !== actor.employeeId);
  const budget = c.budget_paise == null ? null : N(c.budget_paise);
  const used = budgetUse(rows.filter((r) => r.status !== "rejected").map((r) => ({ current: N(r.current), proposed: N(r.proposed) })));
  const teamCurrent = mine.reduce((s, r) => s + N(r.current), 0);
  const pool = budget == null ? null : teamPool(budget, teamCurrent, totalCurrent);
  const poolUsed = budgetUse(mine.map((r) => ({ current: N(r.current), proposed: N(r.proposed) })));
  const reviewCycles = admin ? await tx<{ id: string; name: string; status: string }[]>`select id, name, status from review_cycles where kind <> 'probation' and kind <> 'new_joiner' order by created_at desc` : [];
  return {
    cycle: { id: c.id, name: c.name, reviewCycleId: c.review_cycle_id, effectiveFrom: c.effective_from, budgetPaise: budget, matrix: c.matrix, status: c.status, appliedAt: c.applied_at?.toISOString() ?? null },
    isAdmin: admin, totals: { currentPaise: totalCurrent, usedPaise: used, people: rows.length, pct: totalCurrent ? Math.round((used / totalCurrent) * 10_000) / 100 : 0 },
    team: { poolPaise: pool, usedPaise: poolUsed, people: mine.length },
    rows: visible.map((r) => ({
      ...r, current: N(r.current), proposed: N(r.proposed), rating: r.rating == null ? null : Number(r.rating),
      range: (() => { const m = matrixRowFor(r.rating == null ? null : Number(r.rating), c.matrix); return m ? [m.increment_pct_min, m.increment_pct_max] as [number, number] : null; })(),
      canEdit: c.status === "recommending" && (r.status === "draft" || r.status === "rejected") && (r.recommended_by === actor.employeeId || admin),
    })),
    reviewCycles,
  };
}

/** Inbox detail for an approver. */
export async function proposalDetail(tx: Tx, actor: Actor, id: string) {
  const [p] = await tx<{ id: string; name: string; cycle: string; effective_from: string; current: bigint; proposed: bigint; rating: string | null; increment_bp: number; note: string | null; recommender: string | null; employee_id: string; status: string }[]>`
    select p.id, e.display_name as name, c.name as cycle, c.effective_from::text, p.current_ctc_paise as current, p.proposed_ctc_paise as proposed, p.rating, p.increment_bp, p.note,
      r.display_name as recommender, p.employee_id, p.status
    from comp_proposals p join employees e on e.id = p.employee_id join comp_cycles c on c.id = p.cycle_id left join employees r on r.id = p.recommended_by where p.id = ${id}`;
  if (!p || p.employee_id === actor.employeeId) return null;
  const [step] = await tx`select 1 from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_type = 'comp_proposal' and r.entity_id = ${id} and s.approver_employee_id = ${actor.employeeId}`;
  if (!step && !isCompAdmin(actor)) return null;
  return { ...p, current: N(p.current), proposed: N(p.proposed), rating: p.rating == null ? null : Number(p.rating) };
}

/** Withdraw a sent recommendation (before anyone decides) to change it. */
export async function withdrawRecommendation(tx: Tx, actor: Actor, proposalId: string) {
  const p = await proposalRow(tx, proposalId);
  if (p.recommended_by !== actor.employeeId && !(await mayRecommend(tx, actor, p))) throw new AppError("forbidden", "You don't recommend increments for this person.");
  if (p.status !== "submitted") throw new AppError("conflict", "Only a recommendation waiting for approval can be withdrawn.");
  const [acted] = await tx`select 1 from approval_requests r join approval_steps s on s.request_id = r.id where r.entity_type = 'comp_proposal' and r.entity_id = ${proposalId} and s.status = 'approved'`;
  if (acted) throw new AppError("conflict", "Someone has already approved part of this. Ask them to decline it instead.");
  await cancelApproval(tx, "comp_proposal", proposalId);
  await tx`update comp_proposals set status = 'draft' where id = ${proposalId}`;
  await audit(tx, actor, { entityType: "comp_proposal", entityId: proposalId, action: "withdraw", diff: { employeeId: p.employee_id } });
}
