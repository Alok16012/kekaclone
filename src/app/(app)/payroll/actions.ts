"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import * as runs from "@/server/modules/payrun/runs";
import * as slips from "@/server/modules/payrun/payslips";
import * as pay from "@/server/modules/payrun/payments";
import * as fnf from "@/server/modules/payrun/fnf";
import * as imp from "@/server/modules/payrun/import";
import { LINE_ACTIONS, STEPS, type BankFormat, type LineAction, type StepKey } from "@/server/modules/payrun/rules";

const uuid = z.uuid();
const isId = (v: unknown) => uuid.safeParse(v).success;
const bad = (error: string) => ({ ok: false as const, error, field: undefined as string | undefined });
const version = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : null);

// ---------- runs
export async function createRunAction(payGroupId: string, month: string) {
  if (!isId(payGroupId)) return bad("Unknown pay group.");
  return runAction((tx, actor) => runs.createRun(tx, actor, payGroupId, month));
}
export async function calculateAction(runId: string, v: number) {
  if (!isId(runId)) return bad("Unknown run.");
  return runAction(async (tx, actor) => { const r = await runs.calculate(tx, actor, runId, version(v)); return { version: r.version, headcount: r.totals.headcount }; });
}
export async function saveInputAction(runId: string, inputId: string | null, input: unknown, v: number) {
  if (!isId(runId) || (inputId !== null && !isId(inputId))) return bad("Unknown input.");
  return runAction((tx, actor) => runs.saveInput(tx, actor, runId, inputId, input, version(v)));
}
export async function deleteInputAction(runId: string, inputId: string, v: number) {
  if (!isId(runId) || !isId(inputId)) return bad("Unknown input.");
  return runAction((tx, actor) => runs.deleteInput(tx, actor, runId, inputId, version(v)));
}
export async function setInputActionAction(runId: string, inputId: string, action: "pay" | "hold" | "void", v: number) {
  if (!isId(runId) || !isId(inputId) || !["pay", "hold", "void"].includes(action)) return bad("Unknown input.");
  return runAction((tx, actor) => runs.setInputAction(tx, actor, runId, inputId, action, version(v)));
}
export async function setPayActionAction(runId: string, employeeId: string, action: LineAction, note: string | null, v: number) {
  if (!isId(runId) || !isId(employeeId) || !LINE_ACTIONS.includes(action)) return bad("Pick what to do with this person's pay.");
  return runAction((tx, actor) => runs.setPayAction(tx, actor, runId, employeeId, action, typeof note === "string" ? note.slice(0, 200) : null, version(v)));
}
export async function setOverrideAction(runId: string, employeeId: string, code: (typeof runs.OVERRIDE_CODES)[number], amountPaise: number | null, reason: string | null, v: number) {
  if (!isId(runId) || !isId(employeeId) || !runs.OVERRIDE_CODES.includes(code)) return bad("Pick a statutory deduction.");
  return runAction((tx, actor) => runs.setOverride(tx, actor, runId, employeeId, code, amountPaise, typeof reason === "string" ? reason.slice(0, 200) : null, version(v)));
}
export async function reviewStepAction(runId: string, step: StepKey, reviewed: boolean, v: number) {
  if (!isId(runId) || !STEPS.some((s) => s.key === step)) return bad("Unknown step.");
  return runAction((tx, actor) => runs.markReviewed(tx, actor, runId, step, !!reviewed, version(v)));
}
export async function finalizeAction(runId: string, v: number) {
  if (!isId(runId)) return bad("Unknown run.");
  return runAction((tx, actor) => runs.finalizeRun(tx, actor, runId, version(v)));
}
export async function rollbackAction(runId: string, reason: string, v: number) {
  if (!isId(runId)) return bad("Unknown run.");
  return runAction((tx, actor) => runs.rollbackRun(tx, actor, runId, String(reason ?? "").slice(0, 500), version(v)));
}
export async function releasePayslipsAction(runId: string) {
  if (!isId(runId)) return bad("Unknown run.");
  return runAction((tx, actor) => slips.releasePayslips(tx, actor, runId));
}
export async function releaseHeldAction(lineId: string) {
  if (!isId(lineId)) return bad("Unknown person.");
  return runAction((tx, actor) => runs.releaseHeldPayout(tx, actor, lineId));
}
export async function paidOutsideAction(lineId: string, note: string) {
  if (!isId(lineId)) return bad("Unknown person.");
  return runAction((tx, actor) => runs.markLinePaidOutside(tx, actor, lineId, String(note ?? "").slice(0, 200)));
}

