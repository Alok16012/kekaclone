import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { cancelApproval, decide, notifyEmployee, startApproval, timeline, type Level } from "@/server/modules/approvals/service";
import { validateUpload } from "@/server/modules/documents/rules";
import { saveFile } from "@/server/storage";
import { markOpenRunStale } from "@/server/modules/payrun/stale";
import { addDaysISO, todayIn } from "@/lib/dates";
import { canFinanceFor, canPayFor, canReportFor, EXP_APPROVE, canAdminExpenses } from "./access";
import { audit, policyFor } from "./admin";
import { onExpenseAdvanceDecided, onExpenseClaimDecided } from "./effects";
import {
  checkLine, extOf, inr, isBlocking, isEditable, MAX_RECEIPTS, mileagePaise, monthLabel, perDiemPaise, RECEIPT_EXTS, RECEIPT_LABEL,
  schedulableMonth, summarize, violationText, type Category, type ClaimStatus, type Line,
} from "./rules";

const N = (v: bigint | number | string | null | undefined) => (v == null ? 0 : Number(v));
type Person = Placement & { id: string; display_name: string; manager_id: string | null; pay_group_id: string | null; status: string };

async function person(tx: Tx, id: string): Promise<Person> {
  const [p] = await tx<Person[]>`select id, display_name, manager_id, pay_group_id, status, department_id, location_id, legal_entity_id, business_unit_id from employees where id = ${id}`;
  if (!p) throw new AppError("not_found", "Person not found.");
  return p;
}

// ---------- receipts ----------
export type Upload = { name: string; bytes: Uint8Array };

async function saveReceipts(tx: Tx, actor: Actor, files: Upload[]) {
  const ids: string[] = [];
  for (const f of files) {
    if (!RECEIPT_EXTS.has(extOf(f.name))) throw new AppError("invalid", `Receipts must be ${RECEIPT_LABEL}.`, "receipts");
    const v = validateUpload({ name: f.name, size: f.bytes.byteLength, head: f.bytes.subarray(0, 512) });
    if (!v.ok) throw new AppError("invalid", v.error, "receipts");
    ids.push(await saveFile(tx, { tenantId: actor.tenant.id, userId: actor.userId, name: v.name, mime: v.mime, bytes: f.bytes, ext: extOf(v.name) }));
  }
  return ids;
}

/** Deletes file rows no expense refers to any more; returns their storage keys so the caller removes the bytes after commit. */
async function dropFiles(tx: Tx, ids: string[]) {
  if (!ids.length) return [];
  const rows = await tx<{ storage_key: string }[]>`
    delete from files f where f.id = any(${ids}::uuid[]) and not exists (select 1 from expenses x where f.id = any(x.receipt_file_ids)) returning storage_key`;
  return rows.map((r) => r.storage_key);
}

// ---------- policy checks ----------
type RawLine = { id: string; category_id: string; claim_id: string | null; spent_on: string; amount_paise: bigint; receipts: number; merchant: string | null };
const toLine = (r: RawLine): Line => ({ id: r.id, categoryId: r.category_id, claimId: r.claim_id, spentOn: r.spent_on, amountPaise: N(r.amount_paise), receipts: r.receipts, merchant: r.merchant });

/**
 * Re-checks the person's editable lines (unclaimed or in a draft claim) against their policy, and stores the result.
 * Lines already submitted keep the flags they were sent with. Returns the flags per line id.
 */
async function recheck(tx: Tx, employeeId: string, onlyClaimId?: string) {
  const policy = await policyFor(tx, employeeId);
  if (!policy) return new Map<string, string[]>();
  const live = (await tx<(RawLine & { editable: boolean })[]>`
    select x.id, x.category_id, x.claim_id, x.spent_on::text, x.base_amount_paise as amount_paise, cardinality(x.receipt_file_ids) as receipts, x.merchant,
      (c.id is null or c.status = 'draft') as editable
    from expenses x left join expense_claims c on c.id = x.claim_id
    where x.employee_id = ${employeeId} and (c.id is null or c.status <> 'rejected')`);
  const lines = live.map(toLine);
  const cats = new Map(policy.categories.map((c) => [c.id, c]));
  const today = todayIn();
  const out = new Map<string, string[]>();
  for (const [i, l] of lines.entries()) {
    if (!live[i].editable) continue;
    if (onlyClaimId && l.claimId !== onlyClaimId) continue;
    const cat = cats.get(l.categoryId);
    const v = cat ? checkLine(l, cat, policy, today, lines) : [];
    out.set(l.id, v);
    await tx`update expenses set violations = ${v}::text[] where id = ${l.id} and violations is distinct from ${v}::text[]`;
  }
  return out;
}

async function refreshTotal(tx: Tx, claimId: string) {
  await tx`update expense_claims set total_paise = (select coalesce(sum(base_amount_paise), 0) from expenses where claim_id = ${claimId}) where id = ${claimId}`;
}

async function editableClaim(tx: Tx, actor: Actor, claimId: string) {
  const [c] = await tx<{ id: string; status: ClaimStatus; employee_id: string }[]>`select id, status, employee_id from expense_claims where id = ${claimId} for update`;
  if (!c || c.employee_id !== actor.employeeId) throw new AppError("not_found", "Claim not found.");
  if (!isEditable(c.status)) throw new AppError("invalid", "This claim was already sent. Withdraw it first to make changes.");
  return c;
}

// ---------- expenses ----------
export type ExpenseInput = {
  categoryId: string; spentOn: string; amountPaise: number | null; kmHundredths: number | null; halfDays: number | null;
  merchant: string | null; description: string | null; claimId?: string | null;
};

function amountFor(cat: Category, input: ExpenseInput) {
  if (cat.kind === "mileage") {
    if (!input.kmHundredths || input.kmHundredths <= 0) throw new AppError("invalid", "Enter the distance in km.", "distance");
    return { amount: mileagePaise(input.kmHundredths, cat.rate_per_km_paise ?? 0), km: input.kmHundredths, halfDays: null };
  }
  if (cat.kind === "per_diem") {
    if (!input.halfDays) throw new AppError("invalid", "Enter the number of days (half days are fine).", "days");
    return { amount: perDiemPaise(input.halfDays, cat.limit_paise ?? 0), km: null, halfDays: input.halfDays };
  }
  if (!input.amountPaise || input.amountPaise <= 0) throw new AppError("invalid", "Enter an amount above zero.", "amount");
  return { amount: input.amountPaise, km: null, halfDays: null };
}
const kmText = (h: number | null) => (h == null ? null : `${Math.floor(h / 100)}.${String(h % 100).padStart(2, "0")}`);

async function categoryFor(tx: Tx, employeeId: string, categoryId: string) {
  const policy = await policyFor(tx, employeeId);
  const cat = policy?.categories.find((c) => c.id === categoryId);
  if (!cat) throw new AppError("invalid", "Pick one of your expense categories.", "categoryId");
  return cat;
}

