"use client";
import * as React from "react";
import { MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/ui/button";
import { Card, CardHeader } from "@/ui/card";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { ConfirmDialog, Menu, Modal } from "@/ui/overlay";
import { Banner, EmptyState } from "@/ui/feedback";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { toast } from "@/ui/toast";
import { deleteMasterAction, saveMasterAction } from "@/app/(app)/actions";
import type { MasterRow } from "@/server/modules/settings/org";

type Props = { kind: string; label: string; plural: string; rows: MasterRow[]; people: Person[]; canEdit: boolean; description: string };

export function MasterTable({ kind, label, plural, rows, people, canEdit, description }: Props) {
  const [editing, setEditing] = React.useState<MasterRow | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<MasterRow | null>(null);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return (
    <Card>
      <CardHeader title={plural} description={description} action={canEdit ? <Button size="sm" onClick={() => setEditing("new")}><Plus />Add {label.toLowerCase()}</Button> : undefined} />
      {rows.length === 0 ? (
        <EmptyState compact title={`No ${plural.toLowerCase()} yet`} description={canEdit ? `Add your first ${label.toLowerCase()} to start organising people.` : undefined} />
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-medium">{r.name}</p>
                <p className="text-sm text-text-muted">
                  {r.people} {r.people === 1 ? "person" : "people"}
                  {kind === "departments" && r.parent_id && byId.get(r.parent_id) ? ` · under ${byId.get(r.parent_id)!.name}` : ""}
                  {kind === "departments" && r.head ? ` · head: ${r.head}` : ""}
                  {kind === "locations" && r.state_code ? ` · state ${r.state_code}` : ""}
                </p>
              </div>
              {canEdit && (
                <Menu trigger={<IconButton label={`Actions for ${r.name}`} size="icon-sm"><MoreHorizontal /></IconButton>}
                  items={[{ label: "Edit", icon: <Pencil />, onSelect: () => setEditing(r) }, { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setDeleting(r) }]} />
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <MasterDialog kind={kind} label={label} row={editing === "new" ? null : editing} rows={rows} people={people} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting.name}?`}
          description={deleting.people ? `${deleting.people} ${deleting.people === 1 ? "person is" : "people are"} assigned here, so it can't be deleted yet. Move them first.` : "This can't be undone."}
          confirmLabel="Delete" onConfirm={async () => { const r = await deleteMasterAction(kind, deleting.id); if (r.ok) toast.success(`${deleting.name} deleted`); else toast.error(r.error); setDeleting(null); }} />
      )}
    </Card>
  );
}

function MasterDialog({ kind, label, row, rows, people, onClose }: { kind: string; label: string; row: MasterRow | null; rows: MasterRow[]; people: Person[]; onClose: () => void }) {
  const [name, setName] = React.useState(row?.name ?? "");
  const [parentId, setParentId] = React.useState<string | null>(row?.parent_id ?? null);
  const [headId, setHeadId] = React.useState<string | null>(row?.head_id ?? null);
  const [stateCode, setStateCode] = React.useState(row?.state_code ?? "");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    const r = await saveMasterAction(kind, row?.id ?? null, { name, parentId, headId, stateCode: stateCode || null });
    if (!r.ok) { setError(r.error); return; }
    toast.success(row ? `${name} updated` : `${name} added`);
    onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="sm" title={row ? `Edit ${label.toLowerCase()}` : `Add ${label.toLowerCase()}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>{row ? "Save" : "Add"}</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} /></Field>
        {kind === "departments" && (
          <>
            <Field label="Part of" help="Leave empty for a top-level department">
              <Select value={parentId ?? "none"} onValueChange={(v) => setParentId(v === "none" ? null : v)}
                options={[{ value: "none", label: "Top level" }, ...rows.filter((r) => r.id !== row?.id).map((r) => ({ value: r.id, label: r.name }))]} />
            </Field>
            <Field label="Department head"><EmployeePicker people={people} value={headId ? [headId] : []} onChange={(ids) => setHeadId(ids[0] ?? null)} placeholder="Choose a person" /></Field>
          </>
        )}
        {kind === "locations" && <Field label="State code" help="Used for professional tax and labour welfare fund, e.g. KA, MH"><Input value={stateCode} onChange={(e) => setStateCode(e.target.value)} maxLength={5} className="uppercase" /></Field>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
