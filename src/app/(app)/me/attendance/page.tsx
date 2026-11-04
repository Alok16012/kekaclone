import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { load } from "@/server/page-data";
import * as attendance from "@/server/modules/attendance/service";
import * as requests from "@/server/modules/attendance/requests";
import { addDaysISO, todayIn } from "@/lib/dates";
import { PageHeader } from "@/ui/app-shell";
import { Button } from "@/ui/button";
import { StatTile } from "@/ui/card";
import { ClockCard } from "@/features/clock-card";
import { MyAttendance, type MyRequestRow } from "@/features/attendance/my-attendance";
import { REQUEST_KIND, hm } from "@/features/attendance/status";
import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n";

export const metadata: Metadata = { title: "Attendance" };

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export default async function AttendancePage(props: PageProps<"/me/attendance">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => {
    const today = todayIn();   // read the clock only after the request-time session read
    const thisMonth = today.slice(0, 7);
    const asked = typeof sp.month === "string" && MONTH.test(sp.month) && sp.month <= thisMonth ? sp.month : thisMonth;
    const month = `${asked}-01`;
    const [state, rows, mine, allowance] = await Promise.all([
      attendance.today(tx, actor.employeeId), attendance.monthLog(tx, actor.employeeId, month),
      requests.myRequests(tx, actor.employeeId), requests.requestAllowance(tx, actor.employeeId, today),
    ]);
    return { state, rows, mine, allowance, month, today, thisMonth };
  });
  const { month, today } = d;
  const worked = d.rows.filter((r) => r.effective > 0);
  const avg = worked.length ? Math.round(worked.reduce((s, r) => s + r.effective, 0) / worked.length) : 0;
  const fixedDays = d.rows.filter((r) => r.firstIn && r.dayType === "working");
  const onTime = fixedDays.length ? Math.round((fixedDays.filter((r) => r.late === 0).length / fixedDays.length) * 100) : null;
  const penalties = d.rows.reduce((s, r) => s + r.penalties.reduce((x, p) => x + p.days, 0), 0);
  const { t, date: fmtDate, number: num } = await getT();
  const monthName = fmtDate(month, { month: "long", year: "numeric" });
  const prev = addDaysISO(month, -1).slice(0, 7);
  const next = addDaysISO(month, 32).slice(0, 7);
  const reqRows: MyRequestRow[] = d.mine.map((r) => ({
    id: r.id, kind: r.kind, title: r.kind in REQUEST_KIND ? t(`att.kind.${r.kind}` as MessageKey) : r.kind, detail: requests.describe(r.kind, r.from_date, r.to_date, r.payload).split(" · ").slice(1).join(" · "),
    reason: r.reason, status: r.status, createdAt: r.created_at.toISOString(),
  }));
  return (
    <>
      <PageHeader title={t("attendance.title")} description={`${t("attendance.description")} ${monthName}`}
        actions={
          <nav aria-label={t("att.month")} className="flex items-center gap-1">
            <Button asChild variant="ghost" size="icon-sm"><Link href={`/me/attendance?month=${prev}`} aria-label={t("att.prev")}><ChevronLeft /></Link></Button>
            <span className="min-w-28 text-center text-sm font-medium">{monthName}</span>
            {month.slice(0, 7) < d.thisMonth
              ? <Button asChild variant="ghost" size="icon-sm"><Link href={`/me/attendance?month=${next}`} aria-label={t("att.next")}><ChevronRight /></Link></Button>
              : <Button variant="ghost" size="icon-sm" disabled aria-label={t("att.next")}><ChevronRight /></Button>}
          </nav>
        } />
      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <ClockCard state={d.state} />
        <div className="grid grid-cols-2 gap-4 lg:col-span-2">
          <StatTile label={t("att.avg")} value={avg ? hm(avg) : "—"} hint={t("att.days_logged", { count: worked.length })} />
          <StatTile label={t("att.on_time")} value={onTime == null ? "—" : `${num(onTime)}%`} hint={t("att.on_time_hint")} />
          <StatTile label={t("att.late")} value={num(d.rows.filter((r) => r.late > 0).length)} hint={t("att.late_hint")} />
          <StatTile label={t("att.penalties")} value={penalties ? t("att.penalty_days", { count: penalties }) : t("att.none")} hint={t("att.penalties_hint")} />
        </div>
      </div>
      <MyAttendance rows={d.rows} requests={reqRows} allowance={d.allowance} today={today} monthLabel={monthName} tab={typeof sp.tab === "string" ? sp.tab : undefined} />
    </>
  );
}
