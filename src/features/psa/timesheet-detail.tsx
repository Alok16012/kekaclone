"use client";
import * as React from "react";
import { Badge } from "@/ui/badge";
import { Field, Textarea } from "@/ui/field";
import { Skeleton } from "@/ui/feedback";
import { ApprovalTimeline } from "@/ui/flow";
import { timesheetDetailAction } from "@/app/(app)/psa/actions";
import { fmtWeek, formatMinutes } from "@/server/modules/psa/rules";
import type { TimesheetDetail } from "@/server/modules/psa/service";

const DAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function useTimesheetDetail(id: string | null) {
  const [state, setState] = React.useState<{ id: string; d?: TimesheetDetail; error?: string } | null>(null);
  React.useEffect(() => {
    if (!id) return;
    let live = true;
    timesheetDetailAction(id).then((r) => { if (live) setState(r.ok ? { id, d: r.data } : { id, error: r.error }); });
    return () => { live = false; };
  }, [id]);
  return id && state?.id === id ? state : null;
}

/** The read-only week: rows by project and task, day columns, totals, approval chain so far. */
export function TimesheetSummary({ d }: { d: TimesheetDetail }) {
  const dayTotals = d.days.map((_, i) => d.rows.reduce((t, r) => t + r.minutes[i], 0));
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-base">
        <div><dt className="text-sm text-text-muted">Week</dt><dd className="font-medium">{fmtWeek(d.week_start)}</dd></div>
        <div><dt className="text-sm text-text-muted">Hours</dt><dd className="font-medium tabular">{formatMinutes(d.total_minutes)} <span className="font-normal text-text-muted">· {formatMinutes(d.billable_minutes)} billable</span></dd></div>
      </dl>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[520px] text-sm">
          <caption className="sr-only">Hours by project and day</caption>
          <thead className="bg-surface-sunken text-text-muted"><tr><th scope="col" className="px-3 py-2 text-left font-medium">Project</th>{DAY.map((x) => <th key={x} scope="col" className="w-12 px-1 py-2 text-center font-medium">{x}</th>)}<th scope="col" className="px-2 py-2 text-right font-medium">Total</th></tr></thead>
          <tbody>
            {d.rows.map((r, i) => (
              <tr key={i} className="border-t border-border">
                <td className="px-3 py-2">
                  <span className="font-medium">{r.code}</span> {r.project}{r.task && <span className="text-text-muted"> · {r.task}</span>}
                  {!r.billable && <Badge tone="neutral" className="ml-1">Not billable</Badge>}
                  {r.note && <p className="mt-0.5 text-xs text-text-muted">{r.note}</p>}
                </td>
                {r.minutes.map((m, j) => <td key={j} className="px-1 py-2 text-center tabular">{m ? formatMinutes(m) : "–"}</td>)}
                <td className="px-2 py-2 text-right font-medium tabular">{formatMinutes(r.minutes.reduce((a, b) => a + b, 0))}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr className="border-t border-border bg-surface-sunken font-medium"><td className="px-3 py-2">Daily total</td>{dayTotals.map((m, j) => <td key={j} className="px-1 py-2 text-center tabular">{m ? formatMinutes(m) : "–"}</td>)}<td className="px-2 py-2 text-right tabular">{formatMinutes(d.total_minutes)}</td></tr></tfoot>
        </table>
      </div>
      {d.steps.length > 0 && (
        <div>
          <h3 className="mb-3 text-sm font-semibold">Approvals</h3>
          <ApprovalTimeline levels={d.steps.map((s) => ({ level: s.level, approver: s.approver, role: s.title ?? undefined, status: (s.status === "skipped" ? "waiting" : s.status) as "approved" | "rejected" | "pending" | "waiting", comment: s.comment ?? undefined, at: s.acted_at ? new Date(s.acted_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : undefined }))} />
        </div>
      )}
    </div>
  );
}

/** Inbox pane for a timesheet: the week's hours and a comment box for the decision. */
export function TimesheetRequestDetail({ id, comment, onComment }: { id: string; comment: string; onComment: (v: string) => void }) {
  const s = useTimesheetDetail(id);
  if (!s) return <div className="flex flex-col gap-3"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-32" /></div>;
  if (s.error || !s.d) return <p className="text-base text-danger-text">{s.error ?? "Couldn't load this timesheet."}</p>;
  return (
    <div className="flex flex-col gap-5">
      <TimesheetSummary d={s.d} />
      <Field label="Comment" help="Shared with the person; required when you send it back"><Textarea value={comment} onChange={(e) => onComment(e.target.value)} maxLength={1000} /></Field>
    </div>
  );
}
