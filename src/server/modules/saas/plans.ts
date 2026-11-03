/**
 * erp's own plans and what each one unlocks. Pure: shared by server checks, the nav/palette and the Billing page.
 * Prices are per employee per month in paise (billed quarterly or yearly). One place to change the table.
 */
export type Plan = "core" | "plus" | "pro";
export const PLANS: Plan[] = ["core", "plus", "pro"];

export type Feature =
  | "sso" | "custom_roles" | "workflow_builder" | "report_builder" | "performance" | "hire"
  | "api" | "webhooks" | "integrations" | "branding" | "ip_allowlist" | "mobile_otp" | "accounting_export";

export type PlanDef = {
  key: Plan; name: string; tagline: string;
  /** per employee per month, paise */
  pricePaise: number;
  minSeats: number;
  features: Feature[];
};

export const PLAN_DEFS: Record<Plan, PlanDef> = {
  core: {
    key: "core", name: "Core", tagline: "People, leave, attendance and payroll for growing teams.",
    pricePaise: 6_000, minSeats: 25,
    features: ["mobile_otp"],
  },
  plus: {
    key: "plus", name: "Plus", tagline: "Adds single sign-on, custom roles, branding and integrations.",
    pricePaise: 9_900, minSeats: 25,
    features: ["mobile_otp", "sso", "custom_roles", "branding", "integrations", "performance", "hire", "accounting_export"],
  },
  pro: {
    key: "pro", name: "Pro", tagline: "Everything, plus the public API, webhooks, workflow and report builders.",
    pricePaise: 13_900, minSeats: 25,
    features: ["mobile_otp", "sso", "custom_roles", "branding", "integrations", "performance", "hire", "accounting_export", "api", "webhooks", "workflow_builder", "report_builder", "ip_allowlist"],
  },
};

export const FEATURE_LABELS: Record<Feature, string> = {
  sso: "Single sign-on (Google, Microsoft)", custom_roles: "Custom roles", workflow_builder: "Workflow builder", report_builder: "Report builder",
  performance: "Performance (OKRs, reviews)", hire: "Hiring (ATS)", api: "Public API", webhooks: "Webhooks", integrations: "Slack, Teams and calendar integrations",
  branding: "Company branding", ip_allowlist: "IP allowlist", mobile_otp: "Mobile OTP sign-in", accounting_export: "Accounting export (Tally, Zoho)",
};

export const BILLING_CYCLES = { monthly: { label: "Monthly", months: 1 }, quarterly: { label: "Quarterly", months: 3 }, yearly: { label: "Yearly", months: 12 } } as const;
export type BillingCycle = keyof typeof BILLING_CYCLES;
export const GST_PERCENT = 18;

export const isPlan = (v: unknown): v is Plan => typeof v === "string" && (PLANS as string[]).includes(v);

/** Unknown plan (a script's partial tenant object) means no gate; real actors always carry the plan. */
export function featureAllowed(plan: string | null | undefined, feature: Feature) {
  if (!isPlan(plan)) return true;
  return PLAN_DEFS[plan].features.includes(feature);
}

/** The cheapest plan that has this feature (for "available on Plus" messages). */
export function planFor(feature: Feature): Plan {
  return PLANS.find((p) => PLAN_DEFS[p].features.includes(feature)) ?? "pro";
}

export function planRank(plan: string | null | undefined) { return isPlan(plan) ? PLANS.indexOf(plan) : 0; }

/** Why this workspace can't use a feature right now (null = it can). Suspended or cancelled workspaces lose every gated feature. */
export function featureProblem(tenant: { plan?: string | null; status?: string | null }, feature: Feature): string | null {
  if (tenant.status === "suspended" || tenant.status === "cancelled") return "This workspace's subscription is not active. Ask an admin to check Settings → Billing.";
  if (!featureAllowed(tenant.plan, feature)) return `${FEATURE_LABELS[feature]} is available on the ${PLAN_DEFS[planFor(feature)].name} plan. Upgrade in Settings → Billing.`;
  return null;
}

/** Subscription price for a seat count and cycle: base + GST, in paise. Seats below the plan minimum are billed at the minimum. */
export function quote(plan: Plan, seats: number, cycle: BillingCycle) {
  const def = PLAN_DEFS[plan];
  const billedSeats = Math.max(def.minSeats, Math.max(0, Math.floor(seats)));
  const months = BILLING_CYCLES[cycle].months;
  const base = def.pricePaise * billedSeats * months;
  const discount = cycle === "yearly" ? Math.round(base * 0.1) : 0;   // two months free-ish: 10% off yearly
  const amount = base - discount;
  const gst = Math.round((amount * GST_PERCENT) / 100);
  return { billedSeats, months, basePaise: base, discountPaise: discount, amountPaise: amount, gstPaise: gst, totalPaise: amount + gst };
}

/** Days of trial left (negative when over). Pure: pass the clock in. */
export function trialDaysLeft(trialEndsAt: Date | string | null | undefined, now: Date) {
  if (!trialEndsAt) return null;
  const end = typeof trialEndsAt === "string" ? new Date(trialEndsAt) : trialEndsAt;
  return Math.ceil((end.getTime() - now.getTime()) / 864e5);
}

/** Which trial reminder (7 days, 1 day, ended) is due today and hasn't been sent yet. */
export function dueTrialReminder(daysLeft: number | null, sent: string[]): "7d" | "1d" | "ended" | null {
  if (daysLeft === null) return null;
  if (daysLeft <= 0) return sent.includes("ended") ? null : "ended";
  if (daysLeft <= 1) return sent.includes("1d") ? null : "1d";
  if (daysLeft <= 7) return sent.includes("7d") ? null : "7d";
  return null;
}
