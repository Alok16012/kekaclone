"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, FolderPlus, MoreHorizontal, Pencil, Plus, Receipt, Trash2 } from "lucide-react";
import { Card, CardHeader, StatTile } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Checkbox } from "@/ui/choice";
import { ConfirmDialog, Menu, Modal } from "@/ui/overlay";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { Banner, EmptyState } from "@/ui/feedback";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { toast } from "@/ui/toast";
import { createClaimAction, deleteExpenseAction } from "@/app/(app)/me/expenses/actions";
import { inr, type Category } from "@/server/modules/expenses/rules";
import type { AdvanceRow, ClaimRow, ExpenseRow } from "@/server/modules/expenses/service";
import { ExpenseDialog } from "./expense-dialog";
import { ClaimStatus, ExpenseLine, Money, shortDate } from "./shared";

export type MyExpensesData = { categories: Category[]; policyName: string | null; unclaimed: ExpenseRow[]; claims: ClaimRow[]; advances: AdvanceRow[]; today: string };

export function MyExpenses({ d, startAdding }: { d: MyExpensesData; startAdding?: boolean }) {
  const [adding, setAdding] = React.useState(!!startAdding && d.categories.length > 0);
  const [editing, setEditing] = React.useState<ExpenseRow | null>(null);
  const [deleting, setDeleting] = React.useState<ExpenseRow | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [grouping, setGrouping] = React.useState(false);
  const open = d.claims.filter((c) => c.status === "draft" || c.status === "submitted" || c.status === "rejected");
  const past = d.claims.filter((c) => c.status === "approved" || c.status === "paid");
  const toBePaid = d.claims.filter((c) => c.status === "approved").reduce((s, c) => s + c.payable_paise, 0);
  const inReview = d.claims.filter((c) => c.status === "submitted").reduce((s, c) => s + c.total_paise, 0);
  const unclaimedTotal = d.unclaimed.reduce((s, x) => s + x.amount_paise, 0);
  const openAdvances = d.advances.filter((a) => a.status === "paid");

  if (!d.categories.length) {
    return <Card><EmptyState icon={<Receipt />} title="Expenses aren't set up yet" description="Your company hasn't added expense categories. Ask your HR or finance team." /></Card>;
  }
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="secondary" asChild><Link href="/me/expenses/advances">Advances{openAdvances.length ? ` (${openAdvances.length} open)` : ""}</Link></Button>
        <Button onClick={() => setAdding(true)}><Plus />Add expense</Button>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile label="Not in a claim yet" value={inr(unclaimedTotal)} hint={`${d.unclaimed.length} ${d.unclaimed.length === 1 ? "expense" : "expenses"}`} />
        <StatTile label="In review" value={inr(inReview)} />
        <StatTile label="Approved, to be paid" value={inr(toBePaid)} />
      </div>

      <Tabs defaultValue="expenses">
        <TabsList items={[{ value: "expenses", label: "Expenses", count: d.unclaimed.length }, { value: "open", label: "Open claims", count: open.length }, { value: "past", label: "Approved and paid", count: past.length }]} />
        <TabsContent value="expenses">
          <Card>
            <CardHeader title="Expenses not in a claim" description="Select expenses and group them into a claim to send for approval."
              action={selected.size ? <Button size="sm" onClick={() => setGrouping(true)}><FolderPlus />Make a claim ({selected.size})</Button> : undefined} />
            {d.unclaimed.length === 0 ? (
              <EmptyState compact icon={<Receipt />} title="Nothing waiting to be claimed" description="Add an expense as soon as you spend: it's easier with the receipt in hand." action={<Button variant="secondary" size="sm" onClick={() => setAdding(true)}><Plus />Add expense</Button>} />
            ) : (
              <ul className="divide-y divide-border border-t border-border">
                {d.unclaimed.map((x) => (
                  <ExpenseLine key={x.id} x={x}
                    leading={<Checkbox className="mt-1" aria-label={`Select ${x.category} on ${shortDate(x.spent_on)}, ${inr(x.amount_paise)}`} checked={selected.has(x.id)}
                      onCheckedChange={(c) => setSelected((s) => { const n = new Set(s); if (c) n.add(x.id); else n.delete(x.id); return n; })} />}
                    actions={<Menu trigger={<IconButton size="icon-sm" variant="ghost" label={`Actions for ${x.category} on ${shortDate(x.spent_on)}`}><MoreHorizontal /></IconButton>}
                      items={[{ label: "Edit", icon: <Pencil />, onSelect: () => setEditing(x) }, "separator", { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setDeleting(x) }]} />} />
                ))}
              </ul>
            )}
          </Card>
        </TabsContent>
        <TabsContent value="open"><ClaimList claims={open} empty="No open claims. Group your expenses into a claim to send them for approval." /></TabsContent>
        <TabsContent value="past"><ClaimList claims={past} empty="Approved and paid claims will show here." /></TabsContent>
      </Tabs>

      {adding && <ExpenseDialog open onOpenChange={setAdding} categories={d.categories} today={d.today} />}
      {editing && <ExpenseDialog open onOpenChange={(o) => !o && setEditing(null)} categories={d.categories} expense={editing} today={d.today} />}
      {grouping && <NewClaimDialog ids={[...selected]} total={d.unclaimed.filter((x) => selected.has(x.id)).reduce((s, x) => s + x.amount_paise, 0)} advances={openAdvances}
        onClose={(done) => { setGrouping(false); if (done) setSelected(new Set()); }} />}
      {deleting && (
        <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)} title="Delete this expense?" description={`${deleting.category}, ${inr(deleting.amount_paise)} on ${shortDate(deleting.spent_on)}. Its receipts are deleted too.`}
          confirmLabel="Delete" onConfirm={async () => { const r = await deleteExpenseAction(deleting.id); if (r.ok) toast.success("Expense deleted"); else toast.error(r.error); setDeleting(null); }} />
      )}
    </div>
  );
}

