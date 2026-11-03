import type { Metadata } from "next";
import { Lock } from "lucide-react";
import { load } from "@/server/page-data";
import { canBuildReports, datasets, roleOptions } from "@/server/modules/reports/service";
import { people } from "@/server/modules/psa/service";
import { PageHeader } from "@/ui/app-shell";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { ReportBuilder } from "@/features/reports/builder";

export const metadata: Metadata = { title: "Report builder" };

export default async function ReportBuilderPage() {
  const d = await load(async (tx, actor) => {
    if (!canBuildReports(actor)) return null;
    const [roles, ppl] = await Promise.all([roleOptions(tx), people(tx)]);
    return { datasets: datasets(), roles, people: ppl };
  });
  return (
    <>
      <PageHeader title="Report builder" description="Pick a dataset, choose columns or a summary, add filters, then save, share or schedule it." />
      {!d ? <Card><EmptyState icon={<Lock />} title="The builder needs report-building access" description="Standard reports and reports shared with you are under Reports." /></Card>
        : <ReportBuilder datasets={d.datasets} roles={d.roles} people={d.people} saved={null} canBuild />}
    </>
  );
}
