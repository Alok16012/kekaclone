"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookOpen, Download, GraduationCap, Plus } from "lucide-react";
import { Card, CardHeader, StatTile } from "@/ui/card";
import { Button } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Modal } from "@/ui/overlay";
import { Field, Input, Textarea } from "@/ui/field";
import { Switch } from "@/ui/choice";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { Banner, EmptyState, Progress } from "@/ui/feedback";
import { DataTable } from "@/ui/table";
import { toast } from "@/ui/toast";
import { saveCourseAction } from "@/app/(app)/learn/actions";
import { STATE_LABEL, type EnrollmentState } from "@/server/modules/learn/rules";

export type CourseListRow = { id: string; title: string; description: string | null; status: "draft" | "published" | "archived"; certificate: boolean; estimated_minutes: number | null; modules: number; enrolled: number; completed: number; overdue: number; assignments: number; updated_at: string };
export type CompletionRow = { course_id: string; course: string; department: string | null; enrolled: number; completed: number; in_progress: number; overdue: number; not_started: number; avg_score: number | null };
export type OverdueRow = { enrollment_id: string; employee_id: string; employee: string; department: string | null; course: string; due_date: string; percent: number; days_overdue: number };
export type LearnerRow = { enrollment_id: string; employee_id: string; employee: string; number: string; department: string | null; course: string; due_date: string | null; percent: number; completed_at: string | null; state: EnrollmentState; best_score: number | null };
export type Reports = { byCourse: CompletionRow[]; byDepartment: CompletionRow[]; overdue: OverdueRow[]; learners: LearnerRow[] };
const TONE: Record<CourseListRow["status"], "neutral" | "success" | "warning"> = { draft: "warning", published: "success", archived: "neutral" };
const fmt = (d: string | null) => (d ? new Date(d.slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "–");

/** S172: every course with its reach, plus completion reports by course and department, and who's overdue. */
export function LearnAdmin({ courses, reports, canEdit, tab }: { courses: CourseListRow[]; reports: Reports; canEdit: boolean; tab: string }) {
  const router = useRouter();
  const [creating, setCreating] = React.useState(false);
  const enrolled = reports.learners.length, completed = reports.learners.filter((l) => l.state === "completed").length;
  return (
    <div className="flex flex-col gap-4">
      {!canEdit && <Banner tone="info" title="Reports only">You can see learning reports for the people you look after. Only learning admins for the whole company author courses.</Banner>}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Published courses" value={courses.filter((c) => c.status === "published").length} icon={<BookOpen />} hint={`${courses.filter((c) => c.status === "draft").length} in draft`} />
        <StatTile label="Enrolments" value={enrolled} icon={<GraduationCap />} />
        <StatTile label="Completed" value={enrolled ? `${Math.round((completed / enrolled) * 100)}%` : "–"} hint={`${completed} of ${enrolled}`} />
        <StatTile label="Overdue" value={reports.overdue.length} hint="people past a due date" />
      </div>
      <Tabs value={tab} onValueChange={(v) => router.replace(`/learn/admin?tab=${v}`, { scroll: false })}>
        <TabsList items={[{ value: "courses", label: "Courses", count: courses.length }, { value: "reports", label: "Completion" }, { value: "overdue", label: "Overdue", count: reports.overdue.length }, { value: "learners", label: "Learners", count: reports.learners.length }]} />
        <TabsContent value="courses">
          <Card>
            <CardHeader title="Courses" description="Build a course from videos, documents, readings and quizzes, then publish and assign it." action={canEdit ? <Button size="sm" onClick={() => setCreating(true)}><Plus />New course</Button> : undefined} />
            {courses.length === 0 ? <EmptyState compact icon={<BookOpen />} title="No courses yet" description="Create your first course, for example a code of conduct or security basics." action={canEdit ? <Button onClick={() => setCreating(true)}><Plus />New course</Button> : undefined} /> : (
              <ul className="divide-y divide-border border-t border-border">
                {courses.map((c) => (
                  <li key={c.id}>
                    <Link href={`/learn/admin/courses/${c.id}`} className="flex flex-col gap-2 px-5 py-4 hover:bg-surface-hover sm:flex-row sm:items-center sm:gap-4">
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-2 text-base font-medium">{c.title}<Badge tone={TONE[c.status]}>{c.status === "published" ? "Published" : c.status === "draft" ? "Draft" : "Archived"}</Badge></p>
                        <p className="mt-0.5 text-sm text-text-muted">{c.modules} {c.modules === 1 ? "module" : "modules"} · {c.assignments} {c.assignments === 1 ? "assignment rule" : "assignment rules"}{c.estimated_minutes ? ` · ${c.estimated_minutes} min` : ""}{c.certificate ? " · certificate" : ""}</p>
                      </div>
                      <div className="w-full sm:w-56">
                        <Progress value={c.enrolled ? (c.completed / c.enrolled) * 100 : 0} label={`${c.completed} of ${c.enrolled} completed`} tone="success" />
                        <p className="mt-1 text-xs text-text-muted">{c.completed} of {c.enrolled} completed{c.overdue ? <span className="text-danger-text"> · {c.overdue} overdue</span> : ""}</p>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </TabsContent>
        <TabsContent value="reports">
          <div className="flex flex-col gap-4">
            <div className="flex justify-end"><Button asChild variant="secondary" size="sm"><a href="/reports/export?key=learning&format=xlsx" download><Download />Export learners (XLSX)</a></Button></div>
            <Completion title="By course" rows={reports.byCourse} />
            <Completion title="By course and department" rows={reports.byDepartment} dept />
          </div>
        </TabsContent>
        <TabsContent value="overdue">
          <DataTable caption="People past their course due date" rows={reports.overdue} rowKey={(r) => r.enrollment_id}
            empty={<EmptyState compact icon={<GraduationCap />} title="Nobody is overdue" description="Reminders go out from the due date until the course is done." />}
            columns={[
              { key: "employee", header: "Person", cell: (r) => <Link href={`/people/${r.employee_id}`} className="font-medium hover:underline">{r.employee}</Link>, sortValue: (r) => r.employee },
              { key: "department", header: "Department", cell: (r) => r.department ?? "–", hideBelow: "md" },
              { key: "course", header: "Course", cell: (r) => r.course, sortValue: (r) => r.course },
              { key: "due", header: "Due", cell: (r) => fmt(r.due_date), sortValue: (r) => r.due_date },
              { key: "days", header: "Days overdue", cell: (r) => <span className="text-danger-text tabular">{r.days_overdue}</span>, sortValue: (r) => r.days_overdue, align: "right" },
              { key: "pct", header: "Progress", cell: (r) => `${Math.round(r.percent)}%`, sortValue: (r) => r.percent, align: "right" },
            ]} />
        </TabsContent>
        <TabsContent value="learners">
          <DataTable caption="Every enrolment" rows={reports.learners} rowKey={(r) => r.enrollment_id} empty={<EmptyState compact icon={<GraduationCap />} title="No enrolments yet" />}
            columns={[
              { key: "employee", header: "Person", cell: (r) => <Link href={`/people/${r.employee_id}`} className="font-medium hover:underline">{r.employee}</Link>, sortValue: (r) => r.employee },
              { key: "department", header: "Department", cell: (r) => r.department ?? "–", hideBelow: "lg" },
              { key: "course", header: "Course", cell: (r) => r.course, sortValue: (r) => r.course },
              { key: "state", header: "State", cell: (r) => <Badge tone={r.state === "completed" ? "success" : r.state === "overdue" ? "danger" : r.state === "in_progress" ? "accent" : "neutral"}>{STATE_LABEL[r.state]}</Badge>, sortValue: (r) => r.state },
              { key: "pct", header: "Progress", cell: (r) => `${Math.round(r.percent)}%`, sortValue: (r) => r.percent, align: "right" },
              { key: "score", header: "Best quiz", cell: (r) => (r.best_score == null ? "–" : `${r.best_score}%`), sortValue: (r) => r.best_score ?? -1, align: "right", hideBelow: "md" },
              { key: "due", header: "Due", cell: (r) => fmt(r.due_date), sortValue: (r) => r.due_date ?? "", hideBelow: "md" },
              { key: "done", header: "Completed", cell: (r) => fmt(r.completed_at), sortValue: (r) => r.completed_at ?? "", hideBelow: "lg" },
            ]} />
        </TabsContent>
      </Tabs>
      {creating && <CourseDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function Completion({ title, rows, dept }: { title: string; rows: CompletionRow[]; dept?: boolean }) {
  return (
    <Card>
      <CardHeader title={title} />
      {rows.length === 0 ? <EmptyState compact title="Nothing to report yet" /> : (
        <div className="overflow-x-auto border-t border-border">
          <table className="w-full text-sm">
            <caption className="sr-only">{title}</caption>
            <thead className="bg-surface-sunken text-text-muted"><tr><th scope="col" className="px-5 py-2 text-left font-medium">Course</th>{dept && <th scope="col" className="px-2 py-2 text-left font-medium">Department</th>}<th scope="col" className="px-2 py-2 text-right font-medium">Enrolled</th><th scope="col" className="px-2 py-2 text-right font-medium">Completed</th><th scope="col" className="px-2 py-2 text-right font-medium">In progress</th><th scope="col" className="px-2 py-2 text-right font-medium">Not started</th><th scope="col" className="px-2 py-2 text-right font-medium">Overdue</th><th scope="col" className="px-2 py-2 text-right font-medium">Avg quiz</th><th scope="col" className="w-40 px-5 py-2 text-left font-medium">Completion</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.course_id}|${r.department ?? ""}`} className="border-t border-border">
                  <td className="px-5 py-2 font-medium">{r.course}</td>{dept && <td className="px-2 py-2">{r.department}</td>}
                  <td className="px-2 py-2 text-right tabular">{r.enrolled}</td><td className="px-2 py-2 text-right tabular">{r.completed}</td><td className="px-2 py-2 text-right tabular">{r.in_progress}</td><td className="px-2 py-2 text-right tabular">{r.not_started}</td>
                  <td className={"px-2 py-2 text-right tabular " + (r.overdue ? "text-danger-text" : "")}>{r.overdue}</td><td className="px-2 py-2 text-right tabular">{r.avg_score == null ? "–" : `${r.avg_score}%`}</td>
                  <td className="px-5 py-2"><Progress value={r.enrolled ? (r.completed / r.enrolled) * 100 : 0} label={`${r.completed} of ${r.enrolled}`} tone="success" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function CourseDialog({ course, onClose }: { course?: { id: string; title: string; description: string | null; certificate: boolean; estimated_minutes: number | null }; onClose: () => void }) {
  const router = useRouter();
  const [f, setF] = React.useState({ title: course?.title ?? "", description: course?.description ?? "", certificate: course?.certificate ?? true, minutes: course?.estimated_minutes == null ? "" : String(course.estimated_minutes) });
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, start] = React.useTransition();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.title.trim()) { setErrors({ title: "Give the course a title." }); return; }
    start(async () => {
      const r = await saveCourseAction(course?.id ?? null, { title: f.title, description: f.description || null, certificate: f.certificate, estimatedMinutes: f.minutes === "" ? null : Number(f.minutes) });
      if (!r.ok) { setErrors({ [r.field ?? "form"]: r.error }); return; }
      toast.success(course ? "Course saved" : "Course created");
      onClose();
      if (!course && r.data) router.push(`/learn/admin/courses/${r.data.id}`);
    });
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={course ? "Edit course" : "New course"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="course-form" loading={busy}>{course ? "Save" : "Create and add modules"}</Button></>}>
      <form id="course-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {errors.form && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{errors.form}</p>}
        <Field label="Title" required error={errors.title}><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={160} /></Field>
        <Field label="Description" help="What people will learn and why it matters." error={errors.description}><Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={4000} rows={3} /></Field>
        <Field label="Estimated time (minutes)" error={errors.estimatedMinutes} className="sm:w-48"><Input type="number" min={0} inputMode="numeric" value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value })} /></Field>
        <Switch label="Issue a certificate on completion" checked={f.certificate} onCheckedChange={(c) => setF({ ...f, certificate: !!c })} />
      </form>
    </Modal>
  );
}
