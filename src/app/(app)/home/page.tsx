import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, CalendarPlus, Inbox, PartyPopper, UserPlus } from "lucide-react";
import { load, leaveMarks } from "@/server/page-data";
import * as attendance from "@/server/modules/attendance/service";
import * as leave from "@/server/modules/leave/service";
import { orgOptions } from "@/server/modules/employees/service";
import { can } from "@/server/auth/session";
import { todayIn } from "@/lib/dates";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { BalanceRing, Banner, EmptyState } from "@/ui/feedback";
import { ClockCard } from "@/features/clock-card";
import { ApplyLeave } from "@/features/apply-leave";

export const metadata: Metadata = { title: "Home" };

function greeting(hourIST: number) {
  return hourIST < 12 ? "Good morning" : hourIST < 17 ? "Good afternoon" : "Good evening";
}

export default async function HomePage(props: PageProps<"/home">) {
  const sp = await props.searchParams;
  const data = await load(async (tx, actor) => {
    const [state, bal, off, marks, opts, [{ pending }], [{ headcount }]] = await Promise.all([
      attendance.today(tx, actor.employeeId), leave.balances(tx, actor.employeeId), leave.offToday(tx),
      leaveMarks(tx, actor.employeeId), orgOptions(tx),
      tx<{ pending: number }[]>`select count(*)::int as pending from approval_steps where approver_employee_id = ${actor.employeeId} and status = 'pending'`,
      tx<{ headcount: number }[]>`select count(*)::int as headcount from employees where status <> 'relieved'`,
    ]);
    return { actor, state, bal, off, marks, people: opts.people.filter((p) => p.id !== actor.employeeId), pending, headcount, admin: can(actor, "employees.write") };
  });
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
  const date = new Date(todayIn() + "T00:00:00Z").toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const types = data.bal.map((b) => ({ id: b.id, name: b.name, available: Number.isFinite(b.available) ? b.available : null, allowHalfDay: !!b.rules.allowHalfDay }));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm text-text-muted">{date}</p>
        <h1 className="text-2xl font-semibold tracking-tight">{greeting(hour)}, {data.actor.name.split(" ")[0]}</h1>
      </div>

      {sp.welcome && data.admin && data.headcount <= 1 && (
        <Banner tone="success" title="Your workspace is ready" action={<Button asChild size="sm"><Link href="/org/employees/new"><UserPlus />Add your team</Link></Button>}>
          Add the people who work with you. They can then apply for leave and clock in, and you approve from your Inbox.
        </Banner>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <ClockCard state={data.state} />
        <Card className="lg:col-span-2">
          <CardHeader title="Leave balance" description="This leave year" action={<ApplyLeave types={types} marks={data.marks} people={data.people} trigger={<Button size="sm"><CalendarPlus />Apply leave</Button>} />} />
          <CardBody className="flex flex-wrap justify-around gap-6">
            {data.bal.filter((b) => b.quota != null).map((b) => (
              <BalanceRing key={b.id} label={b.name.replace(/ leave$/i, "")} available={b.available} total={b.credited} color={b.color} />
            ))}
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Off today" description={`${data.off.length} ${data.off.length === 1 ? "person" : "people"}`} />
          {data.off.length === 0 ? (
            <EmptyState compact icon={<PartyPopper />} title="Everyone's in today" />
          ) : (
            <ul className="flex flex-col gap-3 px-5 pb-5">
              {data.off.map((p) => (
                <li key={p.id} className="flex items-center gap-3"><Avatar name={p.name} size="sm" status="leave" /><span className="min-w-0"><span className="block truncate text-base font-medium">{p.name}</span><span className="block text-sm text-text-muted">{p.type}{p.half ? " · half day" : ""}</span></span></li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Waiting for you" />
          <CardBody>
            {data.pending > 0 ? (
              <Link href="/inbox" className="group flex items-center gap-4 rounded-md border border-border px-4 py-3 hover:bg-surface-sunken">
                <span className="flex size-10 items-center justify-center rounded-pill bg-accent-soft text-accent-text"><Inbox className="size-5" /></span>
                <span className="flex-1"><span className="block text-base font-medium">{data.pending} {data.pending === 1 ? "request needs" : "requests need"} your approval</span><span className="block text-sm text-text-muted">Leave and attendance requests from your team</span></span>
                <ArrowRight className="size-4 text-text-muted transition-transform group-hover:translate-x-0.5" />
              </Link>
            ) : (
              <p className="text-base text-text-muted">Nothing needs your approval right now.</p>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
