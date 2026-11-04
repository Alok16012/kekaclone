import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { canSeeExitSurveys, listExitQuestions } from "@/server/modules/exits/survey";
import { ExitSurveySettings } from "@/features/exits/exit-survey-settings";

export const metadata: Metadata = { title: "Exit survey" };

export default async function ExitSurveySettingsPage() {
  const d = await load(async (tx, actor) => ({ questions: await listExitQuestions(tx), canEdit: canSeeExitSurveys(actor) }));
  return <ExitSurveySettings {...d} />;
}
