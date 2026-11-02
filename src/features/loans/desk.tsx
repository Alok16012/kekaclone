"use client";
import * as React from "react";
import Link from "next/link";
import { HandCoins } from "lucide-react";
import { Card, CardBody, CardHeader, StatTile } from "@/ui/card";
import { Button } from "@/ui/button";
import { Drawer, ConfirmDialog, Modal } from "@/ui/overlay";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { Banner, EmptyState } from "@/ui/feedback";
import { DataTable, type Column } from "@/ui/table";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { toast } from "@/ui/toast";
import { cancelApprovedLoanAction, disburseLoanAction, prepareEmisAction, prepayLoanAction, skipEmiAction } from "@/app/(app)/payroll/loans/actions";
import { addMonths, defaultFirstEmiMonth, formatPaise, monthLabel } from "@/server/modules/loans/rules";
import { parseRupees } from "@/server/modules/tax/rules";
import type { LoanDetail, LoanView } from "@/server/modules/loans/service";
import { DetailSkeleton, LoanFacts, LoanStatus, LoanSteps, Money, ScheduleTable, shortDate, useLoanDetail } from "./shared";

type Row = LoanView & { mine: boolean };

export function LoanDesk({ loans, payGroups, today, companyWide }: { loans: Row[]; payGroups: { id: string; name: string }[]; today: string; companyWide: boolean }) {
  const [open, setOpen] = React.useState<string | null>(null);
  const [version, setVersion] = React.useState(0);
  const groups = {
    requested: loans.filter((l) => l.status === "requested"), approved: loans.filter((l) => l.status === "approved"),
    active: loans.filter((l) => l.status === "active"), done: loans.filter((l) => ["closed", "rejected", "written_off"].includes(l.status)),
  };
  const cols: Column<Row>[] = [
    { key: "who", header: "Person", cell: (r) => <span className="font-medium">{r.employee}{r.mine ? " (you)" : ""}</span>, sortValue: (r) => r.employee },
    { key: "type", header: "Loan", cell: (r) => r.category, sortValue: (r) => r.category, hideBelow: "md" },
    { key: "amount", header: "Amount", align: "right", cell: (r) => <Money paise={r.principalPaise} />, sortValue: (r) => r.principalPaise },
    { key: "owed", header: "Still owed", align: "right", cell: (r) => (r.status === "active" ? <Money paise={r.outstandingPaise} /> : "—"), sortValue: (r) => r.outstandingPaise, hideBelow: "md" },
    { key: "next", header: "Next EMI", cell: (r) => (r.nextDue ? `${formatPaise(r.nextDue.amountPaise)}, ${monthLabel(r.nextDue.month)}` : "—"), hideBelow: "lg" },
    { key: "status", header: "Status", cell: (r) => <LoanStatus status={r.status} /> },
  ];
  const table = (rows: Row[], empty: string) => (
    <DataTable rows={rows} columns={cols} rowKey={(r) => r.id} onRowClick={(r) => setOpen(r.id)} caption="Loans"
      empty={<EmptyState compact icon={<HandCoins />} title={empty} />} />
  );
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile label="Waiting to be paid out" value={String(groups.approved.length)} hint={formatPaise(groups.approved.reduce((s, l) => s + l.principalPaise, 0))} />
        <StatTile label="Being repaid" value={String(groups.active.length)} hint={`${formatPaise(groups.active.reduce((s, l) => s + l.outstandingPaise, 0))} outstanding`} />
        <StatTile label="In approval" value={String(groups.requested.length)} hint="Decided in the approvers' inboxes" />
      </div>
      <Tabs defaultValue={groups.approved.length ? "approved" : "active"}>
        <TabsList items={[{ value: "approved", label: "To pay out", count: groups.approved.length }, { value: "active", label: "Repaying", count: groups.active.length }, { value: "requested", label: "In approval", count: groups.requested.length }, { value: "done", label: "Closed and declined" }]} />
        <TabsContent value="approved">{table(groups.approved, "Nothing waiting to be paid out")}</TabsContent>
        <TabsContent value="active">{table(groups.active, "No loans being repaid")}</TabsContent>
        <TabsContent value="requested">{table(groups.requested, "No loan requests in approval")}</TabsContent>
        <TabsContent value="done">{table(groups.done, "Nothing here yet")}</TabsContent>
      </Tabs>
      {companyWide && <PrepareEmis payGroups={payGroups} today={today} />}
      <AdminDrawer id={open} version={version} today={today} onClose={() => setOpen(null)} onChanged={() => setVersion((v) => v + 1)} />
    </div>
  );
}

