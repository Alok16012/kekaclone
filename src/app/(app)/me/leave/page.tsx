import type { Metadata } from "next";
import Link from "next/link";
import { BookOpenText, CalendarRange, Gift } from "lucide-react";
import { load, leaveMarks } from "@/server/page-data";
import * as leave from "@/server/modules/leave/service";
import { compOffSettings, myCompOffs } from "@/server/modules/leave/comp-off";
import { upcomingHolidays } from "@/server/modules/leave/holidays";
import { myGrants } from "@/server/modules/leave/grants";
import { orgOptions } from "@/server/modules/employees/service";
import { todayIn } from "@/lib/dates";
import { PageHeader } from "@/ui/app-shell";
import { Button } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Card, CardHeader } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { ApplyLeave } from "@/features/apply-leave";
import { LeaveRequests, type RequestRow } from "@/features/leave-requests";
import { ClaimCompOff, CompOffList, UpcomingHolidays } from "@/features/my-leave-extras";
import { getT } from "@/i18n/server";

export const metadata: Metadata = { title: "Leave" };

type T = Awaited<ReturnType<typeof getT>>["t"];
const part = (t: T, r: { from_date: string; to_date: string; from_half: string; to_half: string }) =>
  r.from_date === r.to_date ? (r.from_half === "second" ? t("leave.second_half") : r.to_half === "first" ? t("leave.first_half") : null)
  : [r.from_half === "second" ? t("leave.from_second") : null, r.to_half === "first" ? t("leave.till_first") : null].filter(Boolean).join(", ") || null;


export default async function LeavePage(props: PageProps<"/me/leave">) {
  const sp = await props.searchParams;
  const apply = sp.apply === "1", claim = sp.compoff === "1";
  const d = await load(async (tx, actor) => {
    const [bal, reqs, marks, opts, hol, co, coRows, grants] = await Promise.all([
      leave.balances(tx, actor.employeeId), leave.myRequests(tx, actor.employeeId), leaveMarks(tx, actor.employeeId), orgOptions(tx),
      upcomingHolidays(tx, actor.employeeId), compOffSettings(tx, actor.employeeId), myCompOffs(tx, actor.employeeId), myGrants(tx, actor.employeeId),
    ]);
    return { bal, reqs, marks, hol, co, coRows, grants, people: opts.people.filter((p) => p.id !== actor.employeeId) };
  });
  const today = todayIn();
  const { t, number: num } = await getT();
  const rows: RequestRow[] = d.reqs.map((r) => ({
    id: r.id, type: r.type, color: r.color, range: leave.fmtRange(r.from_date, r.to_date), days: Number(r.days), part: part(t, r), status: r.status, note: r.note,
    cancellable: r.status === "pending" || (r.status === "approved" && r.from_date >= today), appliedBy: r.applied_by_name, grantEvent: r.grant_event,
  }));
  const fmtD = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
  const types = d.bal.map((b) => ({ id: b.id, name: b.name, available: Number.isFinite(b.available) ? b.available : null, allowHalfDay: !!b.rules.allowHalfDay }));
  return (
    <>
      <PageHeader title={t("leave.title")} description={t("leave.description")}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="ghost"><Link href="/me/leave/policy"><BookOpenText />{t("leave.policy")}</Link></Button>
            <Button asChild variant="ghost"><Link href="/team/leave"><CalendarRange />{t("leave.team_calendar")}</Link></Button>
            {d.co && <ClaimCompOff marks={d.marks} windowDays={d.co.windowDays} expiryDays={d.co.expiryDays} defaultOpen={claim} />}
            <ApplyLeave types={types} marks={d.marks} people={d.people} defaultOpen={apply} />
          </div>
        } />
      {d.bal.length === 0 ? (
        <Card className="mb-6"><EmptyState compact title={t("leave.no_plan_title")} description={t("leave.no_plan")} /></Card>
      ) : (
        <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {d.bal.map((b) => (
            <Card key={b.id} className="p-4">
              <div className="flex items-center gap-2"><span aria-hidden className="size-2.5 rounded-pill" style={{ background: b.color }} /><span className="text-sm font-medium">{b.name}</span></div>
              <p className={`mt-2 text-2xl font-semibold tabular ${!b.unlimited && b.available < 0 ? "text-danger-text" : ""}`}>{b.unlimited ? "—" : num(b.available)}<span className="ml-1 text-sm font-normal text-text-muted">{b.unlimited ? t("leave.no_limit") : t("leave.available")}</span></p>
              <p className="mt-1 text-sm text-text-muted tabular">{b.unlimited ? t("leave.used_year", { used: num(b.used) }) : `${t(b.kind === "comp_off" ? "leave.earned_line" : "leave.credited_line", { credited: num(b.credited), used: num(b.used) })}${b.pending ? t("leave.pending_part", { pending: num(b.pending) }) : ""}`}</p>
            </Card>
          ))}
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
          <LeaveRequests rows={rows} />
          <CompOffList items={d.coRows.map((c) => ({ id: c.id, dates: c.worked_dates, days: Number(c.days), note: c.note, status: c.status, expiresOn: c.expires_on, expired: c.expired }))} />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <UpcomingHolidays listName={d.hol.listName} holidays={d.hol.holidays} allowance={d.hol.allowance} />
          {d.grants.length > 0 && (
            <Card>
              <CardHeader title="Granted for events" description="Leave HR granted you for a specific event. Apply for it within the window." />
              <ul className="divide-y divide-border border-t border-border">
                {d.grants.map((g) => (
                  <li key={g.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
                    <span aria-hidden className="size-2.5 shrink-0 rounded-pill" style={{ background: g.color }} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-base font-medium"><Gift className="mr-1 inline size-4 text-text-muted" aria-hidden />{g.event} · {g.type}</span>
                      <span className="block text-sm text-text-muted tabular">{num(g.days - g.used)} of {num(g.days)} {g.days === 1 ? "day" : "days"} left · use {fmtD(g.valid_from)} – {fmtD(g.valid_to)}</span>
                    </span>
                    <Badge tone={g.status === "active" ? "success" : "neutral"}>{g.status === "active" ? "Active" : g.status === "lapsed" ? "Lapsed" : "Withdrawn"}</Badge>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
