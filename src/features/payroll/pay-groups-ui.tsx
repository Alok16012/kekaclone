"use client";
import * as React from "react";
import Link from "next/link";
import { CalendarClock, Layers, MoreHorizontal, Pencil, Plus, Trash2, UserPlus, Users } from "lucide-react";
import { Button, IconButton } from "@/ui/button";
import { Card, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { RadioGroup } from "@/ui/choice";
import { ConfirmDialog, Drawer, Menu, Modal } from "@/ui/overlay";
import { Banner, EmptyState, Skeleton } from "@/ui/feedback";
import { EmployeePicker } from "@/ui/employee-picker";
import { toast } from "@/ui/toast";
import { assignPayGroupAction, deletePayGroupAction, payGroupPeopleAction, savePayGroupAction } from "@/app/(app)/settings/payroll/actions";
import { PAYABLE_BASES } from "@/server/modules/payroll/rules";
import { BASIS_LABEL } from "./labels";

export type PayGroupItem = { id: string; name: string; legal_entity_id: string; legal_entity: string; attendance_cutoff_day: number; payable_days_basis: string; people: number; structures: number };

export function PayGroupsAdmin({ rows, entities }: { rows: PayGroupItem[]; entities: { id: string; name: string }[] }) {
  const [editing, setEditing] = React.useState<PayGroupItem | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<PayGroupItem | null>(null);
  const [people, setPeople] = React.useState<PayGroupItem | null>(null);
  return (
    <Card>
      <CardHeader title="Pay groups" description="People paid together, on the same cycle and rules. Each pay group belongs to one legal entity."
        action={<Button size="sm" onClick={() => setEditing("new")}><Plus />Add pay group</Button>} />
      {rows.length === 0 ? (
        <EmptyState compact icon={<Layers />} title="No pay groups yet" description="Create one for each legal entity or pay cycle you run."
          action={<Button size="sm" onClick={() => setEditing("new")}><Plus />Add a pay group</Button>} />
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-base font-medium"><span className="truncate">{r.name}</span><Badge>Monthly</Badge></p>
                <p className="text-sm text-text-muted">{r.legal_entity} · attendance cut-off on day {r.attendance_cutoff_day} · {BASIS_LABEL[r.payable_days_basis]?.toLowerCase()}</p>
                <p className="mt-1 flex flex-wrap gap-3 text-sm">
                  <span className="inline-flex items-center gap-1 text-text-muted"><Users className="size-3.5" aria-hidden />{r.people} {r.people === 1 ? "person" : "people"}</span>
                  <Link href={`/settings/payroll/structures?group=${r.id}`} className="inline-flex items-center gap-1 text-accent-text underline-offset-4 hover:underline"><Layers className="size-3.5" aria-hidden />{r.structures} {r.structures === 1 ? "structure" : "structures"}</Link>
                </p>
              </div>
              <Button size="sm" variant="secondary" onClick={() => setPeople(r)}><UserPlus />People</Button>
              <Menu trigger={<IconButton label={`Actions for ${r.name}`} size="icon-sm" variant="ghost"><MoreHorizontal /></IconButton>}
                items={[{ label: "Edit", icon: <Pencil />, onSelect: () => setEditing(r) }, { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setDeleting(r) }]} />
            </li>
          ))}
        </ul>
      )}
      {editing && <PayGroupDialog row={editing === "new" ? null : editing} entities={entities} onClose={() => setEditing(null)} />}
      {people && <PeopleDrawer group={people} onClose={() => setPeople(null)} />}
      {deleting && (
        <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting.name}?`}
          description={deleting.people ? "People are still in this pay group. Move them first." : "Its salary structures are deleted too. This can't be undone."}
          confirmLabel="Delete" onConfirm={async () => { const r = await deletePayGroupAction(deleting.id); if (r.ok) toast.success(`${deleting.name} deleted`); else toast.error(r.error); setDeleting(null); }} />
      )}
    </Card>
  );
}

function PayGroupDialog({ row, entities, onClose }: { row: PayGroupItem | null; entities: { id: string; name: string }[]; onClose: () => void }) {
  const [name, setName] = React.useState(row?.name ?? "");
  const [legalEntityId, setEntity] = React.useState(row?.legal_entity_id ?? entities[0]?.id ?? "");
  const [cutoff, setCutoff] = React.useState(String(row?.attendance_cutoff_day ?? 25));
  const [basis, setBasis] = React.useState(row?.payable_days_basis ?? "calendar");
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    const r = await savePayGroupAction(row?.id ?? null, { name, legalEntityId, cutoffDay: Number(cutoff), payableDaysBasis: basis });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success(row ? `${name} updated` : `${name} added`);
    onClose();
  });
  const fe = (f: string) => (error?.field === f ? error.message : undefined);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={row ? "Edit pay group" : "Add pay group"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>{row ? "Save" : "Add pay group"}</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <Field label="Name" required error={fe("name")}><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={80} placeholder="Monthly" /></Field>
        <Field label="Legal entity" required error={fe("legalEntityId")}><Select value={legalEntityId} onValueChange={setEntity} options={entities.map((e) => ({ value: e.id, label: e.name }))} /></Field>
        <Field label="Attendance cut-off day" required error={fe("cutoffDay")} help="Leave and attendance after this day count towards next month's pay.">
          <Input type="number" inputMode="numeric" min={1} max={31} value={cutoff} onChange={(e) => setCutoff(e.target.value)} className="w-28" />
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">A day&apos;s pay is the monthly amount divided by</legend>
          <RadioGroup value={basis} onValueChange={setBasis} options={PAYABLE_BASES.map((b) => ({ value: b, label: BASIS_LABEL[b] }))} />
        </fieldset>
        <p className="flex items-center gap-2 text-sm text-text-muted"><CalendarClock className="size-4" aria-hidden />Pay cycle: monthly.</p>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

type Member = { id: string; name: string; number: string; department: string | null; in_group: boolean; other_group: string | null; entity_ok: boolean };

function PeopleDrawer({ group, onClose }: { group: PayGroupItem; onClose: () => void }) {
  const [list, setList] = React.useState<Member[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pick, setPick] = React.useState<string[]>([]);
  const [pending, start] = React.useTransition();
  const load = React.useCallback(() => payGroupPeopleAction(group.id).then((r) => { if (r.ok) setList(r.data!); else setError(r.error); }), [group.id]);
  React.useEffect(() => { void load(); }, [load]);
  const members = list?.filter((m) => m.in_group) ?? [];
  const candidates = list?.filter((m) => !m.in_group && m.entity_ok) ?? [];
  const moving = candidates.filter((c) => pick.includes(c.id) && c.other_group);
  const add = () => start(async () => {
    const r = await assignPayGroupAction(group.id, pick);
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(`${r.data!.moved} added to ${group.name}`);
    setPick([]); await load();
  });
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={`${group.name}: people`} description={group.legal_entity}>
      {error ? <Banner tone="danger">{error}</Banner> : !list ? (
        <div className="flex flex-col gap-3" aria-busy aria-label="Loading people">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}</div>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <Field label="Add people" help="Only people in the same legal entity are listed.">
              <EmployeePicker multiple people={candidates.map((c) => ({ id: c.id, name: c.name, department: c.department, title: c.other_group ? `now in ${c.other_group}` : null }))} value={pick} onChange={setPick} />
            </Field>
            {moving.length > 0 && <Banner tone="warning">{moving.map((m) => m.name).join(", ")} will move from another pay group. Their current salary stays until you revise it on one of this group&apos;s structures.</Banner>}
            <Button size="sm" className="self-start" disabled={!pick.length} loading={pending} onClick={add}><UserPlus />Add {pick.length || ""}</Button>
          </div>
          {members.length === 0 ? <EmptyState compact icon={<Users />} title="No one in this pay group yet" /> : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {members.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <Link href={`/people/${m.id}?tab=finances`} className="min-w-0 truncate text-base hover:underline">{m.name}</Link>
                  <span className="shrink-0 text-sm text-text-muted tabular">{m.number}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Drawer>
  );
}
