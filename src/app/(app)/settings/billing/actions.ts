"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import * as billing from "@/server/modules/billing/service";

const bad = (error: string, field?: string) => ({ ok: false as const, error, field });

export async function startCheckoutAction(plan: string, cycle: string) {
  return runAction((tx, actor) => billing.startCheckout(tx, actor, String(plan), String(cycle)), { refresh: false });
}

export async function changePlanAction(plan: string) {
  return runAction((tx, actor) => billing.changePlan(tx, actor, String(plan)));
}

export async function cancelSubscriptionAction() {
  return runAction((tx, actor) => billing.cancelSubscription(tx, actor));
}

export async function simulateCheckoutAction(providerSubscriptionId: string) {
  if (!/^fake_sub_[0-9a-f]{12}$/.test(providerSubscriptionId)) return bad("That checkout doesn't exist.");
  return runAction((tx, actor) => billing.simulateCheckout(tx, actor, providerSubscriptionId));
}

const details = z.object({ gstin: z.string().max(20), billingEmail: z.string().max(200) });
export async function saveBillingDetailsAction(raw: z.input<typeof details>) {
  const p = details.safeParse(raw);
  if (!p.success) return bad("Check the billing details.");
  return runAction((tx, actor) => billing.saveBillingDetails(tx, actor, p.data));
}
