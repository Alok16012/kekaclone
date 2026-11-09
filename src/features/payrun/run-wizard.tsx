"use client";
import * as React from "react";
import Link from "next/link";
import {
  AlertTriangle, Banknote, Calculator, CheckCircle2, ChevronRight, Download, FileSpreadsheet, FileText, Lock, MoreHorizontal, Plus, RotateCcw, Send, Trash2, Undo2, Upload, XCircle,
} from "lucide-react";
import { PageHeader } from "@/ui/app-shell";
import { Button, IconButton } from "@/ui/button";
import { Card, CardBody, CardHeader, StatTile } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Field, Input, MoneyInput, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { ConfirmDialog, Drawer, Menu, Modal } from "@/ui/overlay";
import { Banner, EmptyState, Skeleton } from "@/ui/feedback";
import { DataTable, type Column } from "@/ui/table";
import { toast } from "@/ui/toast";
import { cn } from "@/lib/cn";
import { UnverifiedRatesBanner } from "@/features/statutory/rates-banner";
import type { runView, LineRow, InputView } from "@/server/modules/payrun/runs";
import type { StepKey } from "@/server/modules/payrun/rules";
import * as A from "@/app/(app)/payroll/actions";
import { ACTION_LABEL, fmtDate, fmtMonth, INPUT_LABEL, money, OVERRIDE_LABEL, RUN_LABEL, RUN_TONE } from "./format";

export type RunData = Awaited<ReturnType<typeof runView>>;
type Ctx = { joining?: string; lastDay?: string | null; exitStatus?: string | null; currentLop?: number; rolledLop?: number; lateLop?: number; unpaidLeaveDays?: number; absentNoLop?: number; overtimeMinutes?: number; employedDays?: number; workerType?: string; units?: number | null };
const ctx = (l: LineRow) => (l.statutory?.context ?? {}) as Ctx;
const STEP_KINDS: Record<string, string[]> = {
  attendance: ["lop_adjust", "lop_reversal", "payable_units"],
  variable: ["bonus", "arrear", "overtime", "shift_allowance"],
  claims: ["adhoc_earning", "adhoc_deduction", "component_claim", "loan_emi", "leave_encashment"],
};
const DAY_KINDS = ["lop_adjust", "lop_reversal", "payable_units"];

/** Wraps an action call: toast on error, optional success message. Returns whether it worked. */
async function act<T>(p: Promise<{ ok: true; data?: T } | { ok: false; error: string }>, success?: string) {
  const r = await p;
  if (!r.ok) { toast.error(r.error); return null; }
  if (success) toast.success(success);
  return r;
}