function checkDate(spentOn: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spentOn) || Number.isNaN(Date.parse(spentOn + "T00:00:00Z"))) throw new AppError("invalid", "Pick the date you spent it.", "spentOn");
  if (spentOn < addDaysISO(todayIn(), -3 * 366)) throw new AppError("invalid", "That date is too far back.", "spentOn");
}

export async function addExpense(tx: Tx, actor: Actor, input: ExpenseInput, files: Upload[] = []) {
  checkDate(input.spentOn);
  if (files.length > MAX_RECEIPTS) throw new AppError("invalid", `Attach up to ${MAX_RECEIPTS} receipts.`, "receipts");
  const cat = await categoryFor(tx, actor.employeeId, input.categoryId);
  const a = amountFor(cat, input);
  if (input.claimId) await editableClaim(tx, actor, input.claimId);
  const receipts = await saveReceipts(tx, actor, files);
  const [x] = await tx<{ id: string }[]>`
    insert into expenses (tenant_id, claim_id, employee_id, category_id, spent_on, amount_paise, base_amount_paise, merchant, description, distance_km, receipt_file_ids, custom)
    values (${actor.tenant.id}, ${input.claimId ?? null}, ${actor.employeeId}, ${cat.id}, ${input.spentOn}, ${a.amount}, ${a.amount},
      ${input.merchant?.trim().slice(0, 120) || null}, ${input.description?.trim().slice(0, 1000) || null}, ${kmText(a.km)}, ${receipts}::uuid[],
      ${tx.json(a.halfDays ? { half_days: a.halfDays } : {})}) returning id`;
  if (input.claimId) await refreshTotal(tx, input.claimId);
  const flags = await recheck(tx, actor.employeeId);
  return { id: x.id, amountPaise: a.amount, violations: flags.get(x.id) ?? [] };
}

async function ownEditableExpense(tx: Tx, actor: Actor, id: string) {
  const [x] = await tx<{ id: string; claim_id: string | null; receipt_file_ids: string[]; claim_status: ClaimStatus | null; employee_id: string }[]>`
    select x.id, x.claim_id, x.receipt_file_ids, c.status as claim_status, x.employee_id
    from expenses x left join expense_claims c on c.id = x.claim_id where x.id = ${id} for update of x`;
  if (!x || x.employee_id !== actor.employeeId) throw new AppError("not_found", "Expense not found.");
  if (x.claim_status && !isEditable(x.claim_status)) throw new AppError("invalid", "This expense is in a claim that was already sent.");
  return x;
}

export async function updateExpense(tx: Tx, actor: Actor, id: string, input: ExpenseInput, change: { add: Upload[]; remove: string[] }) {
  const x = await ownEditableExpense(tx, actor, id);
  checkDate(input.spentOn);
  const cat = await categoryFor(tx, actor.employeeId, input.categoryId);
  const a = amountFor(cat, input);
  const keep = x.receipt_file_ids.filter((f) => !change.remove.includes(f));
  if (keep.length + change.add.length > MAX_RECEIPTS) throw new AppError("invalid", `Attach up to ${MAX_RECEIPTS} receipts.`, "receipts");
  const added = await saveReceipts(tx, actor, change.add);
  await tx`update expenses set category_id = ${cat.id}, spent_on = ${input.spentOn}, amount_paise = ${a.amount}, base_amount_paise = ${a.amount},
           merchant = ${input.merchant?.trim().slice(0, 120) || null}, description = ${input.description?.trim().slice(0, 1000) || null},
           distance_km = ${kmText(a.km)}, receipt_file_ids = ${[...keep, ...added]}::uuid[], custom = ${tx.json(a.halfDays ? { half_days: a.halfDays } : {})}
           where id = ${id}`;
  const removedKeys = await dropFiles(tx, x.receipt_file_ids.filter((f) => !keep.includes(f)));
  if (x.claim_id) await refreshTotal(tx, x.claim_id);
  const flags = await recheck(tx, actor.employeeId);
  return { id, amountPaise: a.amount, violations: flags.get(id) ?? [], removedKeys };
}

export async function deleteExpense(tx: Tx, actor: Actor, id: string) {
  const x = await ownEditableExpense(tx, actor, id);
  await tx`delete from expenses where id = ${id}`;
  const removedKeys = await dropFiles(tx, x.receipt_file_ids);
  if (x.claim_id) await refreshTotal(tx, x.claim_id);
  await recheck(tx, actor.employeeId);
  return { removedKeys };
}

// ---------- claims ----------
async function nextNumber(tx: Tx, tenantId: string) {
  const [r] = await tx<{ value: bigint }[]>`
    insert into counters (tenant_id, key, value) values (${tenantId}, 'expense_claim', 1)
    on conflict (tenant_id, key) do update set value = counters.value + 1 returning value`;
  return N(r.value);
}

async function checkAdvance(tx: Tx, actor: Actor, advanceId: string | null | undefined, claimId: string | null) {
  if (!advanceId) return null;
  const [a] = await tx<{ id: string; status: string; amount_paise: bigint; settled_paise: bigint; employee_id: string }[]>`
    select id, status, amount_paise, settled_paise, employee_id from expense_advances where id = ${advanceId}`;
  if (!a || a.employee_id !== actor.employeeId) throw new AppError("invalid", "Pick one of your advances.", "advanceId");
  if (a.status !== "paid" || N(a.amount_paise) <= N(a.settled_paise)) throw new AppError("invalid", "Only an advance you've received and not yet settled can be used.", "advanceId");
  const [other] = await tx<{ number: bigint }[]>`select number from expense_claims where advance_id = ${advanceId} and status = 'submitted' and id is distinct from ${claimId}`;
  if (other) throw new AppError("invalid", `Claim #${other.number} is already settling this advance. Wait until it's decided.`, "advanceId");
  return a.id;
}

export async function createClaim(tx: Tx, actor: Actor, input: { title: string; expenseIds: string[]; advanceId?: string | null }) {
  const title = input.title.trim().slice(0, 140);
  if (!title) throw new AppError("invalid", "Give the claim a title, for example the trip or the month.", "title");
  const advanceId = await checkAdvance(tx, actor, input.advanceId, null);
  const number = await nextNumber(tx, actor.tenant.id);
  const [c] = await tx<{ id: string }[]>`
    insert into expense_claims (tenant_id, number, employee_id, title, advance_id) values (${actor.tenant.id}, ${number}, ${actor.employeeId}, ${title}, ${advanceId}) returning id`;
  if (input.expenseIds.length) {
    const r = await tx`update expenses set claim_id = ${c.id} where id = any(${input.expenseIds}::uuid[]) and employee_id = ${actor.employeeId} and claim_id is null`;
    if (r.count !== new Set(input.expenseIds).size) throw new AppError("conflict", "Some of these expenses are already in another claim. Refresh and try again.");
  }
  await refreshTotal(tx, c.id);
  await recheck(tx, actor.employeeId);
  return { id: c.id, number };
}

