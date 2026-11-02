import { AppError } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { isPayrollAdmin } from "@/server/modules/payroll/access";

export const RUN = "payroll.run";
const EVERYWHERE: Placement = { department_id: null, location_id: null, legal_entity_id: null, business_unit_id: null };

/**
 * Running payroll (and full and final settlements) is company-wide work: it needs payroll.run or payroll.admin with
 * no scope. A scoped grant doesn't count, because a run covers everyone in a pay group.
 */
export const canRunPayroll = (actor: Actor) => canFor(actor, RUN, EVERYWHERE) || isPayrollAdmin(actor);
export function assertRunPayroll(actor: Actor) {
  if (!canRunPayroll(actor)) throw new AppError("forbidden", "Only people who run payroll for the whole company can do this.");
}
/** Rolling back a finalised run undoes payslips and unlocks attendance: payroll admins only (unscoped). */
export function assertRollback(actor: Actor) {
  if (!isPayrollAdmin(actor)) throw new AppError("forbidden", "Only a payroll admin for the whole company can roll back a finalised run.");
}
/** Nobody adjusts, holds, overrides or settles their own pay. */
export function assertNotSelf(actor: Actor, employeeId: string, what = "change your own pay") {
  if (employeeId === actor.employeeId) throw new AppError("forbidden", `You can't ${what}. Ask another payroll admin.`);
}
