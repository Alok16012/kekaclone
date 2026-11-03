"use client";
import * as React from "react";
import { Field, Textarea } from "@/ui/field";
import { Skeleton } from "@/ui/feedback";
import { pctText } from "@/server/modules/performance/rules";
import { proposalDetailAction } from "@/app/(app)/compensation/actions";
import { fmtDate, inr } from "./bits";

type D = { name: string; cycle: string; effective_from: string; current: number; proposed: number; rating: number | null; increment_bp: number; note: string | null; recommender: string | null };

/** Inbox pane for an increment recommendation: the numbers an approver needs. */
export function ProposalDetail({ id, comment, onComment }: { id: string; comment: string; onComment: (v: string) => void }) {
  const [state, setState] = React.useState<{ id: string; d?: D; error?: string } | null>(null);
  React.useEffect(() => {
    let live = true;
    proposalDetailAction(id).then((r) => { if (live) setState(r.ok ? { id, d: r.data as D } : { id, error: r.error }); });
    return () => { live = false; };
  }, [id]);
  const s = state?.id === id ? state : null;
  if (!s) return <div className="flex flex-col gap-3"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-20" /></div>;
  if (s.error || !s.d) return <p className="text-base text-danger-text">{s.error ?? "Couldn't load this recommendation."}</p>;
  const d = s.d;
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-base">
        <div><dt className="text-sm text-text-muted">For</dt><dd className="font-medium">{d.name}</dd></div>
        <div><dt className="text-sm text-text-muted">Cycle</dt><dd>{d.cycle}</dd></div>
        <div><dt className="text-sm text-text-muted">Rating</dt><dd className="tabular">{d.rating ?? "—"}</dd></div>
        <div><dt className="text-sm text-text-muted">Increment</dt><dd className="font-medium tabular">{pctText(d.increment_bp)}</dd></div>
        <div><dt className="text-sm text-text-muted">Current CTC</dt><dd className="tabular">{inr(d.current)}</dd></div>
        <div><dt className="text-sm text-text-muted">New CTC</dt><dd className="font-medium tabular">{inr(d.proposed)}</dd></div>
        <div><dt className="text-sm text-text-muted">From</dt><dd>{fmtDate(d.effective_from)}</dd></div>
        <div><dt className="text-sm text-text-muted">Recommended by</dt><dd>{d.recommender ?? "—"}</dd></div>
        {d.note && <div className="col-span-2"><dt className="text-sm text-text-muted">Note</dt><dd className="mt-1 whitespace-pre-line rounded-md bg-surface-sunken px-3 py-2">{d.note}</dd></div>}
      </dl>
      <Field label="Comment" help="Shared with the manager who recommended it"><Textarea value={comment} onChange={(e) => onComment(e.target.value)} maxLength={1000} /></Field>
    </div>
  );
}