export async function updateClaim(tx: Tx, actor: Actor, claimId: string, input: { title: string; advanceId: string | null }) {
  await editableClaim(tx, actor, claimId);
  const title = input.title.trim().slice(0, 140);
  if (!title) throw new AppError("invalid", "Give the claim a title.", "title");
  const advanceId = await checkAdvance(tx, actor, input.advanceId, claimId);
  await tx`update expense_claims set title = ${title}, advance_id = ${advanceId} where id = ${claimId}`;
}

export async function moveExpenses(tx: Tx, actor: Actor, claimId: string, add: string[], remove: string[]) {
  await editableClaim(tx, actor, claimId);
  if (add.length) {
    const r = await tx`update expenses set claim_id = ${claimId} where id = any(${add}::uuid[]) and employee_id = ${actor.employeeId} and claim_id is null`;
    if (r.count !== new Set(add).size) throw new AppError("conflict", "Some of these expenses are already in another claim.");
  }
  if (remove.length) await tx`update expenses set claim_id = null where id = any(${remove}::uuid[]) and claim_id = ${claimId}`;
  await refreshTotal(tx, claimId);
  await recheck(tx, actor.employeeId);
}

/** Drafts only. Its expenses go back to "not in a claim" rather than being deleted. */
export async function deleteClaim(tx: Tx, actor: Actor, claimId: string) {
  await editableClaim(tx, actor, claimId);
  await tx`update expenses set claim_id = null where claim_id = ${claimId}`;
  await tx`delete from expense_claims where id = ${claimId}`;
  await recheck(tx, actor.employeeId);
}

/**
 * Approval chain: the tenant's own workflow if one is set up, otherwise the reporting manager and then a finance
 * reviewer whose scope covers the person (preferring someone other than the manager). Nobody is ever their own approver.
 */
export async function approvalLevels(tx: Tx, entityType: "expense_claim" | "expense_advance", who: Person): Promise<Level[] | undefined> {
  const [wf] = await tx<{ id: string }[]>`select id from approval_workflows where entity_type = ${entityType} and is_active limit 1`;
  if (wf) return undefined;
  const fin = await financeReviewer(tx, who);
  return [{ approver: "manager" }, fin ? { approver: "employee", id: fin } : { approver: "role", role: "global_admin" }];
}

async function financeReviewer(tx: Tx, who: Person) {
  const rows = await tx<{ employee_id: string; permissions: string[]; scopes: Actor["grants"][number]["scopes"] | null; key: string }[]>`
    select ra.employee_id, r.permissions, ra.scopes, r.key from role_assignments ra join roles r on r.id = ra.role_id
    join employees e on e.id = ra.employee_id and e.status <> 'relieved'
    where ra.employee_id <> ${who.id} and (r.permissions && ${[EXP_APPROVE, "*"]}::text[])
    order by (r.key = 'finance') desc, ('*' = any(r.permissions)), ra.created_at`;
  const ok = rows.filter((r) => canFor({ grants: [{ permissions: r.permissions, scopes: r.scopes ?? [] }] } as unknown as Actor, EXP_APPROVE, who)).map((r) => r.employee_id);
  return ok.find((id) => id !== who.manager_id) ?? ok[0] ?? null;
}

/**
 * The engine keeps one approval request per claim. When a withdrawn or declined claim is sent again, the earlier round is
 * copied into the audit log (who decided what, with comments) and removed, so the new round starts clean.
 */
async function clearPreviousRound(tx: Tx, actor: Actor, entityId: string) {
  const [old] = await tx<{ id: string; status: string }[]>`select id, status from approval_requests where entity_type = 'expense_claim' and entity_id = ${entityId} and status in ('cancelled','rejected')`;
  if (!old) return;
  const steps = await timeline(tx, "expense_claim", entityId);
  await audit(tx, actor, "expense_claim", entityId, "approval.previous_round", { status: old.status, steps: steps.map((s) => ({ level: s.level, approver: s.approver, status: s.status, comment: s.comment, at: s.acted_at })) });
  await tx`delete from approval_requests where id = ${old.id}`;
}

export async function submitClaim(tx: Tx, actor: Actor, claimId: string) {
  await editableClaim(tx, actor, claimId);
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from expenses where claim_id = ${claimId}`;
  if (!n) throw new AppError("invalid", "Add at least one expense to the claim first.");
  const flags = await recheck(tx, actor.employeeId, claimId);
  const blocking = [...flags.values()].flat().filter(isBlocking);
  if (blocking.length) {
    const msg = blocking.includes("receipt_missing") ? "Some expenses need a receipt before you can send this claim." : "Some expenses are dated in the future.";
    throw new AppError("invalid", msg);
  }
  await refreshTotal(tx, claimId);
  const [c] = await tx<{ id: string; number: bigint; title: string; total_paise: bigint; advance_id: string | null }[]>`
    update expense_claims set status = 'submitted', submitted_at = now() where id = ${claimId} and status = 'draft' returning id, number, title, total_paise, advance_id`;
  if (!c) throw new AppError("conflict", "This claim was already sent.");
  if (c.advance_id) await checkAdvance(tx, actor, c.advance_id, c.id);
  const who = await person(tx, actor.employeeId);
  await clearPreviousRound(tx, actor, c.id);
  const r = await startApproval(tx, {
    tenantId: actor.tenant.id, entityType: "expense_claim", entityId: c.id, requesterId: actor.employeeId,
    summary: `${actor.name} · Expense claim #${c.number} · ${inr(N(c.total_paise))} · ${c.title}`, levels: await approvalLevels(tx, "expense_claim", who),
  });
  if (r.status === "approved") await onExpenseClaimDecided(tx, actor, c.id, "approved");
  return { status: r.status === "approved" ? "approved" : "submitted" };
}

/** Back to draft while it's still being reviewed. */
export async function withdrawClaim(tx: Tx, actor: Actor, claimId: string) {
  const [c] = await tx<{ id: string }[]>`update expense_claims set status = 'draft', submitted_at = null where id = ${claimId} and employee_id = ${actor.employeeId} and status = 'submitted' returning id`;
  if (!c) throw new AppError("conflict", "Only a claim waiting for approval can be withdrawn.");
  await cancelApproval(tx, "expense_claim", claimId);
  await recheck(tx, actor.employeeId);
}

/** A declined claim can be reopened as a draft, fixed and sent again. */
export async function reopenClaim(tx: Tx, actor: Actor, claimId: string) {
  const [c] = await tx<{ id: string }[]>`update expense_claims set status = 'draft', submitted_at = null where id = ${claimId} and employee_id = ${actor.employeeId} and status = 'rejected' returning id`;
  if (!c) throw new AppError("conflict", "Only a declined claim can be reopened.");
  await recheck(tx, actor.employeeId);
}

