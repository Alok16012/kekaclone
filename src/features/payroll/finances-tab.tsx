"use client";
import * as React from "react";
import { Banknote, Clock3, Landmark, Pencil, Plus, ShieldCheck, Trash2, TrendingUp, Wallet } from "lucide-react";
import { Button, IconButton } from "@/ui/button";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { Switch } from "@/ui/choice";
import { ConfirmDialog, Modal } from "@/ui/overlay";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { deleteSalaryAction, saveBankAction, saveSalaryAction, saveStatutoryAction } from "@/app/(app)/people/[id]/finance-actions";
import { computeBreakup, isAccountNumber, isIfsc, type Calc, type ComponentKind } from "@/server/modules/payroll/rules";
import { fmtDate, fmtMonth, KIND_LABEL, money, REASON_LABEL, rupeesToPaise } from "./labels";

type Line = { code: string; name: string; kind: ComponentKind; monthlyPaise: number };
type StructureOpt = { id: string; name: string; pay_group: string; lines: { code: string; name: string; kind: ComponentKind; calc: Calc; value: string | null; formula: string | null }[] };
export type FinancesData = {
  self: boolean; canEdit: boolean; name: string;
  current: { id: string; structureId: string; structureName: string; ctcPaise: number; effectiveFrom: string; reason: string; arrearsFromMonth: string | null; lines: Line[] } | null;
  upcoming: { effectiveFrom: string; ctcPaise: number }[];
  history: { id: string; effectiveFrom: string; ctcPaise: number; reason: string; structureName: string; arrearsFromMonth: string | null; status: string; deletable: boolean }[];
  pending: { id: string; effectiveFrom: string; ctcPaise: number; reason: string; structureName: string; arrearsFromMonth: string | null; createdAt: string; requestedBy: string | null; waitingOn: string | null }[];
  revisionsNeedApproval: boolean;
  statutory: { pfEnabled: boolean; uan: string | null; pfNumber: string | null; pfOnFullWage: boolean; esiEnabled: boolean; esiNumber: string | null; ptState: string | null; ptStateSource: "profile" | "location" | null; ptStateOverride: string | null; locationState: string | null; lwfState: string | null; taxRegime: "old" | "new" };
  bank: { bankName: string; ifsc: string; last4: string; holderName: string; updatedAt: string } | null;
  payGroup: { id: string; name: string } | null;
  structures: StructureOpt[];
  states: { code: string; name: string }[];
  today: string;
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,11rem)_1fr] gap-3 py-2">
      <dt className="text-sm text-text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-base">{value ?? <span className="text-text-muted">Not added</span>}</dd>
    </div>
  );
}

