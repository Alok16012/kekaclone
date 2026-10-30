"use client";
import * as React from "react";
import { AlertTriangle, HandCoins, Plus } from "lucide-react";
import { Card } from "@/ui/card";
import { Button } from "@/ui/button";
import { ConfirmDialog, Modal } from "@/ui/overlay";
import { Field, Input, Textarea } from "@/ui/field";
import { Banner, EmptyState, Progress } from "@/ui/feedback";
import { Badge } from "@/ui/badge";
import { toast } from "@/ui/toast";
import { cancelAdvanceAction, requestAdvanceAction } from "@/app/(app)/me/expenses/actions";
import { inr } from "@/server/modules/expenses/rules";
import type { AdvanceRow } from "@/server/modules/expenses/service";
import { ClaimStatus, Money, shortDate } from "./shared";

export function MyAdvances({ advances, maxPaise, dueDays }: { advances: AdvanceRow[]; maxPaise: number | null; dueDays: number | null }) {
  const [asking, setAsking] = React.useState(false);
  const [withdrawing, setWithdrawing] = React.useState<AdvanceRow | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-base text-text-muted">Need money before a trip? Ask for an advance, then claim your expenses against it{dueDays ? ` within ${dueDays} days of receiving it` : ""}.</p>
        <Button onClick={() => setAsking(true)}><Plus />Ask for an advance</Button>
      </div>
      {advances.length === 0 ? (
        <Card><EmptyState icon={<HandCoins />} title="No advances" description={maxPaise ? `You can ask for up to ${inr(maxPaise)} at a time.` : "Ask for one when you expect to spend on company work."} /></Card>
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {advances.map((a) => (
              <li key={a.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:gap-4">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-base font-medium"><span className="truncate">{a.purpose}</span><ClaimStatus status={a.status} advance />
                    {a.overdue && <Badge tone="danger"><AlertTriangle aria-hidden />Receipts overdue</Badge>}</p>
                  <p className="text-sm text-text-muted">
                    Asked {shortDate(a.created_at)}
                    {a.status === "pending" && a.waiting_on ? ` · Waiting for ${a.waiting_on}` : ""}
                    {a.status === "paid" && a.receipts_due_on ? ` · Claim against it by ${shortDate(a.receipts_due_on)}` : ""}
                    {a.payment_ref ? ` · ${a.payment_ref}` : ""}
                  </p>
                  {(a.status === "paid" || a.status === "settled") && (
                    <div className="mt-2 max-w-sm"><Progress value={a.settled_paise} max={a.amount_paise} label={`${inr(a.settled_paise)} of ${inr(a.amount_paise)} settled`} tone={a.status === "settled" ? "success" : "accent"} />
                      <p className="mt-1 text-sm text-text-muted">{inr(a.settled_paise)} settled{a.status === "paid" ? ` · ${inr(a.outstanding_paise)} still open` : ""}</p></div>
                  )}
                </div>
                <Money paise={a.amount_paise} className="text-base font-medium" />
                {a.status === "pending" && <Button variant="secondary" size="sm" onClick={() => setWithdrawing(a)}>Withdraw</Button>}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {asking && <AskAdvance maxPaise={maxPaise} onClose={() => setAsking(false)} />}
      {withdrawing && (
        <ConfirmDialog open onOpenChange={(o) => !o && setWithdrawing(null)} title="Withdraw this request?" description={`${withdrawing.purpose}, ${inr(withdrawing.amount_paise)}.`}
          confirmLabel="Withdraw" onConfirm={async () => { const r = await cancelAdvanceAction(withdrawing.id); if (r.ok) toast.success("Request withdrawn"); else toast.error(r.error); setWithdrawing(null); }} />
      )}
    </div>
  );
}

function AskAdvance({ maxPaise, onClose }: { maxPaise: number | null; onClose: () => void }) {
  const [amount, setAmount] = React.useState("");
  const [purpose, setPurpose] = React.useState("");
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    const r = await requestAdvanceAction({ amount, purpose });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success(r.data?.status === "approved" ? "Advance approved" : "Advance requested", { description: "We'll let you know when it's decided." });
    onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="sm" title="Ask for an advance"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>Send request</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <Field label="Amount (₹)" required help={maxPaise ? `Up to ${inr(maxPaise)}` : undefined} error={error?.field === "amount" ? error.message : undefined}>
          <Input inputMode="decimal" leading={<span className="text-sm">₹</span>} value={amount} onChange={(e) => setAmount(e.target.value)} className="tabular" autoFocus />
        </Field>
        <Field label="What is it for?" required error={error?.field === "purpose" ? error.message : undefined}>
          <Textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={300} rows={2} placeholder="e.g. Customer visits in Chennai, 12–14 Nov" />
        </Field>
      </form>
    </Modal>
  );
}
