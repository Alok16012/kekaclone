"use client";
import * as React from "react";
import { CalendarX2, UserRound } from "lucide-react";
import { Card, CardHeader } from "@/ui/card";
import { Button } from "@/ui/button";
import { StatusChip } from "@/ui/badge";
import { ConfirmDialog, Drawer } from "@/ui/overlay";
import { Banner, EmptyState, Skeleton } from "@/ui/feedback";
import { ApprovalTimeline } from "@/ui/flow";
import { toast } from "@/ui/toast";
import { cancelLeaveAction } from "@/app/(app)/actions";
import { myLeaveRequestDetailAction } from "@/app/(app)/me/leave/actions";
import { useT } from "@/i18n/client";

export type RequestRow = { id: string; type: string; color: string; range: string; days: number; part: string | null; status: "pending" | "approved" | "rejected" | "cancelled"; note: string | null; cancellable: boolean; appliedBy?: string | null; grantEvent?: string | null };
type Detail = Awaited<ReturnType<typeof myLeaveRequestDetailAction>>;

const STATUS_COPY: Record<RequestRow["status"], string> = {
  pending: "Waiting for approval. You'll be told as soon as it's decided.", approved: "Approved. The days have been taken from your balance.",
  rejected: "Declined. The days stay in your balance.", cancelled: "Cancelled. Nothing was taken from your balance.",
};

/** Where a request stands: every approval step with who, when and what they said. */
function RequestDrawer({ row, onClose }: { row: RequestRow; onClose: () => void }) {
  const [detail, setDetail] = React.useState<Detail | undefined>(undefined);
  React.useEffect(() => {
    let live = true;
    myLeaveRequestDetailAction(row.id).then((d) => { if (live) setDetail(d); }).catch(() => { if (live) setDetail(null); });
    return () => { live = false; };
  }, [row.id]);
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={`${row.type} · ${row.range}`} description={`${row.days} ${row.days === 1 ? "day" : "days"}${row.part ? ` · ${row.part}` : ""}`}>
      {detail === undefined ? <div className="flex flex-col gap-3" aria-busy><Skeleton className="h-5 w-1/2" /><Skeleton className="h-20" /><Skeleton className="h-24" /></div>
        : detail === null ? <Banner tone="warning">This request isn&apos;t available anymore.</Banner> : (
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-3"><StatusChip status={detail.status} /><p className="text-sm text-text-muted">{STATUS_COPY[detail.status]}</p></div>
          {detail.appliedBy && <Banner tone="info"><span className="flex gap-2"><UserRound className="mt-0.5 size-4 shrink-0" aria-hidden />Applied by {detail.appliedBy} on your behalf.</span></Banner>}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-base">
            <div><dt className="text-sm text-text-muted">Requested on</dt><dd className="font-medium">{new Date(detail.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</dd></div>
            {detail.grantEvent && <div><dt className="text-sm text-text-muted">Granted for</dt><dd className="font-medium">{detail.grantEvent}</dd></div>}
            {detail.note && <div className="col-span-2"><dt className="text-sm text-text-muted">Note</dt><dd className="mt-1 rounded-md bg-surface-sunken px-3 py-2">{detail.note}</dd></div>}
          </dl>
          <div>
            <h3 className="mb-3 text-sm font-semibold">Approval chain</h3>
            {detail.steps.length === 0 ? <p className="text-sm text-text-muted">Nobody needed to approve this, so it was decided straight away.</p> : (
              <ApprovalTimeline levels={detail.steps.map((s) => ({ level: s.level, approver: s.approver, role: s.title ?? undefined, status: s.status === "skipped" ? "waiting" : s.status, comment: s.comment ?? undefined, at: s.actedAt ? new Date(s.actedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : undefined }))} />
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

export function LeaveRequests({ rows }: { rows: RequestRow[] }) {
  const [open, setOpen] = React.useState<RequestRow | null>(null);
  const { t } = useT();
  const upcoming = rows.filter((r) => r.status === "pending" || r.cancellable).reverse();   // rows arrive newest first; upcoming reads soonest first
  const past = rows.filter((r) => !upcoming.includes(r));
  const list = (items: RequestRow[]) => (
    <ul className="divide-y divide-border">
      {items.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
          <span aria-hidden className="h-9 w-1 shrink-0 rounded-pill" style={{ background: r.color }} />
          <button type="button" onClick={() => setOpen(r)} className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-offset-4" aria-label={`${r.type}, ${r.range}: see status and approvals`}>
            <p className="text-base font-medium">{r.type} <span className="font-normal text-text-muted">· {r.range}</span></p>
            <p className="text-sm text-text-muted tabular">{t("leave.days", { count: r.days })}{r.part ? ` · ${r.part}` : ""}{r.appliedBy ? ` · applied by ${r.appliedBy}` : ""}{r.note ? ` · “${r.note}”` : ""}</p>
          </button>
          <StatusChip status={r.status} label={t(`leave.status.${r.status}` as const)} />
          {r.cancellable && (
            <ConfirmDialog title={t("leave.cancel_title")} description={`${r.type}, ${r.range}. ${r.status === "approved" ? t("leave.cancel_back") : t("leave.cancel_pending")}`}
              confirmLabel={t("leave.cancel_confirm")} onConfirm={async () => { const res = await cancelLeaveAction(r.id); if (res.ok) toast.success(t("leave.cancelled")); else toast.error(res.error); }}
              trigger={<Button variant="ghost" size="sm">{t("leave.cancel")}</Button>} />
          )}
        </li>
      ))}
    </ul>
  );
  return (
    <Card>
      <CardHeader title={t("leave.your_requests")} description={t("leave.requests_hint")} />
      {rows.length === 0 ? (
        <EmptyState compact icon={<CalendarX2 />} title={t("leave.no_requests")} description={t("leave.no_requests_hint")} />
      ) : (
        <>
          {list(upcoming)}
          {past.length > 0 && <><p className="border-t border-border bg-surface-sunken px-5 py-2 text-xs font-medium uppercase tracking-wide text-text-muted">{t("leave.history")}</p>{list(past)}</>}
        </>
      )}
      {open && <RequestDrawer row={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}