// ---------- reading ----------
export type ExpenseRow = {
  id: string; claim_id: string | null; category_id: string; category: string; kind: string; gl_code: string | null; spent_on: string;
  amount_paise: number; merchant: string | null; description: string | null; km_h: number | null; half_days: number | null;
  receipts: { id: string; name: string; mime: string }[]; violations: string[]; violation_text: string[];
};

async function expenseRows(tx: Tx, where: { claimId?: string; unclaimedFor?: string }): Promise<ExpenseRow[]> {
  const rows = await tx<(Omit<ExpenseRow, "amount_paise" | "receipts" | "violation_text" | "half_days"> & { amount_paise: bigint; receipt_file_ids: string[]; custom: { half_days?: number }; limit_paise: bigint | null; receipt_required_above_paise: bigint | null; employee_id: string })[]>`
    select x.id, x.claim_id, x.category_id, c.name as category, c.kind, c.gl_code, x.spent_on::text, x.base_amount_paise as amount_paise, x.merchant, x.description,
      round(x.distance_km * 100)::int as km_h, x.receipt_file_ids, x.violations, x.custom, c.limit_paise, c.receipt_required_above_paise, x.employee_id
    from expenses x join expense_categories c on c.id = x.category_id
    where ${where.claimId ? tx`x.claim_id = ${where.claimId}` : tx`x.claim_id is null and x.employee_id = ${where.unclaimedFor!}`}
    order by x.spent_on, x.created_at`;
  const fileIds = rows.flatMap((r) => r.receipt_file_ids);
  const files = fileIds.length ? await tx<{ id: string; name: string; mime: string }[]>`select id, name, mime from files where id = any(${fileIds}::uuid[])` : [];
  const byId = new Map(files.map((f) => [f.id, f]));
  const policy = rows[0] ? await policyFor(tx, rows[0].employee_id) : null;
  const rules = policy ? { allowFutureDated: policy.allowFutureDated, submissionDeadlineDays: policy.submissionDeadlineDays } : null;
  return rows.map((r) => ({
    id: r.id, claim_id: r.claim_id, category_id: r.category_id, category: r.category, kind: r.kind, gl_code: r.gl_code, spent_on: r.spent_on,
    amount_paise: N(r.amount_paise), merchant: r.merchant, description: r.description, km_h: r.km_h, half_days: r.custom?.half_days ?? null,
    receipts: r.receipt_file_ids.map((id) => byId.get(id)).filter((f): f is { id: string; name: string; mime: string } => !!f),
    violations: r.violations,
    violation_text: r.violations.map((v) => violationText(v, { limit_paise: r.limit_paise == null ? null : N(r.limit_paise), receipt_required_above_paise: r.receipt_required_above_paise == null ? null : N(r.receipt_required_above_paise) }, rules)),
  }));
}

export type ClaimRow = {
  id: string; number: number; title: string; status: ClaimStatus; total_paise: number; advance_applied_paise: number; payable_paise: number;
  payout: string; payout_month: string | null; submitted_at: string | null; paid_at: string | null; payment_ref: string | null; items: number; flags: number; waiting_on: string | null;
  advance_id: string | null;
};
type RawClaim = Omit<ClaimRow, "number" | "total_paise" | "advance_applied_paise" | "payable_paise" | "submitted_at" | "paid_at"> & { number: bigint; total_paise: bigint; advance_applied_paise: bigint; submitted_at: Date | null; paid_at: Date | null };
const toClaim = (c: RawClaim): ClaimRow => ({
  ...c, number: N(c.number), total_paise: N(c.total_paise), advance_applied_paise: N(c.advance_applied_paise),
  payable_paise: N(c.total_paise) - N(c.advance_applied_paise), submitted_at: c.submitted_at?.toISOString() ?? null, paid_at: c.paid_at?.toISOString() ?? null,
});
const CLAIM_SELECT = (tx: Tx) => tx`
  select c.id, c.number, c.title, c.status, c.total_paise, c.advance_applied_paise, c.payout, c.payout_month::text, c.submitted_at, c.paid_at, c.payment_ref, c.advance_id,
    (select count(*)::int from expenses x where x.claim_id = c.id) as items,
    (select coalesce(sum(cardinality(x.violations)), 0)::int from expenses x where x.claim_id = c.id) as flags,
    (select e.display_name from approval_requests r join approval_steps s on s.request_id = r.id and s.status = 'pending' join employees e on e.id = s.approver_employee_id
      where r.entity_type = 'expense_claim' and r.entity_id = c.id and r.status = 'pending' limit 1) as waiting_on
  from expense_claims c`;

export async function myExpenses(tx: Tx, actor: Actor) {
  const [policy, unclaimed, claims, advances] = await Promise.all([
    policyFor(tx, actor.employeeId),
    expenseRows(tx, { unclaimedFor: actor.employeeId }),
    tx<RawClaim[]>`${CLAIM_SELECT(tx)} where c.employee_id = ${actor.employeeId} order by c.created_at desc`,
    myAdvances(tx, actor),
  ]);
  return { policy, unclaimed, claims: claims.map(toClaim), advances };
}

/**
 * Who may open a claim: the person, anyone in its approval chain, and finance / payout / report holders whose scope
 * covers the person. Everyone else gets "not found".
 */
async function claimAccess(tx: Tx, actor: Actor, claimId: string) {
  const [c] = await tx<{ id: string; employee_id: string }[]>`select id, employee_id from expense_claims where id = ${claimId}`;
  if (!c) return null;
  const who = await person(tx, c.employee_id);
  const own = c.employee_id === actor.employeeId;
  const [step] = await tx<{ id: string }[]>`
    select s.id from approval_requests r join approval_steps s on s.request_id = r.id
    where r.entity_type = 'expense_claim' and r.entity_id = ${claimId} and s.approver_employee_id = ${actor.employeeId} limit 1`;
  const finance = canFinanceFor(actor, who), pay = canPayFor(actor, who);
  if (!own && !step && !finance && !pay && !canReportFor(actor, who)) return null;
  return { who, own, approver: !!step, finance, pay };
}

