import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { assertExpenseAdmin } from "./access";
import { categoryProblem, type Category, type CategoryInput, type CategoryKind, type LimitPeriod } from "./rules";

export type AdvanceRules = { max_paise: number | null; receipts_due_days: number | null };
export type PolicyRow = {
  id: string; name: string; allow_future_dated: boolean; submission_deadline_days: number | null; advance: AdvanceRules;
  is_default: boolean; people: number; categories: (Category & { used: number })[];
};

const CATEGORY_COLS = "id, name, kind, limit_paise, limit_period, rate_per_km_paise, receipt_required_above_paise, gl_code";
type RawCategory = { id: string; name: string; kind: CategoryKind; limit_paise: bigint | null; limit_period: LimitPeriod | null; rate_per_km_paise: bigint | null; receipt_required_above_paise: bigint | null; gl_code: string | null };
const n = (v: bigint | number | null) => (v == null ? null : Number(v));
export const toCategory = (c: RawCategory): Category => ({ ...c, limit_paise: n(c.limit_paise), rate_per_km_paise: n(c.rate_per_km_paise), receipt_required_above_paise: n(c.receipt_required_above_paise) });
export const parseAdvanceRules = (raw: unknown): AdvanceRules => {
  const r = (raw ?? {}) as Record<string, unknown>;
  const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
  return { max_paise: int(r.max_paise), receipts_due_days: int(r.receipts_due_days) };
};

/** Default categories for a new company. Limits are company policy defaults, not statutory figures: admins change them freely. */
export const DEFAULT_CATEGORIES: (Omit<CategoryInput, "glCode"> & { glCode: string })[] = [
  { name: "Travel", kind: "travel", limitPaise: null, limitPeriod: null, ratePerKmPaise: null, receiptAbovePaise: 0, glCode: "6110" },
  { name: "Local conveyance", kind: "mileage", limitPaise: null, limitPeriod: null, ratePerKmPaise: 1000, receiptAbovePaise: null, glCode: "6120" },
  { name: "Meals", kind: "general", limitPaise: 150000, limitPeriod: "day", ratePerKmPaise: null, receiptAbovePaise: 50000, glCode: "6130" },
  { name: "Per diem", kind: "per_diem", limitPaise: 120000, limitPeriod: "day", ratePerKmPaise: null, receiptAbovePaise: null, glCode: "6140" },
  { name: "Internet and phone", kind: "general", limitPaise: 150000, limitPeriod: "month", ratePerKmPaise: null, receiptAbovePaise: 0, glCode: "6150" },
  { name: "Office supplies", kind: "general", limitPaise: 500000, limitPeriod: "claim", ratePerKmPaise: null, receiptAbovePaise: 20000, glCode: "6160" },
];

/** Standard policy with the default categories, and a Finance role for second-level approval and payouts. Idempotent. */
export async function ensureExpenseDefaults(tx: Tx, tenantId: string) {
  await tx`insert into roles (tenant_id, key, name, is_system, permissions) values (${tenantId}, 'finance', 'Finance', true, ${["expenses.approve", "expenses.payout"]})
           on conflict (tenant_id, key) do nothing`;
  const [{ n: count }] = await tx<{ n: number }[]>`select count(*)::int as n from expense_policies`;
  if (count) return;
  const [p] = await tx<{ id: string }[]>`
    insert into expense_policies (tenant_id, name, submission_deadline_days, advance_rules)
    values (${tenantId}, 'Standard', 60, ${tx.json({ max_paise: 5000000, receipts_due_days: 30 })}) returning id`;
  for (const c of DEFAULT_CATEGORIES) {
    await tx`insert into expense_categories (tenant_id, policy_id, name, kind, limit_paise, limit_period, rate_per_km_paise, receipt_required_above_paise, gl_code)
             values (${tenantId}, ${p.id}, ${c.name}, ${c.kind}, ${c.limitPaise}, ${c.limitPeriod}, ${c.ratePerKmPaise}, ${c.receiptAbovePaise}, ${c.glCode})`;
  }
}

/** The person's policy, or the company default (the oldest policy) when none is assigned. */
export async function policyIdFor(tx: Tx, employeeId: string): Promise<string | null> {
  const [r] = await tx<{ id: string | null }[]>`
    select coalesce((select p.id from employees e join expense_policies p on p.id = e.expense_policy_id where e.id = ${employeeId}),
                    (select id from expense_policies order by created_at, id limit 1)) as id`;
  return r?.id ?? null;
}

