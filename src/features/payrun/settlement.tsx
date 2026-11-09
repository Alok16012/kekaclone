"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Calculator, Download, Lock, Plus, Trash2 } from "lucide-react";
import { Segmented } from "@/ui/choice";
import { PageHeader } from "@/ui/app-shell";
import { Button, IconButton } from "@/ui/button";
import { Card, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Field, Input, MoneyInput } from "@/ui/field";
import { Select } from "@/ui/select";
import { ConfirmDialog, Modal } from "@/ui/overlay";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import type { FnfView } from "@/server/modules/payrun/fnf";
import type { FnfItem } from "@/server/modules/payrun/rules";
import * as A from "@/app/(app)/payroll/actions";
import { fmtDate, fmtMonth, money } from "./format";

const ITEM_ACTION: Record<FnfItem["action"], string> = { pay: "Settle", void: "Don't settle", paid_outside: "Paid separately" };
const net = (items: FnfItem[]) => items.filter((i) => i.action === "pay").reduce((t, i) => t + (i.side === "earning" ? i.paise : -i.paise), 0);

async function act<T>(p: Promise<{ ok: boolean; error?: string; data?: T }>, success?: string) {
  const r = await p;
  if (!r.ok) { toast.error(r.error ?? "That didn't work."); return null; }
  if (success) toast.success(success);
  return r;
}

