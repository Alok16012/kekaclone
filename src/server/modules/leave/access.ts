import { AppError } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";

const EVERYWHERE: Placement = { department_id: null, location_id: null, legal_entity_id: null, business_unit_id: null };

/**
 * Company-wide leave settings (types, plans, holiday lists, year-end) need leave.admin without a scope:
 * an HR admin scoped to one department can manage that department's balances but not everyone's policies.
 */
export function isLeaveAdmin(actor: Actor) {
  return canFor(actor, "leave.admin", EVERYWHERE);
}

export function assertLeaveAdmin(actor: Actor) {
  if (!isLeaveAdmin(actor)) throw new AppError("forbidden", "Only leave admins for the whole company can change leave settings.");
}

/** leave.admin on this particular person (respects department / location scopes). */
export function canAdminLeaveFor(actor: Actor, target: Placement) {
  return canFor(actor, "leave.admin", target);
}

/** Has leave.admin anywhere (scoped or not): may open the balances screen, which then shows only their people. */
export function hasAnyLeaveAdmin(actor: Actor) {
  return (actor.grants ?? []).some((g) => g.permissions.includes("*") || g.permissions.includes("leave.admin"));
}
