"use client";
import * as React from "react";
import { Check, Inbox as InboxIcon, X } from "lucide-react";
import { Card } from "@/ui/card";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { Badge, StatusChip } from "@/ui/badge";
import { Drawer } from "@/ui/overlay";
import { Field, Textarea } from "@/ui/field";
import { EmptyState, Skeleton } from "@/ui/feedback";
import { ApprovalTimeline } from "@/ui/flow";
import { toast } from "@/ui/toast";
import { decideAction, leaveRequestDetailAction, profileChangeDetailAction } from "@/app/(app)/actions";
import { FIELD_LABELS } from "@/server/modules/employees/fields";
import { compOffDetailAction } from "@/app/(app)/me/leave/actions";
import { AttendanceRequestDetail } from "@/features/attendance/request-detail";
import { ExitSummary, useExitDetail } from "@/features/exits/exit-drawer";
import { ExpenseReviewDetail } from "@/features/expenses/review";
import { AssetRequestDetail } from "@/features/assets/request-detail";
import { LoanRequestDetail } from "@/features/loans/request-detail";

export type InboxRow = { stepId: string; entityType: string; entityId: string; summary: string; requester: string; requesterTitle: string | null; createdAt: string; ago: string };
type Detail = Awaited<ReturnType<typeof leaveRequestDetailAction>>;
type ChangeDetail = Awaited<ReturnType<typeof profileChangeDetailAction>>;
type CompOffDetail = { employee: string; days: number; note: string | null; dates: { date: string; dayType: string; clockedIn: boolean }[]; steps: { level: number; status: string; comment: string | null; acted_at: string | null; approver: string; title: string | null }[] } | null;
const KIND: Record<string, string> = { leave: "Leave", attendance_request: "Attendance", profile_change: "Profile change", comp_off: "Comp-off", exit: "Resignation", expense_claim: "Expense claim", expense_advance: "Expense advance", asset_request: "Asset", loan: "Loan" };
const DAY_TYPE: Record<string, string> = { weekly_off: "Weekly off", half_weekly_off: "Half weekly off", holiday: "Holiday", working: "Working day" };
const show = (v: unknown): string => v == null || v === "" ? "—" : typeof v === "object" ? Object.values(v as Record<string, unknown>).map(show).filter((x) => x !== "—").join(", ") || "—" : String(v);

