import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { canAdminHelpdesk, listCategories } from "@/server/modules/helpdesk/service";
import { HelpdeskSettings } from "@/features/helpdesk/category-settings";
import { assistantStats, helpdeskSettings } from "@/server/modules/helpdesk/assist";
import { llm } from "@/server/modules/assist/provider";
import { HelpdeskAssistantSettings } from "@/features/helpdesk/assist";

export const metadata: Metadata = { title: "Helpdesk settings" };

export default async function HelpdeskSettingsPage() {
  const d = await load(async (tx, actor) => {
    const canEdit = canAdminHelpdesk(actor);
    const [categories, people] = await Promise.all([
      listCategories(tx),
      canEdit ? tx<{ id: string; name: string; title: string | null; department: string | null }[]>`
        select e.id, e.display_name as name, d.title, dp.name as department from employees e left join designations d on d.id = e.designation_id
        left join departments dp on dp.id = e.department_id where e.status <> 'relieved' order by e.display_name` : Promise.resolve([]),
    ]);
    const [hs, stats] = await Promise.all([helpdeskSettings(tx), canEdit ? assistantStats(tx) : Promise.resolve({ asked: 0, helped: 0, not_helped: 0 })]);
    return { categories, people, canEdit, assistant: { canEdit, aiEnabled: hs.ai_enabled, suggestBeforeRaise: hs.suggest_before_raise, provider: llm()?.name ?? null, stats } };
  });
  const { assistant, ...rest } = d;
  return (
    <div className="flex flex-col gap-4">
      <HelpdeskSettings {...rest} />
      <HelpdeskAssistantSettings {...assistant} />
    </div>
  );
}
