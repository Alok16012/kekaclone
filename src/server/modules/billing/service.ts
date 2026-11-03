import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { appUrl, queueEmail } from "@/server/email";
import { invoiceEmail, trialEmail } from "@/server/email/templates";
import { audit } from "@/server/modules/audit/service";
import { formatINR } from "@/lib/money";
import { assertWorkspace, canWorkspace } from "@/server/modules/saas/gate";
import { BILLING_CYCLES, dueTrialReminder, isPlan, PLAN_DEFS, PLANS, quote, trialDaysLeft, type BillingCycle, type Plan } from "@/server/modules/saas/plans";
import { BILLING_ENV_HINT, billingProvider, type ProviderEvent, type SubStatus } from "./provider";

export type SubscriptionRow = { id: string; plan: Plan; seats: number; billing_cycle: BillingCycle; status: SubStatus; razorpay_subscription_id: string | null; current_period_end: Date | null; created_at: Date };
export type InvoiceRow = { id: string; number: string; amount_paise: number; gst_paise: number; status: string; issued_at: Date; paid_at: Date | null; razorpay_payment_id: string | null };

const isCycle = (v: unknown): v is BillingCycle => typeof v === "string" && v in BILLING_CYCLES;

async function tenantRow(tx: Tx) {
  const [t] = await tx<{ id: string; name: string; plan: Plan; status: string; seats: number; trial_ends_at: Date | null; billing: Record<string, unknown>; subdomain: string }[]>`
    select id, name, plan, status, seats, trial_ends_at, billing, subdomain::text from tenants`;
  return t;
}

