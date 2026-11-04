"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import { AppError } from "@/server/db";
import { storage } from "@/server/storage";
import * as exp from "@/server/modules/expenses/service";
import { MAX_RECEIPTS, parseHalfDays, parseKm, parseRupees } from "@/server/modules/expenses/rules";
import { MAX_UPLOAD_BYTES } from "@/server/modules/documents/rules";
import { OCR_IMAGE_MIMES, readReceipt } from "@/server/ocr";

const uuid = z.uuid();
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });
const str = (form: FormData, k: string) => { const v = form.get(k); return typeof v === "string" ? v : ""; };

async function filesFrom(form: FormData): Promise<exp.Upload[] | string> {
  const files = form.getAll("receipts").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length > MAX_RECEIPTS) return `Attach up to ${MAX_RECEIPTS} receipts.`;
  if (files.some((f) => f.size > MAX_UPLOAD_BYTES)) return "Each receipt must be 5 MB or smaller.";
  return Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
}

/** Expense fields from the form. Amounts arrive as text and are parsed to integer paise here (never via floats). */
function inputFrom(form: FormData): exp.ExpenseInput | { error: string; field: string } {
  const categoryId = str(form, "categoryId");
  if (!uuid.safeParse(categoryId).success) return { error: "Pick a category.", field: "categoryId" };
  const kind = str(form, "kind");
  const amount = kind === "mileage" || kind === "per_diem" ? null : parseRupees(str(form, "amount"));
  if (kind !== "mileage" && kind !== "per_diem" && amount == null) return { error: "Enter the amount in rupees, for example 1250.50.", field: "amount" };
  const km = kind === "mileage" ? parseKm(str(form, "distance")) : null;
  if (kind === "mileage" && km == null) return { error: "Enter the distance in km, for example 12.5.", field: "distance" };
  const days = kind === "per_diem" ? parseHalfDays(str(form, "days")) : null;
  if (kind === "per_diem" && days == null) return { error: "Enter days in whole or half days, for example 1.5.", field: "days" };
  const claimId = str(form, "claimId");
  const currency = str(form, "currency").trim().toUpperCase() || "INR";
  if (!/^[A-Z]{3}$/.test(currency)) return { error: "Pick a currency.", field: "currency" };
  return {
    categoryId, spentOn: str(form, "spentOn"), amountPaise: amount, kmHundredths: km, halfDays: days,
    merchant: str(form, "merchant") || null, description: str(form, "description") || null,
    claimId: uuid.safeParse(claimId).success ? claimId : null, currency,
  };
}

async function removeBlobs(keys: string[] | undefined) {
  for (const k of keys ?? []) await storage().remove(k).catch((e) => console.error("storage remove", e));
}

export async function addExpenseAction(form: FormData) {
  const input = inputFrom(form);
  if ("error" in input) return bad(input.error, input.field);
  const files = await filesFrom(form);
  if (typeof files === "string") return bad(files, "receipts");
  return runAction((tx, actor) => exp.addExpense(tx, actor, input, files));
}

export async function updateExpenseAction(form: FormData) {
  const id = str(form, "id");
  if (!uuid.safeParse(id).success) return bad("Expense not found.");
  const input = inputFrom(form);
  if ("error" in input) return bad(input.error, input.field);
  const files = await filesFrom(form);
  if (typeof files === "string") return bad(files, "receipts");
  const remove = form.getAll("removeReceipt").filter((v): v is string => typeof v === "string" && uuid.safeParse(v).success);
  const r = await runAction((tx, actor) => exp.updateExpense(tx, actor, id, input, { add: files, remove }));
  if (r.ok) await removeBlobs(r.data?.removedKeys);
  return r.ok ? { ok: true as const, data: { violations: r.data!.violations } } : r;
}

export async function deleteExpenseAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Expense not found.");
  const r = await runAction((tx, actor) => exp.deleteExpense(tx, actor, id));
  if (r.ok) await removeBlobs(r.data?.removedKeys);
  return r.ok ? { ok: true as const } : r;
}

