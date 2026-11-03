"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, CreditCard, Download, Users } from "lucide-react";
import { Button } from "@/ui/button";
import { Card, CardBody, CardHeader, StatTile } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Banner, EmptyState } from "@/ui/feedback";
import { Field, Input, formatINR } from "@/ui/field";
import { Segmented } from "@/ui/choice";
import { ConfirmDialog } from "@/ui/overlay";
import { DataTable } from "@/ui/table";
import { toast } from "@/ui/toast";
import { cn } from "@/lib/cn";
import { BILLING_CYCLES, FEATURE_LABELS, planRank, type BillingCycle } from "@/server/modules/saas/plans";
import type { billingOverview } from "@/server/modules/billing/service";
import { cancelSubscriptionAction, changePlanAction, saveBillingDetailsAction, simulateCheckoutAction, startCheckoutAction } from "@/app/(app)/settings/billing/actions";

type Data = Awaited<ReturnType<typeof billingOverview>>;
const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "—");
const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = { trial: "warning", active: "success", past_due: "danger", suspended: "danger", cancelled: "neutral" };
const STATUS_LABEL: Record<string, string> = { trial: "Free trial", active: "Active", past_due: "Payment overdue", suspended: "Suspended", cancelled: "Cancelled" };

/** Settings → Billing: plan, seats, trial state, checkout, invoices and GST details. */
export function BillingPage({ data, checkout }: { data: Data; checkout: string | null }) {
  const [cycle, setCycle] = React.useState<BillingCycle>((data.subscription?.billing_cycle as BillingCycle) ?? "quarterly");
  const sub = data.subscription;
  const live = sub && sub.status !== "created";
  return (
    <div className="flex flex-col gap-4">
      {!data.provider.configured && (
        <Banner tone="warning" title="Billing not configured">Payments are simulated on this server. To take real payments, add {data.provider.hint}.</Banner>
      )}
      {checkout && sub?.razorpay_subscription_id === checkout && sub.status === "created" && !data.provider.configured && <FakeCheckout id={checkout} />}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile label="Plan" value={<span className="flex items-center gap-2">{data.plans.find((p) => p.key === data.tenant.plan)?.name ?? data.tenant.plan}<Badge tone={STATUS_TONE[data.tenant.status] ?? "neutral"}>{STATUS_LABEL[data.tenant.status] ?? data.tenant.status}</Badge></span>}
          hint={data.tenant.status === "trial" && data.tenant.trialDaysLeft !== null ? (data.tenant.trialDaysLeft > 0 ? `Trial ends ${date(data.tenant.trialEndsAt)} (${data.tenant.trialDaysLeft} days)` : "Trial has ended") : live ? `Renews ${date(sub.current_period_end)} · ${BILLING_CYCLES[sub.billing_cycle].label.toLowerCase()}` : undefined} icon={<CreditCard />} />
        <StatTile label="People" value={data.headcount} hint="Active employees today" icon={<Users />} />
        <StatTile label="Billed seats" value={live ? sub.seats : data.tenant.seats} hint={live ? "Synced to headcount nightly (plan minimum 25)" : "Seats are counted when you subscribe"} />
      </div>

      <Card>
        <CardHeader title={live ? "Change plan" : "Choose a plan"} description="Per employee per month. Billed in advance for the cycle; GST at 18% is added."
          action={!live ? <Segmented value={cycle} onChange={setCycle} label="Billing cycle" options={(Object.keys(BILLING_CYCLES) as BillingCycle[]).map((c) => ({ value: c, label: BILLING_CYCLES[c].label }))} /> : undefined} />
        <CardBody className="grid gap-3 lg:grid-cols-3">
          {data.plans.map((p) => <PlanCard key={p.key} plan={p} cycle={live ? (sub.billing_cycle as BillingCycle) : cycle} current={live ? sub.plan === p.key : data.tenant.plan === p.key && data.tenant.status !== "trial"} live={!!live} currentRank={planRank(live ? sub.plan : null)} />)}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Invoices" description="GST invoices for every payment. Open one to download the PDF." />
        {data.invoices.length === 0 ? <CardBody><EmptyState compact title="No invoices yet" description="Invoices appear here after the first payment." /></CardBody> : (
          <DataTable caption="Invoices" rows={data.invoices} rowKey={(r) => r.id} columns={[
            { key: "number", header: "Invoice", cell: (r) => <span className="font-medium tabular">{r.number}</span> },
            { key: "issued", header: "Date", cell: (r) => date(r.issued_at), sortValue: (r) => r.issued_at },
            { key: "amount", header: "Amount", align: "right", cell: (r) => <span className="tabular">{formatINR(r.amount_paise)}</span> },
            { key: "gst", header: "GST", align: "right", hideBelow: "md", cell: (r) => <span className="tabular">{formatINR(r.gst_paise)}</span> },
            { key: "total", header: "Total", align: "right", cell: (r) => <span className="font-medium tabular">{formatINR(r.amount_paise + r.gst_paise)}</span> },
            { key: "status", header: "Status", cell: (r) => <Badge tone={r.status === "paid" ? "success" : r.status === "failed" ? "danger" : "neutral"}>{r.status}</Badge> },
            { key: "pdf", header: <span className="sr-only">Download</span>, align: "right", cell: (r) => <a href={`/settings/billing/invoices/${r.id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent-text hover:underline"><Download className="size-4" aria-hidden />PDF</a> },
          ]} />
        )}
      </Card>

      <BillingDetails gstin={data.tenant.gstin} email={data.tenant.billingEmail} />

      {live && (
        <Card>
          <CardHeader title="Cancel subscription" description="The plan stays on until the end of the paid period. Your data stays; after that, plan features switch off." />
          <CardBody>
            <ConfirmDialog trigger={<Button variant="danger">Cancel subscription</Button>} title="Cancel the subscription?" description={`It stays active until ${date(sub.current_period_end)}. You can subscribe again any time.`} confirmLabel="Cancel subscription"
              onConfirm={async () => { const r = await cancelSubscriptionAction(); if (r.ok) toast.success("Subscription cancelled"); else toast.error(r.error); }} />
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function PlanCard({ plan, cycle, current, live, currentRank }: { plan: Data["plans"][number]; cycle: BillingCycle; current: boolean; live: boolean; currentRank: number }) {
  const [pending, start] = React.useTransition();
  const q = plan.quotes[cycle];
  const rank = planRank(plan.key);
  const label = current ? "Current plan" : live ? (rank > currentRank ? `Upgrade to ${plan.name}` : `Move to ${plan.name}`) : `Start ${plan.name}`;
  return (
    <div className={cn("flex flex-col gap-3 rounded-lg border p-4", current ? "border-accent bg-accent-soft/40" : "border-border")}>
      <div>
        <p className="text-md font-semibold">{plan.name}</p>
        <p className="text-sm text-text-muted">{plan.tagline}</p>
      </div>
      <p><span className="text-2xl font-semibold tabular">{formatINR(plan.pricePaise, { decimals: 0 })}</span><span className="text-sm text-text-muted"> / employee / month</span></p>
      <p className="text-sm text-text-muted">{q.billedSeats} seats × {q.months} {q.months === 1 ? "month" : "months"} = <span className="tabular">{formatINR(q.amountPaise, { decimals: 0 })}</span> + GST {formatINR(q.gstPaise, { decimals: 0 })}{q.discountPaise ? " (10% yearly discount applied)" : ""}</p>
      <ul className="flex flex-col gap-1 text-sm">
        {plan.features.map((f) => <li key={f} className="flex items-start gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />{FEATURE_LABELS[f]}</li>)}
        {plan.key === "core" && <li className="flex items-start gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />People, leave, attendance, payroll, expenses, helpdesk</li>}
      </ul>
      <Button variant={current ? "secondary" : "primary"} disabled={current} loading={pending} className="mt-auto" onClick={() => start(async () => {
        if (live) { const r = await changePlanAction(plan.key); if (r.ok) toast.success(`Moved to ${plan.name}`); else toast.error(r.error); return; }
        const r = await startCheckoutAction(plan.key, cycle);
        if (!r.ok) { toast.error(r.error); return; }
        if (r.data?.checkoutUrl) window.location.assign(r.data.checkoutUrl); else toast.error("The provider didn't return a checkout link.");
      })}>{label}</Button>
    </div>
  );
}

/** Stand-in for the provider's hosted checkout when billing isn't configured. */
function FakeCheckout({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  return (
    <Banner tone="info" title="Simulated checkout" action={<Button size="sm" loading={pending} onClick={() => start(async () => {
      const r = await simulateCheckoutAction(id);
      if (r.ok) { toast.success("Payment recorded"); router.replace("/settings/billing"); } else toast.error(r.error);
    })}>Simulate successful payment</Button>}>
      A real provider would show its payment page here. Click to post the same events (activated, charged) a payment would.
    </Banner>
  );
}

function BillingDetails({ gstin, email }: { gstin: string; email: string }) {
  const [form, setForm] = React.useState({ gstin, billingEmail: email });
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  return (
    <Card>
      <CardHeader title="Billing details" description="Shown on invoices." />
      <CardBody className="flex flex-col gap-3">
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="GSTIN (optional)" error={error?.field === "gstin" ? error.message : undefined}><Input value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value })} placeholder="29ABCDE1234F1Z5" maxLength={15} /></Field>
          <Field label="Invoice email" error={error?.field === "billingEmail" ? error.message : undefined}><Input type="email" value={form.billingEmail} onChange={(e) => setForm({ ...form, billingEmail: e.target.value })} /></Field>
        </div>
        <div><Button variant="secondary" loading={pending} onClick={() => start(async () => { setError(null); const r = await saveBillingDetailsAction(form); if (r.ok) toast.success("Billing details saved"); else setError({ message: r.error, field: r.field }); })}>Save details</Button></div>
      </CardBody>
    </Card>
  );
}
