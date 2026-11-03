import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { isPerfAdmin, reportIds } from "@/server/modules/performance/access";
import { currentPeriod, insights, listPeriods } from "@/server/modules/performance/goals";
import { AdminHeader } from "@/features/performance/admin-header";
import { GoalInsights } from "@/features/performance/goal-insights";
import { NoAccess } from "@/features/performance/no-access";

export const metadata: Metadata = { title: "Goal insights" };

export default async function InsightsPage(props: PageProps<"/performance/insights">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => {
    const admin = isPerfAdmin(actor);
    if (!admin && !(await reportIds(tx, actor.employeeId)).length) return { admin, data: null, periods: [], periodId: null };
    const periods = await listPeriods(tx);
    const periodId = typeof sp.period === "string" && periods.some((p) => p.id === sp.period) ? sp.period : (await currentPeriod(tx))?.id ?? null;
    return { admin, data: await insights(tx, actor, periodId), periods, periodId };
  });
  if (!d.data) return <><AdminHeader title="Goal insights" admin={d.admin} /><NoAccess what="Goal insights for a team" /></>;
  return (
    <>
      <AdminHeader title="Goal insights" description={d.data.isAdmin ? "Goals across the company" : "Goals across your team"} admin={d.admin} />
      <GoalInsights data={d.data} periods={d.periods} periodId={d.periodId} />
    </>
  );
}
