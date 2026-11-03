"use client";
import * as React from "react";
import { ArrowLeftRight, CalendarClock, ClipboardList, Clock, House, MoreHorizontal, Plus, Repeat, Timer, Zap } from "lucide-react";
import { Card, CardHeader } from "@/ui/card";
import { Badge, StatusChip } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { DataTable, type Column } from "@/ui/table";
import { ConfirmDialog, Menu } from "@/ui/overlay";
import { EmptyState } from "@/ui/feedback";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { toast } from "@/ui/toast";
import type { LogRow } from "@/server/modules/attendance/service";
import { cancelAttendanceRequestAction } from "@/app/(app)/me/attendance/actions";
import { RequestDialog, type Allowance, type RequestKindUI } from "./request-dialog";
import { PENALTY_RULE, REQUEST_KIND, clock, dayLabel, hm, statusOf } from "./status";

export type MyRequestRow = { id: string; kind: string; title: string; detail: string; reason: string | null; status: "pending" | "approved" | "rejected" | "cancelled"; createdAt: string };

export function MyAttendance({ rows, requests, allowance, today, monthLabel, tab }: {
  rows: LogRow[]; requests: MyRequestRow[]; allowance: Allowance; today: string; monthLabel: string; tab?: string;
}) {
  const [dialog, setDialog] = React.useState<{ kind: RequestKindUI; date: string; row?: LogRow } | null>(null);
  const pending = requests.filter((r) => r.status === "pending").length;
  const open = (kind: RequestKindUI, date: string, row?: LogRow) => setDialog({ kind, date, row });
  const yesterday = rows.find((r) => r.date < today)?.date ?? today;

  const cols: Column<LogRow>[] = [
    { key: "date", header: "Date", sortValue: (r) => r.date, cell: (r) => <span className="whitespace-nowrap">{dayLabel(r.date)}</span> },
    { key: "status", header: "Status", cell: (r) => {
      const s = statusOf(r.status);
      return (
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone={s.tone}>{s.label}</Badge>
          {r.leave && r.status !== "present" && <span className="text-sm text-text-muted">{r.leave}</span>}
          {r.late > 0 && <Badge tone="warning">Late {r.late}m</Badge>}
          {r.missingSwipe && <Badge tone="danger">Missing swipe</Badge>}
          {r.regularized && <Badge tone="neutral">Regularized</Badge>}
          {r.overtime > 0 && <Badge tone="success"><Zap aria-hidden />OT {hm(r.overtime)}</Badge>}
          {r.penalties.filter((p) => p.days > 0).map((p) => (
            <Badge key={p.rule} tone="danger" title={p.detail}>{PENALTY_RULE[p.rule] ?? p.rule}: −{p.days} {p.deductions.every((d) => d.leaveTypeId) ? (p.deductions[0]?.leaveType ?? "leave") : "LOP"}</Badge>
          ))}
          {r.requests.filter((q) => q.status === "pending").map((q) => <Badge key={q.kind} tone="accent">{REQUEST_KIND[q.kind] ?? q.kind} pending</Badge>)}
        </span>
      );
    } },
    { key: "in", header: "First in", cell: (r) => <span className="tabular">{clock(r.firstIn)}</span> },
    { key: "out", header: "Last out", cell: (r) => <span className="tabular">{clock(r.lastOut)}</span>, hideBelow: "md" },
    { key: "eff", header: "Worked", align: "right", sortValue: (r) => r.effective, cell: (r) => hm(r.effective) },
    { key: "gross", header: "In office", align: "right", cell: (r) => hm(r.gross), hideBelow: "lg" },
    { key: "menu", header: <span className="sr-only">Actions</span>, align: "right", cell: (r) => (
      <Menu trigger={<IconButton label={`Requests for ${dayLabel(r.date)}`} size="icon-sm"><MoreHorizontal /></IconButton>}
        items={[
          { label: "Regularize", icon: <Clock />, disabled: r.date >= today || r.status === "not_joined", onSelect: () => open("regularization", r.date, r) },
          { label: "Partial day", icon: <Timer />, disabled: r.status === "not_joined", onSelect: () => open("partial_day", r.date, r) },
          { label: "Work from home / on duty", icon: <House />, disabled: r.status === "not_joined", onSelect: () => open("remote", r.date, r) },
          ...(allowance.overtime === "request" ? [{ label: "Claim overtime", icon: <Zap />, disabled: r.date > today || r.status === "not_joined", onSelect: () => open("overtime", r.date, r) }] : []),
          { label: "Change shift", icon: <Repeat />, disabled: r.date < today || r.status === "not_joined", onSelect: () => open("shift_change", r.date, r) },
          { label: "Swap weekly off", icon: <ArrowLeftRight />, disabled: r.date < today || r.status === "not_joined", onSelect: () => open("weekly_off_change", r.date, r) },
        ]} />
    ) },
  ];

  return (
    <>
      <Tabs defaultValue={tab === "requests" ? "requests" : "logs"}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <TabsList items={[{ value: "logs", label: "Logs" }, { value: "requests", label: "Requests", count: pending || undefined }]} />
          <Menu align="end" trigger={<Button size="sm" variant="secondary"><Plus />New request</Button>}
            items={[
              { label: "Regularize a day", icon: <Clock />, onSelect: () => open("regularization", yesterday) },
              { label: "Partial day", icon: <Timer />, onSelect: () => open("partial_day", today) },
              { label: "Work from home / on duty", icon: <House />, onSelect: () => open("remote", today) },
              ...(allowance.overtime === "request" ? [{ label: "Claim overtime", icon: <Zap />, onSelect: () => open("overtime", yesterday) }] : []),
              { label: "Change shift", icon: <Repeat />, onSelect: () => open("shift_change", today) },
              { label: "Swap weekly off", icon: <ArrowLeftRight />, onSelect: () => open("weekly_off_change", today) },
            ]} />
        </div>
        <TabsContent value="logs">
          <DataTable caption={`Attendance log for ${monthLabel}`} rows={rows} columns={cols} rowKey={(r) => r.date}
            empty={<EmptyState compact icon={<CalendarClock />} title="No days to show yet" description="Your attendance for this month appears here from your first working day." />} />
        </TabsContent>
        <TabsContent value="requests">
          <Card>
            <CardHeader title="Your attendance requests" description="Regularizations, partial days, work from home, on duty, overtime and shift changes" />
            {requests.length === 0 ? (
              <EmptyState compact icon={<ClipboardList />} title="No requests yet" description="Forgot to clock out, working from home or stepping out early? Ask from a day's menu in your logs." />
            ) : (
              <ul className="divide-y divide-border border-t border-border">
                {requests.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-base font-medium">{r.title} <span className="font-normal text-text-muted">· {r.detail}</span></p>
                      {r.reason && <p className="truncate text-sm text-text-muted">“{r.reason}”</p>}
                    </div>
                    <StatusChip status={r.status} />
                    {r.status === "pending" && (
                      <ConfirmDialog title="Withdraw this request?" description={`${r.title}, ${r.detail}. Your manager won't need to review it anymore.`} confirmLabel="Withdraw"
                        onConfirm={async () => { const res = await cancelAttendanceRequestAction(r.id); if (res.ok) toast.success("Request withdrawn"); else toast.error(res.error); }}
                        trigger={<Button variant="ghost" size="sm">Withdraw</Button>} />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </TabsContent>
      </Tabs>
      {dialog && <RequestDialog kind={dialog.kind} date={dialog.date} today={today} allowance={allowance} current={dialog.row ? { firstIn: dialog.row.firstIn, lastOut: dialog.row.lastOut, overtime: dialog.row.overtime } : undefined} onClose={() => setDialog(null)} />}
    </>
  );
}
