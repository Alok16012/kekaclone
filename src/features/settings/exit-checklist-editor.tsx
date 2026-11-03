"use client";
import * as React from "react";
import { ArrowDown, ArrowUp, ListChecks, Pencil, Plus, Trash2, Zap } from "lucide-react";
import { Card, CardHeader } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Modal, ConfirmDialog } from "@/ui/overlay";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Banner, EmptyState } from "@/ui/feedback";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { toast } from "@/ui/toast";
import { deleteChecklistItemAction, moveChecklistItemAction, saveChecklistItemAction } from "@/app/(app)/org/exits/actions";
import { AUTO_KINDS, AUTO_LABEL, OWNER_LABEL, type AutoKind, type TaskOwner } from "@/server/modules/exits/rules";

export type ChecklistItem = { id: string; title: string; description: string | null; owner: TaskOwner; due_offset_days: number; auto: AutoKind | null };
const offset = (n: number) => (n === 0 ? "On the last working day" : n < 0 ? `${-n} ${n === -1 ? "day" : "days"} before the last day` : `${n} ${n === 1 ? "day" : "days"} after the last day`);
const AUTO_SHORT: Record<AutoKind, string> = { assets_returned: "Auto: assets returned", access_revoked: "Auto: access revoked", fnf_finalized: "Auto: settlement finalised" };

/** Settings → Exits: the checklist template every new exit gets. Add, edit, reorder and remove tasks; some tick themselves. */
export function ExitChecklistEditor({ checklist, people, canEdit }: { checklist: ChecklistItem[]; people: Person[]; canEdit: boolean }) {
  const [editing, setEditing] = React.useState<ChecklistItem | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<ChecklistItem | null>(null);
  const [busy, start] = React.useTransition();
  const move = (id: string, dir: "up" | "down") => start(async () => { const r = await moveChecklistItemAction(id, dir); if (!r.ok) toast.error(r.error); });
  return (
    <Card>
      <CardHeader title="Exit checklist" description="Created for everyone whose exit starts. Due dates count from the last working day. Tasks marked “auto” tick themselves when the system can tell they're done."
        action={canEdit ? <Button size="sm" onClick={() => setEditing("new")}><Plus />Add task</Button> : undefined} />
      {checklist.length === 0 ? <EmptyState compact icon={<ListChecks />} title="No checklist yet" description={canEdit ? "Add the first task, for example “Return company assets”." : "It's set up the first time someone's exit starts."} /> : (
        <ol className="divide-y divide-border border-t border-border">
          {checklist.map((c, i) => (
            <li key={c.id} className="flex items-start gap-3 px-5 py-3">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-pill bg-surface-hover text-sm tabular">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-base font-medium">{c.title}{c.auto && <Badge tone="accent" size="sm"><Zap />{AUTO_SHORT[c.auto]}</Badge>}</p>
                {c.description && <p className="text-sm text-text-muted">{c.description}</p>}
                <p className="mt-0.5 text-sm text-text-muted">Owner: {OWNER_LABEL(c.owner)}{c.owner.type === "employee" ? ` (${people.find((p) => p.id === (c.owner as { id: string }).id)?.name ?? "someone"})` : ""} · {offset(c.due_offset_days)}</p>
              </div>
              {canEdit && (
                <div className="flex shrink-0 items-center gap-0.5">
                  <IconButton size="icon-sm" variant="ghost" label={`Move ${c.title} up`} disabled={i === 0 || busy} onClick={() => move(c.id, "up")}><ArrowUp /></IconButton>
                  <IconButton size="icon-sm" variant="ghost" label={`Move ${c.title} down`} disabled={i === checklist.length - 1 || busy} onClick={() => move(c.id, "down")}><ArrowDown /></IconButton>
                  <IconButton size="icon-sm" variant="ghost" label={`Edit ${c.title}`} onClick={() => setEditing(c)}><Pencil /></IconButton>
                  <IconButton size="icon-sm" variant="ghost" label={`Remove ${c.title}`} onClick={() => setDeleting(c)}><Trash2 /></IconButton>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {editing && <ItemDialog item={editing === "new" ? null : editing} people={people} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)} title={`Remove “${deleting.title}”?`} description="Exits already under way keep their tasks; new exits won't get this one." confirmLabel="Remove"
          onConfirm={async () => { const r = await deleteChecklistItemAction(deleting.id); if (r.ok) toast.success("Task removed"); else toast.error(r.error); setDeleting(null); }} />
      )}
    </Card>
  );
}

const OWNER_OPTIONS = [{ value: "self", label: "The person leaving" }, { value: "manager", label: "Their manager" }, { value: "role:hr_admin", label: "HR admin" }, { value: "role:global_admin", label: "Global admin" }, { value: "role:payroll_admin", label: "Payroll admin" }, { value: "role:finance", label: "Finance" }, { value: "employee", label: "A named person" }];
const ownerKey = (o: TaskOwner) => (o.type === "role" ? `role:${o.role}` : o.type);

function ItemDialog({ item, people, onClose }: { item: ChecklistItem | null; people: Person[]; onClose: () => void }) {
  const [title, setTitle] = React.useState(item?.title ?? "");
  const [description, setDescription] = React.useState(item?.description ?? "");
  const [ownerKind, setOwnerKind] = React.useState(item ? ownerKey(item.owner) : "self");
  const [ownerId, setOwnerId] = React.useState<string[]>(item?.owner.type === "employee" ? [item.owner.id] : []);
  const [days, setDays] = React.useState(String(item?.due_offset_days ?? 0));
  const [auto, setAuto] = React.useState<string>(item?.auto ?? "none");
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    const n = Number(days);
    if (!Number.isInteger(n)) { setError({ message: "Use whole days.", field: "dueOffsetDays" }); return; }
    const owner: TaskOwner = ownerKind === "self" ? { type: "self" } : ownerKind === "manager" ? { type: "manager" } : ownerKind === "employee" ? { type: "employee", id: ownerId[0] ?? "" } : { type: "role", role: ownerKind.slice(5) };
    if (owner.type === "employee" && !owner.id) { setError({ message: "Pick the person.", field: "owner" }); return; }
    const r = await saveChecklistItemAction(item?.id ?? null, { title, description: description || null, owner, dueOffsetDays: n, auto: auto === "none" ? null : (auto as AutoKind) });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success(item ? "Task updated" : "Task added"); onClose();
  });
  const err = (f: string) => (error?.field === f ? error.message : undefined);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="md" title={item ? "Edit task" : "Add a task"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>Save</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <Field label="Task" required error={err("title")}><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} autoFocus placeholder="e.g. Hand over the project repository" /></Field>
        <Field label="Details" help="Optional"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={1000} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Owner" required error={err("owner")}><Select value={ownerKind} onValueChange={setOwnerKind} options={OWNER_OPTIONS} /></Field>
          <Field label="Due" required help="Days after the last working day (negative = before)" error={err("dueOffsetDays")}><Input type="number" inputMode="numeric" min={-365} max={365} value={days} onChange={(e) => setDays(e.target.value)} /></Field>
        </div>
        {ownerKind === "employee" && <Field label="Person" required><EmployeePicker people={people} value={ownerId} onChange={setOwnerId} /></Field>}
        <Field label="Ticks itself when" help="Leave as “Someone ticks it” for tasks the system can't check.">
          <Select value={auto} onValueChange={setAuto} options={[{ value: "none", label: "Someone ticks it" }, ...AUTO_KINDS.map((k) => ({ value: k, label: AUTO_LABEL[k] }))]} />
        </Field>
      </form>
    </Modal>
  );
}
