import type { Metadata } from "next";
import Link from "next/link";
import { load } from "@/server/page-data";
import { canAdminLearn, hasLearnReports, myCourses } from "@/server/modules/learn/service";
import { PageHeader } from "@/ui/app-shell";
import { Button } from "@/ui/button";
import { MyCourses, type MyCourseCard } from "@/features/learn/my-courses";

export const metadata: Metadata = { title: "My learning" };

export default async function MyLearnPage() {
  const d = await load(async (tx, actor) => ({
    courses: (await myCourses(tx, actor)).map((c): MyCourseCard => ({ course_id: c.course_id, title: c.title, description: c.description, estimated_minutes: c.estimated_minutes, certificate: c.certificate, modules: c.modules, due_date: c.due_date, percent: Number(c.percent), completed_at: c.completed_at?.toISOString() ?? null, certificate_file_id: c.certificate_file_id, state: c.state })),
    admin: canAdminLearn(actor) || hasLearnReports(actor),
  }));
  return (
    <>
      <PageHeader title="My learning" description="Courses assigned to you, your progress and your certificates." actions={d.admin ? <Button asChild variant="secondary"><Link href="/learn/admin">Manage courses</Link></Button> : undefined} />
      <MyCourses courses={d.courses} />
    </>
  );
}
