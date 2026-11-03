"use client";
import * as React from "react";
import { CalendarClock, CalendarPlus, Check, Lock, Repeat, Trash2, Users } from "lucide-react";
import type { MeetingRow } from "@/server/modules/performance/one-on-ones";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { Card } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Modal, Drawer, ConfirmDialog } from "@/ui/overlay";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Checkbox } from "@/ui/choice";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { EmptyState, Skeleton } from "@/ui/feedback";
import { Avatar } from "@/ui/avatar";
import { toast } from "@/ui/toast";
import {
  addMeetingItemAction, cancelMeetingAction, completeMeetingAction, deleteMeetingItemAction, meetingDetailAction, rescheduleMeetingAction, saveMeetingNotesAction,
  scheduleOneOnOneAction, setActionDoneAction,
} from "@/app/(app)/me/performance/actions";
import { fmtDate, fmtDateTime } from "./bits";

const REPEAT: Record<string, string> = { weekly: "Every week", biweekly: "Every two weeks", monthly: "Every month" };

export function OneOnOnesView({ meetings, people, now, openId, openNew }: { meetings: MeetingRow[]; people: Person[]; now: string; openId: string | null; openNew: boolean }) {
  const [open, setOpen] = React.useState<string | null>(openId);
  const [scheduling, setScheduling] = React.useState(openNew);
  const upcoming = meetings.filter((m) => m.status === "scheduled" && m.ends_at >= now).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const past = meetings.filter((m) => !(m.status === "scheduled" && m.ends_at >= now));
  return (
    <>
      <div className="mb-4 flex justify-end"><Button size="sm" onClick={() => setScheduling(true)}><CalendarPlus />Schedule a 1:1</Button></div>
      <Tabs defaultValue="upcoming">
        <TabsList items={[{ value: "upcoming", label: "Upcoming", count: upcoming.length }, { value: "past", label: "Past" }]} />
        <TabsContent value="upcoming"><MeetingList rows={upcoming} onOpen={setOpen} empty="No 1:1s coming up. Regular check-ins with your manager or team are the easiest habit to keep." /></TabsContent>
        <TabsContent value="past"><MeetingList rows={past} onOpen={setOpen} empty="Past and cancelled meetings show up here." /></TabsContent>
      </Tabs>
      {scheduling && <ScheduleDialog people={people} onClose={() => setScheduling(false)} onCreated={(id) => setOpen(id)} />}
      {open && <MeetingDrawer id={open} onClose={() => setOpen(null)} onOpen={setOpen} />}
    </>
  );
}

