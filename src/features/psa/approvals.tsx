"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, ClipboardCheck, RotateCcw, X } from "lucide-react";
import { Card } from "@/ui/card";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { Badge, StatusChip } from "@/ui/badge";
import { Drawer, Modal } from "@/ui/overlay";
import { Field, Textarea } from "@/ui/field";
import { TabsList, Tabs } from "@/ui/tabs";
import { EmptyState, Skeleton } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { decideTimesheetAction, reopenTimesheetAction } from "@/app/(app)/psa/actions";
import { fmtWeek, formatMinutes, TIMESHEET_STATUS_LABEL, type TimesheetStatus } from "@/server/modules/psa/rules";
import { TimesheetSummary, useTimesheetDetail } from "./timesheet-detail";

export type QueueRow = { id: string; employee: string; title: string | null; week_start: string; total_minutes: number; billable_minutes: number; status: TimesheetStatus; submitted_at: string | null; step_id: string | null; projects: string[] };
const CHIP: Record<TimesheetStatus, "draft" | "pending" | "approved" | "rejected"> = { draft: "draft", submitted: "pending", approved: "approved", rejected: "rejected" };
const FILTERS = [{ value: "submitted", label: "Waiting" }, { value: "approved", label: "Approved" }, { value: "rejected", label: "Sent back" }] as const;

/** S128: timesheets waiting on you (and, for project admins, everyone's). Approve inline or open the week first. */
export function TimesheetApprovals({ rows, status, isAdmin }: { rows: QueueRow[]; status: string; isAdmin: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState<QueueRow | null>(null);
  const [comment, setComment] = React.useState("");
  const [reopen, setReopen] = React.useState<QueueRow | null>(null);
  const [reason, setReason] = React.useState("");
  const [hidden, setHidden] = React.useState<Set<string>>(new Set());
  const [busy, start] = React.useTransition();
  const detail = useTimesheetDetail(open?.id ?? null);
  const visible = rows.filter((r) => !hidden.has(r.id));

  const decideRow = (row: QueueRow, decision: "approved" | "rejected") => {
    if (!row.step_id) return;
    if (decision === "rejected" && !comment.trim()) { toast.error("Say what needs to change before sending it back."); setOpen(row); return; }
    setHidden((h) => new Set(h).add(row.id));
    setOpen(null);
    start(async () => {
      const r = await decideTimesheetAction(row.step_id!, decision, comment || undefined);
      setComment("");
      if (r.ok) toast.success(decision === "approved" ? "Timesheet approved" : "Sent back", { description: `${row.employee} · ${fmtWeek(row.week_start)}` });
      else { toast.error(r.error); setHidden((h) => { const n = new Set(h); n.delete(row.id); return n; }); }
    });
  };
  const doReopen = () => start(async () => {
    if (!reopen) return;
    const r = await reopenTimesheetAction(reopen.id, reason);
    if (r.ok) { toast.success("Week reopened", { description: "They can edit and resubmit it." }); setReopen(null); setReason(""); } else toast.error(r.error);
  });

  return (
    <div className="flex flex-col gap-4">
      <Tabs value={status} onValueChange={(v) => router.push(`/psa/approvals?status=${v}`)}>
        <TabsList variant="pill" items={FILTERS.map((f) => ({ value: f.value, label: f.label }))} />
      </Tabs>
      {visible.length === 0 ? (
        <Card><EmptyState icon={<ClipboardCheck />} title={status === "submitted" ? "Nothing waiting for you" : "No timesheets here"} description={status === "submitted" ? "Submitted weeks from the projects you approve show up here." : "Switch the filter to see other weeks."} /></Card>
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {visible.map((r) => (
              <li key={r.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
                <button type="button" onClick={() => { setOpen(r); setComment(""); }} className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-offset-4">
                  <Avatar name={r.employee} />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2"><span className="text-base font-medium">{r.employee}</span><StatusChip status={CHIP[r.status]} label={TIMESHEET_STATUS_LABEL[r.status]} /></span>
                    <span className="block truncate text-sm text-text-muted">{fmtWeek(r.week_start)} · {formatMinutes(r.total_minutes)} ({formatMinutes(r.billable_minutes)} billable) · {r.projects.join(", ") || "no projects"}</span>
                  </span>
                </button>
                <div className="flex shrink-0 gap-2 sm:ml-auto">
                  {r.step_id ? (
                    <>
                      <Button variant="secondary" size="sm" onClick={() => { setOpen(r); setComment(""); }} disabled={busy}><X />Send back</Button>
                      <Button size="sm" onClick={() => decideRow(r, "approved")} disabled={busy}><Check />Approve</Button>
                    </>
                  ) : r.status === "submitted" ? <Badge tone="neutral">Waiting for someone else</Badge>
                    : r.status === "approved" && isAdmin ? <Button variant="secondary" size="sm" onClick={() => setReopen(r)}><RotateCcw />Reopen</Button> : null}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Drawer open={!!open} onOpenChange={(o) => !o && setOpen(null)} title={open?.employee ?? ""} description={open ? fmtWeek(open.week_start) : undefined}
        footer={open?.step_id ? <><Button variant="danger" onClick={() => decideRow(open, "rejected")} disabled={busy}>Send back</Button><Button onClick={() => decideRow(open, "approved")} disabled={busy}>Approve</Button></> : undefined}>
        {!detail ? <div className="flex flex-col gap-3"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-32" /></div>
          : detail.error || !detail.d ? <p className="text-base text-danger-text">{detail.error ?? "Couldn't load this week."}</p>
          : <div className="flex flex-col gap-5"><TimesheetSummary d={detail.d} />{open?.step_id && <Field label="Comment" help="Shared with the person; required when you send it back"><Textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} /></Field>}</div>}
      </Drawer>
      <Modal open={!!reopen} onOpenChange={(o) => !o && setReopen(null)} title="Reopen this week?" description={reopen ? `${reopen.employee} · ${fmtWeek(reopen.week_start)}` : undefined}
        footer={<><Button variant="secondary" onClick={() => setReopen(null)}>Cancel</Button><Button onClick={doReopen} loading={busy}>Reopen</Button></>}>
        <Field label="Why" help="They'll see this and can edit and resubmit the week."><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
      </Modal>
    </div>
  );
}
