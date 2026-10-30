import type { Metadata } from "next";
import Link from "next/link";
import { load } from "@/server/page-data";
import { approvalQueue, myExpenses } from "@/server/modules/expenses/service";
import { hasAnywhere, EXP_APPROVE, EXP_PAYOUT } from "@/server/modules/expenses/access";
import { todayIn } from "@/lib/dates";
import { PageHeader } from "@/ui/app-shell";
import { Banner } from "@/ui/feedback";
import { MyExpenses } from "@/features/expenses/my-expenses";

export const metadata: Metadata = { title: "Expenses" };

export default async function MyExpensesPage(props: PageProps<"/me/expenses">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => {
    const [mine, queue] = await Promise.all([myExpenses(tx, actor), approvalQueue(tx, actor)]);
    return { ...mine, waiting: queue.filter((q) => q.mine).length, desk: hasAnywhere(actor, EXP_APPROVE) || hasAnywhere(actor, EXP_PAYOUT) };
  });
  return (
    <>
      <PageHeader title="Expenses" description={d.policy ? `Claim money you spent on work. Your policy: ${d.policy.name}.` : "Claim money you spent on work."} />
      {(d.waiting > 0 || d.desk) && (
        <Banner className="mb-6" action={<Link className="shrink-0 font-medium underline underline-offset-4" href="/expenses/approvals">Open the expense desk</Link>}>
          {d.waiting > 0 ? `${d.waiting} expense ${d.waiting === 1 ? "request is" : "requests are"} waiting for your approval.` : "You review or pay out expenses for your team."}
        </Banner>
      )}
      <MyExpenses startAdding={sp.add === "1"} d={{ categories: d.policy?.categories ?? [], policyName: d.policy?.name ?? null, unclaimed: d.unclaimed, claims: d.claims, advances: d.advances, today: todayIn() }} />
    </>
  );
}