function MeetingList({ rows, onOpen, empty }: { rows: MeetingRow[]; onOpen: (id: string) => void; empty: string }) {
  if (!rows.length) return <Card><EmptyState icon={<Users />} title="Nothing here" description={empty} /></Card>;
  return (
    <Card>
      <ul className="divide-y divide-border">
        {rows.map((m) => (
          <li key={m.id}>
            <button type="button" onClick={() => onOpen(m.id)} className="flex w-full items-center gap-3 px-5 py-3.5 text-left hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none">
              <Avatar name={m.with_name} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-medium">{m.with_name}{m.purpose ? <span className="font-normal text-text-muted"> · {m.purpose}</span> : null}</p>
                <p className="text-sm text-text-muted">{fmtDateTime(m.starts_at)}{m.recurrence ? ` · ${REPEAT[m.recurrence]}` : ""}{m.agenda ? ` · ${m.agenda} talking point${m.agenda === 1 ? "" : "s"}` : ""}</p>
              </div>
              {m.open_actions > 0 && <Badge tone="warning">{m.open_actions} open action{m.open_actions === 1 ? "" : "s"}</Badge>}
              {m.status !== "scheduled" && <Badge tone={m.status === "completed" ? "success" : "neutral"}>{m.status === "completed" ? "Done" : "Cancelled"}</Badge>}
              {m.recurrence && <Repeat className="size-4 text-text-muted" aria-label="Repeats" />}
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function ScheduleDialog({ people, onClose, onCreated }: { people: Person[]; onClose: () => void; onCreated: (id: string) => void }) {
  const [who, setWho] = React.useState<string[]>([]);
  const [when, setWhen] = React.useState(() => { const d = new Date(Date.now() + 86400e3); d.setMinutes(0, 0, 0); d.setHours(11); return localInput(d); });
  const [mins, setMins] = React.useState("30");
  const [rec, setRec] = React.useState("weekly");
  const [purpose, setPurpose] = React.useState("");
  const [agenda, setAgenda] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    const startsAt = new Date(when);
    const r = await scheduleOneOnOneAction({ attendeeId: who[0], startsAt: Number.isNaN(startsAt.getTime()) ? "" : startsAt.toISOString(), durationMins: Number(mins), recurrence: rec === "none" ? null : rec,
      purpose: purpose || null, agenda: agenda.split("\n").map((s) => s.trim()).filter(Boolean) });
    setBusy(false);
    if (r.ok) { toast.success("1:1 scheduled"); onClose(); onCreated(r.data!.id); } else setErr(r.error);
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Schedule a 1:1" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save}>Schedule</Button></>}>
      <div className="flex flex-col gap-4">
        {err && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{err}</p>}
        <Field label="With" required><EmployeePicker people={people} value={who} onChange={setWho} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date and time" required><Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
          <Field label="Length"><Select value={mins} onValueChange={setMins} options={[15, 30, 45, 60].map((m) => ({ value: String(m), label: `${m} minutes` }))} /></Field>
        </div>
        <Field label="Repeats"><Select value={rec} onValueChange={setRec} options={[{ value: "none", label: "Doesn't repeat" }, ...Object.entries(REPEAT).map(([value, label]) => ({ value, label }))]} /></Field>
        <Field label="Purpose" help="Optional, e.g. weekly catch-up"><Input value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={200} /></Field>
        <Field label="Talking points" help="One per line. Both of you can add more later."><Textarea value={agenda} onChange={(e) => setAgenda(e.target.value)} rows={3} /></Field>
      </div>
    </Modal>
  );
}

type Detail = {
  id: string; organizerId: string; attendeeId: string; people: { id: string; name: string }[]; isOrganizer: boolean; startsAt: string; endsAt: string; recurrence: string | null; purpose: string | null;
  sharedNotes: string; status: "scheduled" | "completed" | "cancelled"; history: { id: string; starts_at: string; status: string }[];
  items: { id: string; kind: "agenda" | "private_note" | "action_item"; body: string; author_id: string; author: string; assignee_id: string | null; assignee: string | null; due_date: string | null; done: boolean; carried: boolean }[];
};

function MeetingDrawer({ id, onClose, onOpen }: { id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const [d, setD] = React.useState<{ id: string; v?: Detail; error?: string } | null>(null);
  const [tick, setTick] = React.useState(0);
  const reload = () => setTick((t) => t + 1);
  React.useEffect(() => {
    let live = true;
    meetingDetailAction(id).then((r) => { if (live) setD(r.ok ? { id, v: r.data as Detail } : { id, error: r.error }); });
    return () => { live = false; };
  }, [id, tick]);
  const s = d?.id === id ? d : null;
  const m = s?.v;
  const other = m?.people.find((p) => p.id !== (m.isOrganizer ? m.organizerId : m.attendeeId));
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={m ? `1:1 with ${other?.name ?? ""}` : "1:1"} description={m ? `${fmtDateTime(m.startsAt)}${m.recurrence ? ` · ${REPEAT[m.recurrence]}` : ""}` : undefined}
      footer={m && m.status === "scheduled" ? <MeetingActions m={m} onDone={(next) => { reload(); if (next) onOpen(next); }} /> : undefined}>
      {!s ? <div aria-busy className="flex flex-col gap-3"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
        : s.error ? <p className="text-sm text-danger-text">{s.error}</p> : m && (
          <div className="flex flex-col gap-6">
            {m.status !== "scheduled" && <Badge tone={m.status === "completed" ? "success" : "neutral"} size="md">{m.status === "completed" ? "This meeting is done" : "This meeting was cancelled"}</Badge>}
            <Items m={m} kind="agenda" title="Talking points" placeholder="Add a talking point" onChange={reload} />
            <SharedNotes m={m} />
            <Items m={m} kind="action_item" title="Action items" placeholder="Add an action item" onChange={reload} />
            <Items m={m} kind="private_note" title="My private notes" placeholder="Only you will see this" onChange={reload} />
            {m.history.length > 1 && (
              <div><h3 className="mb-2 text-sm font-semibold">Earlier in this series</h3>
                <ul className="flex flex-wrap gap-2">{m.history.filter((h) => h.id !== m.id).map((h) => (
                  <li key={h.id}><Button size="sm" variant="ghost" onClick={() => onOpen(h.id)}>{fmtDate(h.starts_at)}{h.status !== "scheduled" ? ` · ${h.status === "completed" ? "done" : "cancelled"}` : ""}</Button></li>
                ))}</ul></div>
            )}
          </div>
        )}
    </Drawer>
  );
}

function SharedNotes({ m }: { m: Detail }) {
  const [v, setV] = React.useState(m.sharedNotes);
  const [saved, setSaved] = React.useState(m.sharedNotes);
  const [busy, setBusy] = React.useState(false);
  const dirty = v !== saved;
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">Shared notes</h3>
      <Field label="Notes both of you can see" className="[&>label]:sr-only">
        <Textarea value={v} onChange={(e) => setV(e.target.value)} rows={5} maxLength={10_000} disabled={m.status === "cancelled"} placeholder="What you talked about and agreed" />
      </Field>
      {dirty && <Button className="mt-2" size="sm" loading={busy} onClick={async () => { setBusy(true); const r = await saveMeetingNotesAction(m.id, v); setBusy(false); if (r.ok) { toast.success("Notes saved"); setSaved(v); } else toast.error(r.error); }}>Save notes</Button>}
    </section>
  );
}

function Items({ m, kind, title, placeholder, onChange }: { m: Detail; kind: Detail["items"][number]["kind"]; title: string; placeholder: string; onChange: () => void }) {
  const items = m.items.filter((i) => i.kind === kind);
  const [text, setText] = React.useState("");
  const [assignee, setAssignee] = React.useState(m.isOrganizer ? m.attendeeId : m.organizerId);
  const [due, setDue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const me = m.isOrganizer ? m.organizerId : m.attendeeId;
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    const r = await addMeetingItemAction(m.id, { kind, body: text, assigneeId: kind === "action_item" ? assignee : null, dueDate: kind === "action_item" ? due || null : null });
    setBusy(false);
    if (r.ok) { setText(""); setDue(""); onChange(); } else toast.error(r.error);
  };
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">{kind === "private_note" && <Lock className="size-3.5" aria-hidden />}{title}</h3>
      {items.length > 0 && (
        <ul className="mb-2 flex flex-col gap-1.5">
          {items.map((i) => (
            <li key={i.id} className="flex items-start gap-2 rounded-md bg-surface-sunken px-3 py-2 text-sm">
              {kind === "action_item" && <Checkbox checked={i.done} aria-label={`Mark "${i.body}" ${i.done ? "not done" : "done"}`} onCheckedChange={async (c) => { const r = await setActionDoneAction(i.id, !!c); if (r.ok) onChange(); else toast.error(r.error); }} />}
              <div className="min-w-0 flex-1">
                <p className={i.done ? "text-text-muted line-through" : undefined}>{i.body}</p>
                <p className="text-xs text-text-muted">{kind === "action_item" ? `${i.assignee ?? ""}${i.due_date ? ` · due ${fmtDate(i.due_date)}` : ""}${i.carried ? " · carried over" : ""}` : kind === "agenda" ? i.author : ""}</p>
              </div>
              {i.author_id === me && <IconButton label="Remove" size="icon-sm" onClick={async () => { const r = await deleteMeetingItemAction(i.id); if (r.ok) onChange(); else toast.error(r.error); }}><Trash2 /></IconButton>}
            </li>
          ))}
        </ul>
      )}
      {m.status !== "cancelled" && (
        <form onSubmit={add} className="flex flex-col gap-2">
          <div className="flex gap-2">
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label={placeholder} maxLength={2000} />
            <Button type="submit" variant="secondary" loading={busy} aria-label={`Add to ${title.toLowerCase()}`}><Check /></Button>
          </div>
          {kind === "action_item" && (
            <div className="grid grid-cols-2 gap-2">
              <Select size="sm" value={assignee} onValueChange={setAssignee} options={m.people.map((p) => ({ value: p.id, label: p.id === me ? "Me" : p.name }))} />
              <Input type="date" inputSize="sm" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
            </div>
          )}
        </form>
      )}
    </section>
  );
}

function MeetingActions({ m, onDone }: { m: Detail; onDone: (nextId: string | null) => void }) {
  const [moving, setMoving] = React.useState(false);
  const [when, setWhen] = React.useState(localInput(new Date(m.startsAt)));
  const mins = Math.round((new Date(m.endsAt).getTime() - new Date(m.startsAt).getTime()) / 60_000);
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <ConfirmDialog trigger={<Button variant="ghost">Cancel meeting</Button>} title="Cancel this 1:1?" tone="danger" confirmLabel="Cancel meeting"
        description={m.recurrence ? "The next one in the series is still scheduled, and open action items move to it." : "The other person will be told."}
        onConfirm={async () => { const r = await cancelMeetingAction(m.id, false); if (r.ok) { toast.success("Cancelled"); onDone(r.data?.nextId ?? null); } else toast.error(r.error); }} />
      {m.recurrence && m.isOrganizer && <ConfirmDialog trigger={<Button variant="ghost">End series</Button>} title="End this series?" confirmLabel="End series" description="This meeting and every later one are cancelled."
        onConfirm={async () => { const r = await cancelMeetingAction(m.id, true); if (r.ok) { toast.success("Series ended"); onDone(null); } else toast.error(r.error); }} />}
      {m.isOrganizer && <Button variant="secondary" onClick={() => setMoving(true)}><CalendarClock />Move</Button>}
      <Button onClick={async () => { const r = await completeMeetingAction(m.id); if (r.ok) { toast.success(r.data?.nextId ? "Done. Next meeting scheduled" : "Marked as done"); onDone(r.data?.nextId ?? null); } else toast.error(r.error); }}><Check />Mark as done</Button>
      <Modal open={moving} onOpenChange={setMoving} title="Move this 1:1" size="sm"
        footer={<><Button variant="secondary" onClick={() => setMoving(false)}>Cancel</Button><Button onClick={async () => { const r = await rescheduleMeetingAction(m.id, new Date(when).toISOString(), mins); if (r.ok) { toast.success("Moved"); setMoving(false); onDone(null); } else toast.error(r.error); }}>Move</Button></>}>
        <Field label="New date and time"><Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
      </Modal>
    </div>
  );
}
