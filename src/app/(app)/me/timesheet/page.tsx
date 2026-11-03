import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { myWeek, myWeeks, pendingForMe } from "@/server/modules/psa/service";
import { isWeekStart, weekStartOf } from "@/server/modules/psa/rules";
import { todayIn } from "@/lib/dates";
import { PageHeader } from "@/ui/app-shell";
import { TimesheetGrid } from "@/features/psa/timesheet-grid";

export const metadata: Metadata = { title: "My timesheet" };

export default async function MyTimesheetPage(props: PageProps<"/me/timesheet">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => {
    const today = todayIn();   // clock read after the session read
    const week = typeof sp.week === "string" && isWeekStart(sp.week) ? sp.week : weekStartOf(today);
    const [view, recent, toApprove] = await Promise.all([myWeek(tx, actor, week, today), myWeeks(tx, actor), pendingForMe(tx, actor)]);
    return { view, recent, toApprove, today };
  });
  return (
    <>
      <PageHeader title="My timesheet" description="Log your hours by project for each day, then submit the week for approval." />
      <TimesheetGrid key={d.view.weekStart + d.view.status} view={d.view} today={d.today} recent={d.recent} toApprove={d.toApprove} />
    </>
  );
}
