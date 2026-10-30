import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Cake, CalendarClock, FileSpreadsheet, Inbox, Mail, PartyPopper, UserCheck, UserPlus, Users } from "lucide-react";
import { load } from "@/server/page-data";
import { orgDashboard } from "@/server/modules/org/dashboard";
import { PageHeader } from "@/ui/app-shell";
import { Card, CardBody, CardHeader, StatTile } from "@/ui/card";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Banner, EmptyState } from "@/ui/feedback";
import { redirect } from "next/navigation";
import { setupSummary } from "@/server/modules/setup/service";
import { SetupChecklist } from "@/features/setup/setup-checklist";

export const metadata: Metadata = { title: "Dashboard" };

const fmt = (d: string, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { ...opts, timeZone: "UTC" });

function PendingRow({ href, icon, label, count }: { href: string; icon: React.ReactNode; label: string; count: number }) {
  return (
    <li>
      <Link href={href} className="group flex items-center gap-3 rounded-md px-3 py-2.5 hover:bg-surface-sunken">
        <span className="flex size-8 items-center justify-center rounded-md bg-accent-soft text-accent-text [&_svg]:size-4" aria-hidden>{icon}</span>
        <span className="flex-1 text-base">{label}</span>
        <span className={count ? "text-md font-semibold tabular" : "text-md tabular text-text-muted"}>{count}</span>
        <ArrowRight className="size-4 text-text-muted transition-transform group-hover:translate-x-0.5" aria-hidden />
      </Link>
    </li>
  );
}

