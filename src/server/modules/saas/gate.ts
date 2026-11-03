import "server-only";
import { AppError } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { featureProblem, type Feature } from "./plans";

export const EVERYWHERE: Placement = { department_id: null, location_id: null, legal_entity_id: null, business_unit_id: null };

/** Server-side plan gate: throws the standard "available on Plus" error. Use in services and server actions. */
type TenantLike = { tenant: { plan?: string | null; status?: string | null } };
export function assertFeature(actor: TenantLike, feature: Feature) {
  const problem = featureProblem(actor.tenant, feature);
  if (problem) throw new AppError("forbidden", problem);
}

export const hasFeature = (actor: TenantLike, feature: Feature) => featureProblem(actor.tenant, feature) === null;

/** Company-wide workspace admin actions (billing, integrations, branding) need the permission with no scope. */
export const canWorkspace = (actor: Actor, permission: "settings.billing" | "settings.integrations" | "settings.org" | "settings.security") => canFor(actor, permission, EVERYWHERE);
export function assertWorkspace(actor: Actor, permission: "settings.billing" | "settings.integrations" | "settings.org" | "settings.security") {
  if (!canWorkspace(actor, permission)) throw new AppError("forbidden", "Only admins for the whole company can change this.");
}
