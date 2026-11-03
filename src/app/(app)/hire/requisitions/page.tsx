import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { canRecruit } from "@/server/modules/hire/access";
import { backfillCandidates, canRaise, listRequisitions } from "@/server/modules/hire/jobs";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { Requisitions } from "@/features/hire/requisitions";
import { HireHeader, hireTabs } from "../header";

export const metadata: Metadata = { title: "Requisitions" };

export default async function RequisitionsPage(props: PageProps<"/hire/requisitions">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => {
    const [tabs, raise] = await Promise.all([hireTabs(tx, actor), canRaise(tx, actor)]);
    if (!tabs.requisitions) return { tabs, rows: null };
    const [rows, backfills, departments, locations] = await Promise.all([
      listRequisitions(tx, actor), raise ? backfillCandidates(tx) : Promise.resolve([]),
      tx<{ id: string; name: string }[]>`select id, name from departments order by name`, tx<{ id: string; name: string }[]>`select id, name from locations order by name`,
    ]);
    return { tabs, rows, backfills, departments, locations, raise, recruit: canRecruit(actor), me: actor.employeeId };
  });
  return (
    <>
      <HireHeader tabs={d.tabs} title="Requisitions" description="Ask for headcount. Once approved, a recruiter turns it into a job." />
      {!d.rows ? <Card><EmptyState title="Requisitions are for managers and recruiters" description="If your team needs to hire, ask your manager to raise a requisition." /></Card>
        : <Requisitions rows={d.rows} backfills={d.backfills!} departments={d.departments!} locations={d.locations!} canRaise={!!d.raise} canConvert={!!d.recruit} me={d.me!} openNew={sp.new === "1"} />}
    </>
  );
}
