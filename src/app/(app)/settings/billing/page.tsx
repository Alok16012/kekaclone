import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { billingOverview, canSeeBilling } from "@/server/modules/billing/service";
import { BillingPage } from "@/features/saas/billing-ui";
import { EmptyState } from "@/ui/feedback";

export const metadata: Metadata = { title: "Billing" };

export default async function Billing(props: PageProps<"/settings/billing">) {
  const sp = await props.searchParams;
  const checkout = typeof sp.checkout === "string" ? sp.checkout : null;
  const d = await load(async (tx, actor) => (canSeeBilling(actor) ? billingOverview(tx, actor) : null));
  if (!d) return <EmptyState title="Billing is for workspace admins" description="Ask a Global admin if you need to see the plan or invoices." />;
  return <BillingPage data={d} checkout={checkout} />;
}