export async function policyFor(tx: Tx, employeeId: string) {
  const id = await policyIdFor(tx, employeeId);
  if (!id) return null;
  const [p] = await tx<{ id: string; name: string; allow_future_dated: boolean; submission_deadline_days: number | null; advance_rules: unknown }[]>`
    select id, name, allow_future_dated, submission_deadline_days, advance_rules from expense_policies where id = ${id}`;
  const cats = await tx<RawCategory[]>`select ${tx.unsafe(CATEGORY_COLS)} from expense_categories where policy_id = ${id} order by name`;
  return { id: p.id, name: p.name, allowFutureDated: p.allow_future_dated, submissionDeadlineDays: p.submission_deadline_days, advance: parseAdvanceRules(p.advance_rules), categories: cats.map(toCategory) };
}

export async function listPolicies(tx: Tx): Promise<PolicyRow[]> {
  const ps = await tx<{ id: string; name: string; allow_future_dated: boolean; submission_deadline_days: number | null; advance_rules: unknown; people: number }[]>`
    select p.id, p.name, p.allow_future_dated, p.submission_deadline_days, p.advance_rules,
      (select count(*)::int from employees e where e.status <> 'relieved' and (e.expense_policy_id = p.id or (e.expense_policy_id is null and p.id = (select id from expense_policies order by created_at, id limit 1)))) as people
    from expense_policies p order by p.created_at, p.id`;
  const cats = await tx<(RawCategory & { policy_id: string; used: number })[]>`
    select c.policy_id, ${tx.unsafe(CATEGORY_COLS.split(", ").map((k) => "c." + k).join(", "))}, (select count(*)::int from expenses x where x.category_id = c.id) as used
    from expense_categories c order by c.name`;
  return ps.map((p, i) => ({
    id: p.id, name: p.name, allow_future_dated: p.allow_future_dated, submission_deadline_days: p.submission_deadline_days, advance: parseAdvanceRules(p.advance_rules),
    is_default: i === 0, people: p.people, categories: cats.filter((c) => c.policy_id === p.id).map((c) => ({ ...toCategory(c), used: c.used })),
  }));
}

export type PolicyInput = { name: string; allowFutureDated: boolean; submissionDeadlineDays: number | null; advanceMaxPaise: number | null; advanceDueDays: number | null };

export async function savePolicy(tx: Tx, actor: Actor, id: string | null, input: PolicyInput) {
  assertExpenseAdmin(actor);
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new AppError("invalid", "Give the policy a name.", "name");
  const intOk = (v: number | null, max: number) => v == null || (Number.isInteger(v) && v >= 0 && v <= max);
  if (!intOk(input.submissionDeadlineDays, 3650)) throw new AppError("invalid", "Use whole days, up to 3650.", "submissionDeadlineDays");
  if (!intOk(input.advanceDueDays, 365)) throw new AppError("invalid", "Use whole days, up to 365.", "advanceDueDays");
  if (input.advanceMaxPaise != null && (!Number.isInteger(input.advanceMaxPaise) || input.advanceMaxPaise <= 0)) throw new AppError("invalid", "The advance limit must be more than zero.", "advanceMaxPaise");
  const [dup] = await tx<{ id: string }[]>`select id from expense_policies where lower(name) = lower(${name}) and id is distinct from ${id}`;
  if (dup) throw new AppError("conflict", "A policy with this name already exists.", "name");
  const advance = { max_paise: input.advanceMaxPaise, receipts_due_days: input.advanceDueDays };
  if (id) {
    const [r] = await tx<{ id: string }[]>`update expense_policies set name = ${name}, allow_future_dated = ${input.allowFutureDated}, submission_deadline_days = ${input.submissionDeadlineDays},
      advance_rules = ${tx.json(advance)} where id = ${id} returning id`;
    if (!r) throw new AppError("not_found", "Policy not found.");
    await audit(tx, actor, "expense_policy", r.id, "update", { name });
    return r;
  }
  const [r] = await tx<{ id: string }[]>`insert into expense_policies (tenant_id, name, allow_future_dated, submission_deadline_days, advance_rules)
    values (${actor.tenant.id}, ${name}, ${input.allowFutureDated}, ${input.submissionDeadlineDays}, ${tx.json(advance)}) returning id`;
  await audit(tx, actor, "expense_policy", r.id, "create", { name });
  return r;
}

