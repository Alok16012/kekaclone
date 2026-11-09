import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, CalendarPlus, Inbox, PartyPopper, UserPlus } from "lucide-react";
import { load, leaveMarks } from "@/server/page-data";
import * as attendance from "@/server/modules/attendance/service";
import * as leave from "@/server/modules/leave/service";
import * as engage from "@/server/modules/engage/service";
import { POST_KINDS, type PostKind } from "@/server/modules/engage/rules";
import { orgOptions } from "@/server/modules/employees/service";
import { can } from "@/server/auth/session";
import { todayIn } from "@/lib/dates";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { BalanceRing, Banner, EmptyState } from "@/ui/feedback";
import { ClockCard } from "@/features/clock-card";
import { ApplyLeave } from "@/features/apply-leave";
import { Wall } from "@/features/engage/wall";
import { CelebrationsCard, HolidaysCard } from "@/features/engage/home-widgets";
import { canEditQuickLinks, quickLinks, remoteToday } from "@/server/modules/home/service";
import { myOnboarding } from "@/server/modules/onboarding/service";
import { mySurveys, processDueSurveys } from "@/server/modules/surveys/service";
import { QuickLinksCard, RemoteTodayCard, SurveysWaiting } from "@/features/home/extras";
import { OnboardingChecklist } from "@/features/onboarding/checklist";
import { getT } from "@/i18n/server";

export const metadata: Metadata = { title: "Home" };

const greetingKey = (hourIST: number): "home.morning" | "home.afternoon" | "home.evening" => (hourIST < 12 ? "home.morning" : hourIST < 17 ? "home.afternoon" : "home.evening");

export default async function HomePage(props: PageProps<"/home">) {
  const sp = await props.searchParams;
  const data = await load(async (tx, actor) => {
    const today = todayIn();
    await engage.publishDue(tx, actor.tenant.id);   // scheduled announcements that are now due go out before we read the wall
    await processDueSurveys(tx, today);              // likewise scheduled surveys and pulse rounds
    const [state, bal, off, marks, opts, [{ pending }], [{ headcount }], wall, composer, celebrations, holidays] = await Promise.all([
      attendance.today(tx, actor.employeeId), leave.balances(tx, actor.employeeId), leave.offToday(tx),
      leaveMarks(tx, actor.employeeId), orgOptions(tx),
      tx<{ pending: number }[]>`select count(*)::int as pending from approval_steps where approver_employee_id = ${actor.employeeId} and status = 'pending'`,
      tx<{ headcount: number }[]>`select count(*)::int as headcount from employees where status <> 'relieved'`,
      engage.feed(tx, actor, { tab: "org" }), engage.composerOptions(tx, actor), engage.celebrationsFor(tx, today), engage.upcomingHolidays(tx, actor.employeeId, today),
    ]);
    const [links, remote, onboarding, surveys] = await Promise.all([quickLinks(tx), remoteToday(tx, today), myOnboarding(tx, actor, actor.employeeId, today), mySurveys(tx, actor)]);
    return {
      actor, today, state, bal, off, marks, people: opts.people.filter((p) => p.id !== actor.employeeId), pending, headcount, admin: can(actor, "employees.write"), wall, composer, celebrations, holidays,
      links, editLinks: canEditQuickLinks(actor), remote, onboarding: onboarding && onboarding.tasks.length ? onboarding : null, surveys: surveys.filter((x) => !x.answered),
    };
  });
  const { t, date: fmtDate } = await getT();   // after load(): the request boundary has been crossed
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
  const date = fmtDate(data.today);
  const types = data.bal.map((b) => ({ id: b.id, name: b.name, available: Number.isFinite(b.available) ? b.available : null, allowHalfDay: !!b.rules.allowHalfDay }));
  const compose = typeof sp.compose === "string" && (POST_KINDS as readonly string[]).includes(sp.compose) && (sp.compose !== "announcement" || data.composer.announce) ? (sp.compose as PostKind) : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm text-text-muted">{date}</p>
        <h1 className="text-2xl font-semibold tracking-tight">{t(greetingKey(hour))}, {data.actor.name.split(" ")[0]}</h1>
      </div>

      {sp.welcome && data.admin && data.headcount <= 1 && (
        <Banner tone="success" title="Your workspace is ready" action={<Button asChild size="sm"><Link href="/org/employees/new"><UserPlus />Add your team</Link></Button>}>
          Add the people who work with you. They can then apply for leave and clock in, and you approve from your Inbox.
        </Banner>
      )}

      {/* one column on phones (clock and approvals first, then the wall, then the rest); wall + widget column from lg */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] lg:grid-rows-[auto_1fr] lg:gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-4 lg:col-start-2 lg:row-start-1">
          <ClockCard state={data.state} />
          {data.onboarding && <OnboardingChecklist data={data.onboarding} compact />}
          <SurveysWaiting surveys={data.surveys} />
          {data.pending > 0 && (
            <Link href="/inbox" className="group flex items-center gap-4 rounded-lg border border-border bg-surface px-4 py-3 shadow-card hover:bg-surface-sunken">
              <span className="flex size-10 items-center justify-center rounded-pill bg-accent-soft text-accent-text"><Inbox className="size-5" aria-hidden /></span>
              <span className="min-w-0 flex-1"><span className="block text-base font-medium">{t("home.approvals", { count: data.pending })}</span><span className="block text-sm text-text-muted">{t("home.open_inbox")}</span></span>
              <ArrowRight className="size-4 text-text-muted transition-transform group-hover:translate-x-0.5" aria-hidden />
            </Link>
          )}
        </div>

        <div className="min-w-0 lg:col-start-1 lg:row-span-2 lg:row-start-1">
          <Wall initial={data.wall} options={data.composer} people={data.people} me={{ id: data.actor.employeeId, name: data.actor.name }} defaultCompose={compose} />
        </div>

        <div className="flex min-w-0 flex-col gap-4 self-start lg:col-start-2 lg:row-start-2">
          <CelebrationsCard data={data.celebrations} today={data.today} />
          <Card>
            <CardHeader title={t("home.leave_balance")} description={t("home.this_leave_year")} action={<ApplyLeave types={types} marks={data.marks} people={data.people} trigger={<Button size="sm"><CalendarPlus />{t("home.apply")}</Button>} />} />
            <CardBody className="flex flex-wrap justify-around gap-4">
              {data.bal.filter((b) => b.quota != null).length === 0
                ? <p className="text-base text-text-muted">{t("home.no_balances")}</p>
                : data.bal.filter((b) => b.quota != null).map((b) => (
                  <BalanceRing key={b.id} size={76} label={b.name.replace(/ leave$/i, "")} available={b.available} total={b.credited} color={b.color} />
                ))}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title={t("home.off_today")} description={t("home.people_off", { count: data.off.length })} />
            {data.off.length === 0 ? (
              <EmptyState compact icon={<PartyPopper />} title={t("home.everyone_in")} />
            ) : (
              <ul className="flex flex-col gap-3 px-5 pb-5">
                {data.off.map((p) => (
                  <li key={p.id} className="flex items-center gap-3"><Avatar name={p.name} size="sm" status="leave" /><span className="min-w-0"><span className="block truncate text-base font-medium">{p.name}</span><span className="block text-sm text-text-muted">{p.type}{p.half ? ` · ${t("home.half_day")}` : ""}</span></span></li>
                ))}
              </ul>
            )}
          </Card>
          <RemoteTodayCard people={data.remote} />
          <HolidaysCard holidays={data.holidays} today={data.today} />
          <QuickLinksCard links={data.links} canEdit={data.editLinks} />
        </div>
      </div>
    </div>
  );
}
