import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { probationList } from "@/server/modules/corehr/lifecycle";
import { todayIn } from "@/lib/dates";
import { PageHeader } from "@/ui/app-shell";
import { ProbationBoard } from "@/features/corehr/probation-board";

export const metadata: Metadata = { title: "Probation" };

export default async function ProbationPage() {
  const rows = await load((tx, actor) => probationList(tx, actor));
  return (
    <>
      <PageHeader title="Probation" breadcrumb="People" description="People on probation in your teams. Policies that auto-confirm do so the day after the end date." />
      <ProbationBoard rows={rows.map((r) => ({ id: r.id, name: r.name, title: r.title, department: r.department, manager: r.manager, joining_date: r.joining_date, probation_end_date: r.probation_end_date, probation_status: r.probation_status, policy: r.policy, auto_confirm: r.auto_confirm, bucket: r.bucket }))} today={todayIn()} />
    </>
  );
}
