import { AppError } from "@/server/db";
import type { Actor } from "./session";

/** Permission checks: pure, so services and scripts can use them outside a Next request. */
export function can(actor: Actor, permission: string) {
  return actor.permissions.has("*") || actor.permissions.has(permission);
}

export function assertCan(actor: Actor, permission: string) {
  if (!can(actor, permission)) throw new AppError("forbidden", "You don't have access to do this.");
}
