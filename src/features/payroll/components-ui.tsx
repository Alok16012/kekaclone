"use client";
import * as React from "react";
import { Coins, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/ui/button";
import { Card, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { Switch } from "@/ui/choice";
import { ConfirmDialog, Menu, Modal } from "@/ui/overlay";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { deleteComponentAction, saveComponentAction } from "@/app/(app)/settings/payroll/actions";
import { COMPONENT_KINDS, FREQUENCIES, type ComponentKind } from "@/server/modules/payroll/rules";
import { FREQ_LABEL, KIND_HINT, KIND_LABEL } from "./labels";

export type ComponentItem = {
  id: string; code: string; name: string; kind: ComponentKind; is_taxable: boolean; tax_section: string | null; lop_prorated: boolean;
  frequency: string; on_payslip: boolean; in_arrears: boolean; pf_wage: boolean; esi_wage: boolean; structures: number; used: boolean;
};

const TONE: Partial<Record<ComponentKind, "accent" | "warning" | "success" | "neutral">> = { earning: "success", deduction: "warning", employer_contribution: "accent" };

export function ComponentsAdmin({ rows }: { rows: ComponentItem[] }) {
  const [editing, setEditing] = React.useState<ComponentItem | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<ComponentItem | null>(null);
  return (
    <Card>
      <CardHeader title="Salary components" description="The building blocks of pay. Formulas refer to them by code, like [BASIC]."
        action={<Button size="sm" onClick={() => setEditing("new")}><Plus />Add component</Button>} />
      {rows.length === 0 ? (
        <EmptyState compact icon={<Coins />} title="No components yet" description="Add Basic, HRA and a special allowance to start a salary structure."
          action={<Button size="sm" onClick={() => setEditing("new")}><Plus />Add your first component</Button>} />
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-base font-medium">
                  <span className="truncate">{r.name}</span><Badge className="font-mono">{r.code}</Badge>
                  <Badge tone={TONE[r.kind] ?? "neutral"}>{KIND_LABEL[r.kind]}</Badge>
                </p>
                <p className="text-sm text-text-muted">
                  {[r.is_taxable ? "Taxable" : `Not taxable${r.tax_section ? ` (${r.tax_section})` : ""}`, FREQ_LABEL[r.frequency],
                    r.lop_prorated ? "reduced for unpaid days" : "paid in full", r.pf_wage && "counts for PF", r.esi_wage && "counts for ESI",
                    !r.on_payslip && "hidden on payslip", r.structures ? `on ${r.structures} ${r.structures === 1 ? "structure" : "structures"}` : null].filter(Boolean).join(" · ")}
                </p>
              </div>
              <Menu trigger={<IconButton label={`Actions for ${r.name}`} size="icon-sm" variant="ghost"><MoreHorizontal /></IconButton>}
                items={[{ label: "Edit", icon: <Pencil />, onSelect: () => setEditing(r) }, { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setDeleting(r) }]} />
            </li>
          ))}
        </ul>
      )}
      {editing && <ComponentDialog row={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting.name}?`}
          description={deleting.structures ? "It's on a salary structure. Remove it from every structure first." : deleting.used ? "People's salaries use it, so it can't be deleted." : "This can't be undone."}
          confirmLabel="Delete" onConfirm={async () => { const r = await deleteComponentAction(deleting.id); if (r.ok) toast.success(`${deleting.name} deleted`); else toast.error(r.error); setDeleting(null); }} />
      )}
    </Card>
  );
}

function ComponentDialog({ row, onClose }: { row: ComponentItem | null; onClose: () => void }) {
  const [v, setV] = React.useState({
    name: row?.name ?? "", code: row?.code ?? "", kind: row?.kind ?? ("earning" as ComponentKind), taxable: row?.is_taxable ?? true, taxSection: row?.tax_section ?? "",
    lopProrated: row?.lop_prorated ?? true, frequency: row?.frequency ?? "monthly", onPayslip: row?.on_payslip ?? true, inArrears: row?.in_arrears ?? true,
    pfWage: row?.pf_wage ?? false, esiWage: row?.esi_wage ?? true,
  });
  const set = <K extends keyof typeof v>(k: K, x: (typeof v)[K]) => setV((s) => ({ ...s, [k]: x }));
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const locked = !!row && (row.structures > 0 || row.used);
  const save = () => start(async () => {
    const r = await saveComponentAction(row?.id ?? null, { ...v, taxSection: v.taxSection || null });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success(row ? `${v.name} updated` : `${v.name} added`);
    onClose();
  });
  const fe = (f: string) => (error?.field === f ? error.message : undefined);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={row ? "Edit component" : "Add component"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>{row ? "Save" : "Add component"}</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && !["name", "code", "kind"].includes(error.field ?? "") && <Banner tone="danger">{error.message}</Banner>}
        <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
          <Field label="Name" required error={fe("name")}><Input value={v.name} onChange={(e) => set("name", e.target.value)} autoFocus maxLength={80} placeholder="House rent allowance" /></Field>
          <Field label="Code" required error={fe("code")} help={locked ? "In use, so it can't change" : "Used in formulas"}>
            <Input value={v.code} onChange={(e) => set("code", e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))} maxLength={31} placeholder="HRA" className="font-mono uppercase" readOnly={locked} />
          </Field>
        </div>
        <Field label="Type" required error={fe("kind")} help={KIND_HINT[v.kind]}>
          <Select value={v.kind} onValueChange={(k) => set("kind", k as ComponentKind)} disabled={locked}
            options={COMPONENT_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="How often it's paid"><Select value={v.frequency} onValueChange={(x) => set("frequency", x)} options={FREQUENCIES.map((f) => ({ value: f, label: FREQ_LABEL[f] }))} /></Field>
          {!v.taxable && <Field label="Exemption section" help="e.g. 10(13A) for HRA"><Input value={v.taxSection} onChange={(e) => set("taxSection", e.target.value)} maxLength={40} /></Field>}
        </div>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-medium">Rules</legend>
          <Switch label="Taxable income" checked={v.taxable} onCheckedChange={(c) => set("taxable", c)} />
          <Switch label="Reduce for unpaid days (loss of pay)" checked={v.lopProrated} onCheckedChange={(c) => set("lopProrated", c)} />
          <Switch label="Show on payslip" checked={v.onPayslip} onCheckedChange={(c) => set("onPayslip", c)} />
          <Switch label="Include in arrears" checked={v.inArrears} onCheckedChange={(c) => set("inArrears", c)} />
          <Switch label="Counts towards PF wages" checked={v.pfWage} onCheckedChange={(c) => set("pfWage", c)} />
          <Switch label="Counts towards ESI wages" checked={v.esiWage} onCheckedChange={(c) => set("esiWage", c)} />
        </fieldset>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
