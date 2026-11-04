"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import * as exp from "@/server/modules/expenses/service";
import * as admin from "@/server/modules/expenses/admin";
import * as fx from "@/server/modules/expenses/fx";
import { CATEGORY_KINDS, LIMIT_PERIODS, parseRupees } from "@/server/modules/expenses/rules";

const uuid = z.uuid();
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });
const entity = z.enum(["expense_claim", "expense_advance"]);

// ---------- expense desk ----------
export async function deskDecideAction(entityType: string, entityId: string, decision: string, comment?: string) {
  const e = entity.safeParse(entityType), d = z.enum(["approved", "rejected"]).safeParse(decision);
  if (!e.success || !d.success || !uuid.safeParse(entityId).success) return bad("Request not found.");
  return runAction(async (tx, actor) => { await exp.financeDecide(tx, actor, e.data, entityId, d.data, comment?.slice(0, 1000)); });
}

export async function scheduleClaimAction(claimId: string, month: string) {
  if (!uuid.safeParse(claimId).success || typeof month !== "string") return bad("Claim not found.");
  return runAction(async (tx, actor) => { await exp.scheduleExpensePayout(tx, actor, claimId, month); });
}

export async function unscheduleClaimAction(claimId: string) {
  if (!uuid.safeParse(claimId).success) return bad("Claim not found.");
  return runAction(async (tx, actor) => { await exp.unscheduleExpensePayout(tx, actor, claimId); });
}

export async function markClaimPaidAction(claimId: string, reference: string) {
  if (!uuid.safeParse(claimId).success || typeof reference !== "string") return bad("Claim not found.");
  return runAction((tx, actor) => exp.markClaimPaid(tx, actor, claimId, reference.slice(0, 120)));
}

export async function markAdvancePaidAction(advanceId: string, reference: string) {
  if (!uuid.safeParse(advanceId).success || typeof reference !== "string") return bad("Advance not found.");
  return runAction((tx, actor) => exp.markAdvancePaid(tx, actor, advanceId, reference.slice(0, 120)));
}

export async function closeAdvanceAction(advanceId: string, note: string) {
  if (!uuid.safeParse(advanceId).success || typeof note !== "string") return bad("Advance not found.");
  return runAction((tx, actor) => exp.closeAdvance(tx, actor, advanceId, note));
}

// ---------- settings ----------
const days = (v: string, field: string) => {
  if (v.trim() === "") return { ok: true as const, value: null };
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? { ok: true as const, value: n } : { ok: false as const, error: bad("Use whole days.", field) };
};

export async function savePolicyAction(id: string | null, input: { name: string; allowFutureDated: boolean; deadlineDays: string; advanceMax: string; advanceDueDays: string }) {
  if ((id && !uuid.safeParse(id).success) || typeof input?.name !== "string") return bad("Check the policy details.");
  const dl = days(input.deadlineDays ?? "", "submissionDeadlineDays"); if (!dl.ok) return dl.error;
  const due = days(input.advanceDueDays ?? "", "advanceDueDays"); if (!due.ok) return due.error;
  const max = (input.advanceMax ?? "").trim() === "" ? null : parseRupees(input.advanceMax);
  if ((input.advanceMax ?? "").trim() !== "" && max == null) return bad("Enter the limit in rupees.", "advanceMaxPaise");
  return runAction((tx, actor) => admin.savePolicy(tx, actor, id, {
    name: input.name, allowFutureDated: !!input.allowFutureDated, submissionDeadlineDays: dl.value, advanceMaxPaise: max, advanceDueDays: due.value,
  }));
}

export async function deletePolicyAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Policy not found.");
  return runAction((tx, actor) => admin.deletePolicy(tx, actor, id));
}

export async function assignPolicyAction(id: string, employeeIds: string[]) {
  const ids = z.array(uuid).min(1).max(2000).safeParse(employeeIds);
  if (!uuid.safeParse(id).success || !ids.success) return bad("Choose at least one person.");
  return runAction((tx, actor) => admin.assignPolicy(tx, actor, id, ids.data));
}

const kinds = CATEGORY_KINDS.map((k) => k.value) as [string, ...string[]];
const periods = LIMIT_PERIODS.map((k) => k.value) as [string, ...string[]];
export async function saveCategoryAction(policyId: string, id: string | null, input: { name: string; kind: string; limit: string; limitPeriod: string | null; ratePerKm: string; receiptAbove: string; glCode: string }) {
  if (!uuid.safeParse(policyId).success || (id && !uuid.safeParse(id).success) || typeof input?.name !== "string") return bad("Check the category details.");
  const kind = z.enum(kinds).safeParse(input.kind);
  if (!kind.success) return bad("Pick a type.", "kind");
  const money = (v: string, field: string) => {
    if ((v ?? "").trim() === "") return { ok: true as const, value: null };
    const p = parseRupees(v);
    return p == null ? { ok: false as const, error: bad("Enter an amount in rupees.", field) } : { ok: true as const, value: p };
  };
  const limit = money(input.limit, "limitPaise"); if (!limit.ok) return limit.error;
  const rate = money(input.ratePerKm, "ratePerKmPaise"); if (!rate.ok) return rate.error;
  const receipt = money(input.receiptAbove, "receiptAbovePaise"); if (!receipt.ok) return receipt.error;
  const period = input.limitPeriod ? z.enum(periods).safeParse(input.limitPeriod) : null;
  if (period && !period.success) return bad("Pick a period.", "limitPeriod");
  return runAction((tx, actor) => admin.saveCategory(tx, actor, policyId, id, {
    name: input.name, kind: kind.data as never, limitPaise: limit.value, limitPeriod: (period?.data ?? null) as never,
    ratePerKmPaise: rate.value, receiptAbovePaise: receipt.value, glCode: typeof input.glCode === "string" ? input.glCode : null,
  }));
}

export async function deleteCategoryAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Category not found.");
  return runAction((tx, actor) => admin.deleteCategory(tx, actor, id));
}

// ---------- exchange rates
export async function saveRateAction(input: { currency: string; asOf: string; rate: string }) {
  if (typeof input?.currency !== "string" || typeof input.asOf !== "string" || typeof input.rate !== "string") return bad("Check the rate details.");
  return runAction((tx, actor) => fx.saveRate(tx, actor, input));
}
export async function deleteRateAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Rate not found.");
  return runAction(async (tx, actor) => { await fx.deleteRate(tx, actor, id); });
}
