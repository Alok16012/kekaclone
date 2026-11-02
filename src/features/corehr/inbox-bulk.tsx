"use client";
import * as React from "react";
import { Check, X } from "lucide-react";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/choice";
import { Field, Textarea } from "@/ui/field";
import { Modal } from "@/ui/overlay";
import { toast } from "@/ui/toast";
import { bulkDecideAction } from "@/app/(app)/corehr/actions";

export function useBulkSelection(ids: string[]) {
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const live = new Set([...selected].filter((x) => ids.includes(x)));   // rows that left the list drop out of the selection
  return {
    selected: live, all: ids.length > 0 && ids.every((x) => live.has(x)),
    toggle: (id: string, on: boolean) => setSelected((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; }),
    setAll: (on: boolean) => setSelected(on ? new Set(ids) : new Set()),
    clear: () => setSelected(new Set()),
  };
}

/** Select several requests and approve (or decline with one comment) in one go. Each is decided on its own. */
export function InboxBulkBar({ bulk, rows, onDone }: { bulk: ReturnType<typeof useBulkSelection>; rows: { stepId: string }[]; onDone: (ids: string[]) => void }) {
  const [declining, setDeclining] = React.useState(false);
  const [comment, setComment] = React.useState("");
  const [pending, start] = React.useTransition();
  const n = bulk.selected.size;
  if (rows.length < 2) return null;
  const run = (decision: "approved" | "rejected") => start(async () => {
    const ids = [...bulk.selected];
    const r = await bulkDecideAction(ids, decision, decision === "rejected" ? comment : undefined);
    if (!r.ok) { toast.error(r.error); return; }
    const failed = new Set(r.data!.failed.map((f) => f.stepId));
    onDone(ids.filter((x) => !failed.has(x)));
    bulk.clear(); setDeclining(false); setComment("");
    toast.success(`${r.data!.done} ${r.data!.done === 1 ? "request" : "requests"} ${decision === "approved" ? "approved" : "declined"}`,
      { description: r.data!.failed.length ? `${r.data!.failed.length} couldn't be decided: ${r.data!.failed[0].error}` : undefined });
  });
  return (
    <div className="hidden items-center gap-3 rounded-md border border-border bg-surface px-4 py-2 sm:flex" role="toolbar" aria-label="Bulk actions">
      <Checkbox label={n ? `${n} selected` : "Select all"} checked={bulk.all ? true : n ? "indeterminate" : false} onCheckedChange={(c) => bulk.setAll(!!c)} />
      {n > 0 && <div className="ml-auto flex gap-2">
        <Button variant="secondary" size="sm" onClick={() => setDeclining(true)} disabled={pending}><X />Decline {n}</Button>
        <Button size="sm" onClick={() => run("approved")} loading={pending}><Check />Approve {n}</Button>
      </div>}
      <Modal open={declining} onOpenChange={setDeclining} title={`Decline ${n} ${n === 1 ? "request" : "requests"}?`} size="sm"
        footer={<><Button variant="secondary" onClick={() => setDeclining(false)}>Cancel</Button><Button variant="danger" loading={pending} disabled={!comment.trim()} onClick={() => run("rejected")}>Decline</Button></>}>
        <Field label="Reason" required help="Everyone you decline sees this comment"><Textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} /></Field>
      </Modal>
    </div>
  );
}