export default async function DashboardPage() {
  const { d, setup } = await load(async (tx, actor) => ({ d: await orgDashboard(tx, actor), setup: await setupSummary(tx, actor) }));
  if (setup?.autoOpen) redirect("/setup");   // first visit after signup: straight into the setup wizard
  const h = d.headcount;
  const maxDept = Math.max(1, ...d.byDepartment.map((x) => x.count));
  const maxLogin = Math.max(1, ...d.logins.map((x) => x.people));
  const signedInPct = h.total ? Math.round((h.active / h.total) * 100) : 0;
  return (
    <>
      <PageHeader title="Dashboard" description={d.scoped ? "For the departments and locations you manage." : "Your company at a glance."}
        actions={<><Button asChild variant="secondary"><Link href="/org/employees/import"><FileSpreadsheet />Import</Link></Button><Button asChild><Link href="/org/employees/new"><UserPlus />Add employee</Link></Button></>} />

      {setup && <SetupChecklist summary={setup} />}

      {h.notInvited > 0 && (
        <Banner tone="info" className="mb-6" title={`${h.notInvited} ${h.notInvited === 1 ? "person hasn't" : "people haven't"} been invited yet`}
          action={<Button asChild size="sm" variant="secondary"><Link href="/org/employees"><Mail />Invite from People</Link></Button>}>
          They can&apos;t clock in or apply for leave until they set a password.
        </Banner>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="People" value={h.total} icon={<Users />} hint={h.joinedThisMonth ? `${h.joinedThisMonth} joined this month` : "no joiners this month"} />
        <StatTile label="Signed in" value={`${signedInPct}%`} icon={<UserCheck />} hint={`${h.active} of ${h.total}`} />
        <StatTile label="Invited, waiting" value={h.invited} icon={<Mail />} hint="haven't set a password" />
        <StatTile label="Needs action" value={d.pending.leave + d.pending.profileChanges + d.pending.probationDue} icon={<Inbox />} hint="requests and probation" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Needs attention" />
          <ul className="px-2 pb-3">
            <PendingRow href="/inbox" icon={<CalendarClock />} label="Leave requests pending" count={d.pending.leave} />
            <PendingRow href="/inbox" icon={<UserCheck />} label="Profile changes to review" count={d.pending.profileChanges} />
            <PendingRow href="#probation" icon={<CalendarClock />} label="Probation ending in 30 days" count={d.pending.probationDue} />
            <PendingRow href="/org/employees" icon={<ArrowRight />} label="Scheduled job changes" count={d.pending.scheduledChanges} />
          </ul>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="People by department" />
          <CardBody>
            {d.byDepartment.length === 0 ? <EmptyState compact title="No people yet" /> : (
              <ul className="flex flex-col gap-2.5" aria-label="Headcount by department">
                {d.byDepartment.map((x) => (
                  <li key={x.name} className="grid grid-cols-[minmax(0,9rem)_1fr_2.5rem] items-center gap-3">
                    <span className="truncate text-base">{x.name}</span>
                    <span className="h-3 rounded-r-xs bg-chart-1" style={{ width: `${Math.max(4, (x.count / maxDept) * 100)}%` }} aria-hidden />
                    <span className="text-right text-base font-medium tabular">{x.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Coming up this week" description="Birthdays and work anniversaries" />
          {d.celebrations.length === 0 ? <EmptyState compact icon={<PartyPopper />} title="Nothing this week" /> : (
            <ul className="flex flex-col gap-3 px-5 pb-5">
              {d.celebrations.map((c) => (
                <li key={c.id + c.kind} className="flex items-center gap-3">
                  <Avatar name={c.name} size="sm" />
                  <span className="min-w-0 flex-1"><Link href={`/people/${c.id}`} className="block truncate text-base font-medium hover:underline">{c.name}</Link>
                    <span className="block text-sm text-text-muted">{c.kind === "birthday" ? "Birthday" : `${c.years} ${c.years === 1 ? "year" : "years"} at the company`}</span></span>
                  <Badge tone={c.kind === "birthday" ? "warning" : "accent"}>{c.kind === "birthday" ? <Cake /> : <PartyPopper />}{fmt(c.on, { weekday: "short", day: "numeric" })}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="New joiners" description="Last 30 days and next 30" />
          {d.newJoiners.length === 0 ? <EmptyState compact icon={<UserPlus />} title="No recent joiners" /> : (
            <ul className="flex flex-col gap-3 px-5 pb-5">
              {d.newJoiners.map((j) => (
                <li key={j.id} className="flex items-center gap-3">
                  <Avatar name={j.name} size="sm" />
                  <span className="min-w-0 flex-1"><Link href={`/people/${j.id}`} className="block truncate text-base font-medium hover:underline">{j.name}</Link><span className="block truncate text-sm text-text-muted">{j.title ?? "—"}</span></span>
                  <span className="text-sm text-text-muted tabular">{fmt(j.joined)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card id="probation">
          <CardHeader title="Probation ending" description="Within 30 days" />
          {d.probationDue.length === 0 ? <EmptyState compact title="No probations ending soon" /> : (
            <ul className="flex flex-col gap-3 px-5 pb-5">
              {d.probationDue.map((p) => (
                <li key={p.id} className="flex items-center gap-3">
                  <Avatar name={p.name} size="sm" />
                  <Link href={`/people/${p.id}`} className="min-w-0 flex-1 truncate text-base font-medium hover:underline">{p.name}</Link>
                  <Badge tone={p.overdue ? "danger" : "warning"}>{p.overdue ? "Overdue" : fmt(p.ends)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title="Sign-ins" description="People who signed in, last 7 days" />
        <CardBody>
          <div className="flex h-32 items-end gap-2" aria-hidden>
            {d.logins.map((l) => (
              <div key={l.day} className="flex flex-1 flex-col items-center gap-1.5">
                <span className="text-xs font-medium tabular">{l.people || ""}</span>
                <span className="w-full max-w-10 rounded-t-xs bg-chart-1" style={{ height: `${Math.max(2, (l.people / maxLogin) * 88)}px` }} />
                <span className="text-xs text-text-muted">{fmt(l.day, { weekday: "short" })}</span>
              </div>
            ))}
          </div>
          <table className="sr-only"><caption>Sign-ins per day, last 7 days</caption><tbody>{d.logins.map((l) => <tr key={l.day}><th>{l.day}</th><td>{l.people}</td></tr>)}</tbody></table>
        </CardBody>
      </Card>
    </>
  );
}