export async function claimDetail(tx: Tx, actor: Actor, claimId: string) {
  const access = await claimAccess(tx, actor, claimId);
  if (!access) return null;
  const [raw] = await tx<RawClaim[]>`${CLAIM_SELECT(tx)} where c.id = ${claimId}`;
  const claim = toClaim(raw);
  const [items, steps, advance, pending] = await Promise.all([
    expenseRows(tx, { claimId }),
    timeline(tx, "expense_claim", claimId),
    claim.advance_id ? tx<{ id: string; purpose: string; amount_paise: bigint; settled_paise: bigint; status: string }[]>`select id, purpose, amount_paise, settled_paise, status from expense_advances where id = ${claim.advance_id}` : Promise.resolve([]),
    tx<{ id: string; approver_employee_id: string; level: number; max: number }[]>`
      select s.id, s.approver_employee_id, s.level, (select max(level) from approval_steps where request_id = r.id) as max
      from approval_requests r join approval_steps s on s.request_id = r.id and s.status = 'pending'
      where r.entity_type = 'expense_claim' and r.entity_id = ${claimId} and r.status = 'pending'`,
  ]);
  const p = pending[0];
  const canDecide = !!p && !access.own && (p.approver_employee_id === actor.employeeId || (access.finance && p.level === p.max));
  return {
    claim, items, employee: { id: access.who.id, name: access.who.display_name },
    advance: advance[0] ? { id: advance[0].id, purpose: advance[0].purpose, amount_paise: N(advance[0].amount_paise), outstanding_paise: N(advance[0].amount_paise) - N(advance[0].settled_paise), status: advance[0].status } : null,
    steps: steps.map((s) => ({ ...s, acted_at: s.acted_at?.toISOString() ?? null })),
    can: { edit: access.own && claim.status === "draft", decide: canDecide, pay: access.pay && claim.status === "approved" && claim.payable_paise > 0 },
    payoutLabel: claim.status === "paid" ? (claim.payment_ref ?? "Paid") : claim.payout_month ? `In ${monthLabel(claim.payout_month)} payroll` : null,
  };
}

// ---------- advances ----------
export type AdvanceRow = {
  id: string; employee_id: string; employee: string; amount_paise: number; settled_paise: number; outstanding_paise: number; purpose: string; status: string;
  receipts_due_on: string | null; overdue: boolean; created_at: string; paid_at: string | null; payment_ref: string | null; waiting_on: string | null;
};
const ADV_SELECT = (tx: Tx) => tx`
  select a.id, a.employee_id, e.display_name as employee, a.amount_paise, a.settled_paise, a.purpose, a.status, a.receipts_due_on::text, a.created_at, a.paid_at, a.payment_ref,
    (select x.display_name from approval_requests r join approval_steps s on s.request_id = r.id and s.status = 'pending' join employees x on x.id = s.approver_employee_id
      where r.entity_type = 'expense_advance' and r.entity_id = a.id and r.status = 'pending' limit 1) as waiting_on
  from expense_advances a join employees e on e.id = a.employee_id`;
type RawAdv = Omit<AdvanceRow, "amount_paise" | "settled_paise" | "outstanding_paise" | "overdue" | "created_at" | "paid_at"> & { amount_paise: bigint; settled_paise: bigint; created_at: Date; paid_at: Date | null };
const toAdv = (a: RawAdv, today: string): AdvanceRow => ({
  ...a, amount_paise: N(a.amount_paise), settled_paise: N(a.settled_paise), outstanding_paise: N(a.amount_paise) - N(a.settled_paise),
  overdue: a.status === "paid" && !!a.receipts_due_on && a.receipts_due_on < today, created_at: a.created_at.toISOString(), paid_at: a.paid_at?.toISOString() ?? null,
});

export async function myAdvances(tx: Tx, actor: Actor) {
  const today = todayIn();
  return (await tx<RawAdv[]>`${ADV_SELECT(tx)} where a.employee_id = ${actor.employeeId} order by a.created_at desc`).map((a) => toAdv(a, today));
}

export async function requestAdvance(tx: Tx, actor: Actor, input: { amountPaise: number; purpose: string }) {
  const purpose = input.purpose.trim().slice(0, 300);
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) throw new AppError("invalid", "Enter an amount above zero.", "amount");
  if (!purpose) throw new AppError("invalid", "Say what the advance is for.", "purpose");
  const policy = await policyFor(tx, actor.employeeId);
  if (policy?.advance.max_paise != null && input.amountPaise > policy.advance.max_paise) throw new AppError("invalid", `Your policy allows advances up to ${inr(policy.advance.max_paise)}.`, "amount");
  const [a] = await tx<{ id: string }[]>`insert into expense_advances (tenant_id, employee_id, amount_paise, purpose) values (${actor.tenant.id}, ${actor.employeeId}, ${input.amountPaise}, ${purpose}) returning id`;
  const who = await person(tx, actor.employeeId);
  const r = await startApproval(tx, {
    tenantId: actor.tenant.id, entityType: "expense_advance", entityId: a.id, requesterId: actor.employeeId,
    summary: `${actor.name} · Expense advance · ${inr(input.amountPaise)} · ${purpose}`, levels: await approvalLevels(tx, "expense_advance", who),
  });
  if (r.status === "approved") await onExpenseAdvanceDecided(tx, actor, a.id, "approved");
  return { id: a.id, status: r.status };
}

/** Withdraw an advance request nobody has decided yet. */
export async function cancelAdvance(tx: Tx, actor: Actor, id: string) {
  const r = await tx`delete from expense_advances where id = ${id} and employee_id = ${actor.employeeId} and status = 'pending'`;
  if (!r.count) throw new AppError("conflict", "Only a request waiting for approval can be withdrawn.");
  await cancelApproval(tx, "expense_advance", id);
}

async function lockedAdvance(tx: Tx, actor: Actor, id: string) {
  const [a] = await tx<{ id: string; employee_id: string; status: string; amount_paise: bigint; settled_paise: bigint }[]>`
    select id, employee_id, status, amount_paise, settled_paise from expense_advances where id = ${id} for update`;
  if (!a) throw new AppError("not_found", "Advance not found.");
  const who = await person(tx, a.employee_id);
  if (a.employee_id === actor.employeeId) throw new AppError("forbidden", "You can't pay out or settle your own advance.");
  if (!canPayFor(actor, who)) throw new AppError("forbidden", "You don't have access to pay out this person's expenses.");
  return { a, who };
}

export async function markAdvancePaid(tx: Tx, actor: Actor, id: string, reference: string | null) {
  const { a, who } = await lockedAdvance(tx, actor, id);
  if (a.status !== "approved") throw new AppError("conflict", a.status === "paid" || a.status === "settled" ? "This advance was already paid." : "Only an approved advance can be paid.");
  const policy = await policyFor(tx, a.employee_id);
  const due = addDaysISO(todayIn(), policy?.advance.receipts_due_days ?? 30);
  await tx`update expense_advances set status = 'paid', paid_at = now(), paid_by = ${actor.userId}, payment_ref = ${reference?.trim().slice(0, 120) || null}, receipts_due_on = ${due} where id = ${id}`;
  await audit(tx, actor, "expense_advance", id, "paid", { reference, amount_paise: N(a.amount_paise) });
  await notifyEmployee(tx, actor.tenant.id, who.id, "expense.advance_paid", "Your advance was paid", `${inr(N(a.amount_paise))}. Claim your expenses against it by ${due}.`, "/me/expenses/advances");
}

