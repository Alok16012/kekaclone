import type { Metadata } from "next";
import { ShieldOff } from "lucide-react";
import { load } from "@/server/page-data";
import { declarationsOverview, form16List, fyOptions, listTaxSettings, proofQueue } from "@/server/modules/tax/service";
import { fyLabel, fyStartFromLabel, fyStartOf } from "@/server/modules/tax/rules";
import { hasAnyPayrollAdmin, isPayrollAdmin } from "@/server/modules/payroll/access";
import { verificationStatus } from "@/server/modules/statutory/service";
import { todayIn } from "@/lib/dates";
import { PageHeader } from "@/ui/app-shell";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { UnverifiedRatesBanner } from "@/features/statutory/rates-banner";
import { TaxDesk } from "@/features/tax/admin";

export const metadata: Metadata = { title: "Income tax desk" };
const TABS = ["proofs", "declarations", "form16", "windows"] as const;

export default async function TaxDeskPage(props: PageProps<"/payroll/tax">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => {
    if (!hasAnyPayrollAdmin(actor)) return null;
    const today = todayIn();
    const fy = (typeof sp.fy === "string" && fyStartFromLabel(sp.fy)) || fyStartOf(today);
    const [pending, reviewed, people, form16, settings, status] = await Promise.all([
      proofQueue(tx, actor, fy, "submitted"), proofQueue(tx, actor, fy, "reviewed"), declarationsOverview(tx, actor, fy), form16List(tx, actor, fy), listTaxSettings(tx), verificationStatus(tx),
    ]);
    return { fy, fyLabel: fyLabel(fy), fyOptions: fyOptions(today, "2000-04-01"), today, pending, reviewed, people, form16, settings, companyWide: isPayrollAdmin(actor), status };
  });
  if (!d) {
    return (
      <>
        <PageHeader title="Income tax desk" />
        <Card><EmptyState icon={<ShieldOff />} title="You don't have access to the tax desk" description="Payroll admins check tax proofs and share Form 16." /></Card>
      </>
    );
  }
  const tab = TABS.find((t) => t === sp.tab) ?? "proofs";
  return (
    <>
      <PageHeader title="Income tax desk" description="Check proofs, follow declarations, share Form 16 and set when people can declare." />
      <div className="mb-6"><UnverifiedRatesBanner status={d.status} /></div>
      <TaxDesk d={{ fy: d.fy, fyLabel: d.fyLabel, fyOptions: d.fyOptions, today: d.today, companyWide: d.companyWide, pending: d.pending, reviewed: d.reviewed, people: d.people, form16: d.form16, settings: d.settings }} tab={tab} />
    </>
  );
}
