"use client";
import * as React from "react";
import { StatusChip } from "@/ui/badge";
import { Field, Textarea } from "@/ui/field";
import { Banner, Skeleton } from "@/ui/feedback";
import { ApprovalTimeline } from "@/ui/flow";
import { attendanceRequestDetailAction } from "@/app/(app)/me/attendance/actions";
import { clock, dayLabel, statusOf } from "./status";

type Detail = Awaited<ReturnType<typeof attendanceRequestDetailAction>>;
const hrs = (m: number) => (m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`);

/** Inbox drawer body for an attendance request: what was asked, the day as recorded now, the approval chain. */
export function AttendanceRequestDetail({ id, comment, onComment }: { id: string; comment: string; onComment: (v: string) => void }) {
  const [detail, setDetail] = React.useState<Detail | undefined>(undefined);
  React.useEffect(() => {
    let live = true;
    attendanceRequestDetailAction(id).then((d) => { if (live) setDetail(d); }).catch(() => { if (live) setDetail(null); });
    return () => { live = false; };
  }, [id]);
  if (detail === undefined) return <div className="flex flex-col gap-3" aria-busy><Skeleton className="h-5 w-1/2" /><Skeleton className="h-20" /><Skeleton className="h-24" /></div>;
  if (detail === null) return <Banner tone="warning">This request isn&apos;t available anymore.</Banner>;
  const p = detail.payload;
  const range = detail.from_date === detail.to_date ? dayLabel(detail.from_date, { weekday: "long", day: "numeric", month: "long" }) : `${dayLabel(detail.from_date)} → ${dayLabel(detail.to_date)}`;
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-base">
        <div><dt className="text-sm text-text-muted">Request</dt><dd className="font-medium">{detail.label}</dd></div>
        <div><dt className="text-sm text-text-muted">{detail.from_date === detail.to_date ? "Date" : "Dates"}</dt><dd className="font-medium">{range}</dd></div>
        {detail.kind === "regularization" && (
          <>
            <div><dt className="text-sm text-text-muted">Recorded</dt><dd className="font-medium tabular">{detail.day ? `${clock(detail.day.firstIn)} – ${clock(detail.day.lastOut)}` : "Nothing recorded"}</dd></div>
            <div><dt className="text-sm text-text-muted">Asked for</dt><dd className="font-medium tabular">{p.inTime} – {p.outTime}</dd></div>
          </>
        )}
        {detail.kind === "partial_day" && (
          <div className="col-span-2"><dt className="text-sm text-text-muted">Time away</dt><dd className="font-medium">{p.type === "late_arrival" ? "Coming in late" : "Leaving early"} by {hrs(p.minutes ?? 0)}</dd></div>
        )}
        {detail.kind === "overtime" && (
          <>
            <div><dt className="text-sm text-text-muted">Asked for</dt><dd className="font-medium">{hrs(p.minutes ?? 0)} of overtime</dd></div>
            <div><dt className="text-sm text-text-muted">Recorded</dt><dd className="font-medium">{detail.day ? `${hrs(detail.day.effective)} worked · ${detail.day.overtime ? `${hrs(detail.day.overtime)} counted` : "no overtime counted yet"}` : "Nothing recorded"}</dd></div>
          </>
        )}
        {detail.kind === "shift_change" && (
          <div><dt className="text-sm text-text-muted">New shift</dt><dd className="font-medium">{p.shiftName ?? "—"}</dd></div>
        )}
        {detail.kind === "weekly_off_change" && (
          <>
            <div><dt className="text-sm text-text-muted">Takes off</dt><dd className="font-medium">{p.offDate ? dayLabel(p.offDate) : "—"}</dd></div>
            <div><dt className="text-sm text-text-muted">Works instead</dt><dd className="font-medium">{p.workDate ? dayLabel(p.workDate) : "—"}</dd></div>
          </>
        )}
        {(detail.kind === "wfh" || detail.kind === "on_duty") && (
          <div><dt className="text-sm text-text-muted">How long</dt><dd className="font-medium">{p.half ? `${p.half === "first" ? "First" : "Second"} half` : "Full day"}</dd></div>
        )}
        {detail.day && <div><dt className="text-sm text-text-muted">Day so far</dt><dd className="font-medium">{statusOf(detail.day.status).label}{detail.day.late ? ` · late ${detail.day.late}m` : ""}</dd></div>}
        <div className="col-span-2"><dt className="text-sm text-text-muted">Status</dt><dd className="mt-1"><StatusChip status={detail.status} /></dd></div>
        <div className="col-span-2 text-sm text-text-muted">Approved this month: {detail.approvedThisMonth.regs} regularizations, {hrs(detail.approvedThisMonth.minutes)} of partial days.</div>
        {detail.reason && <div className="col-span-2"><dt className="text-sm text-text-muted">Reason</dt><dd className="mt-1 rounded-md bg-surface-sunken px-3 py-2">{detail.reason}</dd></div>}
      </dl>
      <div>
        <h3 className="mb-3 text-sm font-semibold">Approvals</h3>
        <ApprovalTimeline levels={detail.steps.map((s) => ({ level: s.level, approver: s.approver, role: s.title ?? undefined, status: s.status === "skipped" ? "waiting" : s.status, comment: s.comment ?? undefined, at: s.acted_at ? new Date(s.acted_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : undefined }))} />
      </div>
      <Field label="Comment" help="Shared with the requester"><Textarea value={comment} onChange={(e) => onComment(e.target.value)} maxLength={1000} /></Field>
    </div>
  );
}
