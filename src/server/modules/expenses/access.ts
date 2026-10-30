import { AppError } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";

export const EXP_ADMIN = "expenses.admin";
export const EXP_APPROVE = "expenses.approve";
export const EXP_PAYOUT = "expenses.payout";
export const EVERYWHERE: Placement = { department_id: null, location_id: null, legal_entity_id: null, business_unit_id: null };

/** Policies and categories are company-wide, so setting them up needs expenses.admin with no department / location scope. */
export const canAdminExpenses = (actor: Actor) => canFor(actor, EXP_ADMIN, EVERYWHERE);
export function assertExpenseAdmin(actor: Actor) {
  if (!canAdminExpenses(actor)) throw new AppError("forbidden", "Only expense admins for the whole company can change expense policies.");
}

/** Holds the permission somewhere (scoped or not): may open the screen, which then shows only their people. */
export const hasAnywhere = (actor: Actor, permission: string) => (actor.grants ?? []).some((g) => g.permissions.includes("*") || g.permissions.includes(permission));

/** Finance review / payout for a particular person (respects scopes). Never for yourself. */
export const canFinanceFor = (actor: Actor, target: Placement & { id: string }) => target.id !== actor.employeeId && canFor(actor, EXP_APPROVE, target);
export const canPayFor = (actor: Actor, target: Placement & { id: string }) => target.id !== actor.employeeId && canFor(actor, EXP_PAYOUT, target);
/** Reports: finance, payouts, expense admins or general report readers, each within their scope. */
export const canReportFor = (actor: Actor, target: Placement) => [EXP_APPROVE, EXP_PAYOUT, EXP_ADMIN, "reports.read"].some((p) => canFor(actor, p, target));
export const canSeeReports = (actor: Actor) => [EXP_APPROVE, EXP_PAYOUT, EXP_ADMIN, "reports.read"].some((p) => hasAnywhere(actor, p));
