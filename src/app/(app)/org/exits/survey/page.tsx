import type { Metadata } from "next";
import { ShieldAlert } from "lucide-react";
import { load } from "@/server/page-data";
import { canSeeExitSurveys, exitSurveyResults } from "@/server/modules/exits/survey";
import { PageHeader } from "@/ui/app-shell";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { ExitSurveyResults } from "@/features/exits/exit-survey-results";

export const metadata: Metadata = { title: "Exit survey results" };

export default async function ExitSurveyResultsPage(props: PageProps<"/org/exits/survey">) {
  const sp = await props.searchParams;
  const f = { from: typeof sp.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.from) ? sp.from : null, to: typeof sp.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.to) ? sp.to : null, departmentId: typeof sp.department === "string" && /^[0-9a-f-]{36}$/i.test(sp.department) ? sp.department : null };
  const d = await load(async (tx, actor) => {
    if (!canSeeExitSurveys(actor)) return null;
    const [results, departments] = await Promise.all([exitSurveyResults(tx, actor, f), tx<{ id: string; name: string }[]>`select id, name from departments order by name`]);
    return { results, departments };
  });
  if (!d) return <Card><EmptyState icon={<ShieldAlert />} title="Exit survey results are for HR" description="Ask an admin for the “Run exits” permission for the whole company." /></Card>;
  return (
    <>
      <PageHeader title="Exit survey results" description="Why people leave, in their own words and numbers." breadcrumb="Exits" />
      <ExitSurveyResults results={d.results} departments={d.departments} filters={f} />
    </>
  );
}
