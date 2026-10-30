import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ChevronLeft, ChevronRight, Inbox, Users } from "lucide-react";
import { load } from "@/server/page-data";
import { teamAttendance, type TodayEntry } from "@/server/modules/attendance/team";
import { addDaysISO, todayIn } from "@/lib/dates";
import { PageHeader } from "@/ui/app-shell";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card, CardBody, CardHeader, StatTile } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { TeamGrid } from "@/features/attendance/team-grid";
import { clock } from "@/features/attendance/status";

export const metadata: Metadata = { title: "My team" };

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const STATE: Record<TodayEntry["state"], { label: string; tone: "success" | "warning" | "danger" | "neutral" | "accent" }> = {
  in: { label: "In", tone: "success" }, out: { label: "Clocked out", tone: "neutral" }, late: { label: "Late", tone: "warning" },
  absent: { label: "Not in", tone: "danger" }, not_in_yet: { label: "Not in yet", tone: "neutral" }, leave: { label: "On leave", tone: "accent" },
  wfh: { label: "Working from home", tone: "accent" }, on_duty: { label: "On duty", tone: "accent" }, off: { label: "Day off", tone: "neutral" },
};

export default async function TeamPage(props: PageProps<"/team">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => {
    const thisMonth = todayIn().slice(0, 7);   // clock read after the session read
    const asked = typeof sp.month === "string" && MONTH.test(sp.month) ? sp.month : thisMonth;
    return { ...(await teamAttendance(tx, actor, `${asked}-01`)), thisMonth };
  });
  const monthName = new Date(d.first + "T00:00:00Z").toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
  const prev = addDaysISO(d.first, -1).slice(0, 7), next = addDaysISO(d.last, 1).slice(0, 7);
  const count = (...s: TodayEntry["state"][]) => d.entries.filter((e) => s.includes(e.state)).length;

  if (d.members.length === 0) {
    return (
      <>
        <PageHeader title="My team" description="Attendance for the people who report to you." />
        <Card><EmptyState icon={<Users />} title="Nobody reports to you yet" description="When people have you as their manager, their attendance and requests show up here." /></Card>
      </>
    );
  }
  return (
    <>
      <PageHeader title="My team" description={`${d.members.length} ${d.members.length === 1 ? "person reports" : "people report"} to you.`} />
      <section aria-labelledby="today-h" className="mb-6">
        <h2 id="today-h" className="sr-only">Today</h2>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatTile label="In today" value={count("in", "late", "out")} hint={`${count("late")} late`} />
          <StatTile label="Not in" value={count("absent")} hint={`${count("not_in_yet")} not due yet`} />
          <StatTile label="On leave" value={count("leave")} hint="approved leave" />
          <StatTile label="Remote" value={count("wfh", "on_duty")} hint="work from home or on duty" />
        </div>
      </section>
      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Today" description="Who's in, late, away or not in yet" />
          <ul className="divide-y divide-border border-t border-border">
            {d.entries.map((e) => (
              <li key={e.id} className="flex items-center gap-3 px-5 py-3">
                <Avatar name={e.name} size="sm" status={e.state === "leave" ? "leave" : e.state === "wfh" || e.state === "on_duty" ? "remote" : e.state === "in" || e.state === "late" ? "online" : undefined} />
                <span className="min-w-0 flex-1">
                  <Link href={`/people/${e.id}`} className="block truncate text-base font-medium hover:underline">{e.name}</Link>
                  <span className="block truncate text-sm text-text-muted">{[e.title, e.firstIn ? `in at ${clock(e.firstIn)}` : null, e.detail].filter(Boolean).join(" · ")}</span>
                </span>
                <Badge tone={STATE[e.state].tone}>{STATE[e.state].label}</Badge>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader title="Waiting for you" />
          <CardBody>
            {d.pending > 0 ? (
              <Link href="/inbox" className="group flex items-center gap-4 rounded-md border border-border px-4 py-3 hover:bg-surface-sunken">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-pill bg-accent-soft text-accent-text"><Inbox className="size-5" /></span>
                <span className="flex-1"><span className="block text-base font-medium">{d.pending} team {d.pending === 1 ? "request" : "requests"}</span><span className="block text-sm text-text-muted">{d.pendingAttendance} attendance, {d.pending - d.pendingAttendance} other</span></span>
                <ArrowRight className="size-4 text-text-muted transition-transform group-hover:translate-x-0.5" />
              </Link>
            ) : <p className="text-base text-text-muted">No team requests need you right now.</p>}
          </CardBody>
        </Card>
      </div>
      <section aria-labelledby="grid-h">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="grid-h" className="text-lg font-semibold">Attendance in {monthName}</h2>
          <nav aria-label="Month" className="flex items-center gap-1">
            <Button asChild variant="ghost" size="icon-sm"><Link href={`/team?month=${prev}`} aria-label="Previous month"><ChevronLeft /></Link></Button>
            <span className="min-w-28 text-center text-sm font-medium">{monthName}</span>
            {d.first.slice(0, 7) < d.thisMonth
              ? <Button asChild variant="ghost" size="icon-sm"><Link href={`/team?month=${next}`} aria-label="Next month"><ChevronRight /></Link></Button>
              : <Button variant="ghost" size="icon-sm" disabled aria-label="Next month"><ChevronRight /></Button>}
          </nav>
        </div>
        <TeamGrid members={d.members} grid={d.grid} first={d.first} last={d.last} today={d.today} />
      </section>
    </>
  );
}
