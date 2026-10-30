"use client";
import * as React from "react";
import { CalendarClock, CheckCheck, HandCoins, MoreHorizontal, Undo2, Wallet } from "lucide-react";
import { Card, CardHeader } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Menu, Modal, Drawer } from "@/ui/overlay";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Badge } from "@/ui/badge";
import { Banner, EmptyState } from "@/ui/feedback";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { toast } from "@/ui/toast";
import { closeAdvanceAction, markAdvancePaidAction, markClaimPaidAction, scheduleClaimAction, unscheduleClaimAction } from "@/app/(app)/expenses/actions";
import { inr, monthLabel } from "@/server/modules/expenses/rules";
import type { AdvanceRow, ClaimRow } from "@/server/modules/expenses/service";
import { ClaimStatus, Money, shortDate } from "./shared";
import { ExpenseReviewDetail } from "./review";

type PayClaim = ClaimRow & { employee: string; employee_id: string; in_pay_group: boolean };

export function Payouts({ claims, advances, months, selfId }: { claims: PayClaim[]; advances: AdvanceRow[]; months: string[]; selfId: string }) {
  const [paying, setPaying] = React.useState<{ kind: "claim" | "advance" | "close"; id: string; label: string; amount: number } | null>(null);
  const [scheduling, setScheduling] = React.useState<PayClaim | null>(null);
  const [viewing, setViewing] = React.useState<PayClaim | null>(null);
  const [, start] = React.useTransition();
  const toPay = claims.filter((c) => c.status === "approved");
  const unscheduled = toPay.filter((c) => !c.payout_month), scheduled = toPay.filter((c) => c.payout_month);
  const paid = claims.filter((c) => c.status === "paid");
  const advToPay = advances.filter((a) => a.status === "approved"), advOpen = advances.filter((a) => a.status === "paid");
  const sum = (xs: PayClaim[]) => xs.reduce((s, c) => s + c.payable_paise, 0);

  const claimRow = (c: PayClaim) => {
    const self = c.employee_id === selfId;
    return (
      <li key={c.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:gap-4">
        <button type="button" className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-offset-4" onClick={() => setViewing(c)}>
          <p className="flex flex-wrap items-center gap-2 text-base font-medium"><span>{c.employee}</span><span className="text-text-muted">#{c.number} · {c.title}</span></p>
          <p className="text-sm text-text-muted">
            {c.status === "paid" ? `${c.payment_ref ?? "Paid"}${c.paid_at ? " · " + shortDate(c.paid_at) : ""}` : c.payout_month ? `In ${monthLabel(c.payout_month)} payroll` : "Not scheduled yet"}
            {c.advance_applied_paise > 0 ? ` · ${inr(c.advance_applied_paise)} covered by advance` : ""}
            {!c.in_pay_group && c.status === "approved" ? " · Not in a pay group" : ""}
          </p>
        </button>
        <Money paise={c.payable_paise} className="text-base font-medium" />
        {c.status === "approved" && (self ? <Badge>Your own claim</Badge> : (
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={!c.in_pay_group} onClick={() => setScheduling(c)} title={c.in_pay_group ? undefined : "Add them to a pay group to pay through payroll"}><CalendarClock />{c.payout_month ? "Move" : "Payroll"}</Button>
            <Menu trigger={<IconButton size="icon-sm" variant="ghost" label={`More for claim #${c.number}`}><MoreHorizontal /></IconButton>}
              items={[{ label: "Mark paid off-cycle", icon: <Wallet />, onSelect: () => setPaying({ kind: "claim", id: c.id, label: `${c.employee} · claim #${c.number}`, amount: c.payable_paise }) },
                ...(c.payout_month ? [{ label: "Take out of payroll", icon: <Undo2 />, onSelect: () => start(async () => { const r = await unscheduleClaimAction(c.id); if (r.ok) toast.success("Taken out of payroll"); else toast.error(r.error); }) }] : [])]} />
          </div>
        ))}
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <Tabs defaultValue="claims">
        <TabsList items={[{ value: "claims", label: "Claims", count: toPay.length }, { value: "advances", label: "Advances", count: advToPay.length + advOpen.length }, { value: "paid", label: "Recently paid", count: paid.length }]} />
        <TabsContent value="claims" className="flex flex-col gap-6">
          <Card>
            <CardHeader title="Approved, not scheduled" description={unscheduled.length ? `${unscheduled.length} ${unscheduled.length === 1 ? "claim" : "claims"} · ${inr(sum(unscheduled))}` : undefined} />
            {unscheduled.length === 0 ? <EmptyState compact icon={<CheckCheck />} title="All caught up" description="Approved claims you look after appear here to pay." /> : <ul className="divide-y divide-border border-t border-border">{unscheduled.map(claimRow)}</ul>}
          </Card>
          {scheduled.length > 0 && (
            <Card>
              <CardHeader title="Scheduled into payroll" description={`${inr(sum(scheduled))} will be added to net pay as reimbursements`} />
              <ul className="divide-y divide-border border-t border-border">{scheduled.map(claimRow)}</ul>
            </Card>
          )}
        </TabsContent>
        <TabsContent value="advances">
          <Card>
            {advToPay.length + advOpen.length === 0 ? <EmptyState compact icon={<HandCoins />} title="No advances to handle" /> : (
              <ul className="divide-y divide-border">
                {[...advToPay, ...advOpen].map((a) => (
                  <li key={a.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:gap-4">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-base font-medium"><span>{a.employee}</span><span className="text-text-muted">{a.purpose}</span><ClaimStatus status={a.status} advance />
                        {a.overdue && <Badge tone="danger">Receipts overdue</Badge>}</p>
                      <p className="text-sm text-text-muted">{a.status === "paid" ? `${inr(a.outstanding_paise)} still open${a.receipts_due_on ? ` · claims due ${shortDate(a.receipts_due_on)}` : ""}` : "Approved, waiting to be paid"}</p>
                    </div>
                    <Money paise={a.amount_paise} className="text-base font-medium" />
                    {a.employee_id === selfId ? <Badge>Your own advance</Badge> : a.status === "approved"
                      ? <Button size="sm" onClick={() => setPaying({ kind: "advance", id: a.id, label: `${a.employee} · ${a.purpose}`, amount: a.amount_paise })}><Wallet />Mark paid</Button>
                      : <Button size="sm" variant="secondary" onClick={() => setPaying({ kind: "close", id: a.id, label: `${a.employee} · ${a.purpose}`, amount: a.outstanding_paise })}>Close</Button>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </TabsContent>
        <TabsContent value="paid">
          <Card>{paid.length === 0 ? <EmptyState compact title="Nothing paid in the last 45 days" /> : <ul className="divide-y divide-border">{paid.map(claimRow)}</ul>}</Card>
        </TabsContent>
      </Tabs>

      {paying && <PayDialog {...paying} onClose={() => setPaying(null)} />}
      {scheduling && <ScheduleDialog claim={scheduling} months={months} onClose={() => setScheduling(null)} />}
      <Drawer open={!!viewing} onOpenChange={(o) => !o && setViewing(null)} title={viewing?.employee ?? ""} description={viewing ? `Claim #${viewing.number} · ${viewing.title}` : undefined}>
        {viewing && <ExpenseReviewDetail key={viewing.id} entityType="expense_claim" entityId={viewing.id} />}
      </Drawer>
    </div>
  );
}

function PayDialog({ kind, id, label, amount, onClose }: { kind: "claim" | "advance" | "close"; id: string; label: string; amount: number; onClose: () => void }) {
  const [ref, setRef] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const close = kind === "close";
  const save = () => start(async () => {
    const r = kind === "claim" ? await markClaimPaidAction(id, ref) : kind === "advance" ? await markAdvancePaidAction(id, ref) : await closeAdvanceAction(id, ref);
    if (!r.ok) { setError(r.error); return; }
    toast.success(close ? "Advance closed" : "Marked as paid"); onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="sm" title={close ? "Close this advance" : "Mark as paid"} description={label}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>{close ? "Close advance" : `Paid ${inr(amount)}`}</Button></>}>
      <div className="flex flex-col gap-4">
        {error && <Banner tone="danger">{error}</Banner>}
        {close ? (
          <>
            <p className="text-base">{amount > 0 ? `${inr(amount)} wasn't covered by claims. Close it once the employee has returned that amount.` : "Claims covered the whole advance."}</p>
            <Field label="Note" help="Optional, e.g. how the money came back"><Textarea value={ref} onChange={(e) => setRef(e.target.value)} maxLength={500} rows={2} /></Field>
          </>
        ) : (
          <>
            <p className="text-base">Record a payment made outside payroll: bank transfer, UPI or cash. The employee is told it&apos;s paid.</p>
            <Field label="Payment reference" help="Optional: UTR, UPI or cheque number"><Input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={120} autoFocus /></Field>
          </>
        )}
      </div>
    </Modal>
  );
}

function ScheduleDialog({ claim, months, onClose }: { claim: PayClaim; months: string[]; onClose: () => void }) {
  const [month, setMonth] = React.useState(claim.payout_month ?? months[0]);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    const r = await scheduleClaimAction(claim.id, month);
    if (!r.ok) { setError(r.error); return; }
    toast.success(`Added to ${monthLabel(month)} payroll`); onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="sm" title="Pay with salary" description={`${claim.employee} · claim #${claim.number} · ${inr(claim.payable_paise)}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>Schedule</Button></>}>
      <div className="flex flex-col gap-4">
        {error && <Banner tone="danger">{error}</Banner>}
        <p className="text-base">The amount is added to that month&apos;s payroll as a reimbursement. Months whose payroll is finalised can&apos;t be used.</p>
        <Field label="Payroll month"><Select value={month} onValueChange={setMonth} options={months.map((m) => ({ value: m, label: monthLabel(m) }))} /></Field>
      </div>
    </Modal>
  );
}
