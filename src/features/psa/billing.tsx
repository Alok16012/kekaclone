"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Download, FileText, Plus, Receipt } from "lucide-react";
import { Card, CardHeader, StatTile } from "@/ui/card";
import { Button } from "@/ui/button";
import { StatusChip } from "@/ui/badge";
import { Drawer, Modal } from "@/ui/overlay";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Checkbox } from "@/ui/choice";
import { Banner, EmptyState, Skeleton } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { createInvoiceAction, invoiceCandidateAction, invoiceDetailAction, setInvoiceStatusAction } from "@/app/(app)/psa/actions";
import { BILLING_LABEL, formatINR, hours, INVOICE_STATUS_LABEL, type BillingModel, type InvoiceLine, type InvoiceStatus } from "@/server/modules/psa/rules";
import type { InvoiceCandidate, InvoiceDetail } from "@/server/modules/psa/service";

export type InvoiceListRow = { id: string; number: string; client: string; project: string | null; period_from: string; period_to: string; subtotal_paise: number; tax_paise: number; status: InvoiceStatus; issued_on: string | null; due_on: string | null; paid_on: string | null };
export type BillableProject = { id: string; name: string; code: string; billing_model: BillingModel; client: string | null; uninvoiced_minutes: number };
type Candidate = InvoiceCandidate;
type DetailDTO = Omit<InvoiceDetail, "subtotal_paise" | "tax_paise" | "created_at"> & { subtotal_paise: number; tax_paise: number; created_at: string };
const CHIP: Record<InvoiceStatus, "draft" | "pending" | "approved" | "cancelled"> = { draft: "draft", sent: "pending", paid: "approved", void: "cancelled" };
const rupees = (paise: number) => `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
const fmt = (d: string | null) => (d ? new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "–");

/** S131: invoices from approved billable hours, retainers or finished milestones. Numbered, with GST, as PDF. */
export function Billing({ invoices, projects, canBill, initialProject, today }: { invoices: InvoiceListRow[]; projects: BillableProject[]; canBill: boolean; initialProject: string | null; today: string }) {
  const [creating, setCreating] = React.useState(!!initialProject);
  const [open, setOpen] = React.useState<InvoiceListRow | null>(null);
  const outstanding = invoices.filter((i) => i.status === "sent").reduce((t, i) => t + i.subtotal_paise + i.tax_paise, 0);
  const paid = invoices.filter((i) => i.status === "paid").reduce((t, i) => t + i.subtotal_paise + i.tax_paise, 0);
  const toInvoice = projects.reduce((t, p) => t + p.uninvoiced_minutes, 0);
  return (
    <div className="flex flex-col gap-4">
      {!canBill && <Banner tone="info" title="View only">Only people with billing access raise and update invoices.</Banner>}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Outstanding" value={rupees(outstanding)} hint="sent, not yet paid" />
        <StatTile label="Paid" value={rupees(paid)} />
        <StatTile label="Invoices" value={invoices.length} icon={<Receipt />} />
        <StatTile label="Hours to invoice" value={hours(toInvoice)} hint="approved, billable, T&M" />
      </div>
      <Card>
        <CardHeader title="Invoices" description="Draft → sent → paid. Void a wrong invoice to release its hours." action={canBill ? <Button size="sm" onClick={() => setCreating(true)}><Plus />New invoice</Button> : undefined} />
        {invoices.length === 0 ? <EmptyState compact icon={<FileText />} title="No invoices yet" description="Approve some timesheets, then raise an invoice from the hours." /> : (
          <ul className="divide-y divide-border border-t border-border">
            {invoices.map((i) => (
              <li key={i.id}>
                <button type="button" onClick={() => setOpen(i)} className="flex w-full flex-col gap-1 px-5 py-3 text-left hover:bg-surface-hover sm:flex-row sm:items-center sm:gap-3">
                  <span className="w-24 font-medium tabular">{i.number}</span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-base">{i.client}{i.project ? ` · ${i.project}` : ""}</span><span className="block text-sm text-text-muted">{fmt(i.period_from)} – {fmt(i.period_to)} · due {fmt(i.due_on)}</span></span>
                  <span className="font-medium tabular">{formatINR(i.subtotal_paise + i.tax_paise)}</span>
                  <StatusChip status={CHIP[i.status]} label={INVOICE_STATUS_LABEL[i.status]} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {creating && <NewInvoice projects={projects} initialProject={initialProject} today={today} onClose={() => setCreating(false)} />}
      <InvoiceDrawer row={open} canBill={canBill} onClose={() => setOpen(null)} />
    </div>
  );
}

function NewInvoice({ projects, initialProject, today, onClose }: { projects: BillableProject[]; initialProject: string | null; today: string; onClose: () => void }) {
  const router = useRouter();
  const monthStart = today.slice(0, 8) + "01";
  const [f, setF] = React.useState({ projectId: initialProject && projects.some((p) => p.id === initialProject) ? initialProject : (projects[0]?.id ?? ""), from: monthStart, to: today, taxRate: "18", dueInDays: "15", notes: "", milestoneIds: [] as string[] });
  const [cand, setCand] = React.useState<Candidate | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, start] = React.useTransition();
  const taxBp = Math.round(Number(f.taxRate) * 100) || 0;
  React.useEffect(() => {
    if (!f.projectId || !f.from || !f.to) return;
    let live = true;
    invoiceCandidateAction({ projectId: f.projectId, from: f.from, to: f.to, taxRateBp: taxBp, milestoneIds: f.milestoneIds }).then((r) => {
      if (!live) return;
      if (r.ok) { setCand(r.data ?? null); setError(null); } else { setCand(null); setError(r.error); }
    });
    return () => { live = false; };
  }, [f.projectId, f.from, f.to, taxBp, f.milestoneIds]);
  const create = () => start(async () => {
    const r = await createInvoiceAction({ projectId: f.projectId, from: f.from, to: f.to, taxRateBp: taxBp, milestoneIds: f.milestoneIds, notes: f.notes || null, dueInDays: Number(f.dueInDays) || 0 });
    if (!r.ok) { setError(r.error); return; }
    toast.success(`${r.data?.number} created`, { description: "It's a draft until you mark it sent." });
    onClose(); router.replace("/psa/billing");
  });
  const project = projects.find((p) => p.id === f.projectId);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="New invoice" size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={create} loading={busy} disabled={!cand || cand.preview.subtotal <= 0}>Create draft</Button></>}>
      <div className="flex flex-col gap-4">
        {projects.length === 0 && <Banner tone="info">No billable projects with a client yet.</Banner>}
        <Field label="Project"><Select value={f.projectId} onValueChange={(v) => setF({ ...f, projectId: v, milestoneIds: [] })} options={projects.map((p) => ({ value: p.id, label: `${p.code} · ${p.name} (${BILLING_LABEL[p.billing_model]})` }))} /></Field>
        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="From"><Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
          <Field label="To"><Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
          <Field label="GST %"><Input type="number" min={0} max={100} step="0.01" inputMode="decimal" value={f.taxRate} onChange={(e) => setF({ ...f, taxRate: e.target.value })} /></Field>
          <Field label="Due in (days)"><Input type="number" min={0} max={180} inputMode="numeric" value={f.dueInDays} onChange={(e) => setF({ ...f, dueInDays: e.target.value })} /></Field>
        </div>
        {error && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{error}</p>}
        {cand && (
          <div className="rounded-md border border-border">
            {project?.billing_model === "fixed" && (
              <div className="border-b border-border px-4 py-3">
                <p className="mb-2 text-sm font-medium">Milestones done and not yet invoiced</p>
                {cand.milestones.length === 0 ? <p className="text-sm text-text-muted">None yet. Mark a milestone done on the project first.</p> : cand.milestones.map((m) => (
                  <Checkbox key={m.id} label={`${m.name} · ${formatINR(Number(m.amount_paise))}`} checked={!f.milestoneIds.length || f.milestoneIds.includes(m.id)}
                    onCheckedChange={(c) => { const all = cand.milestones.map((x) => x.id); const cur = f.milestoneIds.length ? f.milestoneIds : all; setF({ ...f, milestoneIds: c ? [...new Set([...cur, m.id])] : cur.filter((x) => x !== m.id) }); }} />
                ))}
              </div>
            )}
            <Lines lines={cand.preview.lines} subtotal={cand.preview.subtotal} tax={cand.preview.tax} total={cand.preview.total} taxBp={taxBp} />
            {cand.preview.missingRates.length > 0 && <Banner tone="warning" className="m-3" title="Missing bill rates">{cand.preview.missingRates.join(", ")} have no rate on this project, so their hours come out as zero. Set rates on the project team and reopen this dialog.</Banner>}
            {cand.preview.lines.length === 0 && <p className="px-4 py-3 text-sm text-text-muted">Nothing to invoice for this period: no approved billable hours that aren&apos;t already on an invoice.</p>}
          </div>
        )}
        <Field label="Notes" help="Printed under the totals, e.g. payment terms or bank details."><Textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={1000} rows={2} /></Field>
      </div>
    </Modal>
  );
}

function Lines({ lines, subtotal, tax, total, taxBp }: { lines: InvoiceLine[]; subtotal: number; tax: number; total: number; taxBp: number }) {
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Invoice lines</caption>
      <thead className="text-text-muted"><tr><th scope="col" className="px-4 py-2 text-left font-medium">Description</th><th scope="col" className="px-2 py-2 text-right font-medium">Qty</th><th scope="col" className="px-2 py-2 text-right font-medium">Rate</th><th scope="col" className="px-4 py-2 text-right font-medium">Amount</th></tr></thead>
      <tbody>{lines.map((l, i) => <tr key={i} className="border-t border-border"><td className="px-4 py-2">{l.description}</td><td className="px-2 py-2 text-right tabular">{l.quantity}</td><td className="px-2 py-2 text-right tabular">{formatINR(l.unit_paise)}</td><td className="px-4 py-2 text-right tabular">{formatINR(l.amount_paise)}</td></tr>)}</tbody>
      <tfoot className="border-t border-border">
        <tr><td colSpan={3} className="px-4 py-1.5 text-right text-text-muted">Subtotal</td><td className="px-4 py-1.5 text-right tabular">{formatINR(subtotal)}</td></tr>
        <tr><td colSpan={3} className="px-4 py-1.5 text-right text-text-muted">GST {taxBp / 100}%</td><td className="px-4 py-1.5 text-right tabular">{formatINR(tax)}</td></tr>
        <tr className="font-semibold"><td colSpan={3} className="px-4 py-2 text-right">Total</td><td className="px-4 py-2 text-right tabular">{formatINR(total)}</td></tr>
      </tfoot>
    </table>
  );
}

function InvoiceDrawer({ row, canBill, onClose }: { row: InvoiceListRow | null; canBill: boolean; onClose: () => void }) {
  const [d, setD] = React.useState<{ id: string; data?: DetailDTO; error?: string } | null>(null);
  const [busy, start] = React.useTransition();
  React.useEffect(() => {
    if (!row) return;
    let live = true;
    invoiceDetailAction(row.id).then((r) => { if (live) setD(r.ok ? { id: row.id, data: r.data } : { id: row.id, error: r.error }); });
    return () => { live = false; };
  }, [row]);
  const detail = row && d?.id === row.id ? d : null;
  const move = (to: InvoiceStatus) => start(async () => {
    if (!row) return;
    const r = await setInvoiceStatusAction(row.id, to);
    if (r.ok) { toast.success(`${row.number} marked ${INVOICE_STATUS_LABEL[to].toLowerCase()}`); onClose(); } else toast.error(r.error);
  });
  return (
    <Drawer open={!!row} onOpenChange={(o) => !o && onClose()} title={row?.number ?? ""} description={row ? `${row.client}${row.project ? ` · ${row.project}` : ""}` : undefined}
      footer={row && <>
        <Button asChild variant="secondary"><a href={`/psa/billing/${row.id}/pdf`} target="_blank" rel="noopener"><Download />PDF</a></Button>
        {canBill && (row.status === "draft" || row.status === "sent") && <Button variant="danger" onClick={() => move("void")} loading={busy}>Void</Button>}
        {canBill && row.status === "draft" && <Button onClick={() => move("sent")} loading={busy}>Mark sent</Button>}
        {canBill && row.status === "sent" && <Button onClick={() => move("paid")} loading={busy}>Mark paid</Button>}
      </>}>
      {!detail ? <div className="flex flex-col gap-3"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-32" /></div>
        : detail.error || !detail.data ? <p className="text-base text-danger-text">{detail.error ?? "Couldn't load this invoice."}</p> : (
          <div className="flex flex-col gap-4">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-base">
              <div><dt className="text-sm text-text-muted">Status</dt><dd className="mt-1"><StatusChip status={CHIP[detail.data.status]} label={INVOICE_STATUS_LABEL[detail.data.status]} /></dd></div>
              <div><dt className="text-sm text-text-muted">Period</dt><dd className="font-medium">{fmt(detail.data.period_from)} – {fmt(detail.data.period_to)}</dd></div>
              <div><dt className="text-sm text-text-muted">Issued</dt><dd className="font-medium">{fmt(detail.data.issued_on)}</dd></div>
              <div><dt className="text-sm text-text-muted">{detail.data.paid_on ? "Paid" : "Due"}</dt><dd className="font-medium">{fmt(detail.data.paid_on ?? detail.data.due_on)}</dd></div>
            </dl>
            <div className="rounded-md border border-border"><Lines lines={detail.data.lines} subtotal={detail.data.subtotal_paise} tax={detail.data.tax_paise} total={detail.data.subtotal_paise + detail.data.tax_paise} taxBp={detail.data.tax_rate_bp} /></div>
            {detail.data.notes && <div><p className="text-sm text-text-muted">Notes</p><p className="mt-1 whitespace-pre-wrap rounded-md bg-surface-sunken px-3 py-2 text-base">{detail.data.notes}</p></div>}
          </div>
        )}
    </Drawer>
  );
}
