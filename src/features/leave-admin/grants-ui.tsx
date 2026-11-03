"use client";
import * as React from "react";
import { Gift, Plus, Search } from "lucide-react";
import { Button } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Card, CardHeader } from "@/ui/card";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { ConfirmDialog, Modal } from "@/ui/overlay";
import { Banner, EmptyState } from "@/ui/feedback";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { toast } from "@/ui/toast";
import { cancelGrantAction, grantLeaveAction } from "@/app/(app)/settings/leave/actions";
import type { GrantRow } from "@/server/modules/leave/grants";
import { fmtDate, fmtNum } from "./labels";

const TONE: Record<GrantRow["status"], "success" | "neutral" | "warning"> = { active: "success", cancelled: "neutral", lapsed: "warning" };
const LABEL: Record<GrantRow["status"], string> = { active: "Active", cancelled: "Withdrawn", lapsed: "Lapsed" };

/** Grants of event-based leave: who got how many days for what, valid until when, and how much is used. */
export function GrantsSettings({ rows, people, types, today }: { rows: GrantRow[]; people: Person[]; types: { id: string; name: string }[]; today: string }) {
  const [adding, setAdding] = React.useState(false);
  const [cancelling, setCancelling] = React.useState<GrantRow | null>(null);
  const [q, setQ] = React.useState("");
  const term = q.trim().toLowerCase();
  const shown = term ? rows.filter((r) => [r.employee, r.event, r.type].some((x) => x.toLowerCase().includes(term))) : rows;
  return (
    <Card>
      <CardHeader title="Event-based leave" description="Marriage, bereavement and similar leave is granted per event: a number of days with a window to use them in. Unused days lapse when the window closes."
        action={<Button size="sm" onClick={() => setAdding(true)} disabled={!types.length}><Plus />Grant leave</Button>} />
      {!types.length && <Banner className="mx-5 mb-4" tone="info">Add an event-based leave type (Settings → Leave types, kind “Event based”) to a plan first, leaving its quota empty.</Banner>}
      <div className="px-5 pb-4"><Input leading={<Search />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, event or leave type" aria-label="Search grants" className="max-w-md" /></div>
      {shown.length === 0 ? (
        <EmptyState compact icon={<Gift />} title={term ? "No grants match" : "No grants yet"} description={term ? "Try another name or event." : "Grant someone days for an event and they can apply for them from their Leave page."} />
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {shown.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
              <span aria-hidden className="h-9 w-1 shrink-0 rounded-pill" style={{ background: r.color }} />
              <div className="min-w-0 flex-1">
                <p className="text-base font-medium">{r.employee} <span className="font-normal text-text-muted">· {r.type} · {r.event}</span></p>
                <p className="text-sm text-text-muted tabular">{fmtNum(r.days)} {r.days === 1 ? "day" : "days"} · {fmtNum(r.used)} used · {fmtDate(r.valid_from)} – {fmtDate(r.valid_to)}{r.note ? ` · “${r.note}”` : ""}</p>
              </div>
              <Badge tone={TONE[r.status]}>{LABEL[r.status]}</Badge>
              {r.status === "active" && <Button variant="ghost" size="sm" onClick={() => setCancelling(r)}>Withdraw</Button>}
            </li>
          ))}
        </ul>
      )}
      {adding && <GrantDialog people={people} types={types} today={today} onClose={() => setAdding(false)} />}
      {cancelling && (
        <ConfirmDialog open onOpenChange={(o) => !o && setCancelling(null)} title={`Withdraw ${cancelling.employee}'s grant?`} confirmLabel="Withdraw"
          description={`${fmtNum(cancelling.days - cancelling.used)} unused ${cancelling.days - cancelling.used === 1 ? "day goes" : "days go"} back. Leave already requested against it stays as it is.`}
          onConfirm={async () => { const r = await cancelGrantAction(cancelling.id); if (r.ok) toast.success("Grant withdrawn"); else toast.error(r.error); setCancelling(null); }} />
      )}
    </Card>
  );
}

function GrantDialog({ people, types, today, onClose }: { people: Person[]; types: { id: string; name: string }[]; today: string; onClose: () => void }) {
  const [employeeId, setEmployee] = React.useState<string[]>([]);
  const [typeId, setType] = React.useState(types[0]?.id ?? "");
  const [event, setEvent] = React.useState("");
  const [days, setDays] = React.useState("3");
  const [from, setFrom] = React.useState(today);
  const [to, setTo] = React.useState("");
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    setError(null);
    const r = await grantLeaveAction({ employeeId: employeeId[0], leaveTypeId: typeId, event, days: Number(days), validFrom: from, validTo: to, note: note || null });
    if (!r.ok) { setError(r.error); return; }
    toast.success("Leave granted", { description: "They've been told and can apply for it now." });
    onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Grant leave for an event" description="The days are credited now and can be used inside the window."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save} disabled={!employeeId.length || !typeId || !to}>Grant</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Person" required><EmployeePicker people={people} value={employeeId} onChange={(v) => setEmployee(v.slice(-1))} /></Field>
        <Field label="Leave type" required><Select value={typeId} onValueChange={setType} options={types.map((t) => ({ value: t.id, label: t.name }))} /></Field>
        <Field label="Event" required help="Shown to the person, e.g. Marriage, Bereavement, Paternity"><Input value={event} onChange={(e) => setEvent(e.target.value)} maxLength={80} /></Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Days" required><Input type="number" inputMode="decimal" min={0.5} max={365} step={0.5} value={days} onChange={(e) => setDays(e.target.value)} /></Field>
          <Field label="Use from" required><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Use until" required><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
        <Field label="Note"><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} rows={2} placeholder="Optional" /></Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
