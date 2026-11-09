"use client";
import * as React from "react";
import { MoreHorizontal, Pencil, Plus, Star, Trash2, UserPlus, X } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Modal, Menu, ConfirmDialog } from "@/ui/overlay";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { Checkbox } from "@/ui/choice";
import { Banner, EmptyState } from "@/ui/feedback";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { toast } from "@/ui/toast";
import { addExitReasonAction, assignNoticePolicyAction, deleteExitReasonAction, deleteNoticePolicyAction, saveNoticePolicyAction } from "@/app/(app)/org/exits/actions";
import type { NoticePolicyRow } from "@/server/modules/exits/service";
import { ExitChecklistEditor, type ChecklistItem } from "./exit-checklist-editor";
import type { Reason } from "@/features/exits/initiate-exit";

const KINDS = { resignation: "Resignation", termination: "Company action", other: "Other" } as const;

export function ExitSettings({ policies, reasons, checklist, people, canEdit }: { policies: NoticePolicyRow[]; reasons: Reason[]; checklist: ChecklistItem[]; people: Person[]; canEdit: boolean }) {
  const [editing, setEditing] = React.useState<NoticePolicyRow | "new" | null>(null);
  const [assigning, setAssigning] = React.useState<NoticePolicyRow | null>(null);
  const [deleting, setDeleting] = React.useState<NoticePolicyRow | null>(null);
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader title="Notice periods" description="Decide the last working day when someone resigns. People without one use the default."
          action={canEdit ? <Button size="sm" onClick={() => setEditing("new")}><Plus />Add notice period</Button> : undefined} />
        {policies.length === 0 ? <EmptyState compact title="No notice periods yet" description={canEdit ? "Add one, for example 30 days." : undefined} /> : (
          <ul className="divide-y divide-border border-t border-border">
            {policies.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-base font-medium">{p.name}{p.is_default && <Badge tone="accent"><Star />Default</Badge>}</p>
                  <p className="text-sm text-text-muted">{p.days} days{p.probation_days != null ? ` · ${p.probation_days} during probation` : ""} · {p.people} {p.people === 1 ? "person" : "people"}</p>
                </div>
                {canEdit && (
                  <Menu trigger={<IconButton size="icon-sm" label={`Actions for ${p.name}`}><MoreHorizontal /></IconButton>}
                    items={[{ label: "Edit", icon: <Pencil />, onSelect: () => setEditing(p) }, { label: "Put people on it", icon: <UserPlus />, onSelect: () => setAssigning(p) }, "separator", { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setDeleting(p) }]} />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ReasonsCard reasons={reasons} canEdit={canEdit} />

      <ExitChecklistEditor checklist={checklist} people={people} canEdit={canEdit} />

      {editing && <PolicyDialog policy={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {assigning && <AssignDialog policy={assigning} people={people} onClose={() => setAssigning(null)} />}
      {deleting && (
        <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting.name}?`}
          description={deleting.is_default ? "This is the default. Make another notice period the default first." : deleting.people ? `${deleting.people} ${deleting.people === 1 ? "person is" : "people are"} on it. Move them first.` : "This can't be undone."}
          confirmLabel="Delete" onConfirm={async () => { const r = await deleteNoticePolicyAction(deleting.id); if (r.ok) toast.success("Notice period deleted"); else toast.error(r.error); setDeleting(null); }} />
      )}
    </div>
  );
}

function PolicyDialog({ policy, onClose }: { policy: NoticePolicyRow | null; onClose: () => void }) {
  const [name, setName] = React.useState(policy?.name ?? "");
  const [days, setDays] = React.useState(String(policy?.days ?? 30));
  const [prob, setProb] = React.useState(policy?.probation_days == null ? "" : String(policy.probation_days));
  const [isDefault, setDefault] = React.useState(policy?.is_default ?? false);
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    const d = Number(days), p = prob.trim() === "" ? null : Number(prob);
    if (!Number.isInteger(d) || (p != null && !Number.isInteger(p))) { setError({ message: "Use whole days.", field: Number.isInteger(d) ? "probationDays" : "days" }); return; }
    const r = await saveNoticePolicyAction(policy?.id ?? null, { name, days: d, probationDays: p, isDefault });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success(policy ? "Notice period updated" : "Notice period added");
    onClose();
  });
  const err = (f: string) => (error?.field === f ? error.message : undefined);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="sm" title={policy ? "Edit notice period" : "Add notice period"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>Save</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <Field label="Name" required error={err("name")}><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Senior staff" maxLength={120} autoFocus /></Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Notice (days)" required error={err("days")}><Input type="number" inputMode="numeric" min={0} max={365} value={days} onChange={(e) => setDays(e.target.value)} /></Field>
          <Field label="During probation" help="Optional" error={err("probationDays")}><Input type="number" inputMode="numeric" min={0} max={365} value={prob} onChange={(e) => setProb(e.target.value)} /></Field>
        </div>
        <Checkbox label="Use this for people without a notice period" checked={isDefault} onCheckedChange={(c) => setDefault(!!c)} disabled={policy?.is_default} />
      </form>
    </Modal>
  );
}

function AssignDialog({ policy, people, onClose }: { policy: NoticePolicyRow; people: Person[]; onClose: () => void }) {
  const [ids, setIds] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    const r = await assignNoticePolicyAction(policy.id, ids);
    if (!r.ok) { setError(r.error); return; }
    toast.success(`${r.data!.updated} ${r.data!.updated === 1 ? "person" : "people"} moved to ${policy.name}`);
    onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="sm" title={`Put people on ${policy.name}`} description="Their notice period changes from now on. Exits already started keep their dates."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!ids.length} onClick={save}>Save</Button></>}>
      {error && <Banner tone="danger" className="mb-4">{error}</Banner>}
      <Field label="People"><EmployeePicker multiple people={people} value={ids} onChange={setIds} /></Field>
    </Modal>
  );
}

function ReasonsCard({ reasons, canEdit }: { reasons: Reason[]; canEdit: boolean }) {
  const [kind, setKind] = React.useState<string>("resignation");
  const [name, setName] = React.useState("");
  const [pending, start] = React.useTransition();
  const add = () => start(async () => {
    const r = await addExitReasonAction({ kind, name });
    if (!r.ok) { toast.error(r.error); return; }
    toast.success("Reason added"); setName("");
  });
  return (
    <Card>
      <CardHeader title="Exit reasons" description="Offered when someone resigns or HR starts an exit. Used in attrition reports." />
      <CardBody className="flex flex-col gap-4">
        {(Object.keys(KINDS) as (keyof typeof KINDS)[]).map((k) => {
          const rows = reasons.filter((r) => r.kind === k);
          return (
            <div key={k}>
              <h4 className="mb-2 text-sm font-semibold">{KINDS[k]}</h4>
              {rows.length === 0 ? <p className="text-sm text-text-muted">None yet.</p> : (
                <ul className="flex flex-wrap gap-2">
                  {rows.map((r) => (
                    <li key={r.id} className="inline-flex items-center gap-1 rounded-pill bg-surface-hover py-1 pl-3 pr-1 text-sm">
                      {r.name}
                      {canEdit && <ConfirmDialog title={`Remove “${r.name}”?`} description="Past exits keep their history, without a reason." confirmLabel="Remove"
                        onConfirm={async () => { const x = await deleteExitReasonAction(r.id); if (x.ok) toast.success("Reason removed"); else toast.error(x.error); }}
                        trigger={<button type="button" aria-label={`Remove ${r.name}`} className="rounded-pill p-1 text-text-muted hover:bg-surface hover:text-text"><X className="size-3.5" /></button>} />}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
        {canEdit && (
          <form className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); add(); }}>
            <Field label="Type" className="sm:w-48"><Select value={kind} onValueChange={setKind} options={Object.entries(KINDS).map(([value, label]) => ({ value, label }))} /></Field>
            <Field label="New reason" className="flex-1"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. Career change" /></Field>
            <Button type="submit" variant="secondary" loading={pending} disabled={!name.trim()}><Plus />Add</Button>
          </form>
        )}
      </CardBody>
    </Card>
  );
}