function ClaimList({ claims, empty }: { claims: ClaimRow[]; empty: string }) {
  if (!claims.length) return <Card><EmptyState compact title="Nothing here" description={empty} /></Card>;
  return (
    <Card>
      <ul className="divide-y divide-border">
        {claims.map((c) => (
          <li key={c.id}>
            <Link href={`/me/expenses/claims/${c.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-sunken focus-visible:outline-offset-[-2px]">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-base font-medium"><span className="truncate">#{c.number} · {c.title}</span><ClaimStatus status={c.status} /></p>
                <p className="text-sm text-text-muted">
                  {c.items} {c.items === 1 ? "expense" : "expenses"}
                  {c.status === "submitted" && c.waiting_on ? ` · Waiting for ${c.waiting_on}` : ""}
                  {c.flags ? ` · ${c.flags} policy ${c.flags === 1 ? "flag" : "flags"}` : ""}
                  {c.status === "paid" && c.payment_ref ? ` · ${c.payment_ref}` : ""}
                </p>
              </div>
              <Money paise={c.total_paise} className="text-base font-medium" />
              <ChevronRight aria-hidden className="size-4 text-text-muted" />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function NewClaimDialog({ ids, total, advances, onClose }: { ids: string[]; total: number; advances: AdvanceRow[]; onClose: (done: boolean) => void }) {
  const router = useRouter();
  const [title, setTitle] = React.useState("");
  const [advanceId, setAdvanceId] = React.useState("none");
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    const r = await createClaimAction({ title, expenseIds: ids, advanceId: advanceId === "none" ? null : advanceId });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success("Claim created", { description: "Check it over, then send it for approval." });
    onClose(true);
    router.push(`/me/expenses/claims/${r.data!.id}`);
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose(false)} size="sm" title="Make a claim" description={`${ids.length} ${ids.length === 1 ? "expense" : "expenses"}, ${inr(total)}`}
      footer={<><Button variant="secondary" onClick={() => onClose(false)}>Cancel</Button><Button loading={pending} onClick={save}>Create claim</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <Field label="Title" required help="For example the trip, the client or the month" error={error?.field === "title" ? error.message : undefined}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} autoFocus />
        </Field>
        {advances.length > 0 && (
          <Field label="Settle against an advance" help="The advance covers what it can; the rest is paid to you." error={error?.field === "advanceId" ? error.message : undefined}>
            <Select value={advanceId} onValueChange={setAdvanceId} options={[{ value: "none", label: "Don't use an advance" }, ...advances.map((a) => ({ value: a.id, label: `${a.purpose} (${inr(a.outstanding_paise)} open)` }))]} />
          </Field>
        )}
      </form>
    </Modal>
  );
}
