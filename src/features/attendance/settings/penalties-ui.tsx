"use client";
import * as React from "react";
import { Gavel, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/ui/button";
import { Card, CardHeader } from "@/ui/card";
import { Checkbox, Segmented, Switch } from "@/ui/choice";
import { Field, Input } from "@/ui/field";
import { Banner, EmptyState } from "@/ui/feedback";
import { ConfirmDialog, Menu, Modal } from "@/ui/overlay";
import { toast } from "@/ui/toast";
import { deletePenaltyAction, savePenaltyAction } from "@/app/(app)/settings/time/actions";
import type { PenaltyRow } from "@/server/modules/attendance/policies";

type LeaveType = { id: string; name: string };
const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
const hours = (m: number) => (m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`);

function describe(r: PenaltyRow, types: LeaveType[]) {
  const out: string[] = [];
  if (r.late_arrival?.enabled) out.push(`late: ${r.late_arrival.free_per_month} free, then ${days(r.late_arrival.deduct_days)} each`);
  if (r.hours_shortage?.enabled) out.push(`short hours under ${hours(r.hours_shortage.full_day_minutes)}`);
  if (r.no_attendance?.enabled) out.push("no attendance = loss of pay");
  if (r.missing_swipe?.enabled) out.push(`missing swipe ${days(r.missing_swipe.deduct_days)}`);
  const from = r.deduct_from_leave_type_ids.map((id) => types.find((t) => t.id === id)?.name).filter(Boolean);
  out.push(from.length ? `from ${from.join(", then ")}, then loss of pay` : "from loss of pay");
  return out.join(" · ");
}

export function PenaltySettings({ rows, types, canEdit }: { rows: PenaltyRow[]; types: LeaveType[]; canEdit: boolean }) {
  const [editing, setEditing] = React.useState<PenaltyRow | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<PenaltyRow | null>(null);
  return (
    <Card>
      <CardHeader title="Penalties" description="What happens after late arrivals, short days, missed clock-outs and days without attendance. Checked every night for the day before."
        action={canEdit ? <Button size="sm" onClick={() => setEditing("new")}><Plus />Add policy</Button> : undefined} />
      {rows.length === 0 ? (
        <EmptyState compact icon={<Gavel />} title="No penalty policies" description="Without one, attendance is recorded but nothing is deducted." />
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-base font-medium">{r.name}</p>
                <p className="text-sm text-text-muted">{describe(r, types)} · {r.people} {r.people === 1 ? "person" : "people"}</p>
              </div>
              {canEdit && (
                <Menu trigger={<IconButton label={`Actions for ${r.name}`} size="icon-sm"><MoreHorizontal /></IconButton>}
                  items={[{ label: "Edit", icon: <Pencil />, onSelect: () => setEditing(r) }, { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setDeleting(r) }]} />
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <PenaltyDialog row={editing === "new" ? null : editing} types={types} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting.name}?`} description="Penalties already applied stay. People on this policy must be moved first." confirmLabel="Delete"
          onConfirm={async () => { const r = await deletePenaltyAction(deleting.id); if (r.ok) toast.success(`${deleting.name} deleted`); else toast.error(r.error); setDeleting(null); }} />
      )}
    </Card>
  );
}

type Half = "0.5" | "1";

