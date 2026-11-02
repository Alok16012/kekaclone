"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import { AppError } from "@/server/db";
import { isPayrollAdmin } from "@/server/modules/payroll/access";
import * as loans from "@/server/modules/loans/service";

const uuid = z.uuid();
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });

export async function disburseLoanAction(id: string, input: { disbursedOn: string; firstEmiMonth: string; reference?: string }) {
  if (!uuid.safeParse(id).success) return bad("Loan not found.");
  return runAction((tx, actor) => loans.disburseLoan(tx, actor, id, input));
}

export async function cancelApprovedLoanAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Loan not found.");
  return runAction((tx, actor) => loans.cancelApprovedLoan(tx, actor, id));
}

export async function skipEmiAction(id: string, month: string, reason?: string) {
  if (!uuid.safeParse(id).success || typeof month !== "string") return bad("Loan not found.");
  return runAction((tx, actor) => loans.skipEmi(tx, actor, id, month, typeof reason === "string" ? reason.slice(0, 300) : undefined));
}

export async function prepayLoanAction(id: string, input: { amountPaise: number; paidOn: string; reference?: string }) {
  if (!uuid.safeParse(id).success) return bad("Loan not found.");
  return runAction((tx, actor) => loans.prepayLoan(tx, actor, id, input));
}

export async function saveLoanCategoryAction(id: string | null, input: unknown) {
  if (id !== null && !uuid.safeParse(id).success) return bad("Loan type not found.");
  return runAction((tx, actor) => loans.saveCategory(tx, actor, id, input));
}

export async function deleteLoanCategoryAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Loan type not found.");
  return runAction((tx, actor) => loans.deleteCategory(tx, actor, id));
}

/** Put a month's EMIs for a pay group into payroll inputs now (the payroll run does this itself; this is for checking ahead). */
export async function prepareEmisAction(payGroupId: string, month: string) {
  if (!uuid.safeParse(payGroupId).success || !/^\d{4}-\d{2}-01$/.test(month)) return bad("Pick a pay group and month.");
  return runAction(async (tx, actor) => {
    if (!isPayrollAdmin(actor)) throw new AppError("forbidden", "Only payroll admins for the whole company can prepare payroll inputs.");
    return loans.loanEmisForMonth(tx, payGroupId, month);
  });
}
