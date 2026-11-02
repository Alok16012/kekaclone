"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import { AppError } from "@/server/db";
import * as loans from "@/server/modules/loans/service";

const uuid = z.uuid();
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });

export async function requestLoanAction(input: { categoryId: string; amountPaise: number; months: number; reason: string }) {
  return runAction((tx, actor) => loans.requestLoan(tx, actor, input));
}

export async function withdrawLoanAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Loan not found.");
  return runAction((tx, actor) => loans.withdrawLoan(tx, actor, id));
}

/** Loan detail for drawers (the person, payroll admins covering them, and approvers in its chain). */
export async function loanDetailAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Loan not found.");
  return runAction(async (tx, actor) => {
    const d = await loans.loanDetail(tx, actor, id);
    if (!d) throw new AppError("not_found", "Loan not found.");
    return d;
  }, { refresh: false });
}
