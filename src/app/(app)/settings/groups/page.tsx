import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { canEditStructure, listGroups, listProbationPolicies } from "@/server/modules/corehr/lifecycle";
import { GroupsSettings, ProbationPolicies } from "@/features/corehr/groups-settings";

export const metadata: Metadata = { title: "Groups and probation" };

export default async function GroupsPage() {
  const d = await load(async (tx, actor) => {
    const [types, policies, people] = await Promise.all([
      listGroups(tx), listProbationPolicies(tx),
      tx<{ id: string; name: string; title: string | null; department: string | null }[]>`select e.id, e.display_name as name, d.title, dp.name as department from employees e left join designations d on d.id = e.designation_id left join departments dp on dp.id = e.department_id where e.status <> 'relieved' order by 2`,
    ]);
    return { types, policies, people: [...people], canEdit: canEditStructure(actor) };
  });
  return (
    <div className="flex flex-col gap-6">
      <GroupsSettings types={d.types} people={d.people} canEdit={d.canEdit} />
      <ProbationPolicies rows={[...d.policies]} canEdit={d.canEdit} />
    </div>
  );
}
