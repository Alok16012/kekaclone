"use client";
import * as React from "react";
import Link from "next/link";
import { CalendarHeart, Copy, MapPin, MoreHorizontal, Pencil, Plus, Sparkles, Trash2, Users } from "lucide-react";
import { Button, IconButton } from "@/ui/button";
import { Card, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Field, Input } from "@/ui/field";
import { Checkbox, Switch } from "@/ui/choice";
import { ConfirmDialog, Menu, Modal } from "@/ui/overlay";
import { Banner, EmptyState, Skeleton } from "@/ui/feedback";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { toast } from "@/ui/toast";
import { cn } from "@/lib/cn";
import {
  assignHolidayListAction, copyHolidayListAction, deleteHolidayAction, deleteHolidayListAction, holidayListPeopleAction, saveHolidayAction, saveHolidayListAction,
} from "@/app/(app)/settings/leave/actions";
import { fmtDate } from "./labels";

type List = { id: string; name: string; year: number; floater_limit: number; holidays: number; floaters: number; locations: { id: string; name: string }[]; people: number };
type Holiday = { id: string; holiday_list_id: string; name: string; date: string; is_floater: boolean; description: string | null; chosen: number };
type Location = { id: string; name: string; listId: string | null };

export function HolidayLists({ lists, holidays, locations, people, years, year }: { lists: List[]; holidays: Holiday[]; locations: Location[]; people: Person[]; years: number[]; year: number }) {
  const [editingList, setEditingList] = React.useState<List | "new" | null>(null);
  const shown = lists.filter((l) => l.year === year);
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader title="Holiday lists" description="Company holidays per year. Each location gets a default list; you can give a person a different one. Optional (floater) holidays are picked by each person, up to the list's limit."
          action={<Button size="sm" onClick={() => setEditingList("new")}><Plus />New list</Button>} />
        <nav aria-label="Years" className="flex flex-wrap gap-2 px-5 pb-4">
          {years.map((y) => (
            <Link key={y} href={`?year=${y}`} aria-current={y === year ? "page" : undefined}
              className={cn("rounded-pill border border-border px-3 py-1 text-sm tabular hover:bg-surface-hover", y === year && "border-accent bg-accent-soft text-accent-text")}>{y}</Link>
          ))}
        </nav>
      </Card>
      {shown.length === 0 ? (
        <Card><EmptyState icon={<CalendarHeart />} title={`No holiday lists for ${year}`} description="Create one, or copy last year's list and adjust the dates of festivals that move."
          action={<Button size="sm" onClick={() => setEditingList("new")}><Plus />New list for {year}</Button>} /></Card>
      ) : shown.map((l) => (
        <ListCard key={l.id} list={l} holidays={holidays.filter((h) => h.holiday_list_id === l.id)} locations={locations} people={people} onEdit={() => setEditingList(l)} />
      ))}
      {editingList && <ListDialog list={editingList === "new" ? null : editingList} year={year} onClose={() => setEditingList(null)} />}
    </div>
  );
}

