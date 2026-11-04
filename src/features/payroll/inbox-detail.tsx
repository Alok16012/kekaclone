"use client";
import * as React from "react";
import { Paperclip } from "lucide-react";
import { Badge } from "@/ui/badge";
import { Field, Textarea } from "@/ui/field";
import { Skeleton } from "@/ui/feedback";
import { ApprovalTimeline } from "@/ui/flow";
import { salaryRevisionDetailAction } from "@/app/(app)/people/[id]/finance-actions";
import { componentClaimDetailAction } from "@/app/(app)/me/pay/actions";
import { fmtDate, fmtMonth, money, REASON_LABEL } from "./labels";

type Steps = { level: number; status: string; comment: string | null; acted_at: string | null; approver: string; title: string | null }[];
const Timeline = ({ steps }: { steps: Steps }) => (
  <div>
    <h3 className="mb-3 text-sm font-semibold">Approvals</h3>
    <ApprovalTimeline levels={steps.map((s) => ({ level: s.level, approver: s.approver, role: s.title ?? undefined, status: (s.status === "skipped" ? "waiting" : s.status) as "approved" | "rejected" | "pending" | "waiting", comment: s.comment ?? undefined, at: s.acted_at ? new Date(s.acted_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : undefined }))} />
  </div>
);
const Loading = () => <div className="flex flex-col gap-3"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-24" /></div>;

/** Inbox: a salary revision waiting for approval. */
export function SalaryRevisionDetail({ id, comment, onComment }: { id: string; comment: string; onComment: (v: string) => void }) {
  type D = Extract<Awaited<ReturnType<typeof salaryRevisionDetailAction>>, { ok: true }>["data"];
  const [d, setD] = React.useState<D | null | undefined>(undefined);
  React.useEffect(() => { let live = true; salaryRevisionDetailAction(id).then((r) => { if (live) setD(r.ok ? r.data : null); }); return () => { live = false; }; }, [id]);
  if (d === undefined) return <Loading />;
  if (!d) return <p className="text-base text-danger-text">This revision couldn&apos;t be loaded.</p>;
  const change = d.currentCtcPaise ? Math.round(((d.newCtcPaise - d.currentCtcPaise) / d.currentCtcPaise) * 1000) / 10 : null;
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-base">
        <div><dt className="text-sm text-text-muted">Person</dt><dd className="font-medium">{d.employee.name} <span className="font-normal text-text-muted">{d.employee.number}</span></dd></div>
        <div><dt className="text-sm text-text-muted">Reason</dt><dd className="font-medium">{REASON_LABEL[d.reason] ?? d.reason}</dd></div>
        <div><dt className="text-sm text-text-muted">Current CTC</dt><dd className="font-medium tabular">{d.currentCtcPaise != null ? money(d.currentCtcPaise) : "—"}</dd></div>
        <div><dt className="text-sm text-text-muted">New CTC</dt><dd className="font-medium tabular">{money(d.newCtcPaise)}{change != null && <span className="ml-1 text-sm font-normal text-text-muted">({change >= 0 ? "+" : ""}{change}%)</span>}</dd></div>
        <div><dt className="text-sm text-text-muted">From</dt><dd className="font-medium">{fmtDate(d.effectiveFrom)}</dd></div>
        <div><dt className="text-sm text-text-muted">Structure</dt><dd className="font-medium">{d.structure}</dd></div>
        {d.arrearsFromMonth && <div className="col-span-2"><Badge tone="warning">Back-dated: arrears from {fmtMonth(d.arrearsFromMonth)} are paid in the next payroll</Badge></div>}
        <div className="col-span-2"><dt className="text-sm text-text-muted">Raised by</dt><dd>{d.requestedBy ?? "—"} · {fmtDate(d.requestedAt.slice(0, 10))}</dd></div>
      </dl>
      <Timeline steps={d.steps} />
      <Field label="Comment" help="Shared with the person who raised it"><Textarea value={comment} onChange={(e) => onComment(e.target.value)} maxLength={1000} /></Field>
    </div>
  );
}

/** Inbox: a reimbursable component claim with its bills. */
export function ComponentClaimDetail({ id, comment, onComment }: { id: string; comment: string; onComment: (v: string) => void }) {
  type D = Extract<Awaited<ReturnType<typeof componentClaimDetailAction>>, { ok: true }>["data"];
  const [d, setD] = React.useState<D | null | undefined>(undefined);
  React.useEffect(() => { let live = true; componentClaimDetailAction(id).then((r) => { if (live) setD(r.ok ? r.data : null); }); return () => { live = false; }; }, [id]);
  if (d === undefined) return <Loading />;
  if (!d) return <p className="text-base text-danger-text">This claim couldn&apos;t be loaded.</p>;
  const c = d.claim;
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-base">
        <div><dt className="text-sm text-text-muted">Component</dt><dd className="font-medium">{c.component}</dd></div>
        <div><dt className="text-sm text-text-muted">Month</dt><dd className="font-medium">{fmtMonth(c.claimMonth)}</dd></div>
        <div><dt className="text-sm text-text-muted">Claimed</dt><dd className="font-medium tabular">{money(c.amountPaise)}</dd></div>
        <div><dt className="text-sm text-text-muted">Left in this year&apos;s limit</dt><dd className="font-medium tabular">{d.limit ? `${money(d.limit.remainingPaise)} of ${money(d.limit.limitPaise)}` : "—"}</dd></div>
        {c.note && <div className="col-span-2"><dt className="text-sm text-text-muted">Note</dt><dd className="mt-1 rounded-md bg-surface-sunken px-3 py-2">{c.note}</dd></div>}
      </dl>
      {d.limit && c.amountPaise > d.limit.remainingPaise && <Badge tone="warning">Only {money(d.limit.remainingPaise)} fits in the limit; the rest isn&apos;t paid</Badge>}
      <div>
        <h3 className="mb-2 text-sm font-semibold">Bills</h3>
        <ul className="flex flex-col gap-1">{c.bills.map((b) => <li key={b.id}><a href={`/payroll/files/${b.id}`} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-base text-accent-text underline-offset-4 hover:underline"><Paperclip aria-hidden className="size-4" />{b.name}</a></li>)}</ul>
      </div>
      <Timeline steps={d.steps} />
      <Field label="Comment" help="Shared with the person"><Textarea value={comment} onChange={(e) => onComment(e.target.value)} maxLength={1000} /></Field>
    </div>
  );
}