function PenaltyDialog({ row, types, onClose }: { row: PenaltyRow | null; types: LeaveType[]; onClose: () => void }) {
  const [name, setName] = React.useState(row?.name ?? "");
  const [lateOn, setLateOn] = React.useState(row?.late_arrival?.enabled ?? true);
  const [lateGrace, setLateGrace] = React.useState(row?.late_arrival?.grace_minutes == null ? "" : String(row.late_arrival.grace_minutes));
  const [free, setFree] = React.useState(String(row?.late_arrival?.free_per_month ?? 3));
  const [lateDays, setLateDays] = React.useState<Half>(String(row?.late_arrival?.deduct_days ?? 0.5) as Half);
  const [shortOn, setShortOn] = React.useState(row?.hours_shortage?.enabled ?? false);
  const [basis, setBasis] = React.useState<"effective" | "gross">(row?.hours_shortage?.basis ?? "effective");
  const [full, setFull] = React.useState(String((row?.hours_shortage?.full_day_minutes ?? 480) / 60));
  const [half, setHalf] = React.useState(String((row?.hours_shortage?.half_day_minutes ?? 240) / 60));
  const [absentOn, setAbsentOn] = React.useState(row?.no_attendance?.enabled ?? true);
  const [swipeOn, setSwipeOn] = React.useState(row?.missing_swipe?.enabled ?? false);
  const [swipeDays, setSwipeDays] = React.useState<Half>(String(row?.missing_swipe?.deduct_days ?? 0.5) as Half);
  const [order, setOrder] = React.useState<string[]>(row?.deduct_from_leave_type_ids ?? []);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();

  const save = () => start(async () => {
    setError(null);
    const r = await savePenaltyAction(row?.id ?? null, {
      name,
      late_arrival: { enabled: lateOn, grace_minutes: lateGrace === "" ? null : Number(lateGrace), free_per_month: Number(free), deduct_days: Number(lateDays) },
      hours_shortage: { enabled: shortOn, basis, full_day_minutes: Math.round(Number(full) * 60), half_day_minutes: Math.round(Number(half) * 60) },
      no_attendance: { enabled: absentOn },
      missing_swipe: { enabled: swipeOn, deduct_days: Number(swipeDays) },
      deduct_from: order,
    });
    if (!r.ok) { setError(r.error); return; }
    toast.success(row ? `${name} updated` : `${name} added`);
    onClose();
  });
  const halfOpts = [{ value: "0.5" as const, label: "Half day" }, { value: "1" as const, label: "Full day" }];

  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="lg" title={row ? "Edit penalty policy" : "Add penalty policy"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>{row ? "Save" : "Add policy"}</Button></>}>
      <form className="flex flex-col gap-6" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus placeholder="e.g. Standard" /></Field>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-base font-semibold">Late arrival</legend>
          <Switch label="Penalise late arrivals" checked={lateOn} onCheckedChange={setLateOn} />
          {lateOn && (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Grace (minutes)" help="Empty = the shift's grace"><Input type="number" inputMode="numeric" min={0} max={180} value={lateGrace} onChange={(e) => setLateGrace(e.target.value)} /></Field>
              <Field label="Free late arrivals a month"><Input type="number" inputMode="numeric" min={0} max={31} value={free} onChange={(e) => setFree(e.target.value)} /></Field>
              <div className="flex flex-col gap-1.5"><span className="text-sm font-medium">Each one after that costs</span><Segmented label="Deduction per late arrival" value={lateDays} onChange={setLateDays} options={halfOpts} /></div>
            </div>
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-base font-semibold">Short hours</legend>
          <Switch label="Penalise days with too few hours" checked={shortOn} onCheckedChange={setShortOn} />
          {shortOn && (
            <>
              <Segmented label="Hours counted" value={basis} onChange={setBasis} options={[{ value: "effective", label: "Effective (in → out pairs)" }, { value: "gross", label: "Gross (first in → last out)" }]} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Full day needs (hours)" help="Less than this costs half a day"><Input type="number" inputMode="decimal" min={1} max={16} step={0.5} value={full} onChange={(e) => setFull(e.target.value)} /></Field>
                <Field label="Half day needs (hours)" help="Less than this costs a full day"><Input type="number" inputMode="decimal" min={0.5} max={12} step={0.5} value={half} onChange={(e) => setHalf(e.target.value)} /></Field>
              </div>
            </>
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-base font-semibold">No attendance and missing swipes</legend>
          <Switch label="A working day with no clock-in and no leave is loss of pay" checked={absentOn} onCheckedChange={setAbsentOn} />
          <Switch label="Penalise clocking in without clocking out" checked={swipeOn} onCheckedChange={setSwipeOn} />
          {swipeOn && <div className="flex flex-col gap-1.5"><span className="text-sm font-medium">A missing swipe costs</span><Segmented label="Deduction for a missing swipe" value={swipeDays} onChange={setSwipeDays} options={halfOpts} /></div>}
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-base font-semibold">Deduct from</legend>
          <p className="text-sm text-text-muted">Leave is used in the order you tick it. When there&apos;s no balance left, the rest is loss of pay.</p>
          {types.length === 0 && <p className="text-sm text-text-muted">No leave types yet, so everything is loss of pay.</p>}
          {types.map((t) => {
            const pos = order.indexOf(t.id);
            return (
              <div key={t.id} className="flex items-center gap-3">
                <Checkbox label={t.name} checked={pos >= 0} onCheckedChange={(c) => setOrder((o) => (c ? [...o, t.id] : o.filter((x) => x !== t.id)))} />
                {pos >= 0 && <span className="text-sm text-text-muted">{pos === 0 ? "used first" : `then (${pos + 1})`}</span>}
              </div>
            );
          })}
        </fieldset>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
