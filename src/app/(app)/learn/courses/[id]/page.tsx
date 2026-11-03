import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { load } from "@/server/page-data";
import { player } from "@/server/modules/learn/service";
import { PageHeader } from "@/ui/app-shell";
import { Player } from "@/features/learn/player";

export const metadata: Metadata = { title: "Course" };

export default async function CoursePlayerPage(props: PageProps<"/learn/courses/[id]">) {
  const { id } = await props.params;
  if (!z.uuid().safeParse(id).success) notFound();
  const d = await load(async (tx, actor) => player(tx, actor, id));
  if (!d) notFound();
  return (
    <>
      <PageHeader title={d.course.title} description={d.course.estimated_minutes ? `About ${d.course.estimated_minutes} minutes` : undefined} />
      <Player key={`${d.enrollment.id}:${d.enrollment.percent}`} data={d} preview={!d.enrollment.id} />
    </>
  );
}
