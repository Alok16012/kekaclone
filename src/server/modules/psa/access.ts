import { AppError } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";

export const PSA_ADMIN = "psa.admin";
export const PSA_BILLING = "psa.billing";
export const EVERYWHERE: Placement = { department_id: null, location_id: null, legal_entity_id: null, business_unit_id: null };

/** Clients, projects and the timesheet policy are company-wide: setting them up needs psa.admin with no department / location scope. */
export const canAdminPsa = (actor: Actor) => canFor(actor, PSA_ADMIN, EVERYWHERE);
export const canBill = (actor: Actor) => canFor(actor, PSA_BILLING, EVERYWHERE);
export const canSeePsa = (actor: Actor) => canAdminPsa(actor) || canBill(actor);

export function assertPsaAdmin(actor: Actor) {
  if (!canAdminPsa(actor)) throw new AppError("forbidden", "Only project admins for the whole company can change this.");
}
export function assertBilling(actor: Actor) {
  if (!canBill(actor)) throw new AppError("forbidden", "Only people with billing access can work on invoices.");
}
