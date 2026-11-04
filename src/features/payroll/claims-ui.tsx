"use client";
import * as React from "react";
import { CheckCircle2, Clock3, MinusCircle, Paperclip, Plus, ReceiptText, Wallet, XCircle } from "lucide-react";
import { Button } from "@/ui/button";
import { Card, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { ConfirmDialog, Modal } from "@/ui/overlay";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { submitClaimAction, withdrawClaimAction } from "@/app/(app)/me/pay/actions";
import type { myClaims } from "@/server/modules/payroll/claims";
import { fmtDate, fmtMonth, money } from "./labels";

export type MyClaimsData = Awaited<ReturnType<typeof myClaims>>;
type Claim = MyClaimsData["claims"][number];

const STATUS: Record<Claim["status"], { tone: "neutral" | "warning" | "success" | "danger" | "accent"; label: string; Icon: React.ComponentType<{ className?: string }> }> = {
  submitted: { tone: "warning", label: "Waiting for approval", Icon: Clock3 },
  approved: { tone: "accent", label: "Approved, paid with salary", Icon: CheckCircle2 },
  paid: { tone: "success", label: "Paid", Icon: Wallet },
  rejected: { tone: "danger", label: "Declined", Icon: XCircle },
  withdrawn: { tone: "neutral", label: "Withdrawn", Icon: MinusCircle },
};
/** Status as icon + words. */
export function ClaimStatusBadge({ status }: { status: Claim["status"] }) {
  const s = STATUS[status] ?? STATUS.submitted;
  return <Badge tone={s.tone}><s.Icon aria-hidden />{s.label}</Badge>;
}

/** The person's reimbursable claims: what's left to claim per component, past claims, and a form to send a new one with bills. */
export function MyClaims({ d }: { d: MyClaimsData }) {
  const [adding, setAdding] = React.useState(false);
  const [pending, start] = React.useTransition();
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={`What you can claim, FY ${d.fy}`} description="Reimbursable parts of your salary (fuel, phone, books …) are paid against bills, tax-free up to the yearly limit. Approved claims come with your next salary."
          action={d.components.some((c) => c.remainingPaise > 0) ? <Button size="sm" onClick={() => setAdding(true)}><Plus />Send a claim</Button> : undefined} />
        {d.components.length === 0 ? <EmptyState compact icon={<ReceiptText />} title="Nothing to claim against" description="Your salary has no reimbursable components. Ask payroll if you expect some." /> : (
          <ul className="divide-y divide-border border-t border-border">
            {d.components.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
                <div className="min-w-0 flex-1"><p className="text-base font-medium">{c.name}</p><p className="text-sm text-text-muted">{money(c.limitPaise)} a year · {money(c.usedPaise)} claimed</p></div>
                <span className="text-base font-semibold tabular">{money(c.remainingPaise)} <span className="text-sm font-normal text-text-muted">left</span></span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader title="Your claims" />
        {d.claims.length === 0 ? <EmptyState compact icon={<ReceiptText />} title="No claims this year" /> : (
          <ul className="divide-y divide-border border-t border-border">
            {d.claims.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-base font-medium">{c.component} · {fmtMonth(c.claimMonth)}<ClaimStatusBadge status={c.status} /></p>
                  <p className="text-sm text-text-muted">
                    Sent {fmtDate(c.createdAt.slice(0, 10))}{c.waitingOn ? ` · with ${c.waitingOn}` : ""}{c.payrollMonth ? ` · in ${fmtMonth(c.payrollMonth)} payroll` : ""}
                    {c.allowedPaise != null && c.allowedPaise < c.amountPaise ? ` · ${money(c.allowedPaise)} allowed (over the year's limit)` : ""}{c.note ? ` · ${c.note}` : ""}
                  </p>
                  <ul className="mt-1 flex flex-wrap gap-2">{c.bills.map((b) => <li key={b.id}><a href={`/payroll/files/${b.id}`} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-sm text-accent-text underline-offset-4 hover:underline"><Paperclip aria-hidden className="size-3.5" />{b.name}</a></li>)}</ul>
                </div>
                <span className="text-base font-semibold tabular">{money(c.amountPaise)}</span>
                {c.status === "submitted" && (
                  <ConfirmDialog title="Withdraw this claim?" description="You can send it again later." confirmLabel="Withdraw" trigger={<Button size="sm" variant="ghost" disabled={pending}>Withdraw</Button>}
                    onConfirm={() => new Promise<void>((res) => start(async () => { const r = await withdrawClaimAction(c.id); if (r.ok) toast.success("Claim withdrawn"); else toast.error(r.error); res(); }))} />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {adding && <ClaimDialog d={d} onClose={() => setAdding(false)} />}
    </div>
  );
}

function ClaimDialog({ d, onClose }: { d: MyClaimsData; onClose: () => void }) {
  const avail = d.components.filter((c) => c.remainingPaise > 0);
  const [componentId, setComponent] = React.useState(avail[0]?.id ?? "");
  const months = Array.from({ length: 12 }, (_, i) => { const [y, m] = d.today.split("-").map(Number); const t = y * 12 + m - 1 - i; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}-01`; }).filter((m) => m >= d.fyStart);
  const [month, setMonth] = React.useState(months[0]);
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const form = React.useRef<HTMLFormElement>(null);
  const comp = avail.find((c) => c.id === componentId);
  const fe = (f: string) => (error?.field === f ? error.message : undefined);
  const save = () => start(async () => {
    const fd = new FormData(form.current!);
    fd.set("componentId", componentId); fd.set("claimMonth", month);
    const r = await submitClaimAction(fd);
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success(r.data?.status === "approved" ? "Claim approved" : "Claim sent for approval", { description: r.data?.status === "approved" ? "It'll be paid with your next salary." : "Your manager and then payroll will check it." });
    onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Send a reimbursable claim" description="Attach the bills; the approved amount is paid with your salary, tax-free up to the limit."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>Send claim</Button></>}>
      <form ref={form} className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <Field label="Component" required error={fe("componentId")} help={comp ? `${money(comp.remainingPaise)} left of ${money(comp.limitPaise)} this year` : undefined}>
          <Select value={componentId} onValueChange={setComponent} options={avail.map((c) => ({ value: c.id, label: c.name }))} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Month of the bills" required error={fe("claimMonth")}><Select value={month} onValueChange={setMonth} options={months.map((m) => ({ value: m, label: fmtMonth(m) }))} /></Field>
          <Field label="Amount (₹)" required error={fe("amountPaise")}><Input name="amount" inputMode="decimal" leading={<span className="text-sm">₹</span>} placeholder="0.00" className="tabular" /></Field>
        </div>
        <Field label="Note" help="Optional" error={fe("note")}><Textarea name="note" rows={2} maxLength={300} /></Field>
        <Field label="Bills" required help="PDF, PNG or JPG, up to 5 MB each, at most 5" error={fe("bills")}><Input name="bills" type="file" accept=".pdf,.png,.jpg,.jpeg" multiple className="py-1.5" /></Field>
      </form>
    </Modal>
  );
}
