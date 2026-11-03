import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { load } from "@/server/page-data";
import { compCycleDetail } from "@/server/modules/performance/compensation";
import { PageHeader } from "@/ui/app-shell";
import { CompDetail } from "@/features/performance/comp-detail";

export const metadata: Metadata = { title: "Compensation cycle" };

export default async function CompCyclePage(props: PageProps<"/compensation/[id]">) {
  const { id } = await props.params;
  if (!z.uuid().safeParse(id).success) notFound();
  const d = await load((tx, actor) => compCycleDetail(tx, actor, id));
  if (!d) notFound();
  return (
    <>
      <PageHeader title={d.cycle.name} description={`New pay from ${new Date(d.cycle.effectiveFrom + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}`} />
      <CompDetail d={d} />
    </>
  );
}
