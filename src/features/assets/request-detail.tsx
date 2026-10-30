"use client";
import * as React from "react";
import { Field, Textarea } from "@/ui/field";
import { Skeleton } from "@/ui/feedback";
import { assetRequestDetailAction } from "@/app/(app)/org/assets/actions";
import { fmtDay, RequestStatusBadge } from "./bits";

type Detail = Extract<Awaited<ReturnType<typeof assetRequestDetailAction>>, { ok: true }>["data"];

/** Inbox pane for an asset request: what's asked for, why, what they already hold of that type, stock on hand. */
export function AssetRequestDetail({ id, comment, onComment }: { id: string; comment: string; onComment: (v: string) => void }) {
  const [state, setState] = React.useState<{ id: string; d?: Detail; error?: string } | null>(null);
  React.useEffect(() => {
    let live = true;
    assetRequestDetailAction(id).then((r) => { if (live) setState(r.ok ? { id, d: r.data } : { id, error: r.error }); });
    return () => { live = false; };
  }, [id]);
  const s = state?.id === id ? state : null;
  if (!s) return <div className="flex flex-col gap-3"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-20" /></div>;
  if (s.error || !s.d) return <p className="text-base text-danger-text">{s.error ?? "Couldn't load this request."}</p>;
  const { request: q, holding } = s.d;
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-base">
        <div><dt className="text-sm text-text-muted">Asks for</dt><dd className="font-medium">{q.type}</dd></div>
        <div><dt className="text-sm text-text-muted">Kind</dt><dd>{q.kind === "replacement" ? "Replacement" : "New"}</dd></div>
        <div><dt className="text-sm text-text-muted">Asked on</dt><dd>{fmtDay(q.created_at)}</dd></div>
        <div><dt className="text-sm text-text-muted">In stock</dt><dd className="tabular">{q.available}</dd></div>
        <div className="col-span-2"><dt className="text-sm text-text-muted">Status</dt><dd className="mt-1"><RequestStatusBadge status={q.status} /></dd></div>
        {q.reason && <div className="col-span-2"><dt className="text-sm text-text-muted">Reason</dt><dd className="mt-1 whitespace-pre-line rounded-md bg-surface-sunken px-3 py-2">{q.reason}</dd></div>}
        <div className="col-span-2"><dt className="text-sm text-text-muted">Already holds</dt>
          <dd>{holding.length ? holding.map((h) => `${h.name} (${h.tag}) since ${fmtDay(h.assigned_at)}`).join(", ") : `No ${q.type.toLowerCase()} at the moment`}</dd></div>
      </dl>
      <Field label="Comment" help="Shared with the requester"><Textarea value={comment} onChange={(e) => onComment(e.target.value)} maxLength={1000} /></Field>
    </div>
  );
}
