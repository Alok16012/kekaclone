import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { load } from "@/server/page-data";
import { can } from "@/server/auth/permissions";
import { isMaster, listMaster, MASTERS } from "@/server/modules/settings/org";
import { MasterTable } from "@/features/settings/master-table";

export const metadata: Metadata = { title: "Company structure" };

const COPY: Record<string, { plural: string; description: string }> = {
  departments: { plural: "Departments", description: "Teams people belong to. Departments can sit inside other departments." },
  designations: { plural: "Designations", description: "Job titles shown on profiles and letters." },
  locations: { plural: "Locations", description: "Offices and sites. The state decides state-specific deductions in payroll." },
  legal_entities: { plural: "Legal entities", description: "Registered companies that employ people and run payroll." },
  business_units: { plural: "Business units", description: "Larger groupings across departments, if your company uses them." },
  bands: { plural: "Bands", description: "Grades or levels, used in compensation and policies." },
};

export default async function OrgMasterPage(props: PageProps<"/settings/org/[kind]">) {
  const { kind } = await props.params;
  if (!isMaster(kind)) notFound();
  const d = await load(async (tx, actor) => ({
    rows: await listMaster(tx, kind),
    people: kind === "departments" ? await tx<{ id: string; name: string; title: string | null }[]>`select e.id, e.display_name as name, d.title from employees e left join designations d on d.id = e.designation_id where e.status <> 'relieved' order by 2` : [],
    canEdit: can(actor, "settings.org"),
  }));
  return <MasterTable kind={kind} label={MASTERS[kind].label} plural={COPY[kind].plural} description={COPY[kind].description} rows={d.rows} people={d.people} canEdit={d.canEdit} />;
}
