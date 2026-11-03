import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { load } from "@/server/page-data";
import { canBuildReports, canReadReports, datasets, roleOptions, savedReport } from "@/server/modules/reports/service";
import { people } from "@/server/modules/psa/service";
import { PageHeader } from "@/ui/app-shell";
import { ReportBuilder, type SavedInfo } from "@/features/reports/builder";

export const metadata: Metadata = { title: "Custom report" };

export default async function SavedReportPage(props: PageProps<"/reports/builder/[id]">) {
  const { id } = await props.params;
  if (!z.uuid().safeParse(id).success) notFound();
  const d = await load(async (tx, actor) => {
    if (!canReadReports(actor)) return null;
    const s = await savedReport(tx, actor, id);
    if (!s) return null;
    const build = canBuildReports(actor);
    const [roles, ppl] = await Promise.all([build ? roleOptions(tx) : Promise.resolve([]), build && s.mine ? people(tx) : Promise.resolve([])]);
    const saved: SavedInfo = { id: s.id, name: s.name, dataset: s.dataset, definition: s.definition, mine: s.mine, owner: s.owner, shared_roles: s.shared_roles, schedule: s.schedule, next_run_at: s.next_run_at?.toISOString() ?? null };
    return { saved, roles, people: ppl, canBuild: build, datasets: datasets() };
  });
  if (!d) notFound();
  return (
    <>
      <PageHeader title={d.saved.name} description={d.saved.mine ? "Your custom report." : `Shared with you by ${d.saved.owner ?? "a colleague"}.`} />
      <ReportBuilder key={d.saved.id} datasets={d.datasets} roles={d.roles} people={d.people} saved={d.saved} canBuild={d.canBuild} />
    </>
  );
}