export function FinancesTab({ employeeId, d }: { employeeId: string; d: FinancesData }) {
  const [revising, setRevising] = React.useState(false);
  const [bank, setBank] = React.useState(false);
  const [stat, setStat] = React.useState(false);
  const stateName = (c: string | null) => (c ? d.states.find((s) => s.code === c)?.name ?? c : null);
  const earnings = d.current?.lines.filter((l) => l.kind !== "employer_contribution") ?? [];
  const employer = d.current?.lines.filter((l) => l.kind === "employer_contribution") ?? [];
  const gross = earnings.reduce((t, l) => t + l.monthlyPaise, 0);
  const editBtn = (label: string, onClick: () => void) => d.canEdit ? <Button variant="ghost" size="sm" onClick={onClick} aria-label={label}><Pencil />Edit</Button> : undefined;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader title={d.self ? "My salary" : "Salary"} description={d.current ? `${d.current.structureName}${d.payGroup ? ` · ${d.payGroup.name} pay group` : ""} · since ${fmtDate(d.current.effectiveFrom)}` : undefined}
          action={d.canEdit ? <Button size="sm" onClick={() => setRevising(true)}>{d.history.length ? <><TrendingUp />Revise salary</> : <><Plus />Assign salary</>}</Button> : undefined} />
        <CardBody className="flex flex-col gap-4">
          {d.upcoming.map((u) => <Banner key={u.effectiveFrom} tone="info" title={`New CTC of ${money(u.ctcPaise)} from ${fmtDate(u.effectiveFrom)}`}>{d.self ? "Your breakup updates on that date." : "Scheduled; it takes effect on that date."}</Banner>)}
          {!d.self && d.pending.map((u) => (
            <Banner key={u.id} tone="warning" title={`Revision to ${money(u.ctcPaise)} from ${fmtDate(u.effectiveFrom)} is waiting for approval`}
              action={d.canEdit ? <ConfirmDialog title="Withdraw this revision?" description="It leaves the approver's inbox and isn't applied." confirmLabel="Withdraw"
                onConfirm={async () => { const r = await deleteSalaryAction(u.id); if (r.ok) toast.success("Revision withdrawn"); else toast.error(r.error); }}
                trigger={<Button size="sm" variant="ghost">Withdraw</Button>} /> : undefined}>
              {REASON_LABEL[u.reason] ?? u.reason} · {u.structureName}{u.requestedBy ? ` · raised by ${u.requestedBy}` : ""}{u.waitingOn ? ` · with ${u.waitingOn}` : ""}{u.arrearsFromMonth ? ` · arrears from ${fmtMonth(u.arrearsFromMonth)} once approved` : ""}
            </Banner>
          ))}
          {!d.current ? (
            <EmptyState compact icon={<Wallet />} title={d.self ? "Your salary hasn't been set up yet" : "No salary yet"}
              description={d.self ? "Your payroll team adds it. Ask them if you think it's missing." : d.canEdit ? "Assign a CTC on one of the pay group's salary structures." : undefined} />
          ) : (
            <>
              <div className="flex flex-wrap gap-6">
                <div><p className="text-sm text-text-muted">Annual CTC</p><p className="text-2xl font-semibold tabular">{money(d.current.ctcPaise)}</p></div>
                <div><p className="text-sm text-text-muted">Monthly gross</p><p className="text-2xl font-semibold tabular">{money(gross)}</p></div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-base">
                  <caption className="sr-only">Salary breakup</caption>
                  <thead className="text-left text-sm text-text-muted"><tr><th className="py-1.5 font-medium">Component</th><th className="py-1.5 text-right font-medium">Monthly</th><th className="py-1.5 text-right font-medium">Yearly</th></tr></thead>
                  <tbody>
                    {earnings.map((l) => <tr key={l.code} className="border-t border-border"><td className="py-1.5">{l.name}</td><td className="py-1.5 text-right tabular">{money(l.monthlyPaise)}</td><td className="py-1.5 text-right tabular text-text-muted">{money(l.monthlyPaise * 12)}</td></tr>)}
                    <tr className="border-t border-border-strong font-medium"><td className="py-1.5">Gross</td><td className="py-1.5 text-right tabular">{money(gross)}</td><td className="py-1.5 text-right tabular">{money(gross * 12)}</td></tr>
                    {employer.map((l) => <tr key={l.code} className="border-t border-border"><td className="py-1.5">{l.name}<span className="block text-xs text-text-muted">{KIND_LABEL[l.kind]}</span></td><td className="py-1.5 text-right tabular">{money(l.monthlyPaise)}</td><td className="py-1.5 text-right tabular text-text-muted">{money(l.monthlyPaise * 12)}</td></tr>)}
                    <tr className="border-t border-border-strong font-semibold"><td className="py-1.5">Cost to company</td><td className="py-1.5 text-right tabular">{money(gross + employer.reduce((t, l) => t + l.monthlyPaise, 0))}</td><td className="py-1.5 text-right tabular">{money((gross + employer.reduce((t, l) => t + l.monthlyPaise, 0)) * 12)}</td></tr>
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-text-muted">Deductions such as PF, professional tax and income tax are worked out each month on {d.self ? "your" : "the"} payslip.</p>
            </>
          )}
        </CardBody>
      </Card>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader title="Bank account" action={editBtn("Edit bank account", () => setBank(true))} />
          <CardBody>
            {d.bank ? (
              <dl className="divide-y divide-border">
                <Row label="Bank" value={d.bank.bankName} />
                <Row label="Account" value={<span className="tabular">•••• {d.bank.last4}</span>} />
                <Row label="IFSC" value={<span className="font-mono">{d.bank.ifsc}</span>} />
                <Row label="Name on account" value={d.bank.holderName} />
              </dl>
            ) : <EmptyState compact icon={<Landmark />} title="No bank account" description={d.self ? "Your payroll team adds the account your salary goes to." : undefined} />}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Statutory details" action={editBtn("Edit statutory details", () => setStat(true))} />
          <CardBody>
            <dl className="divide-y divide-border">
              <Row label="Provident fund" value={d.statutory.pfEnabled ? `Yes${d.statutory.pfOnFullWage ? ", on full basic" : ""}` : "Not covered"} />
              <Row label="UAN" value={d.statutory.uan && <span className="tabular">{d.statutory.uan}</span>} />
              {d.statutory.pfNumber && <Row label="PF number" value={<span className="font-mono">{d.statutory.pfNumber}</span>} />}
              <Row label="ESI" value={d.statutory.esiEnabled ? (d.statutory.esiNumber ? <span className="tabular">{d.statutory.esiNumber}</span> : "Covered when eligible") : "Not covered"} />
              <Row label="Professional tax state" value={d.statutory.ptState ? `${stateName(d.statutory.ptState)}${d.statutory.ptStateSource === "location" ? " (from work location)" : ""}` : null} />
              <Row label="Tax regime" value={d.statutory.taxRegime === "new" ? "New regime" : "Old regime"} />
            </dl>
          </CardBody>
        </Card>
      </div>

      <Card className="lg:col-span-3">
        <CardHeader title="Salary history" />
        {d.history.length === 0 ? <EmptyState compact icon={<Clock3 />} title="No salary records yet" /> : (
          <ul className="divide-y divide-border border-t border-border">
            {d.history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
                <Banknote className="size-4 text-text-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-base font-medium tabular">{money(h.ctcPaise)} <span className="font-normal text-text-muted">a year</span></p>
                  <p className="text-sm text-text-muted">{REASON_LABEL[h.reason] ?? h.reason} · from {fmtDate(h.effectiveFrom)} · {h.structureName}</p>
                </div>
                {h.status === "current" && <Badge tone="success">Current</Badge>}
                {h.status === "upcoming" && <Badge tone="accent">Upcoming</Badge>}
                {h.arrearsFromMonth && !d.self && <Badge tone="warning">Arrears from {fmtMonth(h.arrearsFromMonth)}</Badge>}
                {h.deletable && (
                  <ConfirmDialog title="Delete this salary record?" description={`The ${money(h.ctcPaise)} CTC from ${fmtDate(h.effectiveFrom)} will be removed. The previous one applies again.`} confirmLabel="Delete"
                    onConfirm={async () => { const r = await deleteSalaryAction(h.id); if (r.ok) toast.success("Salary record deleted"); else toast.error(r.error); }}
                    trigger={<IconButton label={`Delete the salary from ${fmtDate(h.effectiveFrom)}`} size="icon-sm" variant="ghost"><Trash2 /></IconButton>} />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {revising && <ReviseDialog employeeId={employeeId} d={d} onClose={() => setRevising(false)} />}
      {bank && <BankDialog employeeId={employeeId} d={d} onClose={() => setBank(false)} />}
      {stat && <StatutoryDialog employeeId={employeeId} d={d} onClose={() => setStat(false)} />}
    </div>
  );
}

function ReviseDialog({ employeeId, d, onClose }: { employeeId: string; d: FinancesData; onClose: () => void }) {
  const first = d.history.length === 0;
  const [structureId, setStructure] = React.useState(d.current?.structureId && d.structures.some((s) => s.id === d.current!.structureId) ? d.current.structureId : d.structures[0]?.id ?? "");
  const [ctc, setCtc] = React.useState(d.current ? String(d.current.ctcPaise / 100) : "");
  const [from, setFrom] = React.useState(d.today);
  const [reason, setReason] = React.useState("revision");
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const ctcPaise = rupeesToPaise(ctc);
  const st = d.structures.find((s) => s.id === structureId);
  const preview = st && ctcPaise ? computeBreakup({ lines: st.lines }, ctcPaise) : null;
  const backdated = from && from.slice(0, 7) < d.today.slice(0, 7);
  const change = d.current && ctcPaise ? ((ctcPaise - d.current.ctcPaise) / d.current.ctcPaise) * 100 : null;
  const save = () => start(async () => {
    if (!ctcPaise) { setError({ message: "Enter the annual CTC, like 12,00,000.", field: "ctcPaise" }); return; }
    const r = await saveSalaryAction({ employeeId, structureId, ctcPaise, effectiveFrom: from, reason: first ? "joining" : reason });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success(r.data!.unchanged ? "Already saved" : r.data!.pendingApproval ? "Revision sent for approval" : first ? "Salary assigned" : "Salary revised",
      { description: r.data!.pendingApproval ? "It applies once the approver in Settings → Approvals says yes." : r.data!.arrearsFromMonth ? `Arrears from ${fmtMonth(r.data!.arrearsFromMonth)} will be paid in the next payroll.` : `${d.name} has been notified.` });
    onClose();
  });
  const fe = (f: string) => (error?.field === f ? error.message : undefined);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="lg" title={first ? `Assign salary to ${d.name}` : `Revise ${d.name}'s salary`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save} disabled={!d.structures.length || !preview?.ok}>{first ? "Assign salary" : "Save revision"}</Button></>}>
      {!d.structures.length ? (
        <EmptyState compact icon={<Wallet />} title="No salary structure to use" description={d.payGroup ? `Add a structure to the ${d.payGroup.name} pay group first.` : "Add a pay group and a salary structure in Settings → Payroll first."} />
      ) : (
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
          {error && !["ctcPaise", "effectiveFrom", "structureId"].includes(error.field ?? "") && <Banner tone="danger">{error.message}</Banner>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Annual CTC (₹)" required error={fe("ctcPaise")} help={change != null && Number.isFinite(change) ? `${change >= 0 ? "+" : ""}${change.toFixed(1)}% on today's ${money(d.current!.ctcPaise)}` : undefined}>
              <Input inputMode="decimal" value={ctc} onChange={(e) => setCtc(e.target.value)} autoFocus className="tabular" placeholder="12,00,000" />
            </Field>
            <Field label="Takes effect from" required error={fe("effectiveFrom")} help={`${backdated ? "In a past month: the difference is paid as arrears." : "Future dates are fine."}${!first && d.revisionsNeedApproval ? " Revisions go through approval first." : ""}`}>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="Salary structure" required error={fe("structureId")}>
              <Select value={structureId} onValueChange={setStructure} options={d.structures.map((s) => ({ value: s.id, label: `${s.name} · ${s.pay_group}` }))} />
            </Field>
            {!first && <Field label="Reason"><Select value={reason} onValueChange={setReason} options={["revision", "promotion", "correction"].map((r) => ({ value: r, label: REASON_LABEL[r] }))} /></Field>}
          </div>
          {preview && (preview.ok ? (
            <div className="rounded-md border border-border">
              <table className="w-full text-base">
                <caption className="px-3 pt-2 text-left text-sm font-medium">Monthly breakup</caption>
                <tbody>
                  {preview.lines.map((l) => <tr key={l.code} className="border-t border-border first:border-t-0"><td className="px-3 py-1.5">{l.name}</td><td className="px-3 py-1.5 text-right tabular">{money(l.monthlyPaise)}</td></tr>)}
                  <tr className="border-t border-border-strong font-semibold"><td className="px-3 py-1.5">Monthly CTC</td><td className="px-3 py-1.5 text-right tabular">{money(preview.monthlyCtcPaise)}</td></tr>
                </tbody>
              </table>
            </div>
          ) : <Banner tone="danger">{preview.errors[0].message}</Banner>)}
          <button type="submit" hidden />
        </form>
      )}
    </Modal>
  );
}

function BankDialog({ employeeId, d, onClose }: { employeeId: string; d: FinancesData; onClose: () => void }) {
  const [v, setV] = React.useState({ bankName: d.bank?.bankName ?? "", ifsc: d.bank?.ifsc ?? "", accountNumber: "", confirm: "", holderName: d.bank?.holderName ?? d.name });
  const set = <K extends keyof typeof v>(k: K, x: string) => setV((s) => ({ ...s, [k]: x }));
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const ifscBad = v.ifsc.length >= 11 && !isIfsc(v.ifsc);
  const acctBad = v.accountNumber.length > 0 && !isAccountNumber(v.accountNumber);
  const mismatch = v.confirm.length > 0 && v.confirm.replace(/\s/g, "") !== v.accountNumber.replace(/\s/g, "");
  const save = () => start(async () => {
    if (v.confirm.replace(/\s/g, "") !== v.accountNumber.replace(/\s/g, "")) { setError({ message: "The account numbers don't match.", field: "confirm" }); return; }
    const r = await saveBankAction(employeeId, { bankName: v.bankName, ifsc: v.ifsc, accountNumber: v.accountNumber, holderName: v.holderName });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success("Bank account saved", { description: `${d.name} has been told about the change.` });
    onClose();
  });
  const fe = (f: string) => (error?.field === f ? error.message : undefined);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={d.bank ? "Change bank account" : "Add bank account"} description="Salary is paid into this account. Only the last 4 digits are shown after saving."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>Save account</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }} autoComplete="off">
        {error && !["bankName", "ifsc", "accountNumber", "confirm", "holderName"].includes(error.field ?? "") && <Banner tone="danger">{error.message}</Banner>}
        <Field label="Bank name" required error={fe("bankName")}><Input value={v.bankName} onChange={(e) => set("bankName", e.target.value)} maxLength={80} placeholder="HDFC Bank" /></Field>
        <Field label="IFSC" required error={fe("ifsc") ?? (ifscBad ? "IFSC codes look like HDFC0001234: 4 letters, a zero, then 6 letters or digits." : undefined)}>
          <Input value={v.ifsc} onChange={(e) => set("ifsc", e.target.value.toUpperCase().replace(/\s/g, ""))} maxLength={11} className="font-mono uppercase" placeholder="HDFC0001234" />
        </Field>
        <Field label="Account number" required error={fe("accountNumber") ?? (acctBad ? "Account numbers are 9 to 18 digits." : undefined)}>
          <Input value={v.accountNumber} onChange={(e) => set("accountNumber", e.target.value.replace(/[^\d\s]/g, ""))} inputMode="numeric" maxLength={22} className="tabular" autoComplete="off" />
        </Field>
        <Field label="Account number again" required error={fe("confirm") ?? (mismatch ? "The account numbers don't match." : undefined)}>
          <Input value={v.confirm} onChange={(e) => set("confirm", e.target.value.replace(/[^\d\s]/g, ""))} inputMode="numeric" maxLength={22} className="tabular" autoComplete="off" onPaste={(e) => e.preventDefault()} />
        </Field>
        <Field label="Name on the account" required error={fe("holderName")}><Input value={v.holderName} onChange={(e) => set("holderName", e.target.value)} maxLength={120} /></Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function StatutoryDialog({ employeeId, d, onClose }: { employeeId: string; d: FinancesData; onClose: () => void }) {
  const s = d.statutory;
  const [v, setV] = React.useState({ pfEnabled: s.pfEnabled, uan: s.uan ?? "", pfNumber: s.pfNumber ?? "", pfOnFullWage: s.pfOnFullWage, esiEnabled: s.esiEnabled, esiNumber: s.esiNumber ?? "", ptState: s.ptStateOverride ?? "location", taxRegime: s.taxRegime });
  const set = <K extends keyof typeof v>(k: K, x: (typeof v)[K]) => setV((p) => ({ ...p, [k]: x }));
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    const r = await saveStatutoryAction(employeeId, { ...v, uan: v.uan || null, pfNumber: v.pfNumber || null, esiNumber: v.esiNumber || null, ptState: v.ptState === "location" ? null : v.ptState, lwfState: null });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success("Statutory details saved");
    onClose();
  });
  const fe = (f: string) => (error?.field === f ? error.message : undefined);
  const loc = d.states.find((x) => x.code === s.locationState)?.name;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Statutory details" description={d.name}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}><ShieldCheck />Save</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && !["uan", "pfNumber", "esiNumber", "ptState"].includes(error.field ?? "") && <Banner tone="danger">{error.message}</Banner>}
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-medium">Provident fund</legend>
          <Switch label="Covered by PF" checked={v.pfEnabled} onCheckedChange={(c) => set("pfEnabled", c)} />
          {v.pfEnabled && <Switch label="Contribute on full basic (above the wage ceiling)" checked={v.pfOnFullWage} onCheckedChange={(c) => set("pfOnFullWage", c)} />}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="UAN" error={fe("uan")} help="12 digits"><Input value={v.uan} onChange={(e) => set("uan", e.target.value.replace(/\D/g, ""))} inputMode="numeric" maxLength={12} className="tabular" /></Field>
            <Field label="PF number" error={fe("pfNumber")}><Input value={v.pfNumber} onChange={(e) => set("pfNumber", e.target.value.toUpperCase())} maxLength={26} className="font-mono uppercase" /></Field>
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-medium">ESI</legend>
          <Switch label="Covered by ESI when eligible" checked={v.esiEnabled} onCheckedChange={(c) => set("esiEnabled", c)} />
          <Field label="ESI number" error={fe("esiNumber")} help="10 digits"><Input value={v.esiNumber} onChange={(e) => set("esiNumber", e.target.value.replace(/\D/g, ""))} inputMode="numeric" maxLength={10} className="tabular sm:max-w-52" /></Field>
        </fieldset>
        <Field label="Professional tax state" error={fe("ptState")}>
          <Select value={v.ptState} onValueChange={(x) => set("ptState", x)}
            options={[{ value: "location", label: loc ? `Same as work location (${loc})` : "Same as work location (not set)" }, ...d.states.map((x) => ({ value: x.code, label: x.name }))]} />
        </Field>
        <Field label="Income tax regime">
          <Select value={v.taxRegime} onValueChange={(x) => set("taxRegime", x as "old" | "new")} options={[{ value: "new", label: "New regime" }, { value: "old", label: "Old regime" }]} />
        </Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