/** Closes a paid advance: whatever claims didn't cover was returned by the employee (recorded in the audit log). */
export async function closeAdvance(tx: Tx, actor: Actor, id: string, note: string | null) {
  const { a, who } = await lockedAdvance(tx, actor, id);
  if (a.status !== "paid") throw new AppError("conflict", "Only a paid advance that isn't settled yet can be closed.");
  const [open] = await tx<{ number: bigint }[]>`select number from expense_claims where advance_id = ${id} and status = 'submitted' limit 1`;
  if (open) throw new AppError("conflict", `Claim #${open.number} is still settling this advance. Wait until it's decided.`);
  const returned = N(a.amount_paise) - N(a.settled_paise);
  await tx`update expense_advances set status = 'settled', settled_paise = amount_paise where id = ${id}`;
  await tx`update expense_claims set advance_id = null where advance_id = ${id} and status = 'draft'`;
  await audit(tx, actor, "expense_advance", id, "closed", { returned_paise: returned, note: note?.slice(0, 500) ?? null });
  await notifyEmployee(tx, actor.tenant.id, who.id, "expense.advance_closed", "Your advance was settled", returned ? `${inr(returned)} recorded as returned.` : "Fully covered by your claims.", "/me/expenses/advances");
  return { returnedPaise: returned };
}

// ---------- approvals ----------
export type QueueItem = {
  entity_type: "expense_claim" | "expense_advance"; entity_id: string; employee: string; employee_id: string; title: string; number: number | null;
  amount_paise: number; flags: number; submitted_at: string; level: number; max_level: number; waiting_on: string; mine: boolean;
};

/**
 * Finance / manager queue: steps waiting for the actor, plus (for finance) everything at the final review step for people in
 * their scope that's waiting on someone else, which they may take over. Never the actor's own claims.
 */
export async function approvalQueue(tx: Tx, actor: Actor) {
  const rows = await tx<(Omit<QueueItem, "mine" | "amount_paise" | "number" | "submitted_at"> & Placement & { approver_id: string; amount_paise: bigint | null; number: bigint | null; submitted_at: Date })[]>`
    select r.entity_type, r.entity_id, e.display_name as employee, e.id as employee_id, e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id,
      coalesce(c.title, a.purpose) as title, c.number, coalesce(c.total_paise, a.amount_paise) as amount_paise,
      coalesce((select sum(cardinality(x.violations))::int from expenses x where x.claim_id = c.id), 0) as flags,
      r.created_at as submitted_at, s.level, (select max(level) from approval_steps where request_id = r.id) as max_level,
      ap.display_name as waiting_on, s.approver_employee_id as approver_id
    from approval_requests r join approval_steps s on s.request_id = r.id and s.status = 'pending'
    join employees e on e.id = r.requester_employee_id join employees ap on ap.id = s.approver_employee_id
    left join expense_claims c on r.entity_type = 'expense_claim' and c.id = r.entity_id
    left join expense_advances a on r.entity_type = 'expense_advance' and a.id = r.entity_id
    where r.status = 'pending' and r.entity_type in ('expense_claim','expense_advance') and r.requester_employee_id <> ${actor.employeeId}
    order by r.created_at`;
  return rows
    .filter((r) => r.approver_id === actor.employeeId || canFinanceFor(actor, { ...r, id: r.employee_id }))
    .map((r) => ({
      entity_type: r.entity_type, entity_id: r.entity_id, employee: r.employee, employee_id: r.employee_id, title: r.title, number: r.number == null ? null : N(r.number),
      amount_paise: N(r.amount_paise), flags: r.flags, submitted_at: r.submitted_at.toISOString(), level: r.level, max_level: r.max_level, waiting_on: r.waiting_on,
      mine: r.approver_id === actor.employeeId,
    }));
}

/**
 * Decide a claim or advance from the expense desk. The actor's own pending step is decided directly. Finance in scope may
 * take over the final review step from another reviewer (recorded in the audit log), but never for themselves and never
 * after already approving an earlier step of the same request.
 */
export async function financeDecide(tx: Tx, actor: Actor, entityType: "expense_claim" | "expense_advance", entityId: string, decision: "approved" | "rejected", comment?: string) {
  const [p] = await tx<{ step_id: string; approver: string; level: number; max: number; request_id: string; requester: string }[]>`
    select s.id as step_id, s.approver_employee_id as approver, s.level, (select max(level) from approval_steps where request_id = r.id) as max, r.id as request_id, r.requester_employee_id as requester
    from approval_requests r join approval_steps s on s.request_id = r.id and s.status = 'pending'
    where r.entity_type = ${entityType} and r.entity_id = ${entityId} and r.status = 'pending' for update of s`;
  if (!p) throw new AppError("conflict", "This request was already handled.");
  if (p.requester === actor.employeeId) throw new AppError("forbidden", "You can't approve your own expenses.");
  if (p.approver !== actor.employeeId) {
    const who = await person(tx, p.requester);
    if (!canFinanceFor(actor, who)) throw new AppError("forbidden", "This isn't waiting for you.");
    if (p.level !== p.max) throw new AppError("invalid", "It's still with the manager. Finance reviews it after them.");
    const [mine] = await tx<{ id: string }[]>`select id from approval_steps where request_id = ${p.request_id} and approver_employee_id = ${actor.employeeId} and status = 'approved'`;
    if (mine) throw new AppError("invalid", "You already approved an earlier step, so someone else needs to do the final review.");
    const moved = await tx`update approval_steps set approver_employee_id = ${actor.employeeId} where id = ${p.step_id} and status = 'pending'`;
    if (!moved.count) throw new AppError("conflict", "This request was already handled.");
    await audit(tx, actor, entityType, entityId, "approval.taken_over", { from: p.approver });
  }
  return decide(tx, actor, p.step_id, decision, comment);
}

export async function advanceDetail(tx: Tx, actor: Actor, id: string) {
  const today = todayIn();
  const [raw] = await tx<RawAdv[]>`${ADV_SELECT(tx)} where a.id = ${id}`;
  if (!raw) return null;
  const who = await person(tx, raw.employee_id);
  const own = raw.employee_id === actor.employeeId;
  const [step] = await tx<{ id: string }[]>`select s.id from approval_requests r join approval_steps s on s.request_id = r.id where r.entity_type = 'expense_advance' and r.entity_id = ${id} and s.approver_employee_id = ${actor.employeeId} limit 1`;
  if (!own && !step && !canFinanceFor(actor, who) && !canPayFor(actor, who) && !canReportFor(actor, who)) return null;
  const claims = await tx<{ id: string; number: bigint; title: string; status: string; advance_applied_paise: bigint }[]>`select id, number, title, status, advance_applied_paise from expense_claims where advance_id = ${id} order by number`;
  const steps = await timeline(tx, "expense_advance", id);
  return {
    advance: toAdv(raw, today), claims: claims.map((c) => ({ ...c, number: N(c.number), advance_applied_paise: N(c.advance_applied_paise) })),
    steps: steps.map((s) => ({ ...s, acted_at: s.acted_at?.toISOString() ?? null })),
  };
}

// ---------- payouts ----------
const LOCKED_RUN = ["finalized", "payslips_released", "paid"];

