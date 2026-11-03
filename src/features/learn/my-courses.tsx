"use client";
import Link from "next/link";
import { Award, BookOpen, Clock, Download } from "lucide-react";
import { Card } from "@/ui/card";
import { Button } from "@/ui/button";
import { StatusChip } from "@/ui/badge";
import { EmptyState, Progress } from "@/ui/feedback";
import { STATE_LABEL, type EnrollmentState } from "@/server/modules/learn/rules";

export type MyCourseCard = { course_id: string; title: string; description: string | null; estimated_minutes: number | null; certificate: boolean; modules: number; due_date: string | null; percent: number; completed_at: string | null; certificate_file_id: string | null; state: EnrollmentState };
const CHIP: Record<EnrollmentState, "draft" | "live" | "completed" | "overdue"> = { not_started: "draft", in_progress: "live", completed: "completed", overdue: "overdue" };
const fmt = (d: string | null) => (d ? new Date(d.slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : null);

/** S169: the courses assigned to you, in progress first, with what's due and your certificates. */
export function MyCourses({ courses }: { courses: MyCourseCard[] }) {
  const open = courses.filter((c) => c.state !== "completed"), done = courses.filter((c) => c.state === "completed");
  if (courses.length === 0) return <Card><EmptyState icon={<BookOpen />} title="No courses yet" description="Courses assigned to you by your company show up here." /></Card>;
  const Tile = ({ c }: { c: MyCourseCard }) => (
    <li>
      <Card className="flex h-full flex-col p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-base font-medium"><Link href={`/learn/courses/${c.course_id}`} className="hover:underline focus-visible:outline-offset-2">{c.title}</Link></h3>
          <StatusChip status={CHIP[c.state]} label={STATE_LABEL[c.state]} />
        </div>
        {c.description && <p className="mt-1 line-clamp-2 text-sm text-text-muted">{c.description}</p>}
        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm text-text-muted">
          <span>{c.modules} {c.modules === 1 ? "module" : "modules"}</span>
          {c.estimated_minutes != null && <span className="inline-flex items-center gap-1"><Clock className="size-3.5" aria-hidden />{c.estimated_minutes} min</span>}
          {c.due_date && !c.completed_at && <span className={c.state === "overdue" ? "text-danger-text" : ""}>Due {fmt(c.due_date)}</span>}
          {c.completed_at && <span>Completed {fmt(c.completed_at)}</span>}
        </p>
        <div className="mt-auto pt-3">
          {c.state === "completed" ? (
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="secondary" size="sm"><Link href={`/learn/courses/${c.course_id}`}>Review</Link></Button>
              {c.certificate_file_id && <Button asChild size="sm" variant="soft"><a href={`/learn/files/${c.certificate_file_id}`} target="_blank" rel="noopener"><Award />Certificate</a></Button>}
            </div>
          ) : (
            <>
              <Progress value={c.percent} label={`${Math.round(c.percent)}% done`} tone={c.state === "overdue" ? "danger" : "accent"} />
              <div className="mt-2 flex items-center justify-between gap-2 text-sm text-text-muted"><span>{Math.round(c.percent)}% done</span><Button asChild size="sm"><Link href={`/learn/courses/${c.course_id}`}>{c.percent > 0 ? "Continue" : "Start"}</Link></Button></div>
            </>
          )}
        </div>
      </Card>
    </li>
  );
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="open-courses">
        <h2 id="open-courses" className="mb-3 text-md font-semibold">To do <span className="text-text-muted">({open.length})</span></h2>
        {open.length === 0 ? <Card><EmptyState compact icon={<Award />} title="All caught up" description="You've finished every course assigned to you." /></Card>
          : <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{open.map((c) => <Tile key={c.course_id} c={c} />)}</ul>}
      </section>
      {done.length > 0 && (
        <section aria-labelledby="done-courses">
          <h2 id="done-courses" className="mb-3 text-md font-semibold">Completed <span className="text-text-muted">({done.length})</span></h2>
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{done.map((c) => <Tile key={c.course_id} c={c} />)}</ul>
          <p className="mt-3 flex items-center gap-2 text-sm text-text-muted"><Download className="size-4" aria-hidden />Certificates open as PDFs you can save or share.</p>
        </section>
      )}
    </div>
  );
}
