import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { load } from "@/server/page-data";
import { canManageSurveys, surveyDetail } from "@/server/modules/surveys/service";
import { todayIn } from "@/lib/dates";
import { PageHeader } from "@/ui/app-shell";
import { SurveyBuilder } from "@/features/surveys/builder";
import { NoAccess } from "@/features/onboarding/no-access";

export const metadata: Metadata = { title: "Survey" };

export default async function SurveyPage(props: PageProps<"/engage/surveys/[id]">) {
  const { id } = await props.params;
  if (!z.uuid().safeParse(id).success) notFound();
  const d = await load(async (tx, actor) => {
    if (!canManageSurveys(actor)) return "denied" as const;
    const s = await surveyDetail(tx, actor, id);
    if (!s) return null;
    const [departments, locations] = await Promise.all([
      tx<{ id: string; name: string }[]>`select id, name from departments order by name`,
      tx<{ id: string; name: string }[]>`select id, name from locations order by name`,
    ]);
    return { s, departments, locations };
  });
  if (d === "denied") return <NoAccess what="Surveys are run by HR." />;
  if (!d) notFound();
  return (
    <>
      <PageHeader title={d.s.title} breadcrumb={<Link href="/engage/surveys" className="hover:underline">Surveys</Link>} />
      <SurveyBuilder s={d.s} departments={d.departments} locations={d.locations} today={todayIn()} />
    </>
  );
}
