"use client";
import * as React from "react";
import { Check, MoreHorizontal, Pencil, Plus, Tags, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/ui/button";
import { Card, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Field, Input } from "@/ui/field";
import { RadioGroup, Switch } from "@/ui/choice";
import { ConfirmDialog, Menu, Modal } from "@/ui/overlay";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { cn } from "@/lib/cn";
import { deleteLeaveTypeAction, saveLeaveTypeAction } from "@/app/(app)/settings/leave/actions";
import { COLOURS, KIND_HINT, KIND_LABEL } from "./labels";

export type TypeRow = { id: string; name: string; code: string; kind: "regular" | "incident" | "comp_off" | "unpaid"; is_paid: boolean; color: string; plans: number; used: boolean };

export function LeaveTypes({ rows }: { rows: TypeRow[] }) {
  const [editing, setEditing] = React.useState<TypeRow | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<TypeRow | null>(null);
  return (
    <Card>
      <CardHeader title="Leave types" description="The kinds of leave people can take. Add a type to a leave plan to give it a quota and rules."
        action={<Button size="sm" onClick={() => setEditing("new")}><Plus />Add type</Button>} />
      {rows.length === 0 ? (
        <EmptyState compact icon={<Tags />} title="No leave types yet" description="Start with the leave your company offers, like casual, sick and earned leave."
          action={<Button size="sm" onClick={() => setEditing("new")}><Plus />Add your first type</Button>} />
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-5 py-3">
              <span aria-hidden className="size-3 shrink-0 rounded-pill" style={{ background: r.color }} />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-base font-medium">
                  <span className="truncate">{r.name}</span><Badge>{r.code}</Badge>
                  <Badge tone={r.kind === "unpaid" ? "warning" : r.kind === "comp_off" ? "accent" : "neutral"}>{KIND_LABEL[r.kind]}</Badge>
                </p>
                <p className="text-sm text-text-muted">{r.is_paid ? "Paid" : "Unpaid"} · {r.plans === 0 ? "not in any plan yet" : `in ${r.plans} ${r.plans === 1 ? "plan" : "plans"}`}</p>
              </div>
              <Menu trigger={<IconButton label={`Actions for ${r.name}`} size="icon-sm" variant="ghost"><MoreHorizontal /></IconButton>}
                items={[{ label: "Edit", icon: <Pencil />, onSelect: () => setEditing(r) }, { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setDeleting(r) }]} />
            </li>
          ))}
        </ul>
      )}
      {editing && <TypeDialog row={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting.name}?`}
          description={deleting.plans ? "It's still part of a leave plan. Remove it from every plan first." : deleting.used ? "People have requests or balances for it, so it can't be deleted." : "This can't be undone."}
          confirmLabel="Delete" onConfirm={async () => { const r = await deleteLeaveTypeAction(deleting.id); if (r.ok) toast.success(`${deleting.name} deleted`); else toast.error(r.error); setDeleting(null); }} />
      )}
    </Card>
  );
}

function TypeDialog({ row, onClose }: { row: TypeRow | null; onClose: () => void }) {
  const [name, setName] = React.useState(row?.name ?? "");
  const [code, setCode] = React.useState(row?.code ?? "");
  const [kind, setKind] = React.useState<TypeRow["kind"]>(row?.kind ?? "regular");
  const [paid, setPaid] = React.useState(row?.is_paid ?? true);
  const [color, setColor] = React.useState(row?.color ?? COLOURS[0]);
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    const r = await saveLeaveTypeAction(row?.id ?? null, { name, code, kind, paid: kind === "unpaid" ? false : paid, color });
    if (!r.ok) { setError({ message: r.error, field: (r as { field?: string }).field }); return; }
    toast.success(row ? `${name} updated` : `${name} added`, { description: row ? undefined : "Add it to a leave plan to give people a balance." });
    onClose();
  });
  const fieldError = (f: string) => (error?.field === f ? error.message : undefined);
  const palette = COLOURS.includes(color) ? COLOURS : [color, ...COLOURS];
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={row ? "Edit leave type" : "Add leave type"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>{row ? "Save" : "Add type"}</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
          <Field label="Name" required error={fieldError("name")}><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={60} placeholder="Casual leave" /></Field>
          <Field label="Short code" required error={fieldError("code")} help="Shown in calendars"><Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={8} placeholder="CL" className="uppercase" /></Field>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Kind</legend>
          {fieldError("kind") && <p role="alert" className="text-sm text-danger-text">{fieldError("kind")}</p>}
          <RadioGroup value={kind} onValueChange={(v) => setKind(v as TypeRow["kind"])}
            options={(["regular", "incident", "comp_off", "unpaid"] as const).map((k) => ({ value: k, label: KIND_LABEL[k], hint: KIND_HINT[k] }))} />
        </fieldset>
        <Switch label="Paid leave" checked={kind === "unpaid" ? false : paid} disabled={kind === "unpaid"} onCheckedChange={setPaid} />
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Colour</legend>
          <div role="radiogroup" aria-label="Colour" className="flex flex-wrap gap-2">
            {palette.map((c, i) => (
              <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={`Colour ${i + 1}`} onClick={() => setColor(c)}
                className={cn("flex size-8 items-center justify-center rounded-pill ring-offset-2 ring-offset-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus", color === c && "ring-2 ring-text")}
                style={{ background: c }}>
                {color === c && <Check className="size-4 text-on-accent" aria-hidden />}
              </button>
            ))}
          </div>
        </fieldset>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
