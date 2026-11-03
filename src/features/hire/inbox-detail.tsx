"use client";
import * as React from "react";
import Link from "next/link";
import { Field, Textarea } from "@/ui/field";
import { Skeleton } from "@/ui/feedback";
import { ApprovalTimeline } from "@/ui/flow";
import { offerDetailAction, requisitionDetailAction } from "@/app/(app)/hire/actions";
import { ReqStatus } from "./requisitions";
import { OfferBadge, day, inr0 } from "./shared";

type Steps = { level: number; status: string; comment: string | null; acted_at: Date | null; approver: string; title: string | null }[];
const Timeline = ({ steps }: { steps: Steps }) => (
  <ApprovalTimeline levels={steps.map((s) => ({ level: s.level, approver: s.approver, role: s.title ?? undefined, status: (s.status === "skipped" ? "waiting" : s.status) as "approved" | "rejected" | "pending" | "waiting", comment: s.comment ?? undefined, at: s.acted_at ? new Date(s.acted_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : undefined }))} />
);
const Comment = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
  <Field label="Comment" help="Shared with the person who raised it"><Textarea value={value} onChange={(e) => onChange(e.target.value)} maxLength={1000} /></Field>
);
const Loading = () => <div className="flex flex-col gap-3"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-20" /><Skeleton className="h-24" /></div>;

function useDetail<T>(fetcher: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>) {
  const [state, setState] = React.useState<{ data?: T; error?: string } | null>(null);
  React.useEffect(() => { let live = true; fetcher().then((r) => { if (live) setState(r.ok ? { data: r.data } : { error: r.error }); }); return () => { live = false; }; }, [fetcher]);
  return state;
}

/** Inbox pane for a requisition (headcount request) waiting on the approver. */
export function RequisitionInboxDetail({ id, comment, setComment }: { id: string; comment: string; setComment: (v: string) => void }) {
  const fetcher = React.useCallback(() => requisitionDetailAction(id) as Promise<{ ok: true; data: NonNullable<Extract<Awaited<ReturnType<typeof requisitionDetailAction>>, { ok: true }>["data"]> } | { ok: false; error: string }>, [id]);
  const s = useDetail(fetcher);
  if (!s) return <Loading />;
  if (s.error || !s.data) return <p className="text-base text-danger-text">{s.error ?? "Requisition not found."}</p>;
  const r = s.data.requisition;
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-base">
        <div className="col-span-2"><dt className="text-sm text-text-muted">Role</dt><dd className="font-medium">{r.title} <span className="text-text-muted">· {r.openings} opening{r.openings === 1 ? "" : "s"}</span></dd></div>
        <div><dt className="text-sm text-text-muted">Status</dt><dd className="mt-1"><ReqStatus status={r.status} /></dd></div>
        <div><dt className="text-sm text-text-muted">Fill by</dt><dd>{day(r.target_date)}</dd></div>
        <div><dt className="text-sm text-text-muted">Department</dt><dd>{r.department ?? "—"}</dd></div>
        <div><dt className="text-sm text-text-muted">Location</dt><dd>{r.location ?? "—"}</dd></div>
        <div><dt className="text-sm text-text-muted">Salary range</dt><dd>{r.salary_min_paise != null || r.salary_max_paise != null ? `${r.salary_min_paise != null ? inr0(r.salary_min_paise) : "…"} – ${r.salary_max_paise != null ? inr0(r.salary_max_paise) : "…"}` : "—"}</dd></div>
        <div><dt className="text-sm text-text-muted">Experience</dt><dd>{r.experience_min != null || r.experience_max != null ? `${r.experience_min ?? 0}–${r.experience_max ?? "any"} years` : "—"}</dd></div>
        {r.backfill_for && <div className="col-span-2"><dt className="text-sm text-text-muted">Replaces</dt><dd>{r.backfill_for}</dd></div>}
        {r.description && <div className="col-span-2"><dt className="text-sm text-text-muted">Why</dt><dd className="mt-1 whitespace-pre-line rounded-md bg-surface-sunken px-3 py-2">{r.description}</dd></div>}
      </dl>
      <div><h3 className="mb-3 text-sm font-semibold">Approvals</h3><Timeline steps={s.data.steps} /></div>
      <Comment value={comment} onChange={setComment} />
      <Link href="/hire/requisitions" className="text-sm text-accent-text underline-offset-2 hover:underline">Open requisitions</Link>
    </div>
  );
}

/** Inbox pane for an offer waiting on the approver: who, what role, how much, when. */
export function OfferInboxDetail({ id, comment, setComment }: { id: string; comment: string; setComment: (v: string) => void }) {
  const fetcher = React.useCallback(() => offerDetailAction(id) as Promise<{ ok: true; data: NonNullable<Extract<Awaited<ReturnType<typeof offerDetailAction>>, { ok: true }>["data"]> } | { ok: false; error: string }>, [id]);
  const s = useDetail(fetcher);
  if (!s) return <Loading />;
  if (s.error || !s.data) return <p className="text-base text-danger-text">{s.error ?? "Offer not found."}</p>;
  const o = s.data.offer;
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-base">
        <div className="col-span-2"><dt className="text-sm text-text-muted">Candidate</dt><dd className="font-medium">{o.candidate} <span className="font-normal text-text-muted">· {o.email}</span></dd></div>
        <div><dt className="text-sm text-text-muted">Job</dt><dd>{o.job}</dd></div>
        <div><dt className="text-sm text-text-muted">Designation</dt><dd>{o.designation ?? "—"}</dd></div>
        <div><dt className="text-sm text-text-muted">Annual CTC</dt><dd className="font-medium tabular">{inr0(o.ctc_paise)}</dd></div>
        <div><dt className="text-sm text-text-muted">Joining date</dt><dd>{day(o.joining_date)}</dd></div>
        <div><dt className="text-sm text-text-muted">Accept by</dt><dd>{o.expires_on ? day(o.expires_on) : "No deadline"}</dd></div>
        <div><dt className="text-sm text-text-muted">Version</dt><dd className="mt-1 flex items-center gap-2"><span>v{o.version}</span><OfferBadge status={o.status} /></dd></div>
        <div><dt className="text-sm text-text-muted">Letter template</dt><dd>{o.template ?? "—"}</dd></div>
        <div><dt className="text-sm text-text-muted">Drafted by</dt><dd>{o.created_by ?? "—"}</dd></div>
        {o.note && <div className="col-span-2"><dt className="text-sm text-text-muted">Note</dt><dd className="mt-1 whitespace-pre-line rounded-md bg-surface-sunken px-3 py-2">{o.note}</dd></div>}
      </dl>
      <div><h3 className="mb-3 text-sm font-semibold">Approvals</h3><Timeline steps={s.data.steps} /></div>
      <Comment value={comment} onChange={setComment} />
      <Link href={`/hire/candidates/${o.application_id}`} className="text-sm text-accent-text underline-offset-2 hover:underline">Open the candidate</Link>
    </div>
  );
}
