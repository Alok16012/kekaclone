import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { load } from "@/server/page-data";
import { takeView } from "@/server/modules/surveys/service";
import { PageHeader } from "@/ui/app-shell";
import { TakeSurvey } from "@/features/surveys/take";

export const metadata: Metadata = { title: "Survey" };

export default async function TakeSurveyPage(props: PageProps<"/me/surveys/[id]">) {
  const { id } = await props.params;
  if (!z.uuid().safeParse(id).success) notFound();
  const s = await load((tx, actor) => takeView(tx, actor, id));
  if (!s) notFound();
  return (
    <div className="mx-auto w-full max-w-2xl">
      <PageHeader title={s.title} breadcrumb={<Link href="/me/surveys" className="hover:underline">Surveys</Link>} />
      <TakeSurvey s={s} />
    </div>
  );
}
