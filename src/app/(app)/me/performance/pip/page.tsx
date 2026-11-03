import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { listPips } from "@/server/modules/performance/pip";
import { peopleOptions, reportIds, hasAnyPerf, perfAdminFor } from "@/server/modules/performance/access";
import { PipView } from "@/features/performance/pip-view";
import { todayIn } from "@/lib/dates";

export const metadata: Metadata = { title: "Improvement plans" };

export default async function PipPage(props: PageProps<"/me/performance/pip">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => {
    const [pips, reports, people] = await Promise.all([listPips(tx, actor), reportIds(tx, actor.employeeId), peopleOptions(tx)]);
    const rs = new Set(reports);
    let eligible = people.filter((p) => rs.has(p.id));
    if (hasAnyPerf(actor)) {
      const placed = await tx<{ id: string; department_id: string | null; location_id: string | null; legal_entity_id: string | null; business_unit_id: string | null }[]>`
        select id, department_id, location_id, legal_entity_id, business_unit_id from employees where status in ('active','notice')`;
      const covered = new Set(placed.filter((p) => p.id !== actor.employeeId && perfAdminFor(actor, p)).map((p) => p.id));
      eligible = people.filter((p) => rs.has(p.id) || covered.has(p.id));
    }
    return { pips, eligible };
  });
  return <PipView {...d} openId={typeof sp.open === "string" ? sp.open : null} today={todayIn()} />;
}
