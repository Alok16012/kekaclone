"use client";
import * as React from "react";
import { MoreHorizontal, Pencil, Plus, Star, Trash2, UserPlus } from "lucide-react";
import { Card, CardHeader } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { ConfirmDialog, Menu, Modal } from "@/ui/overlay";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { Checkbox } from "@/ui/choice";
import { Banner, EmptyState } from "@/ui/feedback";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { toast } from "@/ui/toast";
import { assignPolicyAction, deleteCategoryAction, deletePolicyAction, saveCategoryAction, savePolicyAction } from "@/app/(app)/expenses/actions";
import { CATEGORY_KINDS, inr, LIMIT_PERIODS, rupeesText, type Category } from "@/server/modules/expenses/rules";
import type { PolicyRow } from "@/server/modules/expenses/admin";

type Cat = Category & { used: number };
const kindLabel = (k: string) => CATEGORY_KINDS.find((x) => x.value === k)?.label ?? k;
const periodLabel = (p: string | null) => LIMIT_PERIODS.find((x) => x.value === p)?.label ?? "";

export function ExpenseSettings({ policies, people, canEdit }: { policies: PolicyRow[]; people: Person[]; canEdit: boolean }) {
  const [editing, setEditing] = React.useState<PolicyRow | "new" | null>(null);
  const [assigning, setAssigning] = React.useState<PolicyRow | null>(null);
  const [deleting, setDeleting] = React.useState<PolicyRow | null>(null);
  const [cat, setCat] = React.useState<{ policy: PolicyRow; cat: Cat | null } | null>(null);
  const [delCat, setDelCat] = React.useState<Cat | null>(null);
  return (
    <div className="flex flex-col gap-6">
      {!canEdit && <Banner tone="info">You can see the expense policies. Only expense admins for the whole company can change them.</Banner>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h2 className="text-lg font-semibold">Expense policies</h2><p className="text-sm text-text-muted">What people can claim, the limits, and when a receipt is needed. People without a policy use the default.</p></div>
        {canEdit && <Button onClick={() => setEditing("new")}><Plus />Add policy</Button>}
      </div>
      {policies.length === 0 && <Card><EmptyState title="No expense policies" description={canEdit ? "Add one to let people claim expenses." : undefined} /></Card>}
      {policies.map((p) => (
        <Card key={p.id}>
          <CardHeader
            title={<span className="flex flex-wrap items-center gap-2">{p.name}{p.is_default && <Badge tone="accent"><Star />Default</Badge>}</span>}
            description={[`${p.people} ${p.people === 1 ? "person" : "people"}`, p.submission_deadline_days != null ? `claims within ${p.submission_deadline_days} days` : "no claim deadline",
              p.allow_future_dated ? "future dates allowed" : null, p.advance.max_paise ? `advances up to ${inr(p.advance.max_paise)}` : "no advance limit",
              p.advance.receipts_due_days != null ? `advance claims due in ${p.advance.receipts_due_days} days` : null].filter(Boolean).join(" · ")}
            action={canEdit ? (
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => setCat({ policy: p, cat: null })}><Plus />Category</Button>
                <Menu trigger={<IconButton size="icon-sm" variant="ghost" label={`Actions for ${p.name}`}><MoreHorizontal /></IconButton>}
                  items={[{ label: "Edit policy", icon: <Pencil />, onSelect: () => setEditing(p) }, { label: "Put people on it", icon: <UserPlus />, onSelect: () => setAssigning(p) },
                    ...(p.is_default ? [] : ["separator" as const, { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setDeleting(p) }])]} />
              </div>
            ) : undefined} />
          {p.categories.length === 0 ? <EmptyState compact title="No categories" description="Add at least one so people can claim." /> : (
            <div className="overflow-x-auto border-t border-border">
              <table className="w-full text-base">
                <caption className="sr-only">Categories in {p.name}</caption>
                <thead><tr className="border-b border-border text-left text-sm text-text-muted">
                  <th scope="col" className="px-5 py-2 font-medium">Category</th><th scope="col" className="px-3 py-2 font-medium">Limit / rate</th>
                  <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">Receipt</th><th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">GL code</th>
                  {canEdit && <th scope="col" className="w-12 px-3"><span className="sr-only">Actions</span></th>}</tr></thead>
                <tbody>
                  {p.categories.map((c) => (
                    <tr key={c.id} className="border-b border-border last:border-0">
                      <td className="px-5 py-2"><span className="font-medium">{c.name}</span><span className="block text-sm text-text-muted">{kindLabel(c.kind)}</span></td>
                      <td className="px-3 py-2 tabular">{c.kind === "mileage" ? `${inr(c.rate_per_km_paise ?? 0)} per km` : c.kind === "per_diem" ? `${inr(c.limit_paise ?? 0)} per day` : c.limit_paise ? `${inr(c.limit_paise)} ${periodLabel(c.limit_period)}` : "No limit"}</td>
                      <td className="hidden px-3 py-2 md:table-cell">{c.receipt_required_above_paise == null ? "Not needed" : c.receipt_required_above_paise === 0 ? "Always" : `Above ${inr(c.receipt_required_above_paise)}`}</td>
                      <td className="hidden px-3 py-2 md:table-cell">{c.gl_code ?? "—"}</td>
                      {canEdit && <td className="px-3 py-2"><Menu trigger={<IconButton size="icon-sm" variant="ghost" label={`Actions for ${c.name}`}><MoreHorizontal /></IconButton>}
                        items={[{ label: "Edit", icon: <Pencil />, onSelect: () => setCat({ policy: p, cat: c }) }, { label: "Delete", icon: <Trash2 />, danger: true, disabled: c.used > 0, onSelect: () => setDelCat(c) }]} /></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ))}
      {editing && <PolicyDialog policy={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {cat && <CategoryDialog policyId={cat.policy.id} cat={cat.cat} onClose={() => setCat(null)} />}
      {assigning && <AssignDialog policy={assigning} people={people} onClose={() => setAssigning(null)} />}
      {deleting && <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting.name}?`} description="People on it move to the default policy. Policies with claims are kept for the record."
        confirmLabel="Delete" onConfirm={async () => { const r = await deletePolicyAction(deleting.id); if (r.ok) toast.success("Policy deleted"); else toast.error(r.error); setDeleting(null); }} />}
      {delCat && <ConfirmDialog open onOpenChange={(o) => !o && setDelCat(null)} title={`Delete ${delCat.name}?`} description="Nobody has claimed under it yet, so it can go."
        confirmLabel="Delete" onConfirm={async () => { const r = await deleteCategoryAction(delCat.id); if (r.ok) toast.success("Category deleted"); else toast.error(r.error); setDelCat(null); }} />}
    </div>
  );
}

function PolicyDialog({ policy, onClose }: { policy: PolicyRow | null; onClose: () => void }) {
  const [v, setV] = React.useState({
    name: policy?.name ?? "", allowFutureDated: policy?.allow_future_dated ?? false, deadlineDays: policy?.submission_deadline_days?.toString() ?? "60",
    advanceMax: rupeesText(policy?.advance.max_paise), advanceDueDays: policy?.advance.receipts_due_days?.toString() ?? "30",
  });
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const err = (f: string) => (error?.field === f ? error.message : undefined);
  const save = () => start(async () => {
    const r = await savePolicyAction(policy?.id ?? null, v);
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success(policy ? "Policy updated" : "Policy added"); onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={policy ? "Edit policy" : "Add policy"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>Save</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <Field label="Name" required error={err("name")}><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} maxLength={120} autoFocus /></Field>
        <Field label="Claim deadline (days after spending)" help="Leave empty for no deadline. Late expenses are flagged to approvers." error={err("submissionDeadlineDays")}>
          <Input inputMode="numeric" value={v.deadlineDays} onChange={(e) => setV({ ...v, deadlineDays: e.target.value })} />
        </Field>
        <Checkbox label="Allow expenses dated in the future (e.g. booked travel)" checked={v.allowFutureDated} onCheckedChange={(c) => setV({ ...v, allowFutureDated: !!c })} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Largest advance (₹)" help="Empty for no limit" error={err("advanceMaxPaise")}><Input inputMode="decimal" value={v.advanceMax} onChange={(e) => setV({ ...v, advanceMax: e.target.value })} className="tabular" /></Field>
          <Field label="Claim against an advance within (days)" error={err("advanceDueDays")}><Input inputMode="numeric" value={v.advanceDueDays} onChange={(e) => setV({ ...v, advanceDueDays: e.target.value })} /></Field>
        </div>
      </form>
    </Modal>
  );
}

function CategoryDialog({ policyId, cat, onClose }: { policyId: string; cat: Cat | null; onClose: () => void }) {
  const [v, setV] = React.useState({
    name: cat?.name ?? "", kind: cat?.kind ?? "general", limit: rupeesText(cat?.limit_paise), limitPeriod: cat?.limit_period ?? "claim",
    ratePerKm: rupeesText(cat?.rate_per_km_paise), receiptAbove: rupeesText(cat?.receipt_required_above_paise), glCode: cat?.gl_code ?? "",
  });
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const err = (f: string) => (error?.field === f ? error.message : undefined);
  const save = () => start(async () => {
    const r = await saveCategoryAction(policyId, cat?.id ?? null, { ...v, limitPeriod: v.kind === "per_diem" ? "day" : v.limit.trim() ? v.limitPeriod : null });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success(cat ? "Category updated" : "Category added"); onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={cat ? "Edit category" : "Add category"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>Save</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required error={err("name")}><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} maxLength={80} autoFocus /></Field>
          <Field label="Type" error={err("kind")} help={CATEGORY_KINDS.find((k) => k.value === v.kind)?.hint}>
            <Select value={v.kind} onValueChange={(k) => setV({ ...v, kind: k as typeof v.kind })} disabled={!!cat?.used} options={CATEGORY_KINDS.map((k) => ({ value: k.value, label: k.label }))} />
          </Field>
        </div>
        {v.kind === "mileage" && <Field label="Rate per km (₹)" required error={err("ratePerKmPaise")}><Input inputMode="decimal" value={v.ratePerKm} onChange={(e) => setV({ ...v, ratePerKm: e.target.value })} className="tabular" /></Field>}
        {v.kind === "per_diem" ? (
          <Field label="Daily allowance (₹)" required error={err("limitPaise")}><Input inputMode="decimal" value={v.limit} onChange={(e) => setV({ ...v, limit: e.target.value })} className="tabular" /></Field>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Limit (₹)" help="Empty for no limit. Going over is flagged, not blocked." error={err("limitPaise")}><Input inputMode="decimal" value={v.limit} onChange={(e) => setV({ ...v, limit: e.target.value })} className="tabular" /></Field>
            <Field label="Limit applies" error={err("limitPeriod")}><Select value={v.limitPeriod} onValueChange={(p) => setV({ ...v, limitPeriod: p as typeof v.limitPeriod })} disabled={!v.limit.trim()} options={LIMIT_PERIODS.map((p) => ({ value: p.value, label: p.label }))} /></Field>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Receipt needed above (₹)" help="0 = always; empty = never" error={err("receiptAbovePaise")}><Input inputMode="decimal" value={v.receiptAbove} onChange={(e) => setV({ ...v, receiptAbove: e.target.value })} className="tabular" /></Field>
          <Field label="GL code" help="For your accounts team" error={err("glCode")}><Input value={v.glCode} onChange={(e) => setV({ ...v, glCode: e.target.value })} maxLength={30} /></Field>
        </div>
      </form>
    </Modal>
  );
}

function AssignDialog({ policy, people, onClose }: { policy: PolicyRow; people: Person[]; onClose: () => void }) {
  const [ids, setIds] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    const r = await assignPolicyAction(policy.id, ids);
    if (!r.ok) { setError(r.error); return; }
    toast.success(`${r.data!.updated} ${r.data!.updated === 1 ? "person" : "people"} moved to ${policy.name}`); onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="sm" title={`Put people on ${policy.name}`} description="New expenses follow this policy. Claims already sent keep their checks."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!ids.length} onClick={save}>Save</Button></>}>
      {error && <Banner tone="danger" className="mb-4">{error}</Banner>}
      <Field label="People"><EmployeePicker multiple people={people} value={ids} onChange={setIds} /></Field>
    </Modal>
  );
}