export async function deletePolicy(tx: Tx, actor: Actor, id: string) {
  assertExpenseAdmin(actor);
  const [first] = await tx<{ id: string }[]>`select id from expense_policies order by created_at, id limit 1`;
  if (first?.id === id) throw new AppError("invalid", "This is the default policy, used for everyone without one. It can't be deleted.");
  const [{ used }] = await tx<{ used: number }[]>`select count(*)::int as used from expenses x join expense_categories c on c.id = x.category_id where c.policy_id = ${id}`;
  if (used) throw new AppError("invalid", "Expenses were claimed under this policy, so it's kept for the record. Move people to another policy instead.");
  await tx`update employees set expense_policy_id = null where expense_policy_id = ${id}`;
  const r = await tx`delete from expense_policies where id = ${id}`;
  if (!r.count) throw new AppError("not_found", "Policy not found.");
  await audit(tx, actor, "expense_policy", id, "delete", {});
}

export async function assignPolicy(tx: Tx, actor: Actor, policyId: string, employeeIds: string[]) {
  assertExpenseAdmin(actor);
  const [p] = await tx<{ id: string }[]>`select id from expense_policies where id = ${policyId}`;
  if (!p) throw new AppError("not_found", "Policy not found.");
  const r = await tx`update employees set expense_policy_id = ${policyId} where id = any(${employeeIds}::uuid[]) and status <> 'relieved'`;
  await audit(tx, actor, "expense_policy", policyId, "assign", { employees: employeeIds.length });
  return { updated: r.count };
}

export async function saveCategory(tx: Tx, actor: Actor, policyId: string, id: string | null, input: CategoryInput) {
  assertExpenseAdmin(actor);
  const c: CategoryInput = {
    ...input, name: input.name.trim().slice(0, 80), glCode: input.glCode?.trim() || null,
    // fields that don't apply to the kind are dropped, so a category never carries a stale rate
    ratePerKmPaise: input.kind === "mileage" ? input.ratePerKmPaise : null,
    limitPeriod: input.limitPaise == null ? null : input.limitPeriod,
  };
  const problem = categoryProblem(c);
  if (problem) throw new AppError("invalid", problem.message, problem.field);
  const [p] = await tx<{ id: string }[]>`select id from expense_policies where id = ${policyId}`;
  if (!p) throw new AppError("not_found", "Policy not found.");
  const [dup] = await tx<{ id: string }[]>`select id from expense_categories where policy_id = ${policyId} and lower(name) = lower(${c.name}) and id is distinct from ${id}`;
  if (dup) throw new AppError("conflict", "This policy already has a category with this name.", "name");
  if (id) {
    const [cur] = await tx<{ kind: string; used: number }[]>`select kind, (select count(*)::int from expenses where category_id = ${id}) as used from expense_categories where id = ${id} and policy_id = ${policyId}`;
    if (!cur) throw new AppError("not_found", "Category not found.");
    if (cur.used && cur.kind !== c.kind) throw new AppError("invalid", "Expenses already use this category, so its type can't change. Add a new category instead.", "kind");
    await tx`update expense_categories set name = ${c.name}, kind = ${c.kind}, limit_paise = ${c.limitPaise}, limit_period = ${c.limitPeriod}, rate_per_km_paise = ${c.ratePerKmPaise},
             receipt_required_above_paise = ${c.receiptAbovePaise}, gl_code = ${c.glCode} where id = ${id}`;
    await audit(tx, actor, "expense_category", id, "update", { name: c.name });
    return { id };
  }
  const [r] = await tx<{ id: string }[]>`
    insert into expense_categories (tenant_id, policy_id, name, kind, limit_paise, limit_period, rate_per_km_paise, receipt_required_above_paise, gl_code)
    values (${actor.tenant.id}, ${policyId}, ${c.name}, ${c.kind}, ${c.limitPaise}, ${c.limitPeriod}, ${c.ratePerKmPaise}, ${c.receiptAbovePaise}, ${c.glCode}) returning id`;
  await audit(tx, actor, "expense_category", r.id, "create", { name: c.name });
  return r;
}

export async function deleteCategory(tx: Tx, actor: Actor, id: string) {
  assertExpenseAdmin(actor);
  const [{ used }] = await tx<{ used: number }[]>`select count(*)::int as used from expenses where category_id = ${id}`;
  if (used) throw new AppError("invalid", "Expenses already use this category, so it's kept for the record.");
  const r = await tx`delete from expense_categories where id = ${id}`;
  if (!r.count) throw new AppError("not_found", "Category not found.");
  await audit(tx, actor, "expense_category", id, "delete", {});
}

export async function audit(tx: Tx, actor: Actor | null, entity: string, id: string, action: string, diff: Record<string, unknown>) {
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff)
           values (app_tenant(), ${actor?.userId ?? null}, ${entity}, ${id}, ${action}, ${tx.json(diff as never)})`;
}
