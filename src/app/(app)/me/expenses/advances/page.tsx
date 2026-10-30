import type { Metadata } from "next";
import Link from "next/link";
import { load } from "@/server/page-data";
import { myAdvances } from "@/server/modules/expenses/service";
import { policyFor } from "@/server/modules/expenses/admin";
import { PageHeader } from "@/ui/app-shell";
import { MyAdvances } from "@/features/expenses/advances";

export const metadata: Metadata = { title: "Expense advances" };

export default async function AdvancesPage() {
  const d = await load(async (tx, actor) => ({ advances: await myAdvances(tx, actor), policy: await policyFor(tx, actor.employeeId) }));
  return (
    <>
      <PageHeader title="Advances" breadcrumb={<Link href="/me/expenses" className="hover:underline">Expenses</Link>} />
      <MyAdvances advances={d.advances} maxPaise={d.policy?.advance.max_paise ?? null} dueDays={d.policy?.advance.receipts_due_days ?? null} />
    </>
  );
}
