"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ListPlus, MinusCircle, MoreHorizontal, Pencil, Plus, Send, Trash2, Undo2 } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Checkbox } from "@/ui/choice";
import { ConfirmDialog, Menu, Modal } from "@/ui/overlay";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { Banner, EmptyState } from "@/ui/feedback";
import { ApprovalTimeline } from "@/ui/flow";
import { toast } from "@/ui/toast";
import { deleteClaimAction, moveExpensesAction, reopenClaimAction, submitClaimAction, updateClaimAction, withdrawClaimAction } from "@/app/(app)/me/expenses/actions";
import { inr, isBlocking, monthLabel, type Category } from "@/server/modules/expenses/rules";
import type { AdvanceRow, ExpenseRow } from "@/server/modules/expenses/service";
import { ExpenseDialog } from "./expense-dialog";
import { at, ClaimStatus, ExpenseLine, Money, shortDate, type ClaimDetail } from "./shared";

/** The person's own claim: build it while it's a draft, send it, follow it, withdraw or reopen it. */
export function ClaimView({ d, categories, unclaimed, advances, today }: { d: ClaimDetail; categories: Category[]; unclaimed: ExpenseRow[]; advances: AdvanceRow[]; today: string }) {
  const router = useRouter();
  const [adding, setAdding] = React.useState(false);
  const [picking, setPicking] = React.useState(false);
  const [editing, setEditing] = React.useState<ExpenseRow | null>(null);
  const [renaming, setRenaming] = React.useState(false);
  const [confirm, setConfirm] = React.useState<"delete" | "withdraw" | null>(null);
  const [pending, start] = React.useTransition();
  const c = d.claim;
  const draft = d.can.edit;
  const blocking = d.items.filter((x) => x.violations.some(isBlocking));
  const warnings = d.items.reduce((s, x) => s + x.violations.filter((v) => !isBlocking(v)).length, 0);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) => start(async () => {
    const r = await fn();
    if (r.ok) toast.success(done); else toast.error(r.error ?? "Something went wrong.");
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <ClaimStatus status={c.status} />
        {c.status === "submitted" && c.waiting_on && <span className="text-sm text-text-muted">Waiting for {c.waiting_on}</span>}
        {c.status === "approved" && <span className="text-sm text-text-muted">{c.payout_month ? `Will be paid with ${monthLabel(c.payout_month)} salary` : "Finance will pay it soon"}</span>}
        {c.status === "paid" && <span className="text-sm text-text-muted">{c.payment_ref ?? "Paid"}{c.paid_at ? ` · ${at(c.paid_at)}` : ""}</span>}
        <div className="ml-auto flex flex-wrap gap-2">
          {draft && <Button variant="secondary" onClick={() => setConfirm("delete")}><Trash2 />Delete draft</Button>}
          {c.status === "submitted" && <Button variant="secondary" onClick={() => setConfirm("withdraw")}><Undo2 />Withdraw</Button>}
          {c.status === "rejected" && <Button variant="secondary" loading={pending} onClick={() => run(() => reopenClaimAction(c.id), "Claim reopened as a draft")}><Pencil />Reopen to fix</Button>}
          {draft && (
            <Button loading={pending} disabled={!d.items.length || blocking.length > 0} onClick={() => start(async () => {
              const r = await submitClaimAction(c.id);
              if (!r.ok) { toast.error(r.error); return; }
              toast.success(r.data?.status === "approved" ? "Claim approved" : "Claim sent for approval");
            })}><Send />Send for approval</Button>
          )}
        </div>
      </div>

      {draft && blocking.length > 0 && <Banner tone="danger" title="Fix these before sending">{blocking.length} {blocking.length === 1 ? "expense needs" : "expenses need"} attention: see the red notes below.</Banner>}
      {draft && !blocking.length && warnings > 0 && <Banner tone="warning" title="You can send this, with flags">{warnings} policy {warnings === 1 ? "note" : "notes"} will be shown to your approvers. Add a description to explain if you can.</Banner>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="p-4"><p className="text-sm text-text-muted">Total</p><p className="mt-1 text-xl font-semibold"><Money paise={c.total_paise} /></p></Card>
        <Card className="p-4"><p className="text-sm text-text-muted">Covered by advance</p><p className="mt-1 text-xl font-semibold"><Money paise={c.advance_applied_paise} /></p>
          {d.advance && <p className="text-sm text-text-muted">{d.advance.purpose}{c.status === "draft" || c.status === "submitted" ? ` · ${inr(d.advance.outstanding_paise)} open` : ""}</p>}</Card>
        <Card className="p-4"><p className="text-sm text-text-muted">To be paid to you</p><p className="mt-1 text-xl font-semibold"><Money paise={c.status === "draft" || c.status === "submitted" ? Math.max(0, c.total_paise - (d.advance?.outstanding_paise ?? 0)) : c.payable_paise} /></p>
          {(c.status === "draft" || c.status === "submitted") && d.advance && <p className="text-sm text-text-muted">Estimate until approved</p>}</Card>
      </div>

      <Card>
        <CardHeader title={`Expenses (${d.items.length})`} />
        {draft && (
          <div className="flex flex-wrap gap-2 px-5 pb-4">
            <Button size="sm" onClick={() => setAdding(true)}><Plus />New expense</Button>
            {unclaimed.length > 0 && <Button size="sm" variant="secondary" onClick={() => setPicking(true)}><ListPlus />Add existing</Button>}
            <Button size="sm" variant="secondary" onClick={() => setRenaming(true)}><Pencil />Title & advance</Button>
          </div>
        )}
        {d.items.length === 0 ? <EmptyState compact title="No expenses in this claim" description="Add the expenses you want to claim." /> : (
          <ul className="divide-y divide-border border-t border-border">
            {d.items.map((x) => (
              <ExpenseLine key={x.id} x={x} actions={draft ? (
                <Menu trigger={<IconButton size="icon-sm" variant="ghost" label={`Actions for ${x.category} on ${shortDate(x.spent_on)}`}><MoreHorizontal /></IconButton>}
                  items={[{ label: "Edit", icon: <Pencil />, onSelect: () => setEditing(x) },
                    { label: "Take out of this claim", icon: <MinusCircle />, onSelect: () => run(() => moveExpensesAction(c.id, [], [x.id]), "Taken out of the claim") }]} />
              ) : undefined} />
            ))}
          </ul>
        )}
      </Card>

      {d.steps.length > 0 && (
        <Card><CardHeader title="Approvals" /><CardBody>
          <ApprovalTimeline levels={d.steps.map((s) => ({ level: s.level, approver: s.approver, role: s.title ?? undefined, status: s.status === "skipped" ? "waiting" : s.status, comment: s.comment ?? undefined, at: at(s.acted_at) }))} />
        </CardBody></Card>
      )}

      {adding && <ExpenseDialog open onOpenChange={setAdding} categories={categories} claimId={c.id} today={today} />}
      {editing && <ExpenseDialog open onOpenChange={(o) => !o && setEditing(null)} categories={categories} expense={editing} today={today} />}
      {picking && <PickExpenses claimId={c.id} unclaimed={unclaimed} onClose={() => setPicking(false)} />}
      {renaming && <RenameClaim claimId={c.id} title={c.title} advanceId={c.advance_id} advances={advances} onClose={() => setRenaming(false)} />}
      {confirm === "delete" && (
        <ConfirmDialog open onOpenChange={(o) => !o && setConfirm(null)} title="Delete this draft?" description="Its expenses aren't deleted: they go back to your list."
          confirmLabel="Delete draft" onConfirm={async () => { const r = await deleteClaimAction(c.id); if (r.ok) { toast.success("Draft deleted"); router.push("/me/expenses"); } else toast.error(r.error); }} />
      )}
      {confirm === "withdraw" && (
        <ConfirmDialog open onOpenChange={(o) => !o && setConfirm(null)} tone="primary" title="Withdraw this claim?" description="It goes back to a draft and leaves your approvers' inbox. You can change it and send it again."
          confirmLabel="Withdraw" onConfirm={async () => { const r = await withdrawClaimAction(c.id); if (r.ok) toast.success("Claim withdrawn"); else toast.error(r.error); setConfirm(null); }} />
      )}
    </div>
  );
}

function PickExpenses({ claimId, unclaimed, onClose }: { claimId: string; unclaimed: ExpenseRow[]; onClose: () => void }) {
  const [ids, setIds] = React.useState<string[]>([]);
  const [pending, start] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Add expenses to this claim"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!ids.length} onClick={() => start(async () => {
        const r = await moveExpensesAction(claimId, ids, []);
        if (!r.ok) { setError(r.error); return; }
        toast.success(`${ids.length} added`); onClose();
      })}>Add {ids.length || ""}</Button></>}>
      {error && <Banner tone="danger" className="mb-3">{error}</Banner>}
      <ul className="flex flex-col gap-2">
        {unclaimed.map((x) => (
          <li key={x.id} className="flex items-start gap-3 rounded-md border border-border px-3 py-2">
            <Checkbox className="mt-1" checked={ids.includes(x.id)} onCheckedChange={(v) => setIds((s) => (v ? [...s, x.id] : s.filter((i) => i !== x.id)))}
              label={<span><span className="font-medium">{x.category}</span> · {shortDate(x.spent_on)} · {inr(x.amount_paise)}{x.violations.length ? <AlertTriangle aria-label="has policy flags" className="ml-1 inline size-3.5 text-warning-text" /> : null}</span>} />
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function RenameClaim({ claimId, title: t0, advanceId: a0, advances, onClose }: { claimId: string; title: string; advanceId: string | null; advances: AdvanceRow[]; onClose: () => void }) {
  const [title, setTitle] = React.useState(t0);
  const [advanceId, setAdvanceId] = React.useState(a0 ?? "none");
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const options = advances.filter((a) => a.status === "paid" || a.id === a0);
  const save = () => start(async () => {
    const r = await updateClaimAction(claimId, { title, advanceId: advanceId === "none" ? null : advanceId });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success("Claim updated"); onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="sm" title="Title and advance"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>Save</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <Field label="Title" required error={error?.field === "title" ? error.message : undefined}><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} /></Field>
        <Field label="Settle against an advance" help={options.length ? "The advance covers what it can; the rest is paid to you." : "You have no advance to settle."} error={error?.field === "advanceId" ? error.message : undefined}>
          <Select value={advanceId} onValueChange={setAdvanceId} disabled={!options.length} options={[{ value: "none", label: "Don't use an advance" }, ...options.map((a) => ({ value: a.id, label: `${a.purpose} (${inr(a.outstanding_paise)} open)` }))]} />
        </Field>
      </form>
    </Modal>
  );
}
