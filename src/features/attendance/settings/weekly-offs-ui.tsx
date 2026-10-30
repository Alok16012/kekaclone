"use client";
import * as React from "react";
import { CalendarOff, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button, IconButton } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Card, CardHeader } from "@/ui/card";
import { Field, Input } from "@/ui/field";
import { Banner, EmptyState } from "@/ui/feedback";
import { ConfirmDialog, Menu, Modal } from "@/ui/overlay";
import { toast } from "@/ui/toast";
import { deleteWeeklyOffAction, saveWeeklyOffAction } from "@/app/(app)/settings/time/actions";
import type { WeeklyOffRow } from "@/server/modules/attendance/policies";

type V = "off" | "half" | "work";
const DAYS = [["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]] as const;
type Day = (typeof DAYS)[number][0];
const WEEKS = ["1st", "2nd", "3rd", "4th", "5th"];
const NEXT: Record<V, V> = { work: "off", off: "half", half: "work" };
const LABEL: Record<V, string> = { work: "Work", off: "Off", half: "Half" };
const CELL: Record<V, string> = { work: "bg-surface text-text-muted", off: "bg-neutral-soft text-neutral-text font-semibold", half: "bg-warning-soft text-warning-text font-semibold" };

const toGrid = (p: WeeklyOffRow["pattern"]) => Object.fromEntries(DAYS.map(([d]) => {
  const v = p[d];
  return [d, Array.isArray(v) ? [0, 1, 2, 3, 4].map((i) => v[i] ?? "work") : Array<V>(5).fill((v as V) ?? "work")];
})) as Record<Day, V[]>;

function describe(p: WeeklyOffRow["pattern"]) {
  const parts = DAYS.flatMap(([d, label]) => {
    const v = p[d];
    if (!v) return [];
    if (!Array.isArray(v)) return v === "work" ? [] : [`${label}${v === "half" ? " (half)" : ""}`];
    const offs = v.map((x, i) => (x === "work" ? null : `${WEEKS[i]}${x === "half" ? " half" : ""}`)).filter(Boolean);
    return offs.length ? [`${offs.join(", ")} ${label}`] : [];
  });
  return parts.length ? `Off: ${parts.join(" · ")}` : "No weekly offs";
}

export function WeeklyOffSettings({ rows, canEdit }: { rows: WeeklyOffRow[]; canEdit: boolean }) {
  const [editing, setEditing] = React.useState<WeeklyOffRow | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<WeeklyOffRow | null>(null);
  return (
    <Card>
      <CardHeader title="Weekly offs" description="Which days are off, week by week. Use this for alternate or 2nd and 4th Saturdays."
        action={canEdit ? <Button size="sm" onClick={() => setEditing("new")}><Plus />Add policy</Button> : undefined} />
      {rows.length === 0 ? (
        <EmptyState compact icon={<CalendarOff />} title="No weekly-off policies yet" description={canEdit ? "Add one so weekends don't count as absences." : undefined} />
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-base font-medium">{r.name}{r.is_default && <Badge tone="success">Default</Badge>}</p>
                <p className="text-sm text-text-muted">{describe(r.pattern)} · {r.people} {r.people === 1 ? "person" : "people"}</p>
              </div>
              {canEdit && (
                <Menu trigger={<IconButton label={`Actions for ${r.name}`} size="icon-sm"><MoreHorizontal /></IconButton>}
                  items={[{ label: "Edit", icon: <Pencil />, onSelect: () => setEditing(r) }, { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setDeleting(r) }]} />
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <WeeklyOffDialog row={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting.name}?`} description="Policies that have been assigned to people can't be deleted." confirmLabel="Delete"
          onConfirm={async () => { const r = await deleteWeeklyOffAction(deleting.id); if (r.ok) toast.success(`${deleting.name} deleted`); else toast.error(r.error); setDeleting(null); }} />
      )}
    </Card>
  );
}

function WeeklyOffDialog({ row, onClose }: { row: WeeklyOffRow | null; onClose: () => void }) {
  const [name, setName] = React.useState(row?.name ?? "");
  const [grid, setGrid] = React.useState<Record<Day, V[]>>(toGrid(row?.pattern ?? { sat: "off", sun: "off" }));
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const cycle = (d: Day, i: number) => setGrid((g) => ({ ...g, [d]: g[d].map((v, k) => (k === i ? NEXT[v] : v)) }));
  const setRow = (d: Day, v: V) => setGrid((g) => ({ ...g, [d]: Array<V>(5).fill(v) }));
  const save = () => start(async () => {
    setError(null);
    const r = await saveWeeklyOffAction(row?.id ?? null, { name, grid });
    if (!r.ok) { setError(r.error); return; }
    toast.success(row ? `${name} updated` : `${name} added`);
    onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="lg" title={row ? "Edit weekly offs" : "Add weekly-off policy"}
      description="Click a cell to switch it between working, off and half day. Columns are the 1st to 5th time that weekday falls in a month."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>{row ? "Save" : "Add policy"}</Button></>}>
      <form className="flex flex-col gap-5" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus placeholder="e.g. 2nd and 4th Saturdays off" /></Field>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[30rem] border-collapse text-sm">
            <caption className="sr-only">Weekly-off grid: weekdays by week of the month</caption>
            <thead><tr><th scope="col" className="py-1.5 pr-2 text-left font-medium text-text-muted">Day</th>{WEEKS.map((w) => <th key={w} scope="col" className="px-1 py-1.5 font-medium text-text-muted">{w}</th>)}<th scope="col" className="sr-only">Whole row</th></tr></thead>
            <tbody>
              {DAYS.map(([d, label]) => (
                <tr key={d}>
                  <th scope="row" className="py-1 pr-2 text-left font-medium">{label}</th>
                  {grid[d].map((v, i) => (
                    <td key={i} className="p-0.5">
                      <button type="button" onClick={() => cycle(d, i)} aria-label={`${WEEKS[i]} ${label}: ${LABEL[v]}. Click to change.`}
                        className={cn("h-9 w-full rounded-sm border border-border text-sm transition-colors duration-fast hover:border-text-muted", CELL[v])}>{LABEL[v]}</button>
                    </td>
                  ))}
                  <td className="whitespace-nowrap pl-2">
                    <Menu trigger={<IconButton label={`Set every ${label}`} size="icon-sm"><MoreHorizontal /></IconButton>}
                      items={[{ label: `Every ${label} working`, onSelect: () => setRow(d, "work") }, { label: `Every ${label} off`, onSelect: () => setRow(d, "off") }, { label: `Every ${label} half day`, onSelect: () => setRow(d, "half") }]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
