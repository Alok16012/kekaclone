"use client";
import * as React from "react";
import { AlertTriangle, Check, Inbox, X } from "lucide-react";
import { Card } from "@/ui/card";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Drawer } from "@/ui/overlay";
import { Field, Textarea } from "@/ui/field";
import { EmptyState, Skeleton } from "@/ui/feedback";
import { ApprovalTimeline } from "@/ui/flow";
import { toast } from "@/ui/toast";
import { advanceDetailAction, claimDetailAction } from "@/app/(app)/me/expenses/actions";
import { deskDecideAction } from "@/app/(app)/expenses/actions";
import type { advanceDetail, QueueItem } from "@/server/modules/expenses/service";
import { at, ClaimBody, ClaimStatus, Money, shortDate, type ClaimDetail } from "./shared";

type AdvanceDetail = NonNullable<Awaited<ReturnType<typeof advanceDetail>>>;
const Loading = () => <div className="flex flex-col gap-3"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div>;

/** Loads and shows a claim or an advance for review. Used by the inbox drawer and the expense desk. */
export function ExpenseReviewDetail({ entityType, entityId, comment, setComment }: { entityType: string; entityId: string; comment?: string; setComment?: (v: string) => void }) {
  const [claim, setClaim] = React.useState<ClaimDetail | null>(null);
  const [advance, setAdvance] = React.useState<AdvanceDetail | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    let live = true;
    const done = (r: { ok: boolean; error?: string }) => { if (live && !r.ok) setError(r.error ?? "Couldn't load this request."); };
    if (entityType === "expense_claim") claimDetailAction(entityId).then((r) => { done(r); if (live && r.ok) setClaim(r.data as ClaimDetail); });
    else advanceDetailAction(entityId).then((r) => { done(r); if (live && r.ok) setAdvance(r.data as AdvanceDetail); });
    return () => { live = false; };
  }, [entityType, entityId]);
  if (error) return <p role="alert" className="text-base text-danger-text">{error}</p>;
  const body = entityType === "expense_claim" ? (claim ? <ClaimBody d={claim} /> : null) : advance ? <AdvanceBody d={advance} /> : null;
  if (!body) return <Loading />;
  return (
    <div className="flex flex-col gap-5">
      {body}
      {setComment && <Field label="Comment" help="Shared with the employee"><Textarea value={comment ?? ""} onChange={(e) => setComment(e.target.value)} maxLength={1000} /></Field>}
    </div>
  );
}

