import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { isPerfAdmin, peopleOptions, perfAdminFor, reportIds, EVERYWHERE } from "@/server/modules/performance/access";
import { alignableGoals, currentPeriod, listGoals, listPeriods } from "@/server/modules/performance/goals";
import { getSettings } from "@/server/modules/performance/settings";
import { GoalsView } from "@/features/performance/goals-view";
import { todayIn } from "@/lib/dates";

export const metadata: Metadata = { title: "Goals" };

export default async function GoalsPage(props: PageProps<"/me/performance">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => {
    const periods = await listPeriods(tx);
    const cur = await currentPeriod(tx);
    const periodId = typeof sp.period === "string" && periods.some((p) => p.id === sp.period) ? sp.period : cur?.id ?? null;
    const [mine, team, department, company, align, settings, reports, people, depts] = await Promise.all([
      listGoals(tx, actor, "mine", periodId), listGoals(tx, actor, "team", periodId), listGoals(tx, actor, "department", periodId), listGoals(tx, actor, "company", periodId),
      alignableGoals(tx, actor, periodId), getSettings(tx), reportIds(tx, actor.employeeId), peopleOptions(tx),
      tx<{ id: string; name: string }[]>`select id, name from departments order by name`,
    ]);
    const reportSet = new Set(reports);
    return {
      periods, periodId, mine, team, department, company, align, goalMode: settings.goalMode, me: actor.employeeId,
      owners: people.filter((p) => p.id === actor.employeeId || reportSet.has(p.id)),
      departments: depts.filter((x) => perfAdminFor(actor, { ...EVERYWHERE, department_id: x.id })),
      canCompany: isPerfAdmin(actor), hasTeam: reports.length > 0,
    };
  });
  const tab = typeof sp.tab === "string" && ["mine", "team", "department", "company"].includes(sp.tab) ? sp.tab : "mine";
  return <GoalsView {...d} initialTab={tab} openNew={sp.new === "1"} today={todayIn()} />;
}
