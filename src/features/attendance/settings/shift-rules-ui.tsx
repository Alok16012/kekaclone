"use client";
import * as React from "react";
import { MoreHorizontal, Pencil, Plus, Repeat, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Card, CardHeader } from "@/ui/card";
import { Checkbox, Switch } from "@/ui/choice";
import { Field, Input } from "@/ui/field";
import { Banner, EmptyState } from "@/ui/feedback";
import { ConfirmDialog, Menu, Modal } from "@/ui/overlay";
import { toast } from "@/ui/toast";
import { deleteShiftRuleAction, saveShiftRuleAction } from "@/app/(app)/settings/time/actions";
import type { ShiftRuleRow } from "@/server/modules/attendance/roster";

type Shift = { id: string; name: string; code: string };

/** Rules for employees' shift-change and weekly-off-swap requests. The first rule is the company default. */
export function ShiftRulesSettings({ rows, shifts, canEdit }: { rows: ShiftRuleRow[]; shifts: Shift[]; canEdit: boolean }) {
  const [editing, setEditing] = React.useState<ShiftRuleRow | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<ShiftRuleRow | null>(null);
  return (
    <Card>
      <CardHeader title="Shift & weekly-off change rules" description="What people may ask for from their attendance page: which shifts, how far ahead, how often a month, and whether off days can be included. Without a rule, any shift can be asked for up to 60 days ahead."
        action={canEdit ? <Button size="sm" onClick={() => setEditing("new")}><Plus />Add rule</Button> : undefined} />
      {rows.length === 0 ? <EmptyState compact icon={<Repeat />} title="No rules yet" description="Requests are allowed with the defaults until a rule is added." /> : (
        <ul className="divide-y divide-border border-t border-border">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-base font-medium">{r.name} {r.is_default && <Badge tone="success">In force</Badge>}</p>
                <p className="text-sm text-text-muted">
                  {r.allowed.length ? `Shifts: ${r.allowed.join(", ")}` : "Any shift"} · {r.request_window_days == null ? "no window limit" : `up to ${r.request_window_days} days ahead`} · {r.max_requests_per_month == null ? "no monthly cap" : `${r.max_requests_per_month} a month`} · {r.allow_on_off_days ? "off days allowed" : "working days only"}
                </p>
              </div>
              {canEdit && <Menu trigger={<IconButton label={`Actions for ${r.name}`} size="icon-sm"><MoreHorizontal /></IconButton>}
                items={[{ label: "Edit", icon: <Pencil />, onSelect: () => setEditing(r) }, { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setDeleting(r) }]} />}
            </li>
          ))}
        </ul>
      )}
      {editing && <RuleDialog row={editing === "new" ? null : editing} shifts={shifts} onClose={() => setEditing(null)} />}
      {deleting && <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting.name}?`} description="Requests already made are unaffected." confirmLabel="Delete"
        onConfirm={async () => { const r = await deleteShiftRuleAction(deleting.id); if (r.ok) toast.success("Rule deleted"); else toast.error(r.error); setDeleting(null); }} />}
    </Card>
  );
}

function RuleDialog({ row, shifts, onClose }: { row: ShiftRuleRow | null; shifts: Shift[]; onClose: () => void }) {
  const [name, setName] = React.useState(row?.name ?? "");
  const [allowed, setAllowed] = React.useState<string[]>(row?.allowed_shift_ids ?? []);
  const [windowDays, setWindow] = React.useState(row?.request_window_days == null ? "30" : String(row.request_window_days));
  const [perMonth, setPerMonth] = React.useState(row?.max_requests_per_month == null ? "2" : String(row.max_requests_per_month));
  const [offDays, setOffDays] = React.useState(row?.allow_on_off_days ?? false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    setError(null);
    const r = await saveShiftRuleAction(row?.id ?? null, { name, allowedShiftIds: allowed, requestWindowDays: windowDays === "" ? null : Number(windowDays), maxRequestsPerMonth: perMonth === "" ? null : Number(perMonth), allowOnOffDays: offDays });
    if (!r.ok) { setError(r.error); return; }
    toast.success(row ? "Rule updated" : "Rule added"); onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={row ? "Edit rule" : "Add rule"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>{row ? "Save" : "Add rule"}</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus placeholder="e.g. Standard" /></Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Shifts people may ask for <span className="font-normal text-text-muted">(none ticked = any)</span></legend>
          {shifts.map((s) => <Checkbox key={s.id} label={`${s.name} (${s.code})`} checked={allowed.includes(s.id)} onCheckedChange={(c) => setAllowed((ids) => c ? [...ids, s.id] : ids.filter((x) => x !== s.id))} />)}
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Request window (days ahead)" help="Blank = no limit"><Input type="number" inputMode="numeric" min={0} max={365} value={windowDays} onChange={(e) => setWindow(e.target.value)} /></Field>
          <Field label="Requests per month" help="Blank = no cap"><Input type="number" inputMode="numeric" min={0} max={31} value={perMonth} onChange={(e) => setPerMonth(e.target.value)} /></Field>
        </div>
        <Switch label="Allow shift changes that include weekly offs or holidays" checked={offDays} onCheckedChange={setOffDays} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
