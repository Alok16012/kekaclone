"use client";
import * as React from "react";
import { MoreHorizontal, Pencil, Plus, Trash2, Users, BadgeCheck } from "lucide-react";
import { Button, IconButton } from "@/ui/button";
import { Card, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Field, Input } from "@/ui/field";
import { Switch } from "@/ui/choice";
import { Menu, Modal } from "@/ui/overlay";
import { Banner, EmptyState, Skeleton } from "@/ui/feedback";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { toast } from "@/ui/toast";
import {
  deleteGroupAction, deleteGroupTypeAction, deleteProbationPolicyAction, groupMembersAction, saveGroupAction, saveGroupTypeAction, saveProbationPolicyAction, setGroupMembersAction,
} from "@/app/(app)/corehr/actions";

type GroupType = { id: string; name: string; groups: { id: string; name: string; people: number }[] };
type Policy = { id: string; name: string; duration_days: number; auto_confirm: boolean; people: number };
const act = async (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) => { const r = await fn(); if (r.ok) toast.success(ok); else toast.error(r.error); };

/** Groups (e.g. "Project: Apollo", "Committee: POSH") under group types, with members. */
export function GroupsSettings({ types, people, canEdit }: { types: GroupType[]; people: Person[]; canEdit: boolean }) {
  const [typeDialog, setTypeDialog] = React.useState<GroupType | "new" | null>(null);
  const [groupDialog, setGroupDialog] = React.useState<{ typeId: string; group: { id: string; name: string } | null } | null>(null);
  const [members, setMembers] = React.useState<{ id: string; name: string } | null>(null);
  return (
    <Card>
      <CardHeader title="Groups" description="Ways to group people beyond departments: projects, committees, interest clubs. Use them in policies and reports."
        action={canEdit ? <Button size="sm" onClick={() => setTypeDialog("new")}><Plus />Add group type</Button> : undefined} />
      {types.length === 0 ? <EmptyState compact icon={<Users />} title="No groups yet" description={canEdit ? "Start with a group type, for example “Project”." : undefined} /> : (
        <ul className="divide-y divide-border border-t border-border">
          {types.map((t) => (
            <li key={t.id} className="px-5 py-4">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-base font-semibold">{t.name}</h4>
                {canEdit && <Menu trigger={<IconButton label={`Actions for ${t.name}`} size="icon-sm"><MoreHorizontal /></IconButton>} items={[
                  { label: "Add a group", icon: <Plus />, onSelect: () => setGroupDialog({ typeId: t.id, group: null }) },
                  { label: "Rename", icon: <Pencil />, onSelect: () => setTypeDialog(t) },
                  { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => act(() => deleteGroupTypeAction(t.id), `${t.name} deleted`) },
                ]} />}
              </div>
              {t.groups.length === 0 ? <p className="text-sm text-text-muted">No groups yet.</p> : (
                <ul className="mt-2 flex flex-wrap gap-2">
                  {t.groups.map((g) => (
                    <li key={g.id} className="flex items-center gap-1 rounded-md border border-border py-1 pl-3 pr-1">
                      <button type="button" className="text-base hover:underline" onClick={() => setMembers(g)}>{g.name}</button>
                      <Badge><Users />{g.people}</Badge>
                      {canEdit && <Menu trigger={<IconButton label={`Actions for ${g.name}`} size="icon-sm"><MoreHorizontal /></IconButton>} items={[
                        { label: "Members", icon: <Users />, onSelect: () => setMembers(g) },
                        { label: "Rename", icon: <Pencil />, onSelect: () => setGroupDialog({ typeId: t.id, group: g }) },
                        { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => act(() => deleteGroupAction(g.id), `${g.name} deleted`) },
                      ]} />}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {typeDialog && <NameDialog title={typeDialog === "new" ? "New group type" : `Rename ${typeDialog.name}`} initial={typeDialog === "new" ? "" : typeDialog.name}
        onSave={(name) => saveGroupTypeAction(typeDialog === "new" ? null : typeDialog.id, name)} onClose={() => setTypeDialog(null)} />}
      {groupDialog && <NameDialog title={groupDialog.group ? `Rename ${groupDialog.group.name}` : "New group"} initial={groupDialog.group?.name ?? ""}
        onSave={(name) => saveGroupAction(groupDialog.group?.id ?? null, { typeId: groupDialog.typeId, name })} onClose={() => setGroupDialog(null)} />}
      {members && <MembersDialog group={members} people={people} canEdit={canEdit} onClose={() => setMembers(null)} />}
    </Card>
  );
}

function NameDialog({ title, initial, onSave, onClose }: { title: string; initial: string; onSave: (name: string) => Promise<{ ok: boolean; error?: string }>; onClose: () => void }) {
  const [name, setName] = React.useState(initial);
  const [pending, start] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={title} size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={() => start(async () => { const r = await onSave(name); if (!r.ok) setError(r.error ?? "Couldn't save."); else { toast.success("Saved"); onClose(); } })}>Save</Button></>}>
      <Field label="Name" required error={error ?? undefined}><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
    </Modal>
  );
}

function MembersDialog({ group, people, canEdit, onClose }: { group: { id: string; name: string }; people: Person[]; canEdit: boolean; onClose: () => void }) {
  const [ids, setIds] = React.useState<string[] | null>(null);
  const [pending, start] = React.useTransition();
  React.useEffect(() => { groupMembersAction(group.id).then((r) => setIds(r.ok ? r.data!.map((m) => m.id) : [])); }, [group.id]);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`${group.name}: members`}
      footer={canEdit ? <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!ids} onClick={() => start(async () => { const r = await setGroupMembersAction(group.id, ids!); if (r.ok) { toast.success(`${r.data!.count} ${r.data!.count === 1 ? "member" : "members"}`); onClose(); } else toast.error(r.error); })}>Save</Button></> : undefined}>
      {!ids ? <Skeleton className="h-10" /> : canEdit ? (
        <Field label="People"><EmployeePicker multiple people={people} value={ids} onChange={setIds} placeholder="Add people" /></Field>
      ) : ids.length ? <ul className="flex flex-col gap-1">{people.filter((p) => ids.includes(p.id)).map((p) => <li key={p.id}>{p.name}</li>)}</ul> : <p className="text-text-muted">No members yet.</p>}
    </Modal>
  );
}

/** Probation lengths and whether people are confirmed automatically when it ends. */
export function ProbationPolicies({ rows, canEdit }: { rows: Policy[]; canEdit: boolean }) {
  const [editing, setEditing] = React.useState<Policy | "new" | null>(null);
  return (
    <Card>
      <CardHeader title="Probation policies" description="Chosen in the add-employee wizard. With auto-confirm on, the nightly job confirms people the day after their probation ends."
        action={canEdit ? <Button size="sm" onClick={() => setEditing("new")}><Plus />Add policy</Button> : undefined} />
      {rows.length === 0 ? <EmptyState compact icon={<BadgeCheck />} title="No probation policies yet" /> : (
        <ul className="divide-y divide-border border-t border-border">
          {rows.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-base font-medium">{p.name}{p.auto_confirm && <Badge tone="accent">Auto-confirms</Badge>}</p>
                <p className="text-sm text-text-muted">{p.duration_days} days · {p.people} {p.people === 1 ? "person" : "people"}</p>
              </div>
              {canEdit && <Menu trigger={<IconButton label={`Actions for ${p.name}`} size="icon-sm"><MoreHorizontal /></IconButton>} items={[
                { label: "Edit", icon: <Pencil />, onSelect: () => setEditing(p) },
                { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => act(() => deleteProbationPolicyAction(p.id), `${p.name} deleted`) },
              ]} />}
            </li>
          ))}
        </ul>
      )}
      {editing && <PolicyDialog p={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function PolicyDialog({ p, onClose }: { p: Policy | null; onClose: () => void }) {
  const [v, setV] = React.useState({ name: p?.name ?? "", days: String(p?.duration_days ?? 90), auto: p?.auto_confirm ?? false });
  const [pending, start] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={p ? `Edit ${p.name}` : "New probation policy"} size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={() => start(async () => {
        const r = await saveProbationPolicyAction(p?.id ?? null, { name: v.name, durationDays: Number(v.days), autoConfirm: v.auto });
        if (!r.ok) setError(r.error); else { toast.success("Saved"); onClose(); }
      })}>Save</Button></>}>
      <div className="flex flex-col gap-4">
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Name" required><Input value={v.name} onChange={(e) => setV((s) => ({ ...s, name: e.target.value }))} placeholder="Standard (6 months)" /></Field>
        <Field label="Length in days"><Input type="number" min={0} max={730} value={v.days} onChange={(e) => setV((s) => ({ ...s, days: e.target.value }))} /></Field>
        <Switch label="Confirm automatically when it ends" checked={v.auto} onCheckedChange={(c) => setV((s) => ({ ...s, auto: !!c }))} />
      </div>
    </Modal>
  );
}
