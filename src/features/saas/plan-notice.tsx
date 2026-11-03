import Link from "next/link";
import { connection } from "next/server";
import { getActor } from "@/server/auth/session";
import { canWorkspace } from "@/server/modules/saas/gate";
import { trialDaysLeft } from "@/server/modules/saas/plans";
import { Banner } from "@/ui/feedback";

/** Trial countdown / payment problem banner, shown to billing admins only. Reads the tenant row already on the actor. */
export async function PlanNotice() {
  await connection();   // per request: the countdown reads the clock
  const actor = await getActor();
  if (!actor || !canWorkspace(actor, "settings.billing")) return null;
  const t = actor.tenant;
  const link = <Link href="/settings/billing" className="font-medium underline">Open Billing</Link>;
  if (t.status === "trial") {
    const left = trialDaysLeft(t.trialEndsAt, new Date());
    if (left === null || left > 7) return null;
    return (
      <div className="mb-4">
        <Banner tone={left <= 1 ? "danger" : "warning"} title={left <= 0 ? "Your free trial has ended" : `Your free trial ends in ${left} ${left === 1 ? "day" : "days"}`} action={link}>
          Pick a plan to keep everyone signed in. Your data stays safe either way.
        </Banner>
      </div>
    );
  }
  if (t.status === "past_due") return <div className="mb-4"><Banner tone="danger" title="A payment is overdue" action={link}>Update the payment method so the subscription stays active.</Banner></div>;
  if (t.status === "suspended") return <div className="mb-4"><Banner tone="danger" title="This workspace is suspended" action={link}>Plan features are switched off until the subscription is active again.</Banner></div>;
  return null;
}
