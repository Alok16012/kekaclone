import type { Metadata } from "next";
import Link from "next/link";
import { Settings2 } from "lucide-react";
import { load } from "@/server/page-data";
import { canEditOnboardingTemplates, hasOnboardingAccess, newJoiners } from "@/server/modules/onboarding/service";
import { todayIn } from "@/lib/dates";
import { PageHeader } from "@/ui/app-shell";
import { Button } from "@/ui/button";
import { Joiners } from "@/features/onboarding/joiners";
import { NoAccess } from "@/features/onboarding/no-access";

export const metadata: Metadata = { title: "Onboarding" };

export default async function OnboardingPage() {
  const d = await load(async (tx, actor) => {
    if (!hasOnboardingAccess(actor)) return null;
    const today = todayIn();
    const [rows, templates] = await Promise.all([newJoiners(tx, actor, today), tx<{ id: string; name: string }[]>`select id, name from task_templates where kind = 'onboarding' order by created_at`]);
    return { rows, templates, today, canEdit: canEditOnboardingTemplates(actor) };
  });
  return (
    <>
      <PageHeader title="Onboarding" description="New joiners, their checklists and who still has something to do."
        actions={d?.canEdit ? <Button asChild variant="secondary" size="sm"><Link href="/settings/tasks"><Settings2 />Checklists</Link></Button> : undefined} />
      {d ? <Joiners rows={d.rows} templates={d.templates} today={d.today} canEditTemplates={d.canEdit} /> : <NoAccess what="Onboarding is run by HR." />}
    </>
  );
}
