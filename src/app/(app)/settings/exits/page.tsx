import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { canEditExitSettings, exitChecklist, listNoticePolicies, listReasons } from "@/server/modules/exits/service";
import { ExitSettings } from "@/features/settings/exit-settings";

export const metadata: Metadata = { title: "Exits & notice periods" };

export default async function ExitSettingsPage() {
  const d = await load(async (tx, actor) => {
    const canEdit = canEditExitSettings(actor);
    const [policies, reasons, checklist, people] = await Promise.all([
      listNoticePolicies(tx), listReasons(tx), exitChecklist(tx),
      canEdit ? tx<{ id: string; name: string; title: string | null; department: string | null }[]>`
        select e.id, e.display_name as name, d.title, dp.name as department from employees e left join designations d on d.id = e.designation_id
        left join departments dp on dp.id = e.department_id where e.status <> 'relieved' order by e.display_name` : Promise.resolve([]),
    ]);
    return { policies, reasons, checklist, people, canEdit };
  });
  return <ExitSettings {...d} />;
}
