import type { Metadata } from "next";
import { Lock } from "lucide-react";
import { load } from "@/server/page-data";
import { canAdminLearn, completionReport, hasLearnReports, listCourses } from "@/server/modules/learn/service";
import { PageHeader } from "@/ui/app-shell";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { LearnAdmin, type CourseListRow, type Reports } from "@/features/learn/admin-courses";

export const metadata: Metadata = { title: "Learn admin" };
const TABS = ["courses", "reports", "overdue", "learners"];

export default async function LearnAdminPage(props: PageProps<"/learn/admin">) {
  const sp = await props.searchParams;
  const tab = typeof sp.tab === "string" && TABS.includes(sp.tab) ? sp.tab : "courses";
  const d = await load(async (tx, actor) => {
    if (!hasLearnReports(actor)) return null;
    const [courses, r] = await Promise.all([listCourses(tx, actor), completionReport(tx, actor)]);
    const reports: Reports = { byCourse: r.byCourse, byDepartment: r.byDepartment, overdue: r.overdue, learners: r.learners.map((l) => ({ ...l, completed_at: l.completed_at?.toISOString() ?? null })) };
    return { courses: courses.map((c): CourseListRow => ({ id: c.id, title: c.title, description: c.description, status: c.status, certificate: c.certificate, estimated_minutes: c.estimated_minutes, modules: c.modules, enrolled: c.enrolled, completed: c.completed, overdue: c.overdue, assignments: c.assignments, updated_at: c.updated_at.toISOString() })), reports, canEdit: canAdminLearn(actor) };
  });
  return (
    <>
      <PageHeader title="Learn" description="Courses, who they're assigned to, and how people are getting on." />
      {!d ? <Card><EmptyState icon={<Lock />} title="Learning admin is for learning admins and report readers" description="Your own courses are under My learning." /></Card>
        : <LearnAdmin courses={d.courses} reports={d.reports} canEdit={d.canEdit} tab={tab} />}
    </>
  );
}
