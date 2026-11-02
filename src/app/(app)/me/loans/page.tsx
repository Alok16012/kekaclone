import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { myLoans } from "@/server/modules/loans/service";
import { todayIn } from "@/lib/dates";
import { PageHeader } from "@/ui/app-shell";
import { MyLoans } from "@/features/loans/my-loans";

export const metadata: Metadata = { title: "My loans" };

export default async function MyLoansPage() {
  const d = await load((tx, actor) => myLoans(tx, actor));
  return (
    <>
      <PageHeader title="My loans" description="Company loans and salary advances, with what you still owe and your EMI schedule." />
      <MyLoans loans={d.loans} categories={d.categories} today={todayIn()} />
    </>
  );
}
