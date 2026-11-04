import type { Metadata } from "next";
import { ShieldAlert } from "lucide-react";
import { load } from "@/server/page-data";
import { AppError } from "@/server/db";
import { peopleAnalytics } from "@/server/modules/corehr/analytics";
import { PageHeader } from "@/ui/app-shell";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { PeopleAnalytics } from "@/features/corehr/people-analytics";

export const metadata: Metadata = { title: "People analytics" };

export default async function AnalyticsPage(props: PageProps<"/org/analytics">) {
  const sp = await props.searchParams;
  const months = typeof sp.months === "string" && /^\d{1,2}$/.test(sp.months) ? Number(sp.months) : 12;
  const d = await load(async (tx, actor) => {
    try { return await peopleAnalytics(tx, actor, { months }); } catch (e) { if (e instanceof AppError && e.code === "forbidden") return null; throw e; }
  });
  if (!d) return <Card><EmptyState icon={<ShieldAlert />} title="People analytics is for HR and admins" description="Ask an admin for the “View everyone's full profile” or “View and export reports” permission." /></Card>;
  return (
    <>
      <PageHeader title="People analytics" description={d.scoped ? "Headcount and attrition for the departments and locations you manage." : "Headcount, attrition and tenure across the company."} />
      <PeopleAnalytics d={d} months={months} />
    </>
  );
}
