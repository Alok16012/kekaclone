import type { Metadata } from "next";
import { Lock } from "lucide-react";
import { load } from "@/server/page-data";
import { canBuildReports, canReadReports, library, listSaved } from "@/server/modules/reports/service";
import { PageHeader } from "@/ui/app-shell";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { ReportLibrary, type SavedItem } from "@/features/reports/library";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage() {
  const d = await load(async (tx, actor) => {
    if (!canReadReports(actor)) return null;
    const saved = await listSaved(tx, actor);
    return {
      library: library(actor).map(({ key, name, description, group }) => ({ key, name, description, group })),
      saved: saved.map((s): SavedItem => ({ id: s.id, name: s.name, dataset: s.dataset, owner: s.owner, mine: s.mine, shared_roles: s.shared_roles, schedule_text: s.schedule_text, next_run_at: s.next_run_at?.toISOString() ?? null, updated_at: s.updated_at.toISOString() })),
      canBuild: canBuildReports(actor),
    };
  });
  return (
    <>
      <PageHeader title="Reports" description="Standard reports with filters and exports, and custom reports you build, share and schedule." />
      {!d ? <Card><EmptyState icon={<Lock />} title="Reports need report access" description="Ask an admin for a role that can view reports." /></Card>
        : <ReportLibrary library={d.library} saved={d.saved} canBuild={d.canBuild} />}
    </>
  );
}
