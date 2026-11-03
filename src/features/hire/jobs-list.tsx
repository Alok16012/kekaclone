"use client";
import * as React from "react";
import Link from "next/link";
import { BriefcaseBusiness, CalendarClock, Globe, Send, Users } from "lucide-react";
import { Card, StatTile } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { EmptyState } from "@/ui/feedback";
import { Segmented } from "@/ui/choice";
import { Button } from "@/ui/button";
import { jobTypeLabel, type StageGroup } from "@/server/modules/hire/rules";
import type { JobListRow } from "@/server/modules/hire/jobs";
import { day, JobStatusBadge } from "./shared";

const GROUPS: { g: StageGroup; label: string; cls: string }[] = [
  { g: "sourced", label: "New", cls: "bg-neutral-soft" },
  { g: "screening", label: "Screening", cls: "bg-accent-soft" },
  { g: "interview", label: "Interview", cls: "bg-accent" },
  { g: "offer", label: "Offer", cls: "bg-warning" },
  { g: "hired", label: "Hired", cls: "bg-success" },
];

/** S135: jobs with their status and how many candidates sit in each stage group. */
export function JobsList({ jobs, stats, canCreate }: { jobs: JobListRow[]; stats: { interviews: number; offers: number; active: number }; canCreate: boolean }) {
  const [filter, setFilter] = React.useState<"open" | "draft" | "on_hold" | "closed" | "all">("open");
  const shown = jobs.filter((j) => filter === "all" || j.status === filter);
  const count = (s: string) => jobs.filter((j) => j.status === s).length;
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Open jobs" value={count("open")} icon={<BriefcaseBusiness />} />
        <StatTile label="Active candidates" value={stats.active} icon={<Users />} />
        <StatTile label="Interviews in the next 7 days" value={stats.interviews} icon={<CalendarClock />} />
        <StatTile label="Offers waiting for an answer" value={stats.offers} icon={<Send />} />
      </div>
      <div className="overflow-x-auto">
        <Segmented label="Show jobs" value={filter} onChange={setFilter} options={[
          { value: "open", label: `Open (${count("open")})` }, { value: "draft", label: `Drafts (${count("draft")})` },
          { value: "on_hold", label: `On hold (${count("on_hold")})` }, { value: "closed", label: `Closed (${count("closed")})` }, { value: "all", label: "All" },
        ]} />
      </div>
      {shown.length === 0 ? (
        <Card><EmptyState icon={<BriefcaseBusiness />} title={jobs.length ? "No jobs here" : "No jobs yet"}
          description={jobs.length ? "Try another filter." : canCreate ? "Create a job, or turn an approved requisition into one." : "Jobs you're on the hiring team for show up here."}
          action={canCreate && !jobs.length ? <Button asChild><Link href="/hire/jobs/new">Create job</Link></Button> : undefined} /></Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {shown.map((j) => {
            const active = GROUPS.reduce((n, g) => n + j.counts[g.g], 0);
            return (
              <li key={j.id}>
                <Card className="p-4 transition-colors hover:border-border-strong sm:p-5">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link href={`/hire/jobs/${j.id}`} className="text-md font-semibold text-text hover:underline">{j.title}</Link>
                        <JobStatusBadge status={j.status} />
                        {j.publish.career_site && <Badge><Globe aria-hidden />Careers page</Badge>}
                        {j.publish.internal && <Badge>Internal</Badge>}
                      </div>
                      <p className="mt-1 text-sm text-text-muted">
                        {[j.department, j.location, jobTypeLabel(j.job_type), `${j.openings} ${j.openings === 1 ? "opening" : "openings"}`].filter(Boolean).join(" · ")}
                        {j.team.length ? ` · ${j.team.slice(0, 3).join(", ")}${j.team.length > 3 ? ` +${j.team.length - 3}` : ""}` : ""}
                      </p>
                      <p className="mt-0.5 text-xs text-text-muted">{j.published_at ? `Published ${day(j.published_at)}` : `Created ${day(j.created_at)}`}{j.target_date ? ` · fill by ${day(j.target_date)}` : ""}</p>
                    </div>
                    <div className="md:w-80">
                      <div className="flex h-2 overflow-hidden rounded-pill bg-surface-sunken" aria-hidden>
                        {active > 0 && GROUPS.map((g) => j.counts[g.g] ? <span key={g.g} className={g.cls} style={{ width: `${(j.counts[g.g] / active) * 100}%` }} /> : null)}
                      </div>
                      <dl className="mt-2 grid grid-cols-5 gap-1 text-center">
                        {GROUPS.map((g) => (
                          <div key={g.g}><dt className="text-xs text-text-muted">{g.label}</dt><dd className="text-base font-semibold tabular">{j.counts[g.g]}</dd></div>
                        ))}
                      </dl>
                    </div>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
