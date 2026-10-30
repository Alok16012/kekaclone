import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";

export const PAYROLL = "payroll.admin";
const EVERYWHERE: Placement = { department_id: null, location_id: null, legal_entity_id: null, business_unit_id: null };

/** Company-wide payroll setup (components, pay groups, structures, statutory sign-off) needs payroll.admin with no scope. */
export const isPayrollAdmin = (actor: Actor) => canFor(actor, PAYROLL, EVERYWHERE);
export function assertPayrollAdmin(actor: Actor) {
  if (!isPayrollAdmin(actor)) throw new AppError("forbidden", "Only payroll admins for the whole company can change payroll settings.");
}

/** Has payroll.admin anywhere (scoped or not): may open the revisions screen, which then only covers their people. */
export const hasAnyPayrollAdmin = (actor: Actor) => (actor.grants ?? []).some((g) => g.permissions.includes("*") || g.permissions.includes(PAYROLL));

export async function placementOf(tx: Tx, employeeId: string) {
  const [p] = await tx<(Placement & { status: string; first_name: string; display_name: string })[]>`
    select department_id, location_id, legal_entity_id, business_unit_id, status, first_name, display_name from employees where id = ${employeeId}`;
  return p ?? null;
}

/** Salary, bank and statutory details: payroll.admin covering this person (respects scopes). */
export const canPayrollFor = (actor: Actor, p: Placement) => canFor(actor, PAYROLL, p);

/**
 * For changes to someone's pay: payroll.admin in scope, and never on yourself, so nobody sets their own salary or bank account.
 * Returns the person's placement.
 */
export async function assertCanChangePay(tx: Tx, actor: Actor, employeeId: string) {
  const p = await placementOf(tx, employeeId);
  if (!p) throw new AppError("not_found", "Person not found.");
  if (!canPayrollFor(actor, p)) throw new AppError("forbidden", "You don't manage payroll for this person.");
  if (employeeId === actor.employeeId) throw new AppError("forbidden", "You can't change your own salary, bank or statutory details. Ask another payroll admin.");
  return p;
}
