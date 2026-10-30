"use client";
import * as React from "react";
import { Clock, Copy, MoreHorizontal, Moon, Pencil, Plus, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Card, CardHeader } from "@/ui/card";
import { Checkbox, Segmented } from "@/ui/choice";
import { Field, Input } from "@/ui/field";
import { Banner, EmptyState } from "@/ui/feedback";
import { ConfirmDialog, Menu, Modal } from "@/ui/overlay";
import { toast } from "@/ui/toast";
import { deleteShiftAction, saveShiftAction } from "@/app/(app)/settings/time/actions";
import type { ShiftRow } from "@/server/modules/attendance/policies";

const DAYS = [["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]] as const;
type Day = (typeof DAYS)[number][0];
const overnight = (t: { start: string; end: string }) => t.end <= t.start;

/** "Mon–Fri 09:30–18:30" style summary, grouping consecutive days with the same timing. */
function timingSummary(timings: ShiftRow["timings"]) {
  const groups: { days: string[]; t: string }[] = [];
  let cur: { days: string[]; t: string } | null = null;
  for (const [d, label] of DAYS) {
    const t = timings[d];
    if (!t) { cur = null; continue; }
    const key = `${t.start}–${t.end}${overnight(t) ? " (next day)" : ""}`;
    if (cur && cur.t === key) cur.days.push(label.slice(0, 3));
    else { cur = { days: [label.slice(0, 3)], t: key }; groups.push(cur); }
  }
  return groups.map((g) => `${g.days.length > 2 ? `${g.days[0]}–${g.days[g.days.length - 1]}` : g.days.join(", ")} ${g.t}`).join(" · ") || "No working days";
}

export function ShiftsSettings({ rows, canEdit }: { rows: ShiftRow[]; canEdit: boolean }) {
  const [editing, setEditing] = React.useState<ShiftRow | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<ShiftRow | null>(null);
  return (
    <Card>
      <CardHeader title="Shifts" description="Working hours per weekday. A shift that ends at or before it starts runs past midnight and counts for the day it started."
        action={canEdit ? <Button size="sm" onClick={() => setEditing("new")}><Plus />Add shift</Button> : undefined} />
      {rows.length === 0 ? (
        <EmptyState compact icon={<Clock />} title="No shifts yet" description={canEdit ? "Add a shift so arrivals can be checked against it." : undefined} />
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-base font-medium">
                  {r.name} <span className="text-sm font-normal text-text-muted">{r.code}</span>
                  {r.kind === "flexible" && <Badge>Flexible</Badge>}
                  {Object.values(r.timings).some((t) => t && overnight(t)) && <Badge tone="accent"><Moon />Overnight</Badge>}
                  {r.is_default && <Badge tone="success">Default</Badge>}
                </p>
                <p className="text-sm text-text-muted">{timingSummary(r.timings)} · break {r.break_minutes}m · grace {r.grace_minutes}m · {r.people} {r.people === 1 ? "person" : "people"}</p>
              </div>
              {canEdit && (
                <Menu trigger={<IconButton label={`Actions for ${r.name}`} size="icon-sm"><MoreHorizontal /></IconButton>}
                  items={[{ label: "Edit", icon: <Pencil />, onSelect: () => setEditing(r) }, { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setDeleting(r) }]} />
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <ShiftDialog row={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting.name}?`}
          description="Shifts that people have worked can't be deleted, so their history stays correct." confirmLabel="Delete"
          onConfirm={async () => { const r = await deleteShiftAction(deleting.id); if (r.ok) toast.success(`${deleting.name} deleted`); else toast.error(r.error); setDeleting(null); }} />
      )}
    </Card>
  );
}

function ShiftDialog({ row, onClose }: { row: ShiftRow | null; onClose: () => void }) {
  const [name, setName] = React.useState(row?.name ?? "");
  const [code, setCode] = React.useState(row?.code ?? "");
  const [kind, setKind] = React.useState<"fixed" | "flexible">(row?.kind ?? "fixed");
  const [timings, setTimings] = React.useState<Partial<Record<Day, { start: string; end: string } | null>>>(
    row?.timings ?? Object.fromEntries(DAYS.slice(0, 5).map(([d]) => [d, { start: "09:30", end: "18:30" }])),
  );
  const [brk, setBrk] = React.useState(String(row?.break_minutes ?? 60));
  const [grace, setGrace] = React.useState(String(row?.grace_minutes ?? 15));
  const [half, setHalf] = React.useState(row?.half_day_minutes == null ? "" : String(row.half_day_minutes));
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const setDay = (d: Day, v: { start: string; end: string } | null) => setTimings((t) => ({ ...t, [d]: v }));
  const copyMonday = () => { const m = timings.mon; if (m) setTimings((t) => Object.fromEntries(DAYS.map(([d]) => [d, t[d] ? { ...m } : null]))); };

  const save = () => start(async () => {
    setError(null);
    const r = await saveShiftAction(row?.id ?? null, {
      name, code, kind, timings: Object.fromEntries(DAYS.map(([d]) => [d, timings[d] ?? null])),
      break_minutes: Number(brk), grace_minutes: Number(grace), half_day_minutes: half === "" ? null : Number(half),
    });
    if (!r.ok) { setError(r.error); return; }
    toast.success(row ? `${name} updated` : `${name} added`);
    onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="lg" title={row ? "Edit shift" : "Add shift"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>{row ? "Save" : "Add shift"}</Button></>}>
      <form className="flex flex-col gap-5" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && <Banner tone="danger">{error}</Banner>}
        <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
          <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus placeholder="e.g. Night" /></Field>
          <Field label="Code" required help="Letters and numbers"><Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={12} className="uppercase" placeholder="NIGHT" /></Field>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Type</span>
          <Segmented label="Shift type" value={kind} onChange={setKind} options={[{ value: "fixed", label: "Fixed start time" }, { value: "flexible", label: "Flexible hours" }]} />
          <p className="text-sm text-text-muted">{kind === "fixed" ? "Arriving after the start time plus grace counts as late." : "No late arrivals; only the hours worked matter."}</p>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 flex w-full items-center justify-between text-sm font-medium">
            Timings
            <Button type="button" variant="ghost" size="sm" onClick={copyMonday} disabled={!timings.mon}><Copy />Copy Monday to working days</Button>
          </legend>
          {DAYS.map(([d, label]) => {
            const t = timings[d];
            return (
              <div key={d} className="grid grid-cols-[7.5rem_1fr] items-center gap-3 sm:grid-cols-[9rem_1fr_1fr_auto]">
                <Checkbox label={label} checked={!!t} onCheckedChange={(c) => setDay(d, c ? (timings.mon ?? { start: "09:30", end: "18:30" }) : null)} />
                {t ? (
                  <>
                    <div className="col-start-2 flex gap-2 sm:contents">
                      <Input type="time" aria-label={`${label} start`} value={t.start} onChange={(e) => setDay(d, { ...t, start: e.target.value })} />
                      <Input type="time" aria-label={`${label} end`} value={t.end} onChange={(e) => setDay(d, { ...t, end: e.target.value })} />
                    </div>
                    <span className="col-start-2 text-sm text-text-muted sm:col-start-auto">{overnight(t) ? "ends next day" : ""}</span>
                  </>
                ) : <span className="text-sm text-text-muted sm:col-span-3">Not a working day on this shift</span>}
              </div>
            );
          })}
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Break (minutes)"><Input type="number" inputMode="numeric" min={0} max={240} value={brk} onChange={(e) => setBrk(e.target.value)} /></Field>
          <Field label="Grace (minutes)" help="Late only after this"><Input type="number" inputMode="numeric" min={0} max={180} value={grace} onChange={(e) => setGrace(e.target.value)} /></Field>
          <Field label="Half day (minutes)" help="Minimum for a half day"><Input type="number" inputMode="numeric" min={30} max={720} value={half} onChange={(e) => setHalf(e.target.value)} placeholder="240" /></Field>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
