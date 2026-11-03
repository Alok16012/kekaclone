import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { load } from "@/server/page-data";
import { courseAdmin } from "@/server/modules/learn/service";
import { people } from "@/server/modules/psa/service";
import { PageHeader } from "@/ui/app-shell";
import { CourseBuilder, type Lookups } from "@/features/learn/course-builder";

export const metadata: Metadata = { title: "Course builder" };

export default async function CourseBuilderPage(props: PageProps<"/learn/admin/courses/[id]">) {
  const { id } = await props.params;
  if (!z.uuid().safeParse(id).success) notFound();
  const d = await load(async (tx, actor) => {
    const a = await courseAdmin(tx, actor, id);
    if (!a) return null;
    const lookups: Lookups = a.canEdit ? {
      people: await people(tx),
      departments: await tx<{ id: string; name: string }[]>`select id, name from departments order by name`,
      locations: await tx<{ id: string; name: string }[]>`select id, name from locations order by name`,
      designations: await tx<{ id: string; name: string }[]>`select id, title as name from designations order by title`,
    } : { people: [], departments: [], locations: [], designations: [] };
    return { ...a, lookups };
  });
  if (!d) notFound();
  return (
    <>
      <PageHeader title={d.course.title} description="Modules, assignment rules and who's enrolled." />
      <CourseBuilder course={{ ...d.course, updated_at: d.course.updated_at.toISOString() }} modules={d.modules} assignments={d.assignments.map((a) => ({ id: a.id, name: a.name, rule: a.rule, description: a.description, due_in_days: a.due_in_days, reminder_days_before: a.reminder_days_before, is_active: a.is_active, enrolled: a.enrolled }))} lookups={d.lookups} canEdit={d.canEdit} />
    </>
  );
}
