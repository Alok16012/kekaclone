import { AppError } from "@/server/db";
import type { Actor } from "./session";

/** Permission checks: pure, so services and scripts can use them outside a Next request. */
export function can(actor: Actor, permission: string) {
  return actor.permissions.has("*") || actor.permissions.has(permission);
}

export function assertCan(actor: Actor, permission: string) {
  if (!can(actor, permission)) throw new AppError("forbidden", "You don't have access to do this.");
}

export type Placement = { department_id: string | null; location_id: string | null; legal_entity_id: string | null; business_unit_id: string | null };

/**
 * Permission on a specific person: true if some role grants it with no scope, or with a scope that contains
 * the person's department / location / legal entity / business unit (all listed scope types must match).
 */
export function canFor(actor: Actor, permission: string, target: Placement) {
  return (actor.grants ?? []).some((g) => {
    if (!g.permissions.includes("*") && !g.permissions.includes(permission)) return false;
    return g.scopes.every((sc) => sc.ids.includes((target[`${sc.type}_id` as keyof Placement] ?? "") as string));
  });
}
