import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { hiringReport } from "@/server/modules/hire/reports";
import { addDaysISO, todayIn } from "@/lib/dates";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { HiringReports } from "@/features/hire/reports";
import { HireHeader, hireTabs } from "../header";

export const metadata: Metadata = { title: "Hiring reports" };

export default async function ReportsPage(props: PageProps<"/hire/reports">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => {
    const tabs = await hireTabs(tx, actor);
    const today = todayIn();
    const iso = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    const range = { from: iso(sp.from) ?? addDaysISO(today, -180), to: iso(sp.to) ?? today, jobId: typeof sp.job === "string" ? sp.job : null };
    return { tabs, range, report: tabs.reports ? await hiringReport(tx, actor, range) : null };
  });
  return (
    <>
      <HireHeader tabs={d.tabs} title="Hiring reports" description="Funnel, sources, time to hire and offer acceptance for jobs you can see." />
      {!d.report ? <Card><EmptyState title="You're not on any hiring team" /></Card> : <HiringReports report={d.report} range={d.range} />}
    </>
  );
}
