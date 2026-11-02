"use client";
import * as React from "react";
import { Ban, CheckCircle2, CircleDot, Clock3, MinusCircle, Wallet, XCircle } from "lucide-react";
import { Badge } from "@/ui/badge";
import { ApprovalTimeline } from "@/ui/flow";
import { Skeleton } from "@/ui/feedback";
import { cn } from "@/lib/cn";
import { formatPaise, LOAN_STATUS_LABEL, monthLabel, RATE_TYPE_LABEL, type RateType } from "@/server/modules/loans/rules";
import { loanDetailAction } from "@/app/(app)/me/loans/actions";
import type { LoanDetail } from "@/server/modules/loans/service";

export const Money = ({ paise, className }: { paise: number; className?: string }) => <span className={cn("tabular", className)}>{formatPaise(paise)}</span>;
export const shortDate = (iso: string) => new Date(iso.slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const rateText = (rate: string, type: RateType) => (type === "zero" ? "Interest-free" : `${Number(rate)}% a year, ${RATE_TYPE_LABEL[type].toLowerCase()}`);

const TONE: Record<string, { tone: "neutral" | "warning" | "success" | "danger" | "accent"; Icon: React.ComponentType<{ className?: string }> }> = {
  requested: { tone: "warning", Icon: Clock3 }, approved: { tone: "accent", Icon: CheckCircle2 }, rejected: { tone: "danger", Icon: XCircle },
  cancelled: { tone: "neutral", Icon: MinusCircle }, disbursed: { tone: "accent", Icon: Wallet }, active: { tone: "accent", Icon: CircleDot },
  closed: { tone: "success", Icon: CheckCircle2 }, written_off: { tone: "neutral", Icon: Ban },
};
export function LoanStatus({ status }: { status: string }) {
  const s = TONE[status] ?? TONE.requested;
  return <Badge tone={s.tone}><s.Icon aria-hidden />{LOAN_STATUS_LABEL[status] ?? status}</Badge>;
}

const INST: Record<string, string> = { scheduled: "Due", deducted: "Taken from salary", skipped: "Skipped", prepaid: "Paid off early" };

export function ScheduleTable({ rows, caption, actions }: { rows: LoanDetail["schedule"]; caption: string; actions?: (r: LoanDetail["schedule"][number]) => React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-[26rem] text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-surface-sunken text-left text-text-muted">
          <tr><th scope="col" className="px-3 py-2 font-medium">Month</th><th scope="col" className="px-3 py-2 text-right font-medium">Principal</th><th scope="col" className="px-3 py-2 text-right font-medium">Interest</th><th scope="col" className="px-3 py-2 text-right font-medium">EMI</th><th scope="col" className="px-3 py-2 font-medium">Status</th>{actions && <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>}</tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.id} className={cn(r.status === "skipped" || r.status === "prepaid" ? "text-text-muted" : "")}>
              <th scope="row" className="px-3 py-2 text-left font-normal">{monthLabel(r.dueMonth)}</th>
              <td className="px-3 py-2 text-right"><Money paise={r.principalPaise} /></td>
              <td className="px-3 py-2 text-right"><Money paise={r.interestPaise} /></td>
              <td className="px-3 py-2 text-right font-medium"><Money paise={r.principalPaise + r.interestPaise} /></td>
              <td className="px-3 py-2">{INST[r.status] ?? r.status}{r.status === "scheduled" && r.inPayroll ? " · in payroll" : ""}{r.locked && r.status === "scheduled" ? " · payroll finalised" : ""}</td>
              {actions && <td className="px-3 py-2 text-right">{actions(r)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LoanFacts({ d }: { d: LoanDetail }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-base">
      <div><dt className="text-sm text-text-muted">Loan type</dt><dd className="font-medium">{d.category}</dd></div>
      <div><dt className="text-sm text-text-muted">Amount</dt><dd className="font-medium"><Money paise={d.principalPaise} /></dd></div>
      <div><dt className="text-sm text-text-muted">Interest</dt><dd>{rateText(d.interestRate, d.rateType)}</dd></div>
      <div><dt className="text-sm text-text-muted">Repaid over</dt><dd>{d.tenureMonths} month{d.tenureMonths === 1 ? "" : "s"}</dd></div>
      <div><dt className="text-sm text-text-muted">EMI</dt><dd className="tabular">{formatPaise(d.emiPaise ?? d.preview.emiPaise)}</dd></div>
      <div><dt className="text-sm text-text-muted">{d.status === "active" ? "Still owed" : "Total interest"}</dt><dd className="tabular">{d.status === "active" ? formatPaise(d.outstandingPaise) : formatPaise(d.schedule.length ? d.schedule.reduce((s, r) => s + r.interestPaise, 0) : d.preview.totalInterestPaise)}</dd></div>
      {d.disbursedOn && <div><dt className="text-sm text-text-muted">Paid out</dt><dd>{shortDate(d.disbursedOn)}{d.disbursalRef ? ` · ${d.disbursalRef}` : ""}</dd></div>}
      {d.preEmiInterestPaise > 0 && <div><dt className="text-sm text-text-muted">Pre-EMI interest</dt><dd className="tabular">{formatPaise(d.preEmiInterestPaise)} <span className="text-sm text-text-muted">(with the first EMI)</span></dd></div>}
      <div className="col-span-2"><dt className="text-sm text-text-muted">Status</dt><dd className="mt-1"><LoanStatus status={d.status} /></dd></div>
      {d.reason && <div className="col-span-2"><dt className="text-sm text-text-muted">Reason</dt><dd className="mt-1 whitespace-pre-line rounded-md bg-surface-sunken px-3 py-2">{d.reason}</dd></div>}
    </dl>
  );
}

export function LoanSteps({ d }: { d: LoanDetail }) {
  if (!d.steps.length) return null;
  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold">Approvals</h3>
      <ApprovalTimeline levels={d.steps.map((s) => ({ level: s.level, approver: s.approver, role: s.title ?? undefined, status: (s.status === "skipped" ? "waiting" : s.status) as "approved" | "rejected" | "pending" | "waiting", comment: s.comment ?? undefined, at: s.acted_at ? new Date(s.acted_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : undefined }))} />
    </div>
  );
}

/** Loads a loan's detail for a drawer; `version` re-fetches after an action. */
export function useLoanDetail(id: string | null, version = 0) {
  const [state, setState] = React.useState<{ key: string; d?: LoanDetail; error?: string } | null>(null);
  React.useEffect(() => {
    if (!id) return;
    let live = true;
    loanDetailAction(id).then((r) => { if (live) setState(r.ok ? { key: `${id}:${version}`, d: r.data } : { key: `${id}:${version}`, error: r.error }); });
    return () => { live = false; };
  }, [id, version]);
  const s = id && state?.key === `${id}:${version}` ? state : null;
  return s;
}

export const DetailSkeleton = () => <div className="flex flex-col gap-3"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-20" /><Skeleton className="h-32" /></div>;
