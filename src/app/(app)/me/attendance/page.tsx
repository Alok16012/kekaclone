import type { Metadata } from "next";
import { load } from "@/server/page-data";
import * as attendance from "@/server/modules/attendance/service";
import { todayIn } from "@/lib/dates";
import { PageHeader } from "@/ui/app-shell";
import { StatTile } from "@/ui/card";
import { ClockCard } from "@/features/clock-card";
import { AttendanceLog } from "@/features/attendance-log";

export const metadata: Metadata = { title: "Attendance" };

export default async function AttendancePage() {
  const d = await load(async (tx, actor) => {
    const month = todayIn().slice(0, 7) + "-01";   // read the clock only after the request-time session read
    const [state, rows] = await Promise.all([attendance.today(tx, actor.employeeId), attendance.monthLog(tx, actor.employeeId, month)]);
    return { state, rows, month };
  });
  const month = d.month;
  const worked = d.rows.filter((r) => r.effective > 0);
  const avg = worked.length ? Math.round(worked.reduce((s, r) => s + r.effective, 0) / worked.length) : 0;
  const late = d.rows.filter((r) => r.late > 0).length;
  const monthName = new Date(month + "T00:00:00Z").toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
  return (
    <>
      <PageHeader title="Attendance" description={`Your logs for ${monthName}.`} />
      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <ClockCard state={d.state} />
        <div className="grid grid-cols-2 gap-4 lg:col-span-2">
          <StatTile label="Average worked per day" value={avg ? `${Math.floor(avg / 60)}h ${String(avg % 60).padStart(2, "0")}m` : "—"} hint={`${worked.length} days with logs`} />
          <StatTile label="Late arrivals" value={late} hint="after shift start + grace" />
        </div>
      </div>
      <AttendanceLog rows={d.rows} />
    </>
  );
}
