import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { canEditOnboardingTemplates, ensureOnboardingDefaults, hasOnboardingAccess, listTemplates } from "@/server/modules/onboarding/service";
import { OnboardingTemplates } from "@/features/onboarding/templates-ui";
import { NoAccess } from "@/features/onboarding/no-access";

export const metadata: Metadata = { title: "Onboarding tasks" };

export default async function OnboardingTasksSettingsPage() {
  const d = await load(async (tx, actor) => {
    if (!hasOnboardingAccess(actor)) return null;
    const canEdit = canEditOnboardingTemplates(actor);
    if (canEdit) await ensureOnboardingDefaults(tx, actor.tenant.id);
    const [templates, departments, locations, designations, legal_entities, roles, people] = await Promise.all([
      listTemplates(tx),
      tx<{ id: string; name: string }[]>`select id, name from departments order by name`,
      tx<{ id: string; name: string }[]>`select id, name from locations order by name`,
      tx<{ id: string; name: string }[]>`select id, title as name from designations order by title`,
      tx<{ id: string; name: string }[]>`select id, name from legal_entities order by name`,
      tx<{ key: string; name: string }[]>`select key, name from roles order by is_system desc, name`,
      tx<{ id: string; name: string; title: string | null; department: string | null }[]>`
        select e.id, e.display_name as name, d.title, dp.name as department from employees e left join designations d on d.id = e.designation_id
        left join departments dp on dp.id = e.department_id where e.status <> 'relieved' order by e.display_name`,
    ]);
    return { templates, lookups: { departments, locations, designations, legal_entities, roles, people }, canEdit };
  });
  if (!d) return <NoAccess what="Onboarding checklists are managed by HR." />;
  return <OnboardingTemplates templates={d.templates} lookups={d.lookups} canEdit={d.canEdit} />;
}