async function runLocked(tx: Tx, payGroupId: string, month: string) {
  const [r] = await tx<{ status: string }[]>`select status from payroll_runs where pay_group_id = ${payGroupId} and period_month = ${month} and status <> 'rolled_back' limit 1`;
  return !!r && LOCKED_RUN.includes(r.status);
}

async function lockedClaim(tx: Tx, actor: Actor, claimId: string) {
  const [c] = await tx<{ id: string; number: bigint; employee_id: string; status: ClaimStatus; total_paise: bigint; advance_applied_paise: bigint; payout_month: string | null }[]>`
    select id, number, employee_id, status, total_paise, advance_applied_paise, payout_month::text from expense_claims where id = ${claimId} for update`;
  if (!c) throw new AppError("not_found", "Claim not found.");
  if (c.employee_id === actor.employeeId) throw new AppError("forbidden", "You can't pay out your own claim.");
  const who = await person(tx, c.employee_id);
  if (!canPayFor(actor, who)) throw new AppError("forbidden", "You don't have access to pay out this person's expenses.");
  if (c.status === "paid") throw new AppError("conflict", "This claim is already paid.");
  if (c.status !== "approved") throw new AppError("invalid", "Only approved claims can be paid.");
  const payable = N(c.total_paise) - N(c.advance_applied_paise);
  if (payable <= 0) throw new AppError("invalid", "Nothing to pay: the advance covered this claim.");
  return { c, who, payable };
}

/** The claim's payroll input, if it was scheduled. */
async function scheduledInput(tx: Tx, claimId: string) {
  const [r] = await tx<{ id: string; pay_group_id: string; period_month: string; amount_paise: bigint }[]>`
    select id, pay_group_id, period_month::text, amount_paise from payroll_inputs where kind = 'expense' and source_ref->>'expense_claim_id' = ${claimId}`;
  return r ?? null;
}

/**
 * Pay an approved claim with a payroll month: writes one payroll_inputs row (kind 'expense', the payable amount after any
 * advance), which the payroll run adds to net pay as a reimbursement. Idempotent: scheduling the same month again does nothing,
 * a different month moves the row. A month whose payroll is finalised can't be used or changed.
 */
export async function scheduleExpensePayout(tx: Tx, actor: Actor, claimId: string, month: string) {
  const { c, who, payable } = await lockedClaim(tx, actor, claimId);
  const bad = schedulableMonth(month, todayIn());
  if (bad) throw new AppError("invalid", bad, "month");
  if (!who.pay_group_id) throw new AppError("invalid", `${who.display_name} isn't in a pay group yet, so this can't go through payroll. Pay it off-cycle instead.`);
  if (await runLocked(tx, who.pay_group_id, month)) throw new AppError("conflict", `Payroll for ${monthLabel(month)} is already finalised. Pick a later month.`, "month");
  const existing = await scheduledInput(tx, claimId);
  if (existing) {
    if (existing.period_month === month && existing.pay_group_id === who.pay_group_id && N(existing.amount_paise) === payable) return { inputId: existing.id, changed: false };
    if (await runLocked(tx, existing.pay_group_id, existing.period_month)) throw new AppError("conflict", `It's already in the finalised ${monthLabel(existing.period_month)} payroll.`);
    await tx`update payroll_inputs set pay_group_id = ${who.pay_group_id}, period_month = ${month}, amount_paise = ${payable}, created_by = ${actor.userId} where id = ${existing.id}`;
    await markOpenRunStale(tx, existing.pay_group_id, existing.period_month);
  }
  const [input] = existing ? [{ id: existing.id }] : await tx<{ id: string }[]>`
    insert into payroll_inputs (tenant_id, pay_group_id, period_month, employee_id, kind, amount_paise, source_ref, action, note, created_by)
    values (${actor.tenant.id}, ${who.pay_group_id}, ${month}, ${who.id}, 'expense', ${payable}, ${tx.json({ expense_claim_id: claimId, number: N(c.number) })}, 'pay',
            ${`Expense claim #${c.number}`}, ${actor.userId}) returning id`;
  await markOpenRunStale(tx, who.pay_group_id, month);   // an open run for that month must be recalculated to include it
  await tx`update expense_claims set payout = 'payroll', payout_month = ${month} where id = ${claimId}`;
  await audit(tx, actor, "expense_claim", claimId, "payout.scheduled", { month, amount_paise: payable });
  await notifyEmployee(tx, actor.tenant.id, who.id, "expense.scheduled", `Claim #${c.number} will be paid with your salary`, `${inr(payable)} in ${monthLabel(month)} payroll.`, "/me/expenses");
  return { inputId: input.id, changed: true };
}

export async function unscheduleExpensePayout(tx: Tx, actor: Actor, claimId: string) {
  await lockedClaim(tx, actor, claimId);
  const existing = await scheduledInput(tx, claimId);
  if (!existing) return { changed: false };
  if (await runLocked(tx, existing.pay_group_id, existing.period_month)) throw new AppError("conflict", `It's already in the finalised ${monthLabel(existing.period_month)} payroll.`);
  await tx`delete from payroll_inputs where id = ${existing.id}`;
  await markOpenRunStale(tx, existing.pay_group_id, existing.period_month);
  await tx`update expense_claims set payout_month = null where id = ${claimId}`;
  await audit(tx, actor, "expense_claim", claimId, "payout.unscheduled", { month: existing.period_month });
  return { changed: true };
}

/** Paid outside payroll (bank transfer, UPI, cash). Takes it out of payroll first if it was scheduled there. */
export async function markClaimPaid(tx: Tx, actor: Actor, claimId: string, reference: string | null) {
  const { c, who, payable } = await lockedClaim(tx, actor, claimId);
  const existing = await scheduledInput(tx, claimId);
  if (existing) {
    if (await runLocked(tx, existing.pay_group_id, existing.period_month)) throw new AppError("conflict", `It's already in the finalised ${monthLabel(existing.period_month)} payroll.`);
    await tx`delete from payroll_inputs where id = ${existing.id}`;
    // a run that already calculated this claim into someone's pay must be recalculated, or it would be paid twice
    await markOpenRunStale(tx, existing.pay_group_id, existing.period_month);
  }
  const r = await tx`update expense_claims set status = 'paid', payout = 'off_cycle', payout_month = null, paid_at = now(), paid_by = ${actor.userId},
                     payment_ref = ${reference?.trim().slice(0, 120) || "Paid off-cycle"} where id = ${claimId} and status = 'approved'`;
  if (!r.count) throw new AppError("conflict", "This claim is already paid.");
  await audit(tx, actor, "expense_claim", claimId, "paid", { reference, amount_paise: payable });
  await notifyEmployee(tx, actor.tenant.id, who.id, "expense.paid", `Claim #${c.number} was paid`, `${inr(payable)} paid to you.`, "/me/expenses");
}

