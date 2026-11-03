import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { BillingCycle, Plan } from "@/server/modules/saas/plans";

/**
 * Subscription billing behind one interface. Razorpay Subscriptions when RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET /
 * RAZORPAY_WEBHOOK_SECRET are set (plus a plan id per plan+cycle, e.g. RAZORPAY_PLAN_PLUS_QUARTERLY); otherwise a
 * fake provider that simulates checkout locally so the whole flow can be exercised without keys.
 */
export type ProviderSubscription = { id: string; status: SubStatus; checkoutUrl: string | null; currentPeriodEnd: Date | null };
export type SubStatus = "created" | "active" | "past_due" | "halted" | "cancelled";
export type ProviderEvent = {
  id: string; type: "activated" | "charged" | "pending" | "halted" | "cancelled" | "other";
  subscriptionId: string | null; tenantId: string | null; currentPeriodEnd: Date | null;
  payment: { id: string; amountPaise: number } | null; raw: unknown;
};

export interface BillingProvider {
  readonly name: "razorpay" | "fake";
  readonly configured: boolean;
  createSubscription(a: { tenantId: string; plan: Plan; cycle: BillingCycle; seats: number; email: string; company: string }): Promise<ProviderSubscription>;
  updateSubscription(id: string, a: { plan: Plan; cycle: BillingCycle; seats: number }): Promise<void>;
  cancelSubscription(id: string, atCycleEnd: boolean): Promise<void>;
  fetchSubscription(id: string): Promise<{ status: SubStatus; currentPeriodEnd: Date | null } | null>;
  verifyWebhook(rawBody: string, signature: string | null): boolean;
  parseEvent(json: unknown, eventIdHeader: string | null): ProviderEvent;
}

const STATUS: Record<string, SubStatus> = { created: "created", authenticated: "active", active: "active", pending: "past_due", halted: "halted", cancelled: "cancelled", completed: "cancelled", expired: "cancelled", paused: "halted" };

class Razorpay implements BillingProvider {
  readonly name = "razorpay" as const;
  readonly configured = true;
  constructor(private keyId: string, private keySecret: string, private webhookSecret: string) {}
  private planId(plan: Plan, cycle: BillingCycle) {
    const id = process.env[`RAZORPAY_PLAN_${plan.toUpperCase()}_${cycle.toUpperCase()}`]?.trim();
    if (!id) throw new Error(`RAZORPAY_PLAN_${plan.toUpperCase()}_${cycle.toUpperCase()} is not set`);
    return id;
  }
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`https://api.razorpay.com/v1${path}`, {
      method, headers: { authorization: "Basic " + Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64"), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store",
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: { description?: string } };
    if (!res.ok) throw new Error(json.error?.description ?? `Razorpay HTTP ${res.status}`);
    return json;
  }
  async createSubscription(a: { tenantId: string; plan: Plan; cycle: BillingCycle; seats: number; email: string; company: string }) {
    const r = await this.call<{ id: string; status: string; short_url: string; current_end: number | null }>("POST", "/subscriptions", {
      plan_id: this.planId(a.plan, a.cycle), quantity: a.seats, total_count: a.cycle === "yearly" ? 10 : a.cycle === "quarterly" ? 40 : 120, customer_notify: 1,
      notes: { tenant_id: a.tenantId, plan: a.plan, cycle: a.cycle, company: a.company, email: a.email },
    });
    return { id: r.id, status: STATUS[r.status] ?? "created", checkoutUrl: r.short_url ?? null, currentPeriodEnd: r.current_end ? new Date(r.current_end * 1000) : null };
  }
  async updateSubscription(id: string, a: { plan: Plan; cycle: BillingCycle; seats: number }) {
    await this.call("PATCH", `/subscriptions/${id}`, { plan_id: this.planId(a.plan, a.cycle), quantity: a.seats, schedule_change_at: "now", customer_notify: 1 });
  }
  async cancelSubscription(id: string, atCycleEnd: boolean) {
    await this.call("POST", `/subscriptions/${id}/cancel`, { cancel_at_cycle_end: atCycleEnd ? 1 : 0 });
  }
  async fetchSubscription(id: string) {
    try {
      const r = await this.call<{ status: string; current_end: number | null }>("GET", `/subscriptions/${id}`);
      return { status: STATUS[r.status] ?? "created", currentPeriodEnd: r.current_end ? new Date(r.current_end * 1000) : null };
    } catch { return null; }
  }
  verifyWebhook(rawBody: string, signature: string | null) {
    if (!signature) return false;
    const expected = createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
    return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }
  parseEvent(json: unknown, eventIdHeader: string | null): ProviderEvent {
    const j = (json ?? {}) as { event?: string; payload?: { subscription?: { entity?: { id?: string; notes?: Record<string, string>; current_end?: number | null } }; payment?: { entity?: { id?: string; amount?: number } } } };
    const sub = j.payload?.subscription?.entity, pay = j.payload?.payment?.entity;
    const map: Record<string, ProviderEvent["type"]> = { "subscription.activated": "activated", "subscription.authenticated": "activated", "subscription.charged": "charged", "subscription.pending": "pending", "subscription.halted": "halted", "subscription.cancelled": "cancelled", "subscription.completed": "cancelled" };
    return {
      id: eventIdHeader ?? `${j.event}:${sub?.id}:${pay?.id ?? ""}`, type: map[j.event ?? ""] ?? "other",
      subscriptionId: sub?.id ?? null, tenantId: sub?.notes?.tenant_id ?? null, currentPeriodEnd: sub?.current_end ? new Date(sub.current_end * 1000) : null,
      payment: pay?.id && typeof pay.amount === "number" ? { id: pay.id, amountPaise: pay.amount } : null, raw: json,
    };
  }
}

/** Local stand-in: no network, "checkout" is a button on the Billing page that posts the events a real provider would. */
export class FakeBilling implements BillingProvider {
  readonly name = "fake" as const;
  readonly configured = false;
  async createSubscription(a: { tenantId: string }) {
    const id = `fake_sub_${randomBytes(6).toString("hex")}`;
    return { id, status: "created" as const, checkoutUrl: `/settings/billing?checkout=${id}&t=${a.tenantId.slice(0, 8)}`, currentPeriodEnd: null };
  }
  async updateSubscription() {}
  async cancelSubscription() {}
  async fetchSubscription() { return null; }
  verifyWebhook() { return false; }
  parseEvent(json: unknown, eventIdHeader: string | null): ProviderEvent {
    const j = (json ?? {}) as Partial<ProviderEvent> & { type?: ProviderEvent["type"] };
    return { id: eventIdHeader ?? j.id ?? randomBytes(8).toString("hex"), type: j.type ?? "other", subscriptionId: j.subscriptionId ?? null, tenantId: j.tenantId ?? null, currentPeriodEnd: j.currentPeriodEnd ? new Date(j.currentPeriodEnd) : null, payment: j.payment ?? null, raw: json };
  }
}

export function billingProvider(): BillingProvider {
  const id = process.env.RAZORPAY_KEY_ID?.trim(), secret = process.env.RAZORPAY_KEY_SECRET?.trim(), wh = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();
  return id && secret && wh ? new Razorpay(id, secret, wh) : new FakeBilling();
}

export const BILLING_ENV_HINT = "RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET and RAZORPAY_PLAN_<PLAN>_<CYCLE> ids in .env.local";