export function RunWizard({ d, initialStep }: { d: RunData; initialStep: string | null }) {
  const run = d.run;
  const open = run.status === "draft" || run.status === "in_progress";
  const v = run.lock_version;
  const initial = Math.max(0, d.steps.findIndex((s) => s.key === initialStep));
  const [step, setStep] = React.useState(initial);
  const [line, setLine] = React.useState<LineRow | null>(null);
  const [input, setInput] = React.useState<{ kinds: string[]; row?: InputView } | null>(null);
  const [pending, start] = React.useTransition();
  const go = (i: number) => { setStep(i); window.history.replaceState(null, "", `?step=${d.steps[i].key}`); };
  const computed = run.status !== "draft";
  const t = run.totals ?? {};
  const prev = d.prevTotals as Record<string, number> | null;
  const delta = (cur: number | undefined, p: number | undefined) => {
    if (!cur || !p) return undefined;
    const pct = Math.round(((cur - p) / p) * 1000) / 10;
    return { value: `${pct > 0 ? "+" : ""}${pct}%`, up: pct >= 0, good: pct <= 5 };
  };
  const calc = () => start(async () => { await act(A.calculateAction(run.id, v), "Run recalculated"); });
  const allDone = d.steps.every((s) => s.done);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader breadcrumb={<Link href="/payroll" className="hover:underline">Payroll</Link>} title={`${run.pay_group} · ${run.label}`}
        description={<span className="inline-flex flex-wrap items-center gap-2"><Badge tone={RUN_TONE[run.status]}>{RUN_LABEL[run.status]}</Badge>
          <span>{run.legal_entity} · cut-off day {run.cutoff}{run.step_state.computedAt ? ` · calculated ${new Date(run.step_state.computedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}` : ""}</span></span>}
        actions={<RunActions d={d} pending={pending} onCalc={calc} allDone={allDone} />} />
      <UnverifiedRatesBanner status={d.verification} />
      {run.status === "rolled_back" && <Banner tone="danger" title="This run was rolled back">{run.step_state.rollback ? `${run.step_state.rollback.by}: “${run.step_state.rollback.reason}”. ` : ""}Its lines are kept for the record. Start the month again from the payroll page.</Banner>}
      {open && computed && !d.fresh && <Banner tone="warning" title="Changes since the last calculation" action={<Button size="sm" loading={pending} onClick={calc}><Calculator />Recalculate</Button>}>Inputs or pay actions changed after the numbers below were worked out. Recalculate before you finalise.</Banner>}
      {!computed && (
        <Card><EmptyState icon={<Calculator />} title={`Calculate ${run.label}`} description="erp pulls attendance, loss of pay, salaries and inputs for everyone in the pay group. You can recalculate as often as you like until you finalise."
          action={<Button loading={pending} onClick={calc}><Calculator />Calculate payroll</Button>} /></Card>
      )}
      {computed && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatTile label="People" value={t.headcount ?? 0} hint={t.held ? `${t.held} held` : undefined} />
            <StatTile label="Gross earnings" value={money(t.gross ?? 0)} delta={delta(t.gross, prev?.gross)} hint={prev ? "vs last month" : undefined} />
            <StatTile label="Deductions" value={money(t.deductions ?? 0)} />
            <StatTile label="Net pay" value={money(t.net ?? 0)} delta={delta(t.net, prev?.net)} hint={prev ? "vs last month" : undefined} />
            <StatTile label="Cost to company" value={money(t.cost ?? 0)} hint="gross + employer contributions" />
          </div>
          {!open && <AfterFinalise d={d} />}
          <nav aria-label="Run steps">
            <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
              {d.steps.map((s, i) => (
                <li key={s.key}>
                  <button type="button" onClick={() => go(i)} aria-current={i === step ? "step" : undefined}
                    className={cn("flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors", i === step ? "border-accent bg-accent-soft text-accent-text" : "border-border bg-surface hover:bg-surface-hover")}>
                    {s.done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-text" aria-label="Done" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning-text" aria-label={`${s.exceptions} to check`} />}
                    <span className="min-w-0"><span className="block font-medium">{i + 1}. {s.title}</span>
                      <span className="block text-text-muted">{s.exceptions ? `${s.exceptions} to check` : "Nothing to check"}{s.reviewed ? " · reviewed" : ""}</span></span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          <StepBody d={d} stepKey={d.steps[step].key} onLine={setLine} onInput={(kinds, row) => setInput({ kinds, row })} />
          <div className="flex justify-between">
            <Button variant="secondary" disabled={step === 0} onClick={() => go(step - 1)}>Previous</Button>
            {step < d.steps.length - 1 && <Button variant="secondary" onClick={() => go(step + 1)}>Next<ChevronRight /></Button>}
          </div>
        </>
      )}
      {line && <LineDrawer d={d} line={d.lines.find((l) => l.id === line.id) ?? line} onClose={() => setLine(null)} />}
      {input && <InputDialog d={d} kinds={input.kinds} row={input.row} onClose={() => setInput(null)} />}
    </div>
  );
}

function RunActions({ d, pending, onCalc, allDone }: { d: RunData; pending: boolean; onCalc: () => void; allDone: boolean }) {
  const run = d.run, v = run.lock_version;
  const open = run.status === "draft" || run.status === "in_progress";
  const [rollback, setRollback] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [busy, start] = React.useTransition();
  const exp = (k: string) => `/payroll/runs/${run.id}/export/${k}`;
  const reports = run.status !== "draft" && run.status !== "rolled_back";
  return (
    <>
      {open && <Button variant="secondary" onClick={() => setImporting(true)}><Upload />Import inputs</Button>}
      {open && run.status !== "draft" && <Button variant="secondary" loading={pending} onClick={onCalc}><Calculator />Recalculate</Button>}
      {reports && (
        <Menu trigger={<Button variant="secondary"><FileSpreadsheet />Reports</Button>} items={[
          { label: "Payroll register (Excel)", icon: <FileSpreadsheet />, onSelect: () => window.location.assign(exp("register")) },
          { label: "PF return (ECR text)", icon: <FileText />, onSelect: () => window.location.assign(exp("pf-ecr")) },
          { label: "ESI contributions (CSV)", icon: <FileText />, onSelect: () => window.location.assign(exp("esi")) },
          { label: "Professional tax by state (CSV)", icon: <FileText />, onSelect: () => window.location.assign(exp("pt")) },
          { label: "Labour Codes 50% wages check (CSV)", icon: <FileText />, onSelect: () => window.location.assign(exp("labour-code")) },
          { label: "Journal summary (CSV)", icon: <FileText />, onSelect: () => window.location.assign(exp("journal")) },
          { label: "Tally journal voucher (XML)", icon: <FileText />, onSelect: () => window.location.assign(exp("tally")) },
          { label: "Zoho Books journal (CSV)", icon: <FileText />, onSelect: () => window.location.assign(exp("zoho")) },
        ]} />
      )}
      {importing && <ImportInputsDialog d={d} onClose={() => setImporting(false)} />}
      {open && run.status === "in_progress" && (
        <ConfirmDialog title={`Finalise ${run.label}?`} tone="primary" confirmLabel="Finalise"
          description={<>This locks the run and everyone&apos;s attendance up to the cut-off. Later changes go into next month as arrears or LOP adjustments. A payroll admin can roll it back until salaries are marked paid.</>}
          trigger={<Button disabled={!d.fresh || !allDone}><Lock />Finalise</Button>}
          onConfirm={() => new Promise<void>((res) => start(async () => { await act(A.finalizeAction(run.id, v), `${run.label} finalised`); res(); }))} />
      )}
      {d.canRollback && <Button variant="ghost" onClick={() => setRollback(true)} disabled={busy}><RotateCcw />Roll back</Button>}
      {rollback && <RollbackDialog d={d} onClose={() => setRollback(false)} />}
    </>
  );
}

function RollbackDialog({ d, onClose }: { d: RunData; onClose: () => void }) {
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Roll back ${d.run.label}?`} description="Payslips are withdrawn (people are told), bank files that aren't paid are cancelled and attendance is unlocked. The run is kept, marked as rolled back."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" loading={pending} onClick={() => start(async () => {
        const r = await A.rollbackAction(d.run.id, reason, d.run.lock_version);
        if (!r.ok) { setError(r.error); return; }
        toast.success("Run rolled back"); onClose();
      })}>Roll back</Button></>}>
      {error && <Banner tone="danger" className="mb-3">{error}</Banner>}
      <Field label="Why is it being rolled back?" required help="Saved in the audit log and shown on the run."><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
    </Modal>
  );
}

// ---------------------------------------------------------------- after finalising

function AfterFinalise({ d }: { d: RunData }) {
  const [pending, start] = React.useTransition();
  const run = d.run;
  const noBank = d.lines.filter((l) => l.action === "process" && l.net > 0 && !l.has_bank);
  if (run.status === "rolled_back") return null;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Payslips" description={d.payslips.released === d.payslips.total ? `All ${d.payslips.total} released. People see them under My finances.` : `${d.payslips.released} of ${d.payslips.total} released.`}
          action={d.payslips.released < d.payslips.total ? <Button size="sm" loading={pending} onClick={() => start(async () => { await act(A.releasePayslipsAction(run.id), "Payslips released"); })}><Send />Release payslips</Button> : undefined} />
      </Card>
      <Card>
        <CardHeader title="Bank transfers" description={run.status === "paid" ? "Everyone in this run is paid." : "Make a bank file, upload it to your bank, then mark it paid here."}
          action={run.status !== "paid" ? <Menu trigger={<Button size="sm" loading={pending}><Banknote />Make bank file</Button>} items={[
            { label: "Generic NEFT (CSV)", onSelect: () => start(async () => { await act(A.createBatchAction(run.id, "neft_csv"), "Bank file ready"); }) },
            { label: "Bank bulk upload (pipe-separated)", onSelect: () => start(async () => { await act(A.createBatchAction(run.id, "hdfc_bulk"), "Bank file ready"); }) },
          ]} /> : undefined} />
        <CardBody className="flex flex-col gap-2">
          {noBank.length > 0 && <Banner tone="warning">{noBank.map((l) => l.name).join(", ")} {noBank.length === 1 ? "has" : "have"} no bank account, so {noBank.length === 1 ? "isn't" : "aren't"} in bank files. Pay them another way and mark them paid outside erp from the review step.</Banner>}
          {d.batches.length === 0 ? <p className="text-sm text-text-muted">No bank files yet.</p> : (
            <ul className="flex flex-col divide-y divide-border">
              {d.batches.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="min-w-0 flex-1 text-base"><span className="font-medium">{b.bank_format === "neft_csv" ? "NEFT CSV" : "Bulk upload"}</span> · {b.count} {b.count === 1 ? "person" : "people"} · <span className="tabular">{money(b.total_paise)}</span>
                    <span className="block text-sm text-text-muted">{b.status === "paid" ? `Paid ${fmtDate(b.paid_at?.slice(0, 10))}` : b.status === "cancelled" ? "Cancelled" : `Made ${fmtDate(b.created_at.slice(0, 10))}`}</span></span>
                  {b.file_id && b.status !== "cancelled" && <IconButton asChild size="icon-sm" variant="ghost" label="Download bank file"><a href={`/payroll/files/${b.file_id}?download=1`}><Download /></a></IconButton>}
                  {b.status === "generated" && <>
                    <ConfirmDialog title="Mark this bank file paid?" tone="primary" confirmLabel="Mark paid" description="Do this once your bank confirms the transfers. Everyone in the file is told their salary is paid."
                      trigger={<Button size="sm" variant="secondary">Mark paid</Button>} onConfirm={async () => { await act(A.batchPaidAction(b.id), "Marked paid"); }} />
                    <ConfirmDialog title="Cancel this bank file?" confirmLabel="Cancel file" description="Its people can go into a new file." trigger={<IconButton size="icon-sm" variant="ghost" label="Cancel bank file"><Trash2 /></IconButton>} onConfirm={async () => { await act(A.cancelBatchAction(b.id), "Bank file cancelled"); }} />
                  </>}
                  {b.status === "paid" && <Badge tone="success">Paid</Badge>}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- steps

function ReviewBar({ d, k }: { d: RunData; k: StepKey }) {
  const s = d.steps.find((x) => x.key === k)!;
  const open = d.run.status === "draft" || d.run.status === "in_progress";
  const [pending, start] = React.useTransition();
  if (!s.exceptions) return <p className="flex items-center gap-2 text-sm text-success-text"><CheckCircle2 className="size-4" aria-hidden />Nothing needs checking in this step.</p>;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md bg-warning-soft px-4 py-3 text-warning-text">
      <AlertTriangle className="size-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1 text-base">{s.exceptions} {s.exceptions === 1 ? "thing needs" : "things need"} a look before you finalise.{s.reviewed ? ` Reviewed by ${s.reviewed.by}.` : ""}</p>
      {open && (s.reviewed
        ? <Button size="sm" variant="ghost" loading={pending} onClick={() => start(async () => { await act(A.reviewStepAction(d.run.id, k, false, d.run.lock_version)); })}><Undo2 />Undo review</Button>
        : <Button size="sm" variant="secondary" loading={pending} onClick={() => start(async () => { await act(A.reviewStepAction(d.run.id, k, true, d.run.lock_version), "Marked as reviewed"); })}><CheckCircle2 />Mark as reviewed</Button>)}
    </div>
  );
}

const days = (n: number | undefined) => (n ? String(n) : "—");

function StepBody({ d, stepKey, onLine, onInput }: { d: RunData; stepKey: StepKey; onLine: (l: LineRow) => void; onInput: (kinds: string[], row?: InputView) => void }) {
  const open = d.run.status === "draft" || d.run.status === "in_progress";
  const step = d.steps.find((s) => s.key === stepKey)!;
  const month = d.run.period_month, monthEnd = `${month.slice(0, 8)}31`;
  const exceptionsFirst = <T,>(rows: T[], bad: (r: T) => boolean) => [...rows].sort((a, b) => Number(bad(b)) - Number(bad(a)));
  const addBtn = (kinds: string[], label: string) => open ? <Button size="sm" onClick={() => onInput(kinds)}><Plus />{label}</Button> : undefined;

  if (stepKey === "attendance") {
    const rows = exceptionsFirst(d.lines, (l) => (ctx(l).absentNoLop ?? 0) > 0);
    return (
      <Card>
        <CardHeader title={step.title} description={`Loss of pay dated ${fmtDate(d.windows.current.from)} to ${fmtDate(d.windows.current.to)} is deducted now${d.windows.lateFrom ? `; from ${fmtDate(d.windows.lateFrom)} it rolls into next month` : ""}${d.windows.rolled ? `. Last month's LOP after its cut-off (${fmtDate(d.windows.rolled.from)}–${fmtDate(d.windows.rolled.to)}) is deducted here at last month's rate.` : "."}`}
          action={addBtn(STEP_KINDS.attendance, "Add LOP change")} />
        <CardBody className="flex flex-col gap-4">
          <ReviewBar d={d} k={stepKey} />
          <InputList d={d} kinds={STEP_KINDS.attendance} onEdit={onInput} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-base">
              <caption className="sr-only">Payable days and loss of pay per person</caption>
              <thead className="text-left text-sm text-text-muted"><tr className="border-b border-border">
                <th scope="col" className="py-2 pr-3 font-medium">Person</th><th scope="col" className="px-2 text-right font-medium">Paid days</th><th scope="col" className="px-2 text-right font-medium">LOP</th>
                <th scope="col" className="px-2 text-right font-medium">Unpaid leave</th><th scope="col" className="px-2 text-right font-medium">From last month</th><th scope="col" className="px-2 text-right font-medium">After cut-off</th><th scope="col" className="pl-2 font-medium">Check</th></tr></thead>
              <tbody>
                {rows.map((l) => { const c = ctx(l); return (
                  <tr key={l.id} className="border-b border-border last:border-0">
                    <td className="py-2 pr-3"><button type="button" className="text-left hover:underline" onClick={() => onLine(l)}>{l.name}</button></td>
                    <td className="px-2 text-right tabular">{c.units != null ? `${l.payable_days} ${c.workerType === "piece" ? "pieces" : "days"}` : `${l.payable_days} / ${l.period_days}`}</td>
                    <td className="px-2 text-right tabular">{days(l.lop_days)}</td>
                    <td className="px-2 text-right tabular">{days(c.unpaidLeaveDays)}</td>
                    <td className="px-2 text-right tabular">{days(c.rolledLop)}</td>
                    <td className="px-2 text-right tabular">{days(c.lateLop)}</td>
                    <td className="pl-2 text-sm">{c.units != null && !c.units ? <Badge tone="warning">No units entered</Badge> : c.absentNoLop ? <Badge tone="warning">{c.absentNoLop} absent, not LOP</Badge> : <span className="text-text-muted">OK</span>}</td>
                  </tr>
                ); })}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
    );
  }

  if (stepKey === "people") {
    const joiners = d.lines.filter((l) => (ctx(l).joining ?? "") >= month);
    const leavers = d.lines.filter((l) => ctx(l).lastDay && ctx(l).lastDay! <= monthEnd || ctx(l).exitStatus);
    const noBank = d.lines.filter((l) => l.action === "process" && l.net > 0 && !l.has_bank);
    const noSalary = d.run.totals?.noSalary ?? [];
    return (
      <Card>
        <CardHeader title={step.title} description="Joiners and leavers are paid for the days they were employed. Use pay actions to hold or skip someone's pay this month." />
        <CardBody className="flex flex-col gap-5">
          <ReviewBar d={d} k={stepKey} />
          {noSalary.length > 0 && <Banner tone="warning" title="Left out: no salary on record">{noSalary.map((p) => <Link key={p.id} href={`/people/${p.id}?tab=finances`} className="mr-2 underline underline-offset-2">{p.name}</Link>)}</Banner>}
          {noBank.length > 0 && <Banner tone="warning" title="No bank account">{noBank.map((l) => l.name).join(", ")}. They can be paid outside erp after finalising.</Banner>}
          <PeopleList title="Joined this month" empty="Nobody joined this month." rows={joiners} d={d} onLine={onLine} note={(l) => `Joined ${fmtDate(ctx(l).joining)} · ${l.payable_days} of ${l.period_days} days`} />
          <PeopleList title="Leaving or left" empty="Nobody is leaving this month." rows={leavers} d={d} onLine={onLine}
            note={(l) => `${ctx(l).exitStatus === "in_progress" ? "Serving notice" : "Left"}${ctx(l).lastDay ? ` · last day ${fmtDate(ctx(l).lastDay)}` : ""} · settle in the final settlement`} />
          <PeopleList title="Pay actions" empty="Everyone is processed normally." rows={d.lines.filter((l) => l.action !== "process")} d={d} onLine={onLine} note={(l) => ACTION_LABEL[l.action]} />
          {open && <PayActionPicker d={d} />}
        </CardBody>
      </Card>
    );
  }

  if (stepKey === "variable" || stepKey === "claims") {
    const kinds = STEP_KINDS[stepKey];
    const auto = stepKey === "variable" ? d.lines.flatMap((l) => l.earnings.filter((e) => e.kind === "arrear" && e.code.startsWith("ARR_")).map((e) => ({ l, e }))) : [];
    const overtime = stepKey === "variable" ? d.lines.filter((l) => (ctx(l).overtimeMinutes ?? 0) > 0) : [];
    const scheduled = stepKey === "claims" ? d.inputs.filter((i) => i.kind === "expense") : [];
    return (
      <Card>
        <CardHeader title={step.title} description={stepKey === "variable" ? "One-time pay for this month. Arrears from back-dated salary revisions are worked out automatically." : "Payments and deductions for this month, including expense claims finance scheduled into payroll. Expense claims aren't taxed."}
          action={addBtn(kinds, stepKey === "variable" ? "Add payment" : "Add payment or deduction")} />
        <CardBody className="flex flex-col gap-5">
          <ReviewBar d={d} k={stepKey} />
          <InputList d={d} kinds={[...kinds, ...(stepKey === "claims" ? ["expense"] : [])]} onEdit={onInput} />
          {stepKey === "claims" && scheduled.length === 0 && <p className="text-sm text-text-muted">No expense claims are scheduled into this month.</p>}
          {auto.length > 0 && (
            <section aria-label="Automatic arrears"><h3 className="mb-2 text-base font-semibold">Arrears from salary revisions</h3>
              <ul className="flex flex-col divide-y divide-border">{auto.map(({ l, e }, i) => <li key={i} className="flex justify-between gap-3 py-2 text-base"><span>{l.name} · {e.label}</span><span className="tabular">{money(e.paise)}</span></li>)}</ul>
            </section>
          )}
          {overtime.length > 0 && (
            <section aria-label="Overtime recorded"><h3 className="mb-2 text-base font-semibold">Overtime recorded in attendance</h3>
              <p className="mb-2 text-sm text-text-muted">erp doesn&apos;t price overtime yet. Add an overtime payment for anyone who should be paid for it.</p>
              <ul className="flex flex-col divide-y divide-border">{overtime.map((l) => <li key={l.id} className="flex justify-between gap-3 py-2 text-base"><span>{l.name}</span><span className="tabular">{Math.round((ctx(l).overtimeMinutes ?? 0) / 6) / 10} h</span></li>)}</ul>
            </section>
          )}
        </CardBody>
      </Card>
    );
  }

  if (stepKey === "holds") {
    const held = d.lines.filter((l) => l.action === "hold_processing" || l.action === "hold_payout");
    const heldArrears = d.lines.flatMap((l) => l.earnings.filter((e) => e.kind === "arrear" && e.sourceMonth).map((e) => ({ l, e })));
    return (
      <Card>
        <CardHeader title={step.title} description="Held processing: no salary this month; it's paid as arrears once the hold is lifted. Held payout: salary is worked out and taxed, but left out of bank files until released." />
        <CardBody className="flex flex-col gap-5">
          <ReviewBar d={d} k={stepKey} />
          <PeopleList title="On hold" empty="Nobody's pay is on hold." rows={held} d={d} onLine={onLine} note={(l) => ACTION_LABEL[l.action]} />
          <section aria-label="Arrears this month"><h3 className="mb-2 text-base font-semibold">Arrears paid this month</h3>
            {heldArrears.length === 0 ? <p className="text-sm text-text-muted">No arrears this month.</p> : (
              <ul className="flex flex-col divide-y divide-border">{heldArrears.map(({ l, e }, i) => <li key={i} className="flex justify-between gap-3 py-2 text-base"><span>{l.name} · {e.label}</span><span className="tabular">{money(e.paise)}</span></li>)}</ul>
            )}
          </section>
        </CardBody>
      </Card>
    );
  }

  // review: statutory + register + variance
  const bad = (l: LineRow) => l.net < 0 || (l.variance != null && Math.abs(l.variance) > 25) || l.warnings.length > 0;
  const rows = exceptionsFirst(d.lines, bad);
  const sumDed = (code: string) => d.lines.reduce((t, l) => t + l.deduction_items.filter((x) => x.code === code).reduce((s, x) => s + x.paise, 0), 0);
  const sumEmp = (code: string) => d.lines.reduce((t, l) => t + l.employer_items.filter((x) => x.code === code).reduce((s, x) => s + x.paise, 0), 0);
  const overrides = d.inputs.filter((i) => i.kind === "statutory_override");
  const belowHalf = d.lines.filter((l) => l.statutory?.labourCode && !l.statutory.labourCode.ok);
  const columns: Column<LineRow>[] = [
    { key: "name", header: "Person", cell: (l) => <span className="flex flex-col"><span className="font-medium">{l.name}</span><span className="text-sm text-text-muted">{l.number}{l.action !== "process" ? ` · ${ACTION_LABEL[l.action]}` : ""}</span></span>, sortValue: (l) => l.name },
    { key: "days", header: "Days", align: "right", cell: (l) => <span className="tabular">{l.payable_days}/{l.period_days}</span>, hideBelow: "md" },
    { key: "gross", header: "Gross", align: "right", cell: (l) => <span className="tabular">{money(l.gross)}</span>, sortValue: (l) => l.gross, hideBelow: "md" },
    { key: "ded", header: "Deductions", align: "right", cell: (l) => <span className="tabular">{money(l.deductions)}</span>, sortValue: (l) => l.deductions, hideBelow: "lg" },
    { key: "net", header: "Net pay", align: "right", cell: (l) => <span className={cn("tabular font-medium", l.net < 0 && "text-danger-text")}>{money(l.net)}</span>, sortValue: (l) => l.net },
    { key: "var", header: "vs last month", align: "right", cell: (l) => l.variance == null ? <span className="text-text-muted">New</span> : <span className={cn("tabular", Math.abs(l.variance) > 25 && "font-medium text-warning-text")}>{l.variance > 0 ? "+" : ""}{l.variance}%</span>, sortValue: (l) => Math.abs(l.variance ?? 0), hideBelow: "md" },
    { key: "flags", header: "Check", cell: (l) => l.warnings.length ? <Badge tone={l.net < 0 ? "danger" : "warning"}>{l.warnings.length} {l.warnings.length === 1 ? "note" : "notes"}</Badge> : null },
  ];
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="Statutory summary" description="Worked out from erp's statutory rates. Override one person's amount from their line if your CA advises it." />
        <CardBody className="flex flex-col gap-4">
          <ReviewBar d={d} k={stepKey} />
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {[["PF (employee)", sumDed("PF_EMPLOYEE")], ["PF (employer)", sumEmp("PF_EMPLOYER")], ["ESI (employee)", sumDed("ESI")], ["ESI (employer)", sumEmp("ESI_EMPLOYER")], ["Professional tax", sumDed("PT")], ["Income tax (TDS)", sumDed("TDS")]].map(([k, v]) => (
              <div key={k as string} className="rounded-md bg-surface-sunken px-3 py-2"><dt className="text-sm text-text-muted">{k}</dt><dd className="text-md font-semibold tabular">{money(v as number)}</dd></div>
            ))}
          </dl>
          {overrides.length > 0 && <div><h3 className="mb-1 text-base font-semibold">Overrides</h3><ul className="text-base">{overrides.map((o) => <li key={o.id}>{o.name}: {OVERRIDE_LABEL[String(o.source_ref?.code)]} set to {money(o.amount ?? 0)} — {o.note}</li>)}</ul></div>}
          {belowHalf.length > 0 ? (
            <Banner tone="warning" title={`Labour Codes check: ${belowHalf.length} ${belowHalf.length === 1 ? "person's wages are" : "people's wages are"} below half of remuneration`}
              action={<a className="shrink-0 text-base font-medium underline underline-offset-4" href={`/payroll/runs/${d.run.id}/export/labour-code`}>Download the report</a>}>
              The Code on Wages expects basic, DA and retaining allowance to be at least 50% of total remuneration. {belowHalf.map((l) => `${l.name} (${l.statutory.labourCode!.pct}%)`).join(", ")}. An advisory check; erp doesn&apos;t change the pay.
            </Banner>
          ) : <p className="text-sm text-text-muted">Labour Codes check: everyone&apos;s wages (basic, DA, retaining allowance) are at least half of their remuneration.</p>}
        </CardBody>
      </Card>
      <DataTable caption="Payroll register" rows={rows} columns={columns} rowKey={(l) => l.id} onRowClick={onLine}
        empty={<EmptyState compact title="Nobody in this run" description="Add people to the pay group and recalculate." />} />
    </div>
  );
}

function PeopleList({ title, empty, rows, onLine, note }: { title: string; empty: string; rows: LineRow[]; d: RunData; onLine: (l: LineRow) => void; note: (l: LineRow) => string }) {
  return (
    <section aria-label={title}>
      <h3 className="mb-2 text-base font-semibold">{title}</h3>
      {rows.length === 0 ? <p className="text-sm text-text-muted">{empty}</p> : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {rows.map((l) => (
            <li key={l.id}><button type="button" onClick={() => onLine(l)} className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-surface-hover">
              <span className="min-w-0 flex-1"><span className="block font-medium">{l.name}</span><span className="block text-sm text-text-muted">{note(l)}</span></span>
              <span className="tabular">{money(l.net)}</span><ChevronRight className="size-4 text-text-muted" aria-hidden />
            </button></li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PayActionPicker({ d }: { d: RunData }) {
  const [who, setWho] = React.useState("");
  const [action, setAction] = React.useState("hold_payout");
  const [note, setNote] = React.useState("");
  const [pending, start] = React.useTransition();
  const people = d.lines.filter((l) => !l.self);
  return (
    <section aria-label="Change a pay action" className="rounded-md border border-border p-3">
      <h3 className="mb-2 text-base font-semibold">Change someone&apos;s pay action</h3>
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem_1fr_auto] sm:items-end">
        <Field label="Person"><Select value={who} onValueChange={setWho} placeholder="Pick a person" options={people.map((l) => ({ value: l.employee_id, label: l.name }))} /></Field>
        <Field label="Action"><Select value={action} onValueChange={setAction} options={Object.entries(ACTION_LABEL).map(([value, label]) => ({ value, label }))} /></Field>
        <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Why (optional)" /></Field>
        <Button disabled={!who} loading={pending} onClick={() => start(async () => { if (await act(A.setPayActionAction(d.run.id, who, action as never, note || null, d.run.lock_version), "Pay action saved")) { setWho(""); setNote(""); } })}>Save</Button>
      </div>
      <p className="mt-2 text-sm text-text-muted">You can&apos;t change your own pay action. Recalculate afterwards.</p>
    </section>
  );
}

function InputList({ d, kinds, onEdit }: { d: RunData; kinds: string[]; onEdit: (kinds: string[], row?: InputView) => void }) {
  const open = d.run.status === "draft" || d.run.status === "in_progress";
  const rows = d.inputs.filter((i) => kinds.includes(i.kind));
  const [pending, start] = React.useTransition();
  if (!rows.length) return <p className="text-sm text-text-muted">No {kinds.includes("lop_adjust") ? "LOP changes" : "payments or deductions"} added for this month yet.</p>;
  return (
    <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
      {rows.map((i) => (
        <li key={i.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
          <span className="min-w-0 flex-1"><span className="block font-medium">{i.name} · {INPUT_LABEL[i.kind] ?? i.kind}</span>
            <span className="block text-sm text-text-muted">{[i.days != null ? `${i.days} ${i.days === 1 ? "day" : "days"}` : null, i.source_month && i.source_month !== d.run.period_month ? `for ${fmtMonth(i.source_month)}` : null, i.component, i.note].filter(Boolean).join(" · ")}</span></span>
          {i.amount != null && <span className="tabular">{money(i.amount)}</span>}
          {i.action !== "pay" && <Badge tone="warning">{i.action === "hold" ? "On hold" : i.action === "void" ? "Skipped" : i.action}</Badge>}
          {open && !i.self && (
            <Menu trigger={<IconButton size="icon-sm" variant="ghost" label={`More for ${i.name}`} disabled={pending}><MoreHorizontal /></IconButton>} items={[
              ...(i.kind !== "expense" ? [{ label: "Edit", onSelect: () => onEdit(kinds, i) }] : []),
              i.action === "pay" ? { label: "Hold for a later month", onSelect: () => start(async () => { await act(A.setInputActionAction(d.run.id, i.id, "hold", d.run.lock_version), "On hold"); }) }
                : { label: "Pay this month", onSelect: () => start(async () => { await act(A.setInputActionAction(d.run.id, i.id, "pay", d.run.lock_version), "Will be paid"); }) },
              ...(i.kind !== "expense" ? ["separator" as const, { label: "Delete", danger: true, onSelect: () => start(async () => { await act(A.deleteInputAction(d.run.id, i.id, d.run.lock_version), "Deleted"); }) }] : []),
            ]} />
          )}
        </li>
      ))}
    </ul>
  );
}

function InputDialog({ d, kinds, row, onClose }: { d: RunData; kinds: string[]; row?: InputView; onClose: () => void }) {
  const [employeeId, setEmployee] = React.useState(row?.employee_id ?? "");
  const [kind, setKind] = React.useState(row?.kind ?? kinds[0]);
  const [amount, setAmount] = React.useState<number | null>(row?.amount ?? null);
  const [daysV, setDays] = React.useState(row?.days != null ? String(row.days) : "");
  const [source, setSource] = React.useState(row?.source_month ?? d.run.period_month);
  const [note, setNote] = React.useState(row?.note ?? "");
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const byDays = DAY_KINDS.includes(kind);
  const months = [0, 1, 2, 3].map((i) => { const [y, m] = d.run.period_month.split("-").map(Number); const t = y * 12 + m - 1 - i; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}-01`; });
  const save = () => start(async () => {
    const r = await A.saveInputAction(d.run.id, row?.id ?? null, {
      employeeId, kind, amountPaise: byDays ? null : amount, days: byDays || kind === "leave_encashment" ? (daysV ? Number(daysV) : null) : null,
      sourceMonth: byDays && kind !== "payable_units" ? source : null, note: note || null,
    }, d.run.lock_version);
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success(row ? "Saved" : "Added — recalculate to see it in the numbers"); onClose();
  });
  const fe = (f: string) => (error?.field === f ? error.message : undefined);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={row ? "Edit input" : "Add to this month"} description={`${d.run.pay_group} · ${d.run.label}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>{row ? "Save" : "Add"}</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <Field label="Person" required error={fe("employeeId")}><Select value={employeeId} onValueChange={setEmployee} placeholder="Pick a person" options={d.people.filter((p) => p.id !== d.lines.find((l) => l.self)?.employee_id).map((p) => ({ value: p.id, label: `${p.name} (${p.number})` }))} /></Field>
        <Field label="What" required><Select value={kind} onValueChange={setKind} options={kinds.map((k) => ({ value: k, label: INPUT_LABEL[k] }))} /></Field>
        {kind === "payable_units" ? (
          <Field label="Units worked this month" required error={fe("days")} help="Days for daily-wage workers, pieces for piece-rate workers. Their salary breakup holds the rate per unit."><Input inputMode="decimal" value={daysV} onChange={(e) => setDays(e.target.value.replace(/[^\d.]/g, ""))} /></Field>
        ) : byDays ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Days" required error={fe("days")} help="Whole or half days."><Input inputMode="decimal" value={daysV} onChange={(e) => setDays(e.target.value.replace(/[^\d.]/g, ""))} /></Field>
            <Field label="For which month" error={fe("sourceMonth")} help="Up to three months back, valued at that month's salary."><Select value={source} onValueChange={setSource} options={months.map((m) => ({ value: m, label: fmtMonth(m) }))} /></Field>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Amount" required={kind !== "leave_encashment"} error={fe("amountPaise")}><MoneyInput valuePaise={amount} onChangePaise={setAmount} /></Field>
            {kind === "leave_encashment" && <Field label="Or days to encash" error={fe("days")} help="Basic ÷ 30 per day."><Input inputMode="decimal" value={daysV} onChange={(e) => setDays(e.target.value.replace(/[^\d.]/g, ""))} /></Field>}
          </div>
        )}
        <Field label="Note" help="Shown on the payslip line for payments and deductions." error={fe("note")}><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} /></Field>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- one person

function LineDrawer({ d, line, onClose }: { d: RunData; line: LineRow; onClose: () => void }) {
  const open = d.run.status === "draft" || d.run.status === "in_progress";
  const finalised = !open && d.run.status !== "rolled_back";
  const [code, setCode] = React.useState<string>("TDS");
  const [amount, setAmount] = React.useState<number | null>(null);
  const [reason, setReason] = React.useState("");
  const [paidNote, setPaidNote] = React.useState("");
  const [pending, start] = React.useTransition();
  const s = line.statutory;
  const items = (xs: { label: string; paise: number; code: string }[]) => xs.length === 0 ? <p className="text-sm text-text-muted">None.</p> : (
    <ul className="flex flex-col">{xs.map((x, i) => <li key={i} className="flex justify-between gap-3 py-1 text-base"><span className="min-w-0">{x.label}</span><span className="tabular">{money(x.paise)}</span></li>)}</ul>
  );
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={line.name} description={`${line.number}${line.designation ? ` · ${line.designation}` : ""} · ${line.payable_days} of ${line.period_days} days paid`}
      footer={<a href={`/payroll/preview/${line.id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-base text-accent-text hover:underline"><FileText className="size-4" aria-hidden />Preview payslip</a>}>
      <div className="flex flex-col gap-5">
        {line.warnings.length > 0 && <Banner tone={line.net < 0 ? "danger" : "warning"}><ul className="list-disc pl-4">{line.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></Banner>}
        <section aria-label="Earnings"><h3 className="mb-1 text-base font-semibold">Earnings</h3>{items(line.earnings)}<p className="mt-1 flex justify-between border-t border-border pt-1 font-medium"><span>Gross</span><span className="tabular">{money(line.gross)}</span></p></section>
        <section aria-label="Deductions"><h3 className="mb-1 text-base font-semibold">Deductions</h3>{items(line.deduction_items)}<p className="mt-1 flex justify-between border-t border-border pt-1 font-medium"><span>Total</span><span className="tabular">{money(line.deductions)}</span></p></section>
        <p className="flex justify-between rounded-md bg-surface-sunken px-3 py-2 text-md font-semibold"><span>Net pay</span><span className="tabular">{money(line.net)}</span></p>
        <section aria-label="Employer contributions"><h3 className="mb-1 text-base font-semibold">Paid by the company</h3>{items(line.employer_items)}</section>
        <StatutoryBreakdown line={line} />
        {s?.tds && <section aria-label="Income tax"><h3 className="mb-1 text-base font-semibold">Income tax projection</h3>
          <p className="text-sm text-text-muted">FY {s.tds.fy}, {s.tds.regime} regime{s.tds.standardDeductionOnly ? ", standard deduction only (no submitted tax declaration)" : ", with their submitted tax declaration"}. Projected income {money(s.tds.annualIncomePaise)}, tax {money(s.tds.annualTaxPaise)}, already deducted {money(s.tds.ytdTdsPaise)}, spread over {s.tds.remainingMonths} {s.tds.remainingMonths === 1 ? "month" : "months"}.</p></section>}
        {open && !line.self && (
          <section aria-label="Override a statutory amount" className="rounded-md border border-border p-3">
            <h3 className="mb-2 text-base font-semibold">Override a statutory amount</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Deduction"><Select value={code} onValueChange={setCode} options={Object.entries(OVERRIDE_LABEL).map(([value, label]) => ({ value, label }))} /></Field>
              <Field label="Amount"><MoneyInput valuePaise={amount} onChangePaise={setAmount} /></Field>
            </div>
            <Field label="Reason" className="mt-3"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="For example: exemption certificate on file" /></Field>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" loading={pending} onClick={() => start(async () => { await act(A.setOverrideAction(d.run.id, line.employee_id, code as never, amount ?? 0, reason, d.run.lock_version), "Override saved — recalculate"); })}>Save override</Button>
              <Button size="sm" variant="ghost" loading={pending} onClick={() => start(async () => { await act(A.setOverrideAction(d.run.id, line.employee_id, code as never, null, null, d.run.lock_version), "Override removed — recalculate"); })}>Remove override</Button>
            </div>
          </section>
        )}
        {finalised && !line.self && line.action === "hold_payout" && <Button variant="secondary" loading={pending} onClick={() => start(async () => { await act(A.releaseHeldAction(line.id), "Payout released"); })}>Release held payout</Button>}
        {finalised && !line.self && (line.action === "process" || line.action === "hold_payout") && d.run.status !== "paid" && (
          <section aria-label="Paid outside erp" className="rounded-md border border-border p-3">
            <h3 className="mb-2 text-base font-semibold">Paid another way</h3>
            <Field label="How it was paid"><Input value={paidNote} onChange={(e) => setPaidNote(e.target.value)} maxLength={200} placeholder="Cheque or transfer reference" /></Field>
            <Button className="mt-3" size="sm" variant="secondary" disabled={!paidNote.trim()} loading={pending} onClick={() => start(async () => { await act(A.paidOutsideAction(line.id, paidNote), "Marked paid outside erp"); })}>Mark paid outside erp</Button>
          </section>
        )}
        {line.self && <p className="text-sm text-text-muted">This is your own pay, so another payroll admin has to make any changes to it.</p>}
      </div>
    </Drawer>
  );
}

/** Per-line statutory breakdown: how PF, ESI, PT, LWF and TDS were worked out, plus the Labour Codes wages check. */
function StatutoryBreakdown({ line }: { line: LineRow }) {
  const s = line.statutory;
  if (!s) return null;
  const row = (k: string, v: React.ReactNode) => <div key={k} className="flex justify-between gap-3 py-0.5 text-sm"><dt className="text-text-muted">{k}</dt><dd className="tabular">{v}</dd></div>;
  const lc = s.labourCode;
  return (
    <section aria-label="Statutory breakdown" className="rounded-md border border-border p-3">
      <h3 className="mb-2 text-base font-semibold">Statutory breakdown</h3>
      <p className="mb-2 text-xs text-text-muted">Rates from Settings → Payroll → Statutory rates, not yet CA-verified unless your company recorded a check.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <dl><h4 className="mb-1 text-sm font-medium">Provident fund</h4>
          {!s.pf ? <p className="text-sm text-text-muted">Not covered.</p> : <>{row("PF wages", money(s.pf.wagePaise))}{row("Employee 12%", money(s.pf.employeePaise))}{row("Employer: EPS", money(s.pf.epsPaise))}{row("Employer: EPF", money(s.pf.epfPaise))}{row("EDLI", money(s.pf.edliPaise))}{row("Admin charge", money(s.pf.adminPaise))}</>}</dl>
        <dl><h4 className="mb-1 text-sm font-medium">ESI</h4>
          {!s.esi ? <p className="text-sm text-text-muted">Not covered.</p> : <>{row("ESI wages", money(s.esi.wagePaise))}{row("Covered", s.esi.covered ? "Yes" : "No (above the wage ceiling)")}{row("Employee", money(s.esi.employeePaise))}{row("Employer", money(s.esi.employerPaise))}</>}</dl>
        <dl><h4 className="mb-1 text-sm font-medium">Professional tax</h4>
          {!s.pt ? <p className="text-sm text-text-muted">None.</p> : <>{row("State", s.pt.state ?? "Not set")}{row("Gross for PT", money(s.pt.grossPaise))}{row("This month", money(s.pt.amountPaise))}{row("Due this month", s.pt.due ? "Yes" : "No")}</>}</dl>
        <dl><h4 className="mb-1 text-sm font-medium">Labour welfare fund</h4>
          {!s.lwf ? <p className="text-sm text-text-muted">None for this state or month.</p> : <>{row("Employee", money(s.lwf.employeePaise))}{row("Employer", money(s.lwf.employerPaise))}</>}</dl>
      </div>
      {row("Taxable salary this month", money(s.taxablePaise))}
      {lc && (
        <p className={cn("mt-2 text-sm", lc.ok ? "text-text-muted" : "text-warning-text")}>
          Labour Codes check: wages {money(lc.wagesPaise)} of {money(lc.remunerationPaise)} remuneration ({lc.pct ?? 0}%){lc.ok ? ", at least half." : `: ${money(lc.shortfallPaise)} short of the 50% the Code on Wages expects.`}
        </p>
      )}
      {Object.keys(s.overrides ?? {}).length > 0 && <p className="mt-1 text-sm text-text-muted">Overrides this month: {Object.entries(s.overrides).map(([k, v]) => `${OVERRIDE_LABEL[k] ?? k} ${money(v as number)}`).join(", ")}.</p>}
    </section>
  );
}

type ImportPreview = { valid: boolean; total: number; toAdd: number; alreadyAdded: number; results: { rowNumber: number; employee: string; name: string | null; kindLabel: string | null; amountPaise: number | null; days: number | null; note: string | null; existing: boolean; errors: string[] }[] };

/** Excel import of this month's inputs: template → fill → check → save. Re-uploading a file adds nothing twice. */
function ImportInputsDialog({ d, onClose }: { d: RunData; onClose: () => void }) {
  const [file, setFile] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState<ImportPreview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [checking, startCheck] = React.useTransition();
  const [saving, startSave] = React.useTransition();
  const choose = (f: File | undefined) => {
    setError(null); setPreview(null); setFile(null);
    if (!f) return;
    if (!/\.xlsx$/i.test(f.name)) { setError("Choose an Excel .xlsx file."); return; }
    if (f.size > 5 * 1024 * 1024) { setError("The file is larger than 5 MB."); return; }
    setFile(f);
    const fd = new FormData(); fd.set("file", f);
    startCheck(async () => { const r = await A.previewInputsAction(d.run.id, fd); if (r.ok) setPreview(r.data!); else setError(r.error); });
  };
  const commit = () => startSave(async () => {
    const fd = new FormData(); fd.set("file", file!);
    const r = await A.commitInputsAction(d.run.id, fd, d.run.lock_version);
    if (!r.ok) { setError(r.error); return; }
    toast.success(r.data!.added ? `${r.data!.added} ${r.data!.added === 1 ? "input" : "inputs"} added` : "Nothing new to add", { description: r.data!.added ? "Recalculate to see them in the numbers." : "Every row was already in this run." });
    onClose();
  });
  const bad = preview?.results.filter((r) => r.errors.length) ?? [], good = preview?.results.filter((r) => !r.errors.length) ?? [];
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="lg" title={`Import inputs for ${d.run.label}`} description="Bonuses, one-time payments and deductions, overtime, leave encashment and payable units for many people from one Excel file."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={commit} loading={saving} disabled={!preview?.valid || checking || !preview?.toAdd}>{preview?.valid ? `Add ${preview.toAdd} ${preview.toAdd === 1 ? "input" : "inputs"}` : "Add"}</Button></>}>
      <div className="flex flex-col gap-4">
        <ol className="list-decimal space-y-1 pl-5 text-base text-text-muted">
          <li><a href={`/payroll/runs/${d.run.id}/export/inputs-template`} download className="text-accent-text underline-offset-4 hover:underline">Download the template</a>. It lists everyone in the pay group.</li>
          <li>One row per payment, deduction or units entry: pick the kind, enter the amount or units, add a note for the payslip.</li>
          <li>Upload it here. erp checks every row before saving anything, and skips rows it already has.</li>
        </ol>
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-border-strong px-6 py-8 text-center hover:border-accent hover:bg-accent-soft/40 focus-within:outline-2 focus-within:outline-focus">
          {file ? <FileSpreadsheet className="size-6 text-accent-text" aria-hidden /> : <Upload className="size-6 text-accent-text" aria-hidden />}
          <span className="text-base font-medium">{file ? file.name : "Choose the filled file"}</span>
          <span className="text-sm text-text-muted">.xlsx, up to 5 MB</span>
          <input type="file" accept=".xlsx" className="sr-only" onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        {error && <Banner tone="danger">{error}</Banner>}
        {checking && <div className="flex flex-col gap-2" aria-busy aria-label="Checking the file"><Skeleton className="h-6 w-1/2" /><Skeleton className="h-24" /></div>}
        {preview && !checking && (preview.valid
          ? <Banner tone="success" title={preview.toAdd ? `${preview.toAdd} of ${preview.total} rows are new` : "Every row is already in this run"}>{preview.alreadyAdded ? `${preview.alreadyAdded} already added and skipped.` : "Nothing is saved until you choose Add."}</Banner>
          : <Banner tone="danger" title={`${bad.length} of ${preview.total} rows need fixing`}>Nothing is saved until every row is valid.</Banner>)}
        {preview && preview.results.length > 0 && (
          <div className="max-h-72 overflow-auto rounded-md border border-border">
            <table className="w-full text-base">
              <caption className="sr-only">Rows in the file</caption>
              <thead className="sticky top-0 bg-surface-sunken text-left text-sm text-text-muted"><tr><th className="px-3 py-2 font-medium">Row</th><th className="px-3 py-2 font-medium">Person</th><th className="px-3 py-2 font-medium">Result</th></tr></thead>
              <tbody>
                {[...bad, ...good].map((r) => (
                  <tr key={r.rowNumber} className="border-t border-border align-top">
                    <td className="px-3 py-2 tabular text-text-muted">{r.rowNumber}</td>
                    <td className="px-3 py-2">{r.name ?? (r.employee || "—")}</td>
                    <td className="px-3 py-2">{r.errors.length ? (
                      <ul className="flex flex-col gap-0.5 text-sm text-danger-text">{r.errors.map((e) => <li key={e} className="flex gap-1"><XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />{e}</li>)}</ul>
                    ) : (
                      <span className="flex flex-wrap items-center gap-1 text-sm"><CheckCircle2 className="size-3.5 text-success-text" aria-hidden />{r.kindLabel}{r.amountPaise != null ? ` · ${money(r.amountPaise)}` : ""}{r.days != null ? ` · ${r.days} ${r.kindLabel?.startsWith("Payable") ? "units" : "days"}` : ""}{r.note ? ` · ${r.note}` : ""}{r.existing && <Badge>Already added</Badge>}</span>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}
