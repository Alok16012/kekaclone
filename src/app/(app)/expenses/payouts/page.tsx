import type { Metadata } from "next";
import { Lock } from "lucide-react";
import { load } from "@/server/page-data";
import { payoutQueue } from "@/server/modules/expenses/service";
import { upcomingMonths } from "@/server/modules/expenses/rules";
import { todayIn } from "@/lib/dates";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { Payouts } from "@/features/expenses/payouts";
import { DeskHeader, deskAccess } from "../desk";

export const metadata: Metadata = { title: "Expense payouts" };

export default async function ExpensePayoutsPage() {
  const d = await load(async (tx, actor) => {
    const show = deskAccess(actor);
    return { show, selfId: actor.employeeId, queue: show.payouts ? await payoutQueue(tx, actor) : null };
  });
  return (
    <>
      <DeskHeader show={d.show} description="Pay approved claims with salary or off-cycle, and handle advances." />
      {!d.queue
        ? <Card><EmptyState icon={<Lock />} title="You don't pay out expenses" description="Finance pays approved claims here. Ask an admin if you need access." /></Card>
        : <Payouts claims={d.queue.claims} advances={d.queue.advances} months={upcomingMonths(todayIn(), 4)} selfId={d.selfId} />}
    </>
  );
}
