import type { Metadata } from "next";
import { Lock } from "lucide-react";
import { load } from "@/server/page-data";
import { expenseReport } from "@/server/modules/expenses/service";
import { reportRange } from "@/server/modules/expenses/rules";
import { todayIn } from "@/lib/dates";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { ExpenseReports } from "@/features/expenses/reports";
import { DeskHeader, deskAccess } from "../desk";

export const metadata: Metadata = { title: "Expense reports" };

export default async function ExpenseReportsPage(props: PageProps<"/expenses/reports">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => {
    const show = deskAccess(actor);
    const range = reportRange(typeof sp.from === "string" ? sp.from : null, typeof sp.to === "string" ? sp.to : null, todayIn());
    const includePending = sp.pending === "1";
    return { show, range, includePending, report: show.reports ? await expenseReport(tx, actor, { ...range, includePending }) : null };
  });
  return (
    <>
      <DeskHeader show={d.show} description="Where the money goes: totals by category, department and month." />
      {!d.report
        ? <Card><EmptyState icon={<Lock />} title="You don't have access to expense reports" description="Finance and report readers see them here." /></Card>
        : <ExpenseReports summary={d.report.summary} from={d.range.from} to={d.range.to} includePending={d.includePending} />}
    </>
  );
}
