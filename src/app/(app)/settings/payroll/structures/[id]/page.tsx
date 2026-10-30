import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { load } from "@/server/page-data";
import { getStructure, listComponents, listPayGroups } from "@/server/modules/payroll/setup";
import { hasAnyPayrollAdmin, isPayrollAdmin } from "@/server/modules/payroll/access";
import { StructureEditor } from "@/features/payroll/structures-ui";
import { PayrollNoAccess } from "@/features/payroll/no-access";
import { StatutoryBanner } from "@/features/payroll/statutory-banner";
import { bannerProps } from "@/features/payroll/page-data";

export const metadata: Metadata = { title: "Salary structure" };

export default async function StructurePage(props: PageProps<"/settings/payroll/structures/[id]">) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  const isNew = id === "new";
  if (!isNew && !z.uuid().safeParse(id).success) notFound();
  const group = typeof sp.group === "string" && z.uuid().safeParse(sp.group).success ? sp.group : null;
  const d = await load(async (tx, actor) => {
    if (!isPayrollAdmin(actor)) return { denied: true as const, scoped: hasAnyPayrollAdmin(actor) };
    const [structure, components, groups, banner] = await Promise.all([isNew ? null : getStructure(tx, id), listComponents(tx), listPayGroups(tx), bannerProps(tx, actor)]);
    return { denied: false as const, structure, missing: !isNew && !structure, components: components.map((c) => ({ id: c.id, code: c.code, name: c.name, kind: c.kind })), groups: groups.map((g) => ({ id: g.id, name: g.name })), banner };
  });
  if (d.denied) return <PayrollNoAccess scoped={d.scoped} />;
  if (d.missing) notFound();
  return <div className="flex flex-col gap-4"><StatutoryBanner {...d.banner} /><StructureEditor key={id} structure={d.structure} components={d.components} groups={d.groups} defaultGroup={group} /></div>;
}
