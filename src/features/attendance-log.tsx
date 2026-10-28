"use client";
import { DataTable, type Column } from "@/ui/table";
import { Badge } from "@/ui/badge";
import type { LogRow } from "@/server/modules/attendance/service";

const t = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "—");
const hm = (m: number) => (m ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : "—");
const STATUS: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" | "accent" }> = {
  present: { label: "Present", tone: "success" }, absent: { label: "Absent", tone: "danger" }, leave: { label: "On leave", tone: "accent" },
  weekly_off: { label: "Weekly off", tone: "neutral" }, holiday: { label: "Holiday", tone: "neutral" }, today: { label: "Today", tone: "accent" },
  not_joined: { label: "Before joining", tone: "neutral" }, half_day: { label: "Half day", tone: "warning" },
};

export function AttendanceLog({ rows }: { rows: LogRow[] }) {
  const cols: Column<LogRow>[] = [
    { key: "date", header: "Date", sortValue: (r) => r.date, cell: (r) => new Date(r.date + "T00:00:00Z").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }) },
    { key: "status", header: "Status", cell: (r) => { const s = STATUS[r.status] ?? { label: r.status, tone: "neutral" as const }; return <span className="flex flex-wrap items-center gap-1.5"><Badge tone={s.tone}>{s.label}</Badge>{r.leave && <span className="text-sm text-text-muted">{r.leave}</span>}{r.late > 0 && <Badge tone="warning">Late {r.late}m</Badge>}</span>; } },
    { key: "in", header: "First in", cell: (r) => <span className="tabular">{t(r.firstIn)}</span> },
    { key: "out", header: "Last out", cell: (r) => <span className="tabular">{t(r.lastOut)}</span>, hideBelow: "md" },
    { key: "eff", header: "Worked", align: "right", sortValue: (r) => r.effective, cell: (r) => hm(r.effective) },
    { key: "gross", header: "In office", align: "right", cell: (r) => hm(r.gross), hideBelow: "lg" },
  ];
  return <DataTable caption="Attendance log for this month" rows={rows} columns={cols} rowKey={(r) => r.date} />;
}