function AdvanceBody({ d }: { d: AdvanceDetail }) {
  const a = d.advance;
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-base">
        <div className="col-span-2"><dt className="text-sm text-text-muted">Purpose</dt><dd className="font-medium">{a.purpose}</dd></div>
        <div><dt className="text-sm text-text-muted">Amount</dt><dd className="font-medium"><Money paise={a.amount_paise} /></dd></div>
        <div><dt className="text-sm text-text-muted">Status</dt><dd className="mt-0.5"><ClaimStatus status={a.status} advance /></dd></div>
        <div><dt className="text-sm text-text-muted">Asked on</dt><dd>{shortDate(a.created_at)}</dd></div>
        {a.receipts_due_on && <div><dt className="text-sm text-text-muted">Claims due by</dt><dd>{shortDate(a.receipts_due_on)}</dd></div>}
      </dl>
      {d.claims.length > 0 && (
        <div><h3 className="mb-1 text-sm font-semibold">Claims settling it</h3>
          <ul className="text-base">{d.claims.map((c) => <li key={c.id}>#{c.number} {c.title} · <Money paise={c.advance_applied_paise} /></li>)}</ul></div>
      )}
      {d.steps.length > 0 && (
        <div><h3 className="mb-3 text-sm font-semibold">Approvals</h3>
          <ApprovalTimeline levels={d.steps.map((s) => ({ level: s.level, approver: s.approver, role: s.title ?? undefined, status: s.status === "skipped" ? "waiting" : s.status, comment: s.comment ?? undefined, at: at(s.acted_at) }))} /></div>
      )}
    </div>
  );
}

/** Expense desk queue: what's waiting for the actor, and (finance) the finance step waiting on a colleague. */
export function ApprovalQueue({ items }: { items: QueueItem[] }) {
  const [open, setOpen] = React.useState<QueueItem | null>(null);
  const [hidden, setHidden] = React.useState<Set<string>>(new Set());
  const [comment, setComment] = React.useState("");
  const [busy, start] = React.useTransition();
  const visible = items.filter((i) => !hidden.has(i.entity_id));
  const mine = visible.filter((i) => i.mine), others = visible.filter((i) => !i.mine);

  const decide = (row: QueueItem, decision: "approved" | "rejected") => {
    if (decision === "rejected" && !comment.trim() && open?.entity_id === row.entity_id) { toast.error("Say why you're declining, so they can fix it."); return; }
    setHidden((h) => new Set(h).add(row.entity_id));
    setOpen(null);
    start(async () => {
      const r = await deskDecideAction(row.entity_type, row.entity_id, decision, comment || undefined);
      setComment("");
      if (r.ok) toast.success(decision === "approved" ? "Approved" : "Declined", { description: `${row.employee} · ${row.title}` });
      else { toast.error(r.error); setHidden((h) => { const n = new Set(h); n.delete(row.entity_id); return n; }); }
    });
  };
  const canDecide = (r: QueueItem) => r.mine || r.level === r.max_level;

  const row = (r: QueueItem) => (
    <li key={r.entity_id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
      <button type="button" onClick={() => { setOpen(r); setComment(""); }} className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-offset-4">
        <Avatar name={r.employee} />
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2"><span className="text-base font-medium">{r.employee}</span>
            <Badge tone="accent">{r.entity_type === "expense_claim" ? `Claim #${r.number}` : "Advance"}</Badge>
            {r.flags > 0 && <Badge tone="warning"><AlertTriangle aria-hidden />{r.flags} {r.flags === 1 ? "flag" : "flags"}</Badge>}</span>
          <span className="block truncate text-sm text-text-muted">{r.title} · {shortDate(r.submitted_at)}{r.mine ? "" : ` · With ${r.waiting_on}${r.level < r.max_level ? " (manager step)" : ""}`}</span>
        </span>
      </button>
      <Money paise={r.amount_paise} className="text-base font-medium sm:w-28 sm:text-right" />
      {canDecide(r) && (
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => { setOpen(r); setComment(""); }} aria-label={`Review and decline: ${r.employee}, ${r.title}`}><X />Decline</Button>
          <Button size="sm" disabled={busy} onClick={() => decide(r, "approved")} aria-label={`Approve: ${r.employee}, ${r.title}`}><Check />Approve</Button>
        </div>
      )}
    </li>
  );

  return (
    <div className="flex flex-col gap-6">
      {mine.length === 0 ? (
        <Card><EmptyState icon={<Inbox />} title="Nothing waiting for you" description="Expense claims and advances that need your approval show up here and in your Inbox." /></Card>
      ) : <Card><h2 className="px-5 pt-4 text-md font-semibold">Waiting for you</h2><ul className="divide-y divide-border">{mine.map(row)}</ul></Card>}
      {others.length > 0 && (
        <Card>
          <div className="px-5 pt-4"><h2 className="text-md font-semibold">With someone else</h2>
            <p className="text-sm text-text-muted">Claims for people you look after as finance. You can take over the finance review when the reviewer is away.</p></div>
          <ul className="divide-y divide-border">{others.map(row)}</ul>
        </Card>
      )}
      <Drawer open={!!open} onOpenChange={(o) => !o && setOpen(null)} title={open?.employee ?? ""} description={open ? `${open.title} · ${open.entity_type === "expense_claim" ? "Expense claim" : "Advance"}` : undefined}
        footer={open && canDecide(open) && <><Button variant="danger" onClick={() => decide(open, "rejected")}>Decline</Button><Button onClick={() => decide(open, "approved")}>{open.mine ? "Approve" : "Take over and approve"}</Button></>}>
        {open && <ExpenseReviewDetail key={open.entity_id} entityType={open.entity_type} entityId={open.entity_id} comment={comment} setComment={setComment} />}
      </Drawer>
    </div>
  );
}
