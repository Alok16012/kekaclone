import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { listPayGroups } from "@/server/modules/payroll/setup";
import { hasAnyPayrollAdmin, isPayrollAdmin } from "@/server/modules/payroll/access";
import { PayGroupsAdmin } from "@/features/payroll/pay-groups-ui";
import { PayrollNoAccess } from "@/features/payroll/no-access";
import { StatutoryBanner } from "@/features/payroll/statutory-banner";
import { bannerProps } from "@/features/payroll/page-data";

export const metadata: Metadata = { title: "Pay groups" };

export default async function PayGroupsPage() {
  const d = await load(async (tx, actor) => {
    if (!isPayrollAdmin(actor)) return { denied: true as const, scoped: hasAnyPayrollAdmin(actor) };
    const [rows, entities, banner] = await Promise.all([listPayGroups(tx), tx<{ id: string; name: string }[]>`select id, name from legal_entities order by name`, bannerProps(tx, actor)]);
    return { denied: false as const, rows, entities, banner };
  });
  if (d.denied) return <PayrollNoAccess scoped={d.scoped} />;
  return <div className="flex flex-col gap-4"><StatutoryBanner {...d.banner} /><PayGroupsAdmin rows={d.rows} entities={d.entities} /></div>;
}