function PrepareEmis({ payGroups, today }: { payGroups: { id: string; name: string }[]; today: string }) {
  const months = Array.from({ length: 4 }, (_, i) => addMonths(`${today.slice(0, 7)}-01`, i - 1));
  const [group, setGroup] = React.useState(payGroups[0]?.id ?? "");
  const [month, setMonth] = React.useState(months[1]);
  const [pending, start] = React.useTransition();
  if (!payGroups.length) return null;
  return (
    <Card>
      <CardHeader title="EMIs for payroll" description="Each month's payroll run picks up the EMIs due. Prepare them ahead to check what will be taken." />
      <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label="Pay group" className="sm:w-56"><Select value={group} onValueChange={setGroup} options={payGroups.map((g) => ({ value: g.id, label: g.name }))} /></Field>
        <Field label="Month" className="sm:w-44"><Select value={month} onValueChange={setMonth} options={months.map((m) => ({ value: m, label: monthLabel(m) }))} /></Field>
        <Button variant="secondary" loading={pending} onClick={() => start(async () => {
          const r = await prepareEmisAction(group, month);
          if (!r.ok) { toast.error(r.error); return; }
          const x = r.data!;
          if (x.locked) toast.error(`Payroll for ${monthLabel(month)} is already finalised.`);
          else toast.success(`${x.written + x.updated} EMI${x.written + x.updated === 1 ? "" : "s"} ready for ${monthLabel(month)}`, { description: `${formatPaise(x.totalPaise)} in total${x.removed ? `, ${x.removed} out-of-date removed` : ""}.` });
        })}>Prepare EMIs</Button>
      </CardBody>
    </Card>
  );
}

function AdminDrawer({ id, version, today, onClose, onChanged }: { id: string | null; version: number; today: string; onClose: () => void; onChanged: () => void }) {
  const s = useLoanDetail(id, version);
  const [modal, setModal] = React.useState<"disburse" | "prepay" | "cancel" | null>(null);
  const [skip, setSkip] = React.useState<string | null>(null);
  const d = s?.d;
  return (
    <>
      <Drawer open={!!id} onOpenChange={(o) => !o && onClose()} title={d ? `${d.employee}: ${d.category}` : "Loan"} description={d ? `Asked ${shortDate(d.createdAt)}` : undefined}
        footer={d && d.canManage ? (
          <>
            {d.status === "approved" && <><Button variant="ghost" onClick={() => setModal("cancel")}>Cancel loan</Button><Button onClick={() => setModal("disburse")}>Record payout</Button></>}
            {d.status === "active" && <Button variant="secondary" onClick={() => setModal("prepay")}>Record a repayment</Button>}
          </>
        ) : undefined}>
        {!s ? <DetailSkeleton /> : s.error || !d ? <p className="text-base text-danger-text">{s.error ?? "Couldn't load this loan."}</p> : (
          <div className="flex flex-col gap-5">
            {d.mine && <Banner tone="info">This is your own loan, so another payroll admin has to manage it.</Banner>}
            {!d.mine && !d.canManage && <Banner tone="info">You can see this loan but don&apos;t manage payroll for this person.</Banner>}
            <LoanFacts d={d} />
            {d.schedule.length > 0 && (
              <div><h3 className="mb-2 text-sm font-semibold">EMI schedule</h3>
                <ScheduleTable rows={d.schedule} caption="EMI schedule" actions={d.canManage && d.status === "active" ? (r) => r.status === "scheduled" && !r.locked ? <Button variant="link" size="sm" onClick={() => setSkip(r.dueMonth)}>Skip</Button> : null : undefined} /></div>
            )}
            {d.prepayments.length > 0 && (
              <div><h3 className="mb-2 text-sm font-semibold">Repaid outside salary</h3>
                <ul className="flex flex-col gap-1 text-base">{d.prepayments.map((p, i) => <li key={i}>{shortDate(p.paidOn)}: <Money paise={p.amountPaise} />{p.reference ? ` · ${p.reference}` : ""}</li>)}</ul></div>
            )}
            <LoanSteps d={d} />
            <p className="text-sm text-text-muted">A loan at below-market interest can be a taxable perquisite for the employee. erp doesn&apos;t work that out yet; check with your CA. <Link href="/settings/payroll/loans" className="text-accent-text underline-offset-4 hover:underline">Loan types</Link></p>
          </div>
        )}
      </Drawer>
      {d && modal === "disburse" && <Disburse d={d} today={today} onClose={() => setModal(null)} onDone={onChanged} />}
      {d && modal === "prepay" && <Prepay d={d} today={today} onClose={() => setModal(null)} onDone={onChanged} />}
      {d && modal === "cancel" && (
        <ConfirmDialog open onOpenChange={(o) => !o && setModal(null)} title="Cancel this loan?" description={`${d.employee} won't be paid ${formatPaise(d.principalPaise)}. They'll be told.`} confirmLabel="Cancel loan"
          onConfirm={async () => { const r = await cancelApprovedLoanAction(d.id); if (r.ok) { toast.success("Loan cancelled"); onChanged(); } else toast.error(r.error); setModal(null); }} />
      )}
      {d && skip && (
        <ConfirmDialog open tone="primary" onOpenChange={(o) => !o && setSkip(null)} title={`Skip the ${monthLabel(skip)} EMI?`} description="Nothing is taken from salary that month. The same EMI moves to after the last one, with no extra interest." confirmLabel="Skip EMI"
          onConfirm={async () => { const r = await skipEmiAction(d.id, skip); if (r.ok) { toast.success(`EMI moved to ${monthLabel(r.data!.movedTo)}`); onChanged(); } else toast.error(r.error); setSkip(null); }} />
      )}
    </>
  );
}

