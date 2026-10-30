import type { Metadata } from "next";
import { z } from "zod";
import { load } from "@/server/page-data";
import { listPayGroups, listStructures } from "@/server/modules/payroll/setup";
import { hasAnyPayrollAdmin, isPayrollAdmin } from "@/server/modules/payroll/access";
import { StructuresList } from "@/features/payroll/structures-ui";
import { PayrollNoAccess } from "@/features/payroll/no-access";
import { StatutoryBanner } from "@/features/payroll/statutory-banner";
import { bannerProps } from "@/features/payroll/page-data";

export const metadata: Metadata = { title: "Salary structures" };

export default async function StructuresPage(props: PageProps<"/settings/payroll/structures">) {
  const sp = await props.searchParams;
  const group = typeof sp.group === "string" && z.uuid().safeParse(sp.group).success ? sp.group : null;
  const d = await load(async (tx, actor) => {
    if (!isPayrollAdmin(actor)) return { denied: true as const, scoped: hasAnyPayrollAdmin(actor) };
    const [rows, groups, banner] = await Promise.all([listStructures(tx), listPayGroups(tx), bannerProps(tx, actor)]);
    return { denied: false as const, rows, groups: groups.map((g) => ({ id: g.id, name: g.name })), banner };
  });
  if (d.denied) return <PayrollNoAccess scoped={d.scoped} />;
  return <div className="flex flex-col gap-4"><StatutoryBanner {...d.banner} /><StructuresList rows={d.rows} groups={d.groups} group={group} /></div>;
}
