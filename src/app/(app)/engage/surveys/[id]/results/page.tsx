import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { load } from "@/server/page-data";
import { canManageSurveys, results } from "@/server/modules/surveys/service";
import { PageHeader } from "@/ui/app-shell";
import { ResultsView } from "@/features/surveys/results-view";
import { NoAccess } from "@/features/onboarding/no-access";

export const metadata: Metadata = { title: "Survey results" };
const uuid = z.uuid();

export default async function SurveyResultsPage(props: PageProps<"/engage/surveys/[id]/results">) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  if (!uuid.safeParse(id).success) notFound();
  const one = (v: string | string[] | undefined) => (typeof v === "string" && uuid.safeParse(v).success ? v : null);
  const r = await load(async (tx, actor) => {
    if (!canManageSurveys(actor)) return "denied" as const;
    return results(tx, actor, id, { round: Number(sp.round) || null, departmentId: one(sp.department), locationId: one(sp.location) });
  });
  if (r === "denied") return <NoAccess what="Survey results are for HR." />;
  if (!r) notFound();
  return (
    <>
      <PageHeader title={r.survey.title} description={r.survey.status === "live" ? "Results update as answers come in." : "Final results."}
        breadcrumb={<><Link href="/engage/surveys" className="hover:underline">Surveys</Link> / <Link href={`/engage/surveys/${id}`} className="hover:underline">Settings</Link></>} />
      <ResultsView r={r} />
    </>
  );
}