export async function activeHeadcount(tx: Tx) {
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from employees where status <> 'relieved'`;
  return n;
}

async function currentSubscription(tx: Tx) {
  const [s] = await tx<SubscriptionRow[]>`select id, plan, seats, billing_cycle, status, razorpay_subscription_id, current_period_end, created_at from subscriptions where status <> 'cancelled' order by created_at desc limit 1`;
  return s ?? null;
}

/** Everything the Billing page shows. Readable by billing admins only. */
export async function billingOverview(tx: Tx, actor: Actor, now = new Date()) {
  assertWorkspace(actor, "settings.billing");
  const t = await tenantRow(tx);
  const provider = billingProvider();
  const [headcount, sub, invoices] = await Promise.all([activeHeadcount(tx), currentSubscription(tx), tx<InvoiceRow[]>`
    select id, number, amount_paise, gst_paise, status, issued_at, paid_at, razorpay_payment_id from billing_invoices order by issued_at desc limit 50`]);
  return {
    tenant: { name: t.name, plan: t.plan, status: t.status, seats: t.seats, trialEndsAt: t.trial_ends_at?.toISOString() ?? null, trialDaysLeft: trialDaysLeft(t.trial_ends_at, now), gstin: (t.billing.gstin as string | undefined) ?? "", billingEmail: (t.billing.billing_email as string | undefined) ?? actor.email },
    headcount,
    subscription: sub ? { ...sub, current_period_end: sub.current_period_end?.toISOString() ?? null, created_at: sub.created_at.toISOString() } : null,
    invoices: invoices.map((i) => ({ ...i, amount_paise: Number(i.amount_paise), gst_paise: Number(i.gst_paise), issued_at: i.issued_at.toISOString(), paid_at: i.paid_at?.toISOString() ?? null })),
    provider: { name: provider.name, configured: provider.configured, hint: BILLING_ENV_HINT },
    plans: PLANS.map((p) => ({ ...PLAN_DEFS[p], quotes: Object.fromEntries((Object.keys(BILLING_CYCLES) as BillingCycle[]).map((c) => [c, quote(p, headcount, c)])) })),
  };
}

export async function saveBillingDetails(tx: Tx, actor: Actor, input: { gstin: string; billingEmail: string }) {
  assertWorkspace(actor, "settings.billing");
  const gstin = input.gstin.trim().toUpperCase(), email = input.billingEmail.trim().toLowerCase();
  if (gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) throw new AppError("invalid", "That doesn't look like a GSTIN (15 characters, e.g. 29ABCDE1234F1Z5).", "gstin");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError("invalid", "Enter a valid email for invoices.", "billingEmail");
  await tx`update tenants set billing = billing || ${tx.json({ gstin: gstin || null, billing_email: email || null })} where id = ${actor.tenant.id}`;
  await audit(tx, actor, { entityType: "tenant", entityId: actor.tenant.id, action: "billing.details", diff: { gstin: gstin || null, billingEmail: email || null } });
}

/**
 * Start a subscription: seats = everyone active today (at least the plan minimum). Returns the hosted checkout link
 * (a local simulation when no provider is configured). Only one live subscription per workspace.
 */
export async function startCheckout(tx: Tx, actor: Actor, planRaw: string, cycleRaw: string) {
  assertWorkspace(actor, "settings.billing");
  if (!isPlan(planRaw) || !isCycle(cycleRaw)) throw new AppError("invalid", "Pick a plan and a billing cycle.");
  const existing = await currentSubscription(tx);
  if (existing && existing.status !== "created") throw new AppError("conflict", "There's already a subscription. Change the plan instead of starting a new one.");
  const t = await tenantRow(tx);
  const seats = quote(planRaw, await activeHeadcount(tx), cycleRaw).billedSeats;
  const provider = billingProvider();
  const created = await provider.createSubscription({ tenantId: t.id, plan: planRaw, cycle: cycleRaw, seats, email: (t.billing.billing_email as string) || actor.email, company: t.name });
  if (existing) await tx`update subscriptions set status = 'cancelled' where id = ${existing.id}`;   // abandoned checkout
  const [s] = await tx<{ id: string }[]>`insert into subscriptions (tenant_id, plan, seats, billing_cycle, status, razorpay_subscription_id, current_period_end)
    values (${t.id}, ${planRaw}, ${seats}, ${cycleRaw}, ${created.status}, ${created.id}, ${created.currentPeriodEnd}) returning id`;
  await audit(tx, actor, { entityType: "subscription", entityId: s.id, action: "checkout", diff: { plan: planRaw, cycle: cycleRaw, seats, provider: provider.name } });
  return { subscriptionId: s.id, checkoutUrl: created.checkoutUrl, providerId: created.id, simulated: provider.name === "fake" };
}

/** Move an active subscription to another plan (seats stay in sync with headcount). */
export async function changePlan(tx: Tx, actor: Actor, planRaw: string) {
  assertWorkspace(actor, "settings.billing");
  if (!isPlan(planRaw)) throw new AppError("invalid", "Pick a plan.");
  const sub = await currentSubscription(tx);
  if (!sub || sub.status === "created") throw new AppError("conflict", "Start a subscription first.");
  if (sub.plan === planRaw) throw new AppError("invalid", `You're already on ${PLAN_DEFS[planRaw].name}.`);
  const seats = quote(planRaw, await activeHeadcount(tx), sub.billing_cycle).billedSeats;
  if (sub.razorpay_subscription_id) await billingProvider().updateSubscription(sub.razorpay_subscription_id, { plan: planRaw, cycle: sub.billing_cycle, seats });
  await tx`update subscriptions set plan = ${planRaw}, seats = ${seats} where id = ${sub.id}`;
  await tx`update tenants set plan = ${planRaw}, seats = ${seats} where id = ${actor.tenant.id}`;
  await audit(tx, actor, { entityType: "subscription", entityId: sub.id, action: "plan.change", diff: { plan: { old: sub.plan, new: planRaw }, seats } });
}

/** Cancel at the end of the paid period: the plan keeps working until then, after which the workspace is read-only on Core. */
export async function cancelSubscription(tx: Tx, actor: Actor) {
  assertWorkspace(actor, "settings.billing");
  const sub = await currentSubscription(tx);
  if (!sub) throw new AppError("conflict", "There's no subscription to cancel.");
  if (sub.razorpay_subscription_id) await billingProvider().cancelSubscription(sub.razorpay_subscription_id, true);
  await tx`update subscriptions set status = 'cancelled' where id = ${sub.id}`;
  const ended = !sub.current_period_end || sub.current_period_end < new Date();
  if (ended) await tx`update tenants set status = 'cancelled' where id = ${actor.tenant.id}`;
  await audit(tx, actor, { entityType: "subscription", entityId: sub.id, action: "cancel", diff: { endsAt: sub.current_period_end } });
}

async function nextInvoiceNumber(tx: Tx, tenantId: string, at: Date) {
  const [{ value }] = await tx<{ value: number }[]>`insert into counters (tenant_id, key, value) values (${tenantId}, 'billing_invoice', 1)
    on conflict (tenant_id, key) do update set value = counters.value + 1 returning value`;
  return `ERP-${at.getFullYear()}-${String(value).padStart(5, "0")}`;
}

