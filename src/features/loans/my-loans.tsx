"use client";
import * as React from "react";
import { HandCoins, Plus } from "lucide-react";
import { Card, StatTile } from "@/ui/card";
import { Button } from "@/ui/button";
import { ConfirmDialog, Drawer, Modal } from "@/ui/overlay";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Banner, EmptyState, Progress } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { requestLoanAction, withdrawLoanAction } from "@/app/(app)/me/loans/actions";
import { buildSchedule, emiFor, formatPaise, MAX_TENURE_MONTHS, monthLabel, scheduleTotals } from "@/server/modules/loans/rules";
import { parseRupees } from "@/server/modules/tax/rules";
import type { CategoryRow, LoanView } from "@/server/modules/loans/service";
import { DetailSkeleton, LoanFacts, LoanStatus, LoanSteps, Money, rateText, ScheduleTable, shortDate, useLoanDetail } from "./shared";

export function MyLoans({ loans, categories, today }: { loans: LoanView[]; categories: CategoryRow[]; today: string }) {
  const [asking, setAsking] = React.useState(false);
  const [open, setOpen] = React.useState<string | null>(null);
  const [withdrawing, setWithdrawing] = React.useState<LoanView | null>(null);
  const active = loans.filter((l) => l.status === "active");
  const owed = active.reduce((s, l) => s + l.outstandingPaise, 0);
  const next = active.map((l) => l.nextDue).filter((n): n is NonNullable<typeof n> => !!n).sort((a, b) => a.month.localeCompare(b.month));
  const nextMonth = next[0]?.month;
  const nextTotal = next.filter((n) => n.month === nextMonth).reduce((s, n) => s + n.amountPaise, 0);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-base text-text-muted">Borrow from the company and repay through your salary, a little each month.</p>
        <Button onClick={() => setAsking(true)} disabled={!categories.length}><Plus />Ask for a loan</Button>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile label="Still owed" value={<Money paise={owed} />} hint={`${active.length} loan${active.length === 1 ? "" : "s"} being repaid`} />
        <StatTile label="Next EMI" value={nextMonth ? <Money paise={nextTotal} /> : "None"} hint={nextMonth ? monthLabel(nextMonth) : undefined} />
        <StatTile label="Waiting for approval" value={String(loans.filter((l) => l.status === "requested").length)} />
      </div>
      {!categories.length && <Banner tone="info">Your company hasn&apos;t set up any loan types yet.</Banner>}
      {loans.length === 0 ? (
        <Card><EmptyState icon={<HandCoins />} title="No loans" description="When you ask for a loan, its approval, payout and EMI schedule show up here." /></Card>
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {loans.map((l) => (
              <li key={l.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:gap-4">
                <button type="button" className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus/25" onClick={() => setOpen(l.id)}>
                  <p className="flex flex-wrap items-center gap-2 text-base font-medium"><span>{l.category}</span><LoanStatus status={l.status} /></p>
                  <p className="text-sm text-text-muted">{formatPaise(l.principalPaise)} over {l.tenureMonths} months · {rateText(l.interestRate, l.rateType)} · asked {shortDate(l.createdAt)}</p>
                  {l.status === "active" && (
                    <div className="mt-2 max-w-sm"><Progress value={l.repaidPaise} max={l.principalPaise} label={`${formatPaise(l.repaidPaise)} of ${formatPaise(l.principalPaise)} repaid`} />
                      <p className="mt-1 text-sm text-text-muted">{formatPaise(l.outstandingPaise)} still owed{l.nextDue ? ` · next EMI ${formatPaise(l.nextDue.amountPaise)} in ${monthLabel(l.nextDue.month)}` : ""}</p></div>
                  )}
                </button>
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setOpen(l.id)}>Details</Button>
                  {l.status === "requested" && <Button variant="ghost" size="sm" onClick={() => setWithdrawing(l)}>Withdraw</Button>}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {asking && <AskLoan categories={categories} today={today} onClose={() => setAsking(false)} />}
      <LoanDrawer id={open} onClose={() => setOpen(null)} />
      {withdrawing && (
        <ConfirmDialog open onOpenChange={(o) => !o && setWithdrawing(null)} title="Withdraw this request?" description={`${withdrawing.category}, ${formatPaise(withdrawing.principalPaise)}.`} confirmLabel="Withdraw"
          onConfirm={async () => { const r = await withdrawLoanAction(withdrawing.id); if (r.ok) toast.success("Request withdrawn"); else toast.error(r.error); setWithdrawing(null); }} />
      )}
    </div>
  );
}

function LoanDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const s = useLoanDetail(id);
  return (
    <Drawer open={!!id} onOpenChange={(o) => !o && onClose()} title={s?.d ? s.d.category : "Loan"} description={s?.d ? `${formatPaise(s.d.principalPaise)}, ${s.d.tenureMonths} months` : undefined}>
      {!s ? <DetailSkeleton /> : s.error || !s.d ? <p className="text-base text-danger-text">{s.error ?? "Couldn't load this loan."}</p> : (
        <div className="flex flex-col gap-5">
          <LoanFacts d={s.d} />
          {s.d.schedule.length > 0 && <div><h3 className="mb-2 text-sm font-semibold">EMI schedule</h3><ScheduleTable rows={s.d.schedule} caption="EMI schedule" /></div>}
          {s.d.prepayments.length > 0 && (
            <div><h3 className="mb-2 text-sm font-semibold">Paid back outside salary</h3>
              <ul className="flex flex-col gap-1 text-base">{s.d.prepayments.map((p, i) => <li key={i}>{shortDate(p.paidOn)}: <Money paise={p.amountPaise} />{p.reference ? ` · ${p.reference}` : ""}</li>)}</ul></div>
          )}
          <LoanSteps d={s.d} />
        </div>
      )}
    </Drawer>
  );
}

function AskLoan({ categories, today, onClose }: { categories: CategoryRow[]; today: string; onClose: () => void }) {
  const [categoryId, setCategoryId] = React.useState(categories[0]?.id ?? "");
  const [amount, setAmount] = React.useState("");
  const [months, setMonths] = React.useState("12");
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const c = categories.find((x) => x.id === categoryId);
  const amountPaise = parseRupees(amount);
  const n = Number(months);
  const max = Math.min(c?.maxTenureMonths ?? MAX_TENURE_MONTHS, MAX_TENURE_MONTHS);
  const preview = React.useMemo(() => {
    if (!c || !amountPaise || amountPaise < 100_00 || !Number.isInteger(n) || n < 1 || n > max) return null;
    const first = `${today.slice(0, 7)}-01`;
    const rows = buildSchedule({ principalPaise: amountPaise, rateBp: c.rateBp, rateType: c.rateType, months: n, firstMonth: first });
    return { emi: emiFor({ principalPaise: amountPaise, rateBp: c.rateBp, rateType: c.rateType, months: n }), interest: scheduleTotals(rows).interestPaise };
  }, [c, amountPaise, n, max, today]);
  const save = () => start(async () => {
    if (amountPaise == null || amountPaise === 0) { setError({ message: "Enter the amount in rupees, like 50000.", field: "amountPaise" }); return; }
    const r = await requestLoanAction({ categoryId, amountPaise, months: n, reason });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success("Loan requested", { description: "We'll let you know when it's decided." });
    onClose();
  });
  const err = (f: string) => (error?.field === f ? error.message : undefined);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Ask for a loan" description="Your manager and a payroll admin approve it. Payroll then pays it out and takes the EMIs from your salary."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>Send request</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <Field label="Loan type" required error={err("categoryId")} help={c ? `${rateText(c.interestRate, c.rateType)}${c.maxAmountPaise ? ` · up to ${formatPaise(c.maxAmountPaise)}` : ""}${c.maxTenureMonths ? ` · up to ${c.maxTenureMonths} months` : ""}` : undefined}>
          <Select value={categoryId} onValueChange={setCategoryId} options={categories.map((x) => ({ value: x.id, label: x.name }))} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Amount" required error={err("amountPaise")}><Input inputMode="decimal" leading={<span className="text-sm">₹</span>} value={amount} onChange={(e) => setAmount(e.target.value)} className="tabular" autoFocus /></Field>
          <Field label="Repay over (months)" required error={err("months")} help={`1 to ${max}`}><Input type="number" min={1} max={max} value={months} onChange={(e) => setMonths(e.target.value)} /></Field>
        </div>
        <Field label="What is it for?" required error={err("reason")}><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} placeholder="e.g. Medical bills for a family member" /></Field>
        <div className="rounded-md bg-surface-sunken px-4 py-3 text-base" aria-live="polite">
          {preview ? <>About <Money paise={preview.emi} className="font-semibold" /> a month{preview.interest ? <>, <Money paise={preview.interest} /> interest in all</> : ", no interest"}. Payroll confirms the dates when it pays the loan out.</> : "Enter an amount and months to see your EMI."}
        </div>
      </form>
    </Modal>
  );
}