function ListCard({ list, holidays, locations, people, onEdit }: { list: List; holidays: Holiday[]; locations: Location[]; people: Person[]; onEdit: () => void }) {
  const [editing, setEditing] = React.useState<Holiday | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<Holiday | null>(null);
  const [deletingList, setDeletingList] = React.useState(false);
  const [assigning, setAssigning] = React.useState(false);
  const [busy, start] = React.useTransition();
  const copy = () => start(async () => {
    const r = await copyHolidayListAction(list.id, list.year + 1);
    if (r.ok) toast.success(`Copied to ${list.year + 1}`, { description: "Check the dates of festivals that move each year." }); else toast.error(r.error);
  });
  const applies = [list.locations.length ? list.locations.map((l) => l.name).join(", ") : null, list.people ? `${list.people} ${list.people === 1 ? "person" : "people"}` : null].filter(Boolean).join(" · ");
  return (
    <Card>
      <CardHeader title={<span className="flex flex-wrap items-center gap-2">{list.name}<Badge>{list.year}</Badge></span>}
        description={<>{list.holidays} {list.holidays === 1 ? "holiday" : "holidays"}{list.floaters ? ` · ${list.floaters} optional, pick up to ${list.floater_limit}` : ""} · {applies ? `for ${applies}` : "not assigned yet"}</>}
        action={
          <div className="flex gap-1">
            <Button size="sm" variant="secondary" onClick={() => setAssigning(true)}><MapPin /><span className="hidden sm:inline">Assign</span></Button>
            <Menu trigger={<IconButton label={`Actions for ${list.name} ${list.year}`} size="icon-sm" variant="ghost" loading={busy}><MoreHorizontal /></IconButton>}
              items={[{ label: "Edit list", icon: <Pencil />, onSelect: onEdit }, { label: `Copy to ${list.year + 1}`, icon: <Copy />, onSelect: copy }, "separator", { label: "Delete list", icon: <Trash2 />, danger: true, onSelect: () => setDeletingList(true) }]} />
          </div>
        } />
      {holidays.length === 0 ? (
        <EmptyState compact icon={<CalendarHeart />} title="No holidays on this list yet" action={<Button size="sm" onClick={() => setEditing("new")}><Plus />Add holiday</Button>} />
      ) : (
        <>
          <ul className="divide-y divide-border border-t border-border">
            {holidays.map((h) => (
              <li key={h.id} className="flex items-center gap-3 px-5 py-2.5">
                <span className="w-24 shrink-0 text-sm tabular text-text-muted sm:w-32">{fmtDate(h.date, { weekday: "short", day: "numeric", month: "short" })}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2 text-base">{h.name}{h.is_floater && <Badge tone="accent"><Sparkles aria-hidden />Optional</Badge>}</span>
                  {h.is_floater && <span className="block text-sm text-text-muted">{h.chosen} {h.chosen === 1 ? "person has" : "people have"} picked it</span>}
                </span>
                <Menu trigger={<IconButton label={`Actions for ${h.name}`} size="icon-sm" variant="ghost"><MoreHorizontal /></IconButton>}
                  items={[{ label: "Edit", icon: <Pencil />, onSelect: () => setEditing(h) }, { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setDeleting(h) }]} />
              </li>
            ))}
          </ul>
          <div className="border-t border-border px-5 py-3"><Button size="sm" variant="ghost" onClick={() => setEditing("new")}><Plus />Add holiday</Button></div>
        </>
      )}
      {editing && <HolidayDialog list={list} holiday={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {assigning && <AssignDialog list={list} locations={locations} people={people} onClose={() => setAssigning(false)} />}
      {deleting && (
        <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting.name}?`}
          description={deleting.is_floater && deleting.chosen ? `${deleting.chosen} ${deleting.chosen === 1 ? "person picked" : "people picked"} it; they'll lose the day off.` : "People on this list will be expected at work that day."}
          confirmLabel="Delete" onConfirm={async () => { const r = await deleteHolidayAction(deleting.id); if (r.ok) toast.success(`${deleting.name} deleted`); else toast.error(r.error); setDeleting(null); }} />
      )}
      {deletingList && (
        <ConfirmDialog open onOpenChange={setDeletingList} title={`Delete ${list.name} ${list.year}?`}
          description={`Its ${list.holidays + list.floaters} holidays go too. Locations and people using it fall back to the company's first holiday list.`}
          confirmLabel="Delete list" onConfirm={async () => { const r = await deleteHolidayListAction(list.id); if (r.ok) toast.success("Holiday list deleted"); else toast.error(r.error); setDeletingList(false); }} />
      )}
    </Card>
  );
}

function ListDialog({ list, year, onClose }: { list: List | null; year: number; onClose: () => void }) {
  const [name, setName] = React.useState(list?.name ?? "");
  const [y, setY] = React.useState(String(list?.year ?? year));
  const [limit, setLimit] = React.useState(String(list?.floater_limit ?? 0));
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    const r = await saveHolidayListAction(list?.id ?? null, { name, year: Number(y), floaterLimit: Number(limit) });
    if (!r.ok) { setError(r.error); return; }
    toast.success(list ? "List saved" : `${name} ${y} created`);
    onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="sm" title={list ? "Edit holiday list" : "New holiday list"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>{list ? "Save" : "Create list"}</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Name" required help="Lists with the same name in different years are treated as one calendar."><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={80} placeholder="Head office" /></Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Year" required><Input type="number" min={2000} max={2100} value={y} onChange={(e) => setY(e.target.value)} disabled={!!list?.holidays || !!list?.floaters} /></Field>
          <Field label="Optional holidays each person can pick"><Input type="number" min={0} max={20} value={limit} onChange={(e) => setLimit(e.target.value)} /></Field>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function HolidayDialog({ list, holiday, onClose }: { list: List; holiday: Holiday | null; onClose: () => void }) {
  const [name, setName] = React.useState(holiday?.name ?? "");
  const [date, setDate] = React.useState(holiday?.date ?? "");
  const [floater, setFloater] = React.useState(holiday?.is_floater ?? false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    const r = await saveHolidayAction(list.id, holiday?.id ?? null, { name, date, floater });
    if (!r.ok) { setError(r.error); return; }
    toast.success(holiday ? "Holiday saved" : `${name} added`);
    onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="sm" title={holiday ? "Edit holiday" : `Add a holiday to ${list.name} ${list.year}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>{holiday ? "Save" : "Add holiday"}</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={80} placeholder="Independence Day" /></Field>
        <Field label="Date" required><Input type="date" value={date} min={`${list.year}-01-01`} max={`${list.year}-12-31`} onChange={(e) => setDate(e.target.value)} /></Field>
        <Switch label="Optional (floater): each person decides whether to take it" checked={floater} onCheckedChange={setFloater} />
        {floater && list.floater_limit === 0 && <Banner tone="warning">This list lets people pick 0 optional holidays. Raise the limit in the list’s settings so people can pick it.</Banner>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function AssignDialog({ list, locations, people, onClose }: { list: List; locations: Location[]; people: Person[]; onClose: () => void }) {
  const [locs, setLocs] = React.useState<Set<string>>(new Set(list.locations.map((l) => l.id)));
  const [ids, setIds] = React.useState<string[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  React.useEffect(() => {
    let live = true;
    holidayListPeopleAction(list.id).then((r) => { if (live) { if (r.ok) setIds(r.data!); else setError(r.error); } });
    return () => { live = false; };
  }, [list.id]);
  const save = () => start(async () => {
    const r = await assignHolidayListAction(list.id, { locationIds: [...locs], employeeIds: ids ?? [] });
    if (!r.ok) { setError(r.error); return; }
    toast.success(`${list.name} ${list.year} assigned`);
    onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Who gets ${list.name} ${list.year}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={ids === null} onClick={save}>Save</Button></>}>
      <div className="flex flex-col gap-5">
        {error && <Banner tone="danger">{error}</Banner>}
        <fieldset>
          <legend className="mb-2 flex items-center gap-1.5 text-sm font-medium"><MapPin className="size-4" aria-hidden />Default for these locations</legend>
          {locations.length === 0 ? <p className="text-sm text-text-muted">No locations yet. Add them in Company structure.</p> : (
            <div className="flex flex-col gap-2">
              {locations.map((l) => (
                <Checkbox key={l.id} label={<>{l.name}{l.listId && l.listId !== list.id ? <span className="text-sm text-text-muted"> · uses another list now</span> : null}</>}
                  checked={locs.has(l.id)} onCheckedChange={(c) => setLocs((s) => { const n = new Set(s); if (c) n.add(l.id); else n.delete(l.id); return n; })} />
              ))}
            </div>
          )}
        </fieldset>
        <Field label={<span className="flex items-center gap-1.5"><Users className="size-4" aria-hidden />Also for these people, wherever they work</span>} help="Overrides their location's list.">
          {ids === null ? <Skeleton className="h-9" /> : <EmployeePicker multiple people={people} value={ids} onChange={setIds} placeholder="Search people" />}
        </Field>
      </div>
    </Modal>
  );
}