async function notifyAdmins(tx: Tx, tenantId: string, mail: (name: string) => { subject: string; html: string; text: string }, kind: string, extraTo?: string | null) {
  const admins = await tx<{ email: string; name: string }[]>`
    select distinct u.email::text as email, e.display_name as name from role_assignments ra join roles r on r.id = ra.role_id join employees e on e.id = ra.employee_id join users u on u.id = e.user_id
    where r.key = 'global_admin' and u.status = 'active' and e.status <> 'relieved'`;
  const seen = new Set<string>();
  for (const a of admins) { seen.add(a.email); await queueEmail(tx, tenantId, { kind, to: a.email, ...mail(a.name) }); }
  if (extraTo && !seen.has(extraTo)) await queueEmail(tx, tenantId, { kind, to: extraTo, ...mail("there") });
}

/**
 * Apply one provider event inside the tenant's transaction. Idempotency is the caller's job (webhook_events);
 * this is also safe to replay because every change is a plain "set to the state the event describes".
 */
export async function applyProviderEvent(tx: Tx, tenantId: string, ev: ProviderEvent) {
  if (!ev.subscriptionId) return { applied: false, reason: "no subscription id" };
  const [sub] = await tx<SubscriptionRow[]>`select id, plan, seats, billing_cycle, status, razorpay_subscription_id, current_period_end, created_at from subscriptions where razorpay_subscription_id = ${ev.subscriptionId}`;
  if (!sub) return { applied: false, reason: "subscription not found in this workspace" };
  const t = await tenantRow(tx);
  const periodEnd = ev.currentPeriodEnd ?? sub.current_period_end;
  const set = async (status: SubStatus, tenantStatus: string) => {
    await tx`update subscriptions set status = ${status}, current_period_end = ${periodEnd} where id = ${sub.id}`;
    await tx`update tenants set status = ${tenantStatus}, plan = ${sub.plan}, seats = ${sub.seats}, trial_ends_at = null where id = ${tenantId}`;
  };
  switch (ev.type) {
    case "activated": await set("active", "active"); break;
    case "charged": {
      await set("active", "active");
      if (ev.payment) {
        const [dup] = await tx<{ id: string }[]>`select id from billing_invoices where razorpay_payment_id = ${ev.payment.id}`;
        if (!dup) {
          const now = new Date();
          // the payment carries the total; split out GST the way the quote did (amount + 18%)
          const amount = Math.round((ev.payment.amountPaise * 100) / 118), gst = ev.payment.amountPaise - amount;
          const number = await nextInvoiceNumber(tx, tenantId, now);
          await tx`insert into billing_invoices (tenant_id, subscription_id, number, amount_paise, gst_paise, status, razorpay_payment_id, issued_at, paid_at)
            values (${tenantId}, ${sub.id}, ${number}, ${amount}, ${gst}, 'paid', ${ev.payment.id}, ${now}, ${now})`;
          await notifyAdmins(tx, tenantId, (name) => invoiceEmail({ company: t.name, name, number, total: formatINR(ev.payment!.amountPaise), url: appUrl(t.subdomain, "/settings/billing") }), "billing_invoice", (t.billing.billing_email as string | null) ?? null);
        }
      }
      break;
    }
    case "pending": await set("past_due", "past_due"); break;
    case "halted": await set("halted", "past_due"); break;
    case "cancelled": {
      await tx`update subscriptions set status = 'cancelled', current_period_end = ${periodEnd} where id = ${sub.id}`;
      if (!periodEnd || periodEnd < new Date()) await tx`update tenants set status = 'cancelled' where id = ${tenantId}`;
      break;
    }
    default: return { applied: false, reason: "ignored event type" };
  }
  await tx`insert into audit_logs (tenant_id, entity_type, entity_id, action, diff) values (${tenantId}, 'subscription', ${sub.id}, ${"provider." + ev.type}, ${tx.json({ eventId: ev.id, paymentId: ev.payment?.id ?? null })})`;
  return { applied: true };
}

