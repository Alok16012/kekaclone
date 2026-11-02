"use client";
import * as React from "react";
import { HandCoins, Pencil, Plus, Trash2 } from "lucide-react";
import { Card, CardHeader } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { ConfirmDialog, Modal } from "@/ui/overlay";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { deleteLoanCategoryAction, saveLoanCategoryAction } from "@/app/(app)/payroll/loans/actions";
import { formatPaise, RATE_TYPE_LABEL, RATE_TYPES, type RateType } from "@/server/modules/loans/rules";
import { parseRupees } from "@/server/modules/tax/rules";
import type { CategoryRow } from "@/server/modules/loans/service";
import { rateText } from "./shared";

export function LoanCategories({ rows, canEdit }: { rows: CategoryRow[]; canEdit: boolean }) {
  const [editing, setEditing] = React.useState<CategoryRow | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<CategoryRow | null>(null);
  return (
    <Card>
      <CardHeader title="Loan types" description="What people can borrow, for how long and at what interest. Changes apply to new requests; existing loans keep their terms."
        action={canEdit ? <Button size="sm" onClick={() => setEditing("new")}><Plus />Add loan type</Button> : undefined} />
      {!canEdit && <div className="px-5 pb-3"><Banner tone="info">Only payroll admins for the whole company can change loan types.</Banner></div>}
      {rows.length === 0 ? <EmptyState compact icon={<HandCoins />} title="No loan types yet" description="Add one so people can ask for loans." /> : (
        <ul className="divide-y divide-border border-t border-border">
          {rows.map((c) => (
            <li key={c.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-base font-medium">{c.name}</p>
                <p className="text-sm text-text-muted">{rateText(c.interestRate, c.rateType)} · {c.maxAmountPaise ? `up to ${formatPaise(c.maxAmountPaise)}` : "no amount limit"} · {c.maxTenureMonths ? `up to ${c.maxTenureMonths} months` : "any tenure"} · {c.loans} loan{c.loans === 1 ? "" : "s"}</p>
              </div>
              {canEdit && (
                <div className="flex gap-1">
                  <IconButton label={`Edit ${c.name}`} variant="ghost" onClick={() => setEditing(c)}><Pencil /></IconButton>
                  {c.loans === 0 && <IconButton label={`Delete ${c.name}`} variant="ghost" onClick={() => setDeleting(c)}><Trash2 /></IconButton>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <CategoryForm row={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting.name}?`} description="People won't be able to ask for this kind of loan." confirmLabel="Delete"
        onConfirm={async () => { const r = await deleteLoanCategoryAction(deleting.id); if (r.ok) toast.success("Loan type deleted"); else toast.error(r.error); setDeleting(null); }} />}
    </Card>
  );
}

function CategoryForm({ row, onClose }: { row: CategoryRow | null; onClose: () => void }) {
  const [name, setName] = React.useState(row?.name ?? "");
  const [type, setType] = React.useState<RateType>(row?.rateType ?? "zero");
  const [rate, setRate] = React.useState(row && row.rateType !== "zero" ? String(Number(row.interestRate)) : "");
  const [max, setMax] = React.useState(row?.maxAmountPaise ? String(row.maxAmountPaise / 100) : "");
  const [months, setMonths] = React.useState(row?.maxTenureMonths ? String(row.maxTenureMonths) : "");
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    const maxPaise = max.trim() ? parseRupees(max) : null;
    if (max.trim() && !maxPaise) { setError({ message: "Enter the limit in rupees, like 200000.", field: "maxAmountPaise" }); return; }
    const r = await saveLoanCategoryAction(row?.id ?? null, { name, rateType: type, interestRate: type === "zero" ? "0" : rate, maxAmountPaise: maxPaise, maxTenureMonths: months.trim() ? Number(months) : null });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success(row ? "Loan type saved" : "Loan type added"); onClose();
  });
  const err = (f: string) => (error?.field === f ? error.message : undefined);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="sm" title={row ? `Edit ${row.name}` : "Add a loan type"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>Save</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <Field label="Name" required error={err("name")}><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus /></Field>
        <Field label="Interest" required error={err("rateType")} help={type === "flat" ? "Charged on the full amount for the whole tenure." : type === "reducing" ? "Charged each month on what's still owed." : undefined}>
          <Select value={type} onValueChange={(v) => setType(v as RateType)} options={RATE_TYPES.map((t) => ({ value: t, label: RATE_TYPE_LABEL[t] }))} />
        </Field>
        {type !== "zero" && <Field label="Yearly rate (%)" required error={err("interestRate")}><Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="8.5" /></Field>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Largest amount" error={err("maxAmountPaise")} help="Leave empty for no limit"><Input inputMode="decimal" leading={<span className="text-sm">₹</span>} value={max} onChange={(e) => setMax(e.target.value)} className="tabular" /></Field>
          <Field label="Longest tenure (months)" error={err("maxTenureMonths")} help="1 to 360"><Input type="number" min={1} max={360} value={months} onChange={(e) => setMonths(e.target.value)} /></Field>
        </div>
      </form>
    </Modal>
  );
}
