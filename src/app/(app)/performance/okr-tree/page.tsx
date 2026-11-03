import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { isPerfAdmin } from "@/server/modules/performance/access";
import { currentPeriod, listPeriods, okrTree } from "@/server/modules/performance/goals";
import { AdminHeader } from "@/features/performance/admin-header";
import { OkrTree } from "@/features/performance/okr-tree";

export const metadata: Metadata = { title: "Alignment tree" };

export default async function OkrTreePage(props: PageProps<"/performance/okr-tree">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => {
    const periods = await listPeriods(tx);
    const periodId = typeof sp.period === "string" && periods.some((p) => p.id === sp.period) ? sp.period : (await currentPeriod(tx))?.id ?? null;
    return { admin: isPerfAdmin(actor), goals: await okrTree(tx, actor, periodId), periods, periodId };
  });
  return (
    <>
      <AdminHeader title="Alignment tree" description="How company, department and individual goals connect. Progress rolls up from the bottom." admin={d.admin} />
      <OkrTree goals={d.goals} periods={d.periods} periodId={d.periodId} />
    </>
  );
}