/** One exit's full and final settlement: erp's own items, manual items, per-item choices, finalise and the statement. */
export function SettlementView({ d }: { d: FnfView }) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  const [adding, setAdding] = React.useState(false);
  const x = d.exit;
  const s = d.settlement;
  const final = s?.status === "finalized";
  const items = s?.items ?? d.preview;
  const total = s ? s.net : net(d.preview);
  const run = (p: () => Promise<unknown>) => start(async () => { await p(); router.refresh(); });
  const group = (side: FnfItem["side"]) => items.filter((i) => i.side === side);
  const periodic = s?.mode === "periodic";
  const parts = s?.parts ?? [];
  const frozen = new Set(parts.filter((p) => p.status === "finalized").flatMap((p) => p.itemKeys));

  const list = (side: FnfItem["side"], title: string) => {
    const rows = group(side);
    return (
      <section aria-label={title} className="flex flex-col">
        <h3 className="px-5 pb-1 pt-4 text-base font-semibold">{title}</h3>
        {rows.length === 0 ? <p className="px-5 pb-3 text-sm text-text-muted">None.</p> : (
          <ul className="divide-y divide-border">
            {rows.map((i) => (
              <li key={i.key} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className={i.action === "pay" ? "text-base" : "text-base text-text-muted line-through"}>{i.label}{!i.auto && <Badge tone="neutral" className="ml-2">Added by hand</Badge>}</p>
                  {i.note && <p className="text-sm text-text-muted">{i.note}</p>}
                </div>
                <span className="text-base font-medium tabular">{side === "deduction" ? "−" : ""}{money(i.paise)}</span>
                {periodic && <Badge tone={frozen.has(i.key) ? "success" : "neutral"}>{frozen.has(i.key) ? `Paid in part ${i.part}` : `Part ${i.part ?? 1}`}</Badge>}
                {s && d.canEdit && !frozen.has(i.key) ? (
                  <span className="flex items-center gap-1">
                    {periodic && parts.length > 1 && (
                      <Select size="sm" className="w-28" value={String(i.part ?? 1)} disabled={pending} aria-label={`Part for ${i.label}`}
                        onValueChange={(v) => run(() => act(A.settlementItemPartAction(x.id, i.key, Number(v)), "Moved"))}
                        options={parts.filter((p) => p.status !== "finalized").map((p) => ({ value: String(p.partNo), label: `Part ${p.partNo}` }))} />
                    )}
                    <Select size="sm" className="w-40" value={i.action} disabled={pending}
                      onValueChange={(v) => run(() => act(A.settlementItemAction(x.id, i.key, v as FnfItem["action"]), "Item updated"))}
                      options={Object.entries(ITEM_ACTION).map(([value, label]) => ({ value, label }))} />
                    {!i.auto && <IconButton size="icon-sm" label={`Remove ${i.label}`} disabled={pending} onClick={() => run(() => act(A.removeSettlementItemAction(x.id, i.key), "Item removed"))}><Trash2 /></IconButton>}
                  </span>
                ) : s ? <Badge tone={i.action === "pay" ? "accent" : "neutral"}>{ITEM_ACTION[i.action]}</Badge> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <Link href="/payroll/settlements" className="inline-flex w-fit items-center gap-1.5 text-sm text-text-muted hover:text-text"><ArrowLeft className="size-4" aria-hidden />All final settlements</Link>
      <PageHeader title={`Final settlement: ${x.name}`}
        description={`${x.number}${x.designation ? ` · ${x.designation}` : ""} · joined ${fmtDate(x.joining_date)} · last working day ${fmtDate(x.last_working_date)}`}
        actions={final ? (s?.fileId ? <a href={`/payroll/files/${s.fileId}?download=1`} className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-base font-medium hover:bg-surface-hover"><Download className="size-4" aria-hidden />Statement</a> : undefined) : d.canEdit ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" loading={pending} onClick={() => run(() => act(A.buildSettlementAction(x.id), s ? "Settlement recalculated" : "Settlement worked out"))}><Calculator />{s ? "Recalculate" : "Work out settlement"}</Button>
            {s && !periodic && (
              <ConfirmDialog tone="primary" title="Finalise this settlement?" confirmLabel="Finalise"
                description={`The settlement locks at ${money(s.net)} net, a statement PDF is created and ${x.name} is told. You can't change it afterwards.`}
                onConfirm={() => run(() => act(A.finalizeSettlementAction(x.id), "Settlement finalised"))}
                trigger={<Button disabled={!d.prerequisite.ok || pending}><Lock />Finalise</Button>} />
            )}
          </div>
        ) : undefined} />

      {d.self && <Banner tone="info">This is your own settlement, so another payroll admin has to work on it.</Banner>}
      {!final && !d.prerequisite.ok && <Banner tone="warning" title="Not ready to finalise">{d.prerequisite.message}</Banner>}
      {final && <Banner tone="success" title="Finalised">This settlement is locked. {x.name} can download the statement from My finances.</Banner>}
      {!s && !final && <Banner tone="info">This is a preview of what erp would include. Choose “Work out settlement” to save it as a draft you can adjust.</Banner>}
      {d.notes.length > 0 && <Banner tone="info" title="Notes"><ul className="list-disc pl-4">{d.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></Banner>}

      <Card>
        <CardHeader title="Settlement items" description="Statutory figures such as gratuity come from rates a CA hasn't verified yet. Check them before paying."
          action={s && d.canEdit ? <Button size="sm" variant="secondary" onClick={() => setAdding(true)}><Plus />Add item</Button> : undefined} />
        {items.length === 0 ? <EmptyState compact title="Nothing to settle" description="erp found no pay, leave, gratuity or recoveries for this exit." /> : (
          <>
            {list("earning", "To pay")}
            {list("deduction", "To recover")}
            <p className="flex items-center justify-between border-t border-border px-5 py-4 text-md font-semibold">
              <span>{total < 0 ? "Net amount to recover" : "Net amount to pay"}</span><span className="tabular">{money(Math.abs(total))}</span>
            </p>
          </>
        )}
      </Card>
      {s && !final && d.canEdit && (
        <Card>
          <CardHeader title="How it's paid" description="In one go, or in parts over several months (for example salary now, gratuity after the notice period). Each part has its own month and statement and is finalised on its own."
            action={<Segmented label="Payment" value={s.mode} onChange={(m) => run(() => act(A.settlementModeAction(x.id, m), m === "periodic" ? "Paid in parts" : "Paid in one go"))} options={[{ value: "one_time", label: "One payment" }, { value: "periodic", label: "In parts" }]} />} />
        </Card>
      )}
      {s && periodic && <PartsCard d={d} parts={parts} pending={pending} run={run} />}
      {adding && <AddItemDialog exitId={x.id} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); router.refresh(); }} />}
    </div>
  );
}

function PartsCard({ d, parts, pending, run }: { d: FnfView; parts: NonNullable<FnfView["settlement"]>["parts"]; pending: boolean; run: (p: () => Promise<unknown>) => void }) {
  const x = d.exit;
  const months = Array.from({ length: 12 }, (_, i) => { const [y, m] = x.last_working_date.split("-").map(Number); const t = y * 12 + m - 1 + i; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}-01`; });
  const next = parts.length + 1;
  return (
    <Card>
      <CardHeader title="Parts" description="Parts are finalised in order. Put each item into a part from the list above."
        action={d.canEdit && parts.length < 12 ? <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => act(A.settlementPartAction(x.id, next, months[Math.min(parts.length, 11)]), `Part ${next} added`))}><Plus />Add part</Button> : undefined} />
      <ul className="divide-y divide-border border-t border-border">
        {parts.map((p) => (
          <li key={p.partNo} className="flex flex-wrap items-center gap-3 px-5 py-3">
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-base font-medium">Part {p.partNo}<Badge tone={p.status === "finalized" ? "success" : "neutral"}>{p.status === "finalized" ? `Finalised ${fmtDate(p.finalizedAt?.slice(0, 10))}` : "Draft"}</Badge></p>
              <p className="text-sm text-text-muted">{p.status === "finalized" ? `${p.itemKeys.length} ${p.itemKeys.length === 1 ? "item" : "items"} · ${fmtMonth(p.month)}` : "Paid in"}</p>
            </div>
            {p.status !== "finalized" && d.canEdit && (
              <Select size="sm" className="w-44" value={p.month} disabled={pending} aria-label={`Month for part ${p.partNo}`} onValueChange={(m) => run(() => act(A.settlementPartAction(x.id, p.partNo, m), "Month saved"))} options={months.map((m) => ({ value: m, label: fmtMonth(m) }))} />
            )}
            <span className="text-base font-semibold tabular">{p.net < 0 ? "−" : ""}{money(Math.abs(p.net))}</span>
            {p.status === "finalized" && p.fileId && <IconButton asChild size="icon-sm" variant="ghost" label={`Download the statement for part ${p.partNo}`}><a href={`/payroll/files/${p.fileId}?download=1`}><Download /></a></IconButton>}
            {p.status !== "finalized" && d.canEdit && (
              <>
                <ConfirmDialog tone="primary" title={`Finalise part ${p.partNo}?`} confirmLabel="Finalise part" description={`${money(Math.abs(p.net))} ${p.net < 0 ? "to recover" : "net"} in ${fmtMonth(p.month)}. Its items lock and get a statement; ${x.name} is told.`}
                  onConfirm={() => new Promise<void>((res) => { run(async () => { await act(A.finalizeSettlementPartAction(x.id, p.partNo), `Part ${p.partNo} finalised`); res(); }); })}
                  trigger={<Button size="sm" disabled={pending || !d.prerequisite.ok && p.partNo === 1}><Lock />Finalise part</Button>} />
                {p.partNo === parts.length && p.partNo > 1 && <IconButton size="icon-sm" variant="ghost" label={`Remove part ${p.partNo}`} disabled={pending} onClick={() => run(() => act(A.removeSettlementPartAction(x.id, p.partNo), "Part removed"))}><Trash2 /></IconButton>}
              </>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function AddItemDialog({ exitId, onClose, onSaved }: { exitId: string; onClose: () => void; onSaved: () => void }) {
  const [label, setLabel] = React.useState("");
  const [side, setSide] = React.useState<"earning" | "deduction">("earning");
  const [paise, setPaise] = React.useState<number | null>(null);
  const [note, setNote] = React.useState("");
  const [err, setErr] = React.useState<{ field?: string; error: string } | null>(null);
  const [pending, start] = React.useTransition();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await A.addSettlementItemAction(exitId, { label, side, paise: paise ?? 0, note: note.trim() || null });
      if (!r.ok) { setErr({ field: (r as { field?: string }).field, error: r.error }); return; }
      toast.success("Item added");
      onSaved();
    });
  };
  const fe = (f: string) => (err && (err.field === f || (!err.field && f === "label")) ? err.error : undefined);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Add a settlement item" description="For anything erp doesn't work out itself, such as a notice buyout or a retention bonus."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" form="fnf-item" loading={pending}>Add item</Button></>}>
      <form id="fnf-item" onSubmit={submit} className="flex flex-col gap-4">
        <Field label="What it's for" required error={fe("label")}><Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} /></Field>
        <Field label="Type"><Select value={side} onValueChange={(v) => setSide(v as "earning" | "deduction")} options={[{ value: "earning", label: "Pay to the person" }, { value: "deduction", label: "Recover from the person" }]} /></Field>
        <Field label="Amount" required error={fe("paise")}><MoneyInput valuePaise={paise} onChangePaise={setPaise} /></Field>
        <Field label="Note" help="Shown on the statement." error={fe("note")}><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} /></Field>
      </form>
    </Modal>
  );
}

