import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { loanDesk } from "@/server/modules/loans/service";
import { hasAnyPayrollAdmin, isPayrollAdmin } from "@/server/modules/payroll/access";
import { listPayGroups } from "@/server/modules/payroll/setup";
import { todayIn } from "@/lib/dates";
import { PageHeader } from "@/ui/app-shell";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { LoanDesk } from "@/features/loans/desk";
import { ShieldOff } from "lucide-react";

export const metadata: Metadata = { title: "Loans desk" };

export default async function LoanDeskPage() {
  const d = await load(async (tx, actor) => {
    if (!hasAnyPayrollAdmin(actor)) return null;
    const [loans, groups] = await Promise.all([loanDesk(tx, actor), listPayGroups(tx)]);
    return { loans, payGroups: groups.map((g) => ({ id: g.id, name: g.name })), companyWide: isPayrollAdmin(actor) };
  });
  return (
    <>
      <PageHeader title="Loans desk" description="Pay out approved loans, follow repayments, skip an EMI or record money paid back." />
      {!d ? (
        <Card><EmptyState icon={<ShieldOff />} title="You don't have access to loans" description="Payroll admins manage employee loans." /></Card>
      ) : <LoanDesk loans={d.loans} payGroups={d.payGroups} today={todayIn()} companyWide={d.companyWide} />}
    </>
  );
}