/**
 * For the payroll run: once a month is paid, the expense claims it carried are marked paid. With `runId`, only claims
 * whose reimbursement really is on a line that was paid (not held from processing, not skipped) count. Claims that were
 * scheduled for the month but not paid with it (input held, or the person's pay held or skipped) go back to the payout
 * queue unscheduled, so finance can schedule them again or pay them off-cycle. Returns how many were marked paid.
 */
export async function markPayrollExpensesPaid(tx: Tx, payGroupId: string, month: string, opts: { runId?: string } = {}) {
  const onPaidLine = opts.runId
    ? tx`and exists (select 1 from payroll_lines l where l.run_id = ${opts.runId} and l.employee_id = i.employee_id and l.action not in ('hold_processing','void')
                     and l.earnings @> jsonb_build_array(jsonb_build_object('inputId', i.id::text)))`
    : tx``;
  const r = await tx`
    update expense_claims c set status = 'paid', paid_at = now(), payment_ref = ${`Paid with ${monthLabel(month)} payroll`}
    where c.status = 'approved' and c.payout = 'payroll' and c.payout_month = ${month}
      and exists (select 1 from payroll_inputs i where i.kind = 'expense' and i.pay_group_id = ${payGroupId} and i.period_month = ${month}
                  and i.action = 'pay' and i.source_ref->>'expense_claim_id' = c.id::text ${onPaidLine})`;
  if (opts.runId) {
    // not paid by this run: unlink the (now locked) input, keeping a note of the claim, and put the claim back in the queue
    const left = await tx<{ id: string }[]>`
      update payroll_inputs i set source_ref = (i.source_ref - 'expense_claim_id') || jsonb_build_object('unpaid_expense_claim_id', i.source_ref->>'expense_claim_id'), updated_at = now()
      from expense_claims c
      where i.kind = 'expense' and i.pay_group_id = ${payGroupId} and i.period_month = ${month} and i.source_ref->>'expense_claim_id' = c.id::text and c.status = 'approved'
      returning c.id`;
    if (left.length) await tx`update expense_claims set payout_month = null where id = any(${left.map((x) => x.id)}::uuid[]) and status = 'approved'`;
  }
  return r.count;
}

/**
 * Full and final settlement: claims the settlement pays (or records as paid separately) are marked paid, and taken out of
 * any payroll month that hasn't been finalised, so the regular run can't pay them again. Returns the claims marked paid.
 */
export async function settleClaimsInFnf(tx: Tx, actor: Actor, claimIds: string[], reference: string) {
  if (!claimIds.length) return 0;
  const inputs = await tx<{ id: string; pay_group_id: string; period_month: string }[]>`
    select i.id, i.pay_group_id, i.period_month::text from payroll_inputs i
    where i.kind = 'expense' and i.source_ref->>'expense_claim_id' = any(${claimIds}::text[])`;
  for (const i of inputs) {
    if (await runLocked(tx, i.pay_group_id, i.period_month)) continue;
    await tx`delete from payroll_inputs where id = ${i.id}`;
    await markOpenRunStale(tx, i.pay_group_id, i.period_month);
  }
  const r = await tx<{ id: string }[]>`
    update expense_claims set status = 'paid', payout = 'off_cycle', payout_month = null, paid_at = now(), paid_by = ${actor.userId}, payment_ref = ${reference.slice(0, 120)}
    where id = any(${claimIds}::uuid[]) and status = 'approved' returning id`;
  for (const c of r) await audit(tx, actor, "expense_claim", c.id, "paid", { reference });
  return r.length;
}

export async function payoutQueue(tx: Tx, actor: Actor) {
  const today = todayIn();
  const claims = await tx<(RawClaim & Placement & { employee_id: string; employee: string; pay_group_id: string | null })[]>`
    select q.*, e.id as employee_id, e.display_name as employee, e.pay_group_id, e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id
    from (${CLAIM_SELECT(tx)}) q join expense_claims c2 on c2.id = q.id join employees e on e.id = c2.employee_id
    where q.status = 'approved' or (q.status = 'paid' and q.paid_at > now() - interval '45 days')
    order by q.status, q.submitted_at`;
  const advances = await tx<(RawAdv & Placement)[]>`
    select q.*, e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id from (${ADV_SELECT(tx)}) q join employees e on e.id = q.employee_id
    where q.status in ('approved','paid') order by q.created_at`;
  const scope = <T extends Placement & { employee_id: string }>(r: T) => canPayFor(actor, { ...r, id: r.employee_id });
  return {
    claims: claims.filter(scope).map((c) => ({ ...toClaim(c), employee: c.employee, employee_id: c.employee_id, in_pay_group: !!c.pay_group_id })),
    advances: advances.filter(scope).map((a) => toAdv(a, today)),
  };
}

// ---------- reports ----------
export type ReportFilter = { from: string; to: string; includePending: boolean };
export async function expenseReport(tx: Tx, actor: Actor, f: ReportFilter) {
  const statuses = f.includePending ? ["submitted", "approved", "paid"] : ["approved", "paid"];
  const rows = await tx<(Placement & { employee_id: string; employee: string; number: bigint; claim_status: string; category: string; gl_code: string | null; department: string | null; spent_on: string; amount_paise: bigint; merchant: string | null })[]>`
    select e.id as employee_id, e.display_name as employee, e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id,
      c.number, c.status as claim_status, cat.name as category, cat.gl_code, dp.name as department, x.spent_on::text, x.base_amount_paise as amount_paise, x.merchant
    from expenses x join expense_claims c on c.id = x.claim_id join expense_categories cat on cat.id = x.category_id
    join employees e on e.id = x.employee_id left join departments dp on dp.id = e.department_id
    where c.status = any(${statuses}::text[]) and x.spent_on between ${f.from} and ${f.to}
    order by x.spent_on, c.number`;
  const lines = rows.filter((r) => canReportFor(actor, r)).map((r) => ({
    employee: r.employee, number: N(r.number), status: r.claim_status, category: r.category, gl_code: r.gl_code, department: r.department,
    spentOn: r.spent_on, amountPaise: N(r.amount_paise), merchant: r.merchant,
  }));
  return { lines, summary: summarize(lines) };
}

// ---------- receipts ----------
/** A receipt file the actor may open: on their own expense, or on a claim they can see (approvers, finance in scope). */
export async function receiptFor(tx: Tx, actor: Actor, fileId: string) {
  const [f] = await tx<{ id: string; storage_key: string; name: string; mime: string; uploaded_by: string | null }[]>`select id, storage_key, name, mime, uploaded_by from files where id = ${fileId}`;
  if (!f) return null;
  const [x] = await tx<{ employee_id: string; claim_id: string | null }[]>`select employee_id, claim_id from expenses where ${fileId}::uuid = any(receipt_file_ids) limit 1`;
  if (!x) return null;
  if (x.employee_id === actor.employeeId) return f;
  if (x.claim_id && (await claimAccess(tx, actor, x.claim_id))) return f;
  return canAdminExpenses(actor) && canReportFor(actor, await person(tx, x.employee_id)) ? f : null;
}