export function InboxList({ items }: { items: InboxRow[] }) {
  const [hidden, setHidden] = React.useState<Set<string>>(new Set());
  const [open, setOpen] = React.useState<InboxRow | null>(null);
  const [detail, setDetail] = React.useState<Detail>(null);
  const [change, setChange] = React.useState<ChangeDetail>(null);
  const [compOff, setCompOff] = React.useState<CompOffDetail | undefined>(undefined);
  const [comment, setComment] = React.useState("");
  const [busy, start] = React.useTransition();
  const visible = items.filter((i) => !hidden.has(i.stepId));

  const decide = (row: InboxRow, decision: "approved" | "rejected") => {
    setHidden((h) => new Set(h).add(row.stepId));   // optimistic: the row leaves the list now
    if (open?.stepId === row.stepId) setOpen(null);
    start(async () => {
      const r = await decideAction(row.stepId, decision, comment || undefined);
      setComment("");
      if (r.ok) toast.success(decision === "approved" ? "Approved" : "Declined", { description: row.summary });
      else { toast.error(r.error); setHidden((h) => { const n = new Set(h); n.delete(row.stepId); return n; }); }
    });
  };

  const openRow = (row: InboxRow) => {
    setOpen(row); setDetail(null); setChange(null); setCompOff(undefined); setComment("");
    if (row.entityType === "comp_off") compOffDetailAction(row.entityId).then((r) => setCompOff(r.ok ? (r.data as CompOffDetail) : null));
    if (row.entityType === "leave") leaveRequestDetailAction(row.entityId).then(setDetail);
    if (row.entityType === "profile_change") profileChangeDetailAction(row.entityId).then(setChange);
  };

  if (visible.length === 0) {
    return <Card><EmptyState icon={<InboxIcon />} title="You're all caught up" description="Requests from your team that need your approval show up here." /></Card>;
  }
  return (
    <>
      <Card>
        <ul className="divide-y divide-border">
          {visible.map((row) => (
            <li key={row.stepId} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
              <button type="button" onClick={() => openRow(row)} className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-offset-4">
                <Avatar name={row.requester} />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2"><span className="text-base font-medium">{row.requester}</span><Badge tone="accent">{KIND[row.entityType] ?? row.entityType}</Badge></span>
                  <span className="block truncate text-sm text-text-muted">{row.summary.split(" · ").slice(1).join(" · ")} · {row.ago}</span>
                </span>
              </button>
              <div className="flex shrink-0 gap-2 sm:ml-auto">
                <Button variant="secondary" size="sm" onClick={() => decide(row, "rejected")} disabled={busy} aria-label={`Decline: ${row.summary}`}><X />Decline</Button>
                <Button size="sm" onClick={() => decide(row, "approved")} disabled={busy} aria-label={`Approve: ${row.summary}`}><Check />Approve</Button>
              </div>
            </li>
          ))}
        </ul>
      </Card>
      <Drawer open={!!open} onOpenChange={(o) => !o && setOpen(null)} title={open?.requester ?? ""} description={open?.summary.split(" · ").slice(1).join(" · ")}
        footer={open && <><Button variant="danger" onClick={() => decide(open, "rejected")}>Decline</Button><Button onClick={() => decide(open, "approved")}>Approve</Button></>}>
        {open?.entityType === "expense_claim" || open?.entityType === "expense_advance" ? (
          <ExpenseReviewDetail key={open.entityId} entityType={open.entityType} entityId={open.entityId} comment={comment} setComment={setComment} />
        ) : open?.entityType === "exit" ? (
          <ExitInboxDetail exitId={open.entityId} comment={comment} setComment={setComment} />
        ) : open?.entityType === "profile_change" ? (
          !change ? <div className="flex flex-col gap-3"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-24" /></div> : (
            <div className="flex flex-col gap-5">
              <table className="w-full text-base">
                <caption className="sr-only">Requested changes</caption>
                <thead><tr className="border-b border-border text-left text-sm text-text-muted"><th className="py-2 font-medium">Field</th><th className="py-2 font-medium">Now</th><th className="py-2 font-medium">Requested</th></tr></thead>
                <tbody>{Object.entries(change.changes).map(([k, v]) => (
                  <tr key={k} className="border-b border-border last:border-0"><td className="py-2 pr-3 text-text-muted">{FIELD_LABELS[k] ?? k}</td><td className="py-2 pr-3">{show(v.old)}</td><td className="py-2 font-medium">{show(v.new)}</td></tr>
                ))}</tbody>
              </table>
              <Field label="Comment" help="Shared with the requester"><Textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} /></Field>
            </div>
          )
        ) : open?.entityType === "comp_off" ? (
          compOff === undefined ? <div className="flex flex-col gap-3"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-24" /></div> : !compOff ? <p className="text-base text-text-muted">{open.summary}</p> : (
            <div className="flex flex-col gap-5">
              <ul className="flex flex-col gap-2">
                {compOff.dates.map((d) => (
                  <li key={d.date} className="flex flex-wrap items-center gap-2 rounded-md bg-surface-sunken px-3 py-2 text-base">
                    <span className="font-medium">{new Date(d.date + "T00:00:00Z").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}</span>
                    <Badge tone={d.dayType === "working" ? "warning" : "neutral"}>{DAY_TYPE[d.dayType] ?? d.dayType}</Badge>
                    <span className="text-sm text-text-muted">{d.clockedIn ? "Clocked in that day" : "No clock-in recorded"}</span>
                  </li>
                ))}
              </ul>
              {compOff.note && <div><p className="text-sm text-text-muted">Note</p><p className="mt-1 rounded-md bg-surface-sunken px-3 py-2">{compOff.note}</p></div>}
              <div>
                <h3 className="mb-3 text-sm font-semibold">Approvals</h3>
                <ApprovalTimeline levels={compOff.steps.map((s) => ({ level: s.level, approver: s.approver, role: s.title ?? undefined, status: (s.status === "skipped" ? "waiting" : s.status) as "approved" | "rejected" | "pending" | "waiting", comment: s.comment ?? undefined, at: s.acted_at ? new Date(s.acted_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : undefined }))} />
              </div>
              <Field label="Comment" help="Shared with the requester"><Textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} /></Field>
            </div>
          )
        ) : open?.entityType === "asset_request" ? (
          <AssetRequestDetail id={open.entityId} comment={comment} onComment={setComment} />
        ) : open?.entityType === "loan" ? (
          <LoanRequestDetail id={open.entityId} comment={comment} onComment={setComment} />
        ) : open?.entityType === "attendance_request" ? (
          <AttendanceRequestDetail id={open.entityId} comment={comment} onComment={setComment} />
        ) : open?.entityType !== "leave" ? (
          <p className="text-base text-text-muted">{open?.summary}</p>
        ) : !detail ? (
          <div className="flex flex-col gap-3"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-20" /><Skeleton className="h-24" /></div>
        ) : (
          <div className="flex flex-col gap-5">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-base">
              <div><dt className="text-sm text-text-muted">Leave type</dt><dd className="font-medium">{detail.request.type}</dd></div>
              <div><dt className="text-sm text-text-muted">Days</dt><dd className="font-medium tabular">{Number(detail.request.days)}</dd></div>
              <div><dt className="text-sm text-text-muted">Dates</dt><dd className="font-medium">{detail.request.from_date === detail.request.to_date ? detail.request.from_date : `${detail.request.from_date} → ${detail.request.to_date}`}</dd></div>
              <div><dt className="text-sm text-text-muted">Balance after approval</dt><dd className="font-medium tabular">{detail.balance?.available == null ? "No limit" : detail.balance.available}</dd></div>
              <div className="col-span-2"><dt className="text-sm text-text-muted">Status</dt><dd className="mt-1"><StatusChip status={detail.request.status} /></dd></div>
              {detail.request.note && <div className="col-span-2"><dt className="text-sm text-text-muted">Note</dt><dd className="mt-1 rounded-md bg-surface-sunken px-3 py-2">{detail.request.note}</dd></div>}
            </dl>
            <div>
              <h3 className="mb-3 text-sm font-semibold">Approvals</h3>
              <ApprovalTimeline levels={detail.steps.map((s) => ({ level: s.level, approver: s.approver, role: s.title ?? undefined, status: s.status === "skipped" ? "waiting" : s.status, comment: s.comment ?? undefined, at: s.acted_at ? new Date(s.acted_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : undefined }))} />
            </div>
            <Field label="Comment" help="Shared with the requester"><Textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} /></Field>
          </div>
        )}
      </Drawer>
    </>
  );
}

function ExitInboxDetail({ exitId, comment, setComment }: { exitId: string; comment: string; setComment: (v: string) => void }) {
  const { detail, error } = useExitDetail(exitId);
  if (error) return <p className="text-base text-danger-text">{error}</p>;
  if (!detail) return <div className="flex flex-col gap-3"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-28" /></div>;
  return (
    <div className="flex flex-col gap-5">
      <ExitSummary d={detail} />
      <div>
        <h3 className="mb-3 text-sm font-semibold">Approvals</h3>
        <ApprovalTimeline levels={detail.approvals.map((s) => ({ level: s.level, approver: s.approver, role: s.title ?? undefined, status: s.status === "skipped" ? "waiting" : s.status, comment: s.comment ?? undefined, at: s.acted_at ? new Date(s.acted_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : undefined }))} />
      </div>
      <Field label="Comment" help="Shared with the employee"><Textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} /></Field>
    </div>
  );
}
