import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { canManageSurveys, listSurveys, processDueSurveys } from "@/server/modules/surveys/service";
import { PageHeader } from "@/ui/app-shell";
import { EngageNav } from "@/features/engage/engage-nav";
import { SurveyList } from "@/features/surveys/survey-list";
import { NoAccess } from "@/features/onboarding/no-access";

export const metadata: Metadata = { title: "Surveys" };

export default async function SurveysPage() {
  const rows = await load(async (tx, actor) => {
    if (!canManageSurveys(actor)) return null;
    await processDueSurveys(tx);   // scheduled launches / pulse rounds that are due show up right away
    return listSurveys(tx, actor);
  });
  return (
    <>
      <PageHeader title="Engage" description="Announcements, polls and surveys for your company." />
      <EngageNav active="surveys" />
      {rows ? <SurveyList rows={rows} /> : <NoAccess what="Surveys are run by HR." />}
    </>
  );
}