// ---------- payments
export async function createBatchAction(runId: string, format: BankFormat) {
  if (!isId(runId)) return bad("Unknown run.");
  return runAction((tx, actor) => pay.createBatch(tx, actor, runId, format));
}
export async function batchPaidAction(batchId: string) {
  if (!isId(batchId)) return bad("Unknown bank file.");
  return runAction((tx, actor) => pay.markBatchPaid(tx, actor, batchId));
}
export async function cancelBatchAction(batchId: string) {
  if (!isId(batchId)) return bad("Unknown bank file.");
  return runAction((tx, actor) => pay.cancelBatch(tx, actor, batchId));
}

// ---------- full and final
export async function buildSettlementAction(exitId: string) {
  if (!isId(exitId)) return bad("Unknown exit.");
  return runAction((tx, actor) => fnf.buildSettlement(tx, actor, exitId));
}
export async function settlementItemAction(exitId: string, key: string, action: "pay" | "void" | "paid_outside") {
  if (!isId(exitId) || typeof key !== "string" || key.length > 120) return bad("Unknown item.");
  return runAction((tx, actor) => fnf.setItemAction(tx, actor, exitId, key, action));
}
export async function addSettlementItemAction(exitId: string, input: unknown) {
  if (!isId(exitId)) return bad("Unknown exit.");
  return runAction((tx, actor) => fnf.addManualItem(tx, actor, exitId, input));
}
export async function removeSettlementItemAction(exitId: string, key: string) {
  if (!isId(exitId) || typeof key !== "string" || key.length > 120) return bad("Unknown item.");
  return runAction((tx, actor) => fnf.removeManualItem(tx, actor, exitId, key));
}
export async function finalizeSettlementAction(exitId: string) {
  if (!isId(exitId)) return bad("Unknown exit.");
  return runAction((tx, actor) => fnf.finalizeSettlement(tx, actor, exitId));
}
/** For the exit drawer (read only, no refresh). */
export async function settlementSummaryAction(exitId: string) {
  if (!isId(exitId)) return bad("Unknown exit.");
  return runAction((tx, actor) => fnf.fnfSummary(tx, actor, exitId), { refresh: false });
}

// ---------- Excel import of inputs
async function fileFrom(form: FormData) {
  const f = form.get("file");
  if (!(f instanceof File) || f.size === 0) return null;
  return f.arrayBuffer();
}
export async function previewInputsAction(runId: string, form: FormData) {
  if (!isId(runId)) return bad("Unknown run.");
  const bytes = await fileFrom(form);
  if (!bytes) return bad("Choose an .xlsx file first.");
  return runAction((tx, actor) => imp.previewInputImport(tx, actor, runId, bytes), { refresh: false });
}
export async function commitInputsAction(runId: string, form: FormData, v: number) {
  if (!isId(runId)) return bad("Unknown run.");
  const bytes = await fileFrom(form);
  if (!bytes) return bad("Choose an .xlsx file first.");
  return runAction((tx, actor) => imp.commitInputImport(tx, actor, runId, bytes, version(v)));
}

// ---------- settlement in parts
export async function settlementModeAction(exitId: string, mode: "one_time" | "periodic") {
  if (!isId(exitId)) return bad("Unknown exit.");
  return runAction(async (tx, actor) => { await fnf.setSettlementMode(tx, actor, exitId, mode); });
}
export async function settlementPartAction(exitId: string, partNo: number, month: string) {
  if (!isId(exitId) || typeof partNo !== "number" || typeof month !== "string") return bad("Unknown part.");
  return runAction(async (tx, actor) => { await fnf.saveSettlementPart(tx, actor, exitId, partNo, month); });
}
export async function removeSettlementPartAction(exitId: string, partNo: number) {
  if (!isId(exitId) || typeof partNo !== "number") return bad("Unknown part.");
  return runAction(async (tx, actor) => { await fnf.removeSettlementPart(tx, actor, exitId, partNo); });
}
export async function settlementItemPartAction(exitId: string, key: string, partNo: number) {
  if (!isId(exitId) || typeof key !== "string" || key.length > 120 || typeof partNo !== "number") return bad("Unknown item.");
  return runAction(async (tx, actor) => { await fnf.assignItemPart(tx, actor, exitId, key, partNo); });
}
export async function finalizeSettlementPartAction(exitId: string, partNo: number) {
  if (!isId(exitId) || typeof partNo !== "number") return bad("Unknown part.");
  return runAction((tx, actor) => fnf.finalizeSettlementPart(tx, actor, exitId, partNo));
}