const claimInput = z.object({ title: z.string().max(200), expenseIds: z.array(uuid).max(200), advanceId: uuid.nullable().optional() });
export async function createClaimAction(input: z.input<typeof claimInput>) {
  const p = claimInput.safeParse(input);
  if (!p.success) return bad("Check the claim details.");
  return runAction((tx, actor) => exp.createClaim(tx, actor, p.data));
}

export async function updateClaimAction(claimId: string, input: { title: string; advanceId: string | null }) {
  if (!uuid.safeParse(claimId).success || typeof input?.title !== "string" || (input.advanceId != null && !uuid.safeParse(input.advanceId).success)) return bad("Check the claim details.");
  return runAction((tx, actor) => exp.updateClaim(tx, actor, claimId, input));
}

export async function moveExpensesAction(claimId: string, add: string[], remove: string[]) {
  const ids = z.array(uuid).max(200);
  if (!uuid.safeParse(claimId).success || !ids.safeParse(add).success || !ids.safeParse(remove).success) return bad("Claim not found.");
  return runAction((tx, actor) => exp.moveExpenses(tx, actor, claimId, add, remove));
}

const claimStep = (fn: typeof exp.submitClaim | typeof exp.withdrawClaim | typeof exp.reopenClaim | typeof exp.deleteClaim) => async (claimId: string) => {
  if (!uuid.safeParse(claimId).success) return bad("Claim not found.");
  return runAction(async (tx, actor) => { await fn(tx, actor, claimId); });
};
export async function submitClaimAction(claimId: string) {
  if (!uuid.safeParse(claimId).success) return bad("Claim not found.");
  return runAction((tx, actor) => exp.submitClaim(tx, actor, claimId));
}
export async function withdrawClaimAction(claimId: string) { return claimStep(exp.withdrawClaim)(claimId); }
export async function reopenClaimAction(claimId: string) { return claimStep(exp.reopenClaim)(claimId); }
export async function deleteClaimAction(claimId: string) { return claimStep(exp.deleteClaim)(claimId); }

/** Claim detail for the drawers (inbox, expense desk). Same access rules as the claim page. */
export async function claimDetailAction(claimId: string) {
  if (!uuid.safeParse(claimId).success) return bad("Claim not found.");
  return runAction(async (tx, actor) => {
    const d = await exp.claimDetail(tx, actor, claimId);
    if (!d) throw new AppError("not_found", "Claim not found.");
    return d;
  }, { refresh: false });
}

export async function advanceDetailAction(advanceId: string) {
  if (!uuid.safeParse(advanceId).success) return bad("Advance not found.");
  return runAction(async (tx, actor) => {
    const d = await exp.advanceDetail(tx, actor, advanceId);
    if (!d) throw new AppError("not_found", "Advance not found.");
    return d;
  }, { refresh: false });
}

export async function requestAdvanceAction(input: { amount: string; purpose: string }) {
  const amountPaise = parseRupees(input?.amount);
  if (amountPaise == null || amountPaise <= 0) return bad("Enter the amount in rupees, for example 5000.", "amount");
  if (typeof input.purpose !== "string") return bad("Say what the advance is for.", "purpose");
  return runAction((tx, actor) => exp.requestAdvance(tx, actor, { amountPaise, purpose: input.purpose }));
}

export async function cancelAdvanceAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Advance not found.");
  return runAction((tx, actor) => exp.cancelAdvance(tx, actor, id));
}

/** Read a receipt image with the self-hosted OCR: a guess at amount, date and merchant with confidence. Never required: the form works without it. */
export async function readReceiptAction(form: FormData) {
  const f = form.get("receipt");
  if (!(f instanceof File) || f.size === 0) return bad("Pick a receipt image first.", "receipts");
  if (f.size > MAX_UPLOAD_BYTES) return bad("The receipt must be 5 MB or smaller.", "receipts");
  if (!OCR_IMAGE_MIMES.has(f.type)) return bad("Only PNG and JPG receipts can be read. For a PDF, type the amount in.", "receipts");
  const r = await readReceipt(new Uint8Array(await f.arrayBuffer()), f.type);
  if (!r.ok) return bad(r.reason, "receipts");
  return { ok: true as const, data: { guess: r.guess, engineConfidence: r.engineConfidence } };
}