function Disburse({ d, today, onClose, onDone }: { d: LoanDetail; today: string; onClose: () => void; onDone: () => void }) {
  const [on, setOn] = React.useState(today);
  const months = Array.from({ length: 7 }, (_, i) => addMonths(`${on.slice(0, 7)}-01`, i));
  const [first, setFirst] = React.useState(defaultFirstEmiMonth(today));
  const [ref, setRef] = React.useState("");
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    const r = await disburseLoanAction(d.id, { disbursedOn: on, firstEmiMonth: first, reference: ref });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success("Payout recorded", { description: r.data && "installments" in r.data ? `${r.data.installments} EMIs scheduled.` : undefined });
    onDone(); onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="sm" title="Record the payout" description={`Pay ${formatPaise(d.principalPaise)} to ${d.employee} from your bank, then record it here. erp builds the EMI schedule.`}
      footer={<><Button variant="secondary" onClick={onClose}>Back</Button><Button loading={pending} onClick={save}>Record payout</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <Field label="Paid on" required error={error?.field === "disbursedOn" ? error.message : undefined}><Input type="date" value={on} max={today} onChange={(e) => { setOn(e.target.value); if (e.target.value) setFirst(defaultFirstEmiMonth(e.target.value)); }} /></Field>
        <Field label="First EMI in" required error={error?.field === "firstEmiMonth" ? error.message : undefined} help="Paying out before the month ahead of the first EMI adds pre-EMI interest to the first EMI.">
          <Select value={first} onValueChange={setFirst} options={months.map((m) => ({ value: m, label: monthLabel(m) }))} />
        </Field>
        <Field label="Bank reference"><Input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={120} placeholder="UTR or transfer number" /></Field>
      </form>
    </Modal>
  );
}

function Prepay({ d, today, onClose, onDone }: { d: LoanDetail; today: string; onClose: () => void; onDone: () => void }) {
  const locked = d.schedule.filter((r) => r.status === "scheduled" && r.locked).reduce((s, r) => s + r.principalPaise, 0);
  const max = d.outstandingPaise - locked;
  const [amount, setAmount] = React.useState("");
  const [on, setOn] = React.useState(today);
  const [ref, setRef] = React.useState("");
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const paise = parseRupees(amount);
  const save = () => start(async () => {
    if (!paise) { setError({ message: "Enter the amount repaid, in rupees.", field: "amountPaise" }); return; }
    const r = await prepayLoanAction(d.id, { amountPaise: paise, paidOn: on, reference: ref });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success(r.data?.closed ? "Loan closed" : "Repayment recorded", { description: r.data?.closed ? undefined : `${formatPaise(Math.max(0, r.data?.outstandingPaise ?? 0))} still owed.` });
    onDone(); onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="sm" title="Record a repayment" description={`Money ${d.employee} paid back outside salary. ${formatPaise(max)} can be repaid now${locked ? " (EMIs in a finalised payroll still run)" : ""}.`}
      footer={<><Button variant="secondary" onClick={onClose}>Back</Button><Button loading={pending} onClick={save}>{paise === max ? "Record and close loan" : "Record repayment"}</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <Field label="Amount" required error={error?.field === "amountPaise" ? error.message : undefined} help={<Button type="button" variant="link" size="sm" onClick={() => setAmount((max / 100).toFixed(2))}>Repay all {formatPaise(max)}</Button>}>
          <Input inputMode="decimal" leading={<span className="text-sm">₹</span>} value={amount} onChange={(e) => setAmount(e.target.value)} className="tabular" />
        </Field>
        <Field label="Paid on" required error={error?.field === "paidOn" ? error.message : undefined}><Input type="date" value={on} max={today} onChange={(e) => setOn(e.target.value)} /></Field>
        <Field label="Reference"><Input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={120} placeholder="UTR, cheque number, or final settlement" /></Field>
        <p className="text-sm text-text-muted">A part repayment lowers the remaining EMIs over the same months. Interest that isn&apos;t due yet isn&apos;t charged.</p>
      </form>
    </Modal>
  );
}
