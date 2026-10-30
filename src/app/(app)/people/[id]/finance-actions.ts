"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import * as salary from "@/server/modules/payroll/salary";

const uuid = z.uuid();
const bad = (error: string) => ({ ok: false as const, error, field: undefined as string | undefined });

export async function saveSalaryAction(input: unknown) {
  return runAction(async (tx, actor) => {
    const r = await salary.saveSalary(tx, actor, input);
    return { unchanged: r.unchanged, arrearsFromMonth: r.arrearsFromMonth };
  });
}
export async function deleteSalaryAction(salaryId: string) {
  if (!uuid.safeParse(salaryId).success) return bad("Unknown salary record.");
  return runAction((tx, actor) => salary.deleteSalary(tx, actor, salaryId));
}
export async function saveBankAction(employeeId: string, input: unknown) {
  if (!uuid.safeParse(employeeId).success) return bad("Unknown person.");
  return runAction((tx, actor) => salary.saveBankAccount(tx, actor, employeeId, input));
}
export async function saveStatutoryAction(employeeId: string, input: unknown) {
  if (!uuid.safeParse(employeeId).success) return bad("Unknown person.");
  return runAction((tx, actor) => salary.saveStatutory(tx, actor, employeeId, input));
}