/** The Billing page's "simulate payment" for the fake provider: posts activated + charged for a created subscription. */
export async function simulateCheckout(tx: Tx, actor: Actor, providerSubscriptionId: string) {
  assertWorkspace(actor, "settings.billing");
  if (billingProvider().name !== "fake") throw new AppError("forbidden", "Checkout is handled by the payment provider.");
  const [sub] = await tx<SubscriptionRow[]>`select id, plan, seats, billing_cycle, status, razorpay_subscription_id, current_period_end, created_at from subscriptions where razorpay_subscription_id = ${providerSubscriptionId}`;
  if (!sub) throw new AppError("not_found", "That checkout doesn't exist.");
  if (sub.status !== "created") throw new AppError("conflict", "This subscription is already active.");
  const end = new Date(); end.setMonth(end.getMonth() + BILLING_CYCLES[sub.billing_cycle].months);
  const total = quote(sub.plan, sub.seats, sub.billing_cycle).totalPaise;
  const base = { subscriptionId: providerSubscriptionId, tenantId: actor.tenant.id, currentPeriodEnd: end, raw: null };
  await applyProviderEvent(tx, actor.tenant.id, { ...base, id: `${providerSubscriptionId}:activated`, type: "activated", payment: null });
  await applyProviderEvent(tx, actor.tenant.id, { ...base, id: `${providerSubscriptionId}:charged`, type: "charged", payment: { id: `fake_pay_${providerSubscriptionId.slice(-8)}`, amountPaise: total } });
}

/** Seat sync (nightly): billed seats follow the active headcount, never below the plan minimum. */
export async function syncSeats(tx: Tx, tenantId: string) {
  const sub = await currentSubscription(tx);
  if (!sub || sub.status === "created") return { changed: false };
  const seats = quote(sub.plan, await activeHeadcount(tx), sub.billing_cycle).billedSeats;
  if (seats === sub.seats) return { changed: false };
  if (sub.razorpay_subscription_id) await billingProvider().updateSubscription(sub.razorpay_subscription_id, { plan: sub.plan, cycle: sub.billing_cycle, seats });
  await tx`update subscriptions set seats = ${seats} where id = ${sub.id}`;
  await tx`update tenants set seats = ${seats} where id = ${tenantId}`;
  await tx`insert into audit_logs (tenant_id, entity_type, entity_id, action, diff) values (${tenantId}, 'subscription', ${sub.id}, 'seats.sync', ${tx.json({ seats: { old: sub.seats, new: seats } })})`;
  return { changed: true, seats };
}

/** Status sync (nightly): ask the provider where the subscription stands, in case a webhook was missed. */
export async function syncStatus(tx: Tx, tenantId: string) {
  const sub = await currentSubscription(tx);
  if (!sub?.razorpay_subscription_id) return { changed: false };
  const remote = await billingProvider().fetchSubscription(sub.razorpay_subscription_id);
  if (!remote || remote.status === sub.status) return { changed: false };
  const type = remote.status === "active" ? "activated" : remote.status === "past_due" ? "pending" : remote.status === "halted" ? "halted" : remote.status === "cancelled" ? "cancelled" : "other";
  await applyProviderEvent(tx, tenantId, { id: `sync:${sub.id}:${Date.now()}`, type, subscriptionId: sub.razorpay_subscription_id, tenantId, currentPeriodEnd: remote.currentPeriodEnd, payment: null, raw: null });
  return { changed: true, status: remote.status };
}

/** Trial reminders (nightly): 7 days, 1 day, ended. Ending a trial without a subscription suspends plan features. */
export async function trialReminders(tx: Tx, tenantId: string, now = new Date()) {
  const t = await tenantRow(tx);
  if (t.status !== "trial") return { sent: null };
  const sent = Array.isArray(t.billing.reminders_sent) ? (t.billing.reminders_sent as string[]) : [];
  const due = dueTrialReminder(trialDaysLeft(t.trial_ends_at, now), sent);
  if (!due) return { sent: null };
  await notifyAdmins(tx, tenantId, (name) => trialEmail({ company: t.name, name, kind: due, url: appUrl(t.subdomain, "/settings/billing") }), "trial_" + due);
  await tx`update tenants set billing = billing || ${tx.json({ reminders_sent: [...sent, due] })}${due === "ended" ? tx`, status = 'suspended'` : tx``} where id = ${tenantId}`;
  await tx`insert into audit_logs (tenant_id, entity_type, entity_id, action, diff) values (${tenantId}, 'tenant', ${tenantId}, 'trial.reminder', ${tx.json({ kind: due })})`;
  return { sent: due };
}

export const canSeeBilling = (actor: Actor) => canWorkspace(actor, "settings.billing");
