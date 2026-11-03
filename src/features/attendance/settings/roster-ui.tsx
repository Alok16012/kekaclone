"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { CalendarRange, ChevronLeft, ChevronRight, GripVertical, Lock, Repeat, Search, Users } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Card } from "@/ui/card";
import { Checkbox, Segmented } from "@/ui/choice";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { Banner, EmptyState } from "@/ui/feedback";
import { Modal } from "@/ui/overlay";
import { toast } from "@/ui/toast";
import { applyRotationAction, rosterWeekAction, saveRosterAction } from "@/app/(app)/settings/time/actions";
import type { RosterCell, RosterWeek } from "@/server/modules/attendance/roster";
import type { RosterValue } from "@/server/modules/attendance/roster-rules";

const addDays = (s: string, n: number) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayHead = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", timeZone: "UTC" });
const range = (a: string, b: string) => `${new Date(`${a}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" })} – ${new Date(`${b}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}`;
type Pending = Map<string, RosterValue>;   // "employeeId:date" → value
const key = (e: string, d: string) => `${e}:${d}`;

/**
 * People × days for one week. Pick a shift (or Off / Regular) from the palette and click cells, or drag a palette chip
 * onto a cell; changes collect until Save. Rotations fill many weeks at once. Locked days (payroll finalised) can't change.
 */
export function RosterBoard({ initial }: { initial: RosterWeek }) {
  const router = useRouter();
  const [week, setWeek] = React.useState(initial);
  const [q, setQ] = React.useState("");
  const [brush, setBrush] = React.useState<RosterValue | "regular">(initial.shifts[0]?.id ?? "off");
  const [pending, setPending] = React.useState<Pending>(new Map());
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [rotation, setRotation] = React.useState(false);
  const [busy, start] = React.useTransition();
  const [loading, setLoading] = React.useTransition();

  const load = (date: string, term = q) => setLoading(async () => {
    const w = await rosterWeekAction(date, term);
    if (w) { setWeek(w); router.replace(`/settings/time/roster?week=${w.weekStart}${term ? `&q=${encodeURIComponent(term)}` : ""}`); }
  });
  const paint = (employeeId: string, date: string, cell: RosterCell) => {
    if (cell.locked || cell.dayType === "holiday") return;
    const value: RosterValue = brush === "regular" ? null : brush;
    setPending((p) => { const n = new Map(p); if (value === cell.value) n.delete(key(employeeId, date)); else n.set(key(employeeId, date), value); return n; });
  };
  const save = () => start(async () => {
    const entries = [...pending.entries()].map(([k, value]) => { const [employeeId, date] = k.split(":"); return { employeeId, date, value }; });
    const r = await saveRosterAction(entries);
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(`${r.data?.changed ?? 0} ${r.data?.changed === 1 ? "day" : "days"} rostered${r.data?.skippedLocked ? ` · ${r.data.skippedLocked} locked skipped` : ""}`);
    setPending(new Map()); load(week.weekStart);
  });
  const cellValue = (employeeId: string, date: string, cell: RosterCell) => pending.has(key(employeeId, date)) ? pending.get(key(employeeId, date))! : cell.value;
  const cellLabel = (employeeId: string, date: string, cell: RosterCell) => {
    const k = key(employeeId, date);
    if (!pending.has(k)) return cell.label;
    const v = pending.get(k)!;
    return v === null ? "Regular" : v === "off" ? "Off" : week.shifts.find((s) => s.id === v)?.code ?? "?";
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Roster</h2>
          <p className="text-base text-text-muted">Pick a shift below, then click the days to change. Attendance follows the roster over the regular assignment.</p>
        </div>
        <nav aria-label="Week" className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" aria-label="Previous week" onClick={() => load(addDays(week.weekStart, -7))}><ChevronLeft /></Button>
          <span className="min-w-44 text-center text-sm font-medium">{range(week.days[0], week.days[6])}</span>
          <Button variant="ghost" size="icon-sm" aria-label="Next week" onClick={() => load(addDays(week.weekStart, 7))}><ChevronRight /></Button>
          <Button variant="ghost" size="sm" onClick={() => load(week.today)}>Today</Button>
        </nav>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); load(week.weekStart, q); }}>
          <Input leading={<Search />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" aria-label="Search people" className="w-56" />
        </form>
        <div role="radiogroup" aria-label="Shift to assign" className="flex flex-wrap items-center gap-1.5">
          {([...week.shifts.map((s) => s.id), "off", "regular"] as (RosterValue | "regular")[]).map((v) => (
            <button key={String(v)} type="button" role="radio" aria-checked={brush === v} draggable onDragStart={(e) => { e.dataTransfer.setData("text/plain", v === null ? "regular" : String(v)); setBrush(v); }}
              onClick={() => setBrush(v)}
              className={cn("inline-flex h-8 cursor-grab items-center gap-1 rounded-pill border px-3 text-sm font-medium", brush === v ? "border-accent bg-accent-soft text-accent-text" : "border-border bg-surface text-text hover:bg-surface-hover")}>
              <GripVertical className="size-3.5 text-text-muted" aria-hidden />{v === "off" ? "Off" : v === "regular" ? "Regular (clear)" : week.shifts.find((s) => s.id === v)?.name}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => setRotation(true)} disabled={!selected.size}><Repeat />Apply rotation{selected.size ? ` (${selected.size})` : ""}</Button>
          <Button size="sm" onClick={save} loading={busy} disabled={!pending.size}>Save {pending.size ? `${pending.size} ${pending.size === 1 ? "change" : "changes"}` : ""}</Button>
        </div>
      </div>
      <Card>
        {week.people.length === 0 ? <EmptyState compact icon={<Users />} title={q ? "Nobody matches that search" : "Nobody to roster"} description="People you can manage show up here." /> : (
          <div className="overflow-x-auto" aria-busy={loading}>
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <caption className="sr-only">Roster for the week of {week.weekStart}</caption>
              <thead className="bg-surface-sunken">
                <tr className="border-b border-border">
                  <th scope="col" className="w-8 px-3"><Checkbox aria-label="Select everyone" checked={selected.size === week.people.length && week.people.length > 0} onCheckedChange={(c) => setSelected(c ? new Set(week.people.map((p) => p.id)) : new Set())} /></th>
                  <th scope="col" className="sticky left-0 z-10 bg-surface-sunken px-3 py-2 text-left font-medium text-text-muted">Person</th>
                  {week.days.map((d) => <th key={d} scope="col" className={cn("px-2 py-2 text-center font-medium text-text-muted", d === week.today && "text-accent-text")}>{dayHead(d)}</th>)}
                </tr>
              </thead>
              <tbody>
                {week.people.map((p) => (
                  <tr key={p.id} className="border-b border-border last:border-0">
                    <td className="px-3"><Checkbox aria-label={`Select ${p.name}`} checked={selected.has(p.id)} onCheckedChange={(c) => setSelected((s) => { const n = new Set(s); if (c) n.add(p.id); else n.delete(p.id); return n; })} /></td>
                    <th scope="row" className="sticky left-0 z-10 bg-surface px-3 py-1.5 text-left font-normal">
                      <span className="block truncate font-medium">{p.name}</span><span className="block truncate text-xs text-text-muted">{[p.title, p.department].filter(Boolean).join(" · ")}</span>
                    </th>
                    {week.days.map((d) => {
                      const cell = p.cells[d];
                      const changed = pending.has(key(p.id, d));
                      const v = cellValue(p.id, d, cell);
                      const off = v === "off" || (v === null && cell.dayType === "weekly_off") || cell.dayType === "holiday";
                      return (
                        <td key={d} className="p-1 text-center" onDragOver={(e) => { if (!cell.locked) e.preventDefault(); }}
                          onDrop={(e) => { e.preventDefault(); const raw = e.dataTransfer.getData("text/plain"); const val = raw === "regular" ? "regular" : (raw as RosterValue); setBrush(val); const value: RosterValue = val === "regular" ? null : val; if (!cell.locked && cell.dayType !== "holiday") setPending((pm) => { const n = new Map(pm); if (value === cell.value) n.delete(key(p.id, d)); else n.set(key(p.id, d), value); return n; }); }}>
                          <button type="button" onClick={() => paint(p.id, d, cell)} disabled={cell.locked || cell.dayType === "holiday"}
                            aria-label={`${p.name}, ${dayHead(d)}: ${cellLabel(p.id, d, cell)}${cell.locked ? " (locked)" : ""}`}
                            className={cn("inline-flex h-8 w-full min-w-14 items-center justify-center gap-1 rounded-md border text-sm font-medium transition-colors",
                              changed ? "border-accent bg-accent-soft text-accent-text" : off ? "border-transparent bg-neutral-soft text-neutral-text" : (v ?? cell.value) !== null || cell.source === "roster" ? "border-border bg-surface text-text" : "border-dashed border-border text-text-muted",
                              (cell.locked || cell.dayType === "holiday") && "cursor-not-allowed opacity-60")}>
                            {cell.locked && <Lock className="size-3" aria-hidden />}{cellLabel(p.id, d, cell)}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {week.total > week.people.length && <p className="px-5 py-3 text-sm text-text-muted">Showing {week.people.length} of {week.total} people. Search to find the rest.</p>}
      </Card>
      <p className="text-sm text-text-muted"><Badge tone="neutral">Off</Badge> weekly off · dashed = regular assignment · <Badge tone="accent">blue</Badge> unsaved change · <Lock className="inline size-3" aria-hidden /> locked by payroll</p>
      {rotation && <RotationDialog people={[...selected]} shifts={week.shifts} today={week.today} start={week.weekStart} onClose={(done) => { setRotation(false); if (done) { setSelected(new Set()); load(week.weekStart); } }} />}
    </div>
  );
}

function RotationDialog({ people, shifts, today, start, onClose }: { people: string[]; shifts: { id: string; name: string; code: string }[]; today: string; start: string; onClose: (done: boolean) => void }) {
  const [kind, setKind] = React.useState<"weekly" | "cycle">("weekly");
  const [from, setFrom] = React.useState(start < today ? today : start);
  const [days, setDays] = React.useState("28");
  const [week, setWeek] = React.useState<RosterValue[]>([shifts[0]?.id ?? "off", shifts[0]?.id ?? "off", shifts[0]?.id ?? "off", shifts[0]?.id ?? "off", shifts[0]?.id ?? "off", "off", "off"]);
  const [seq, setSeq] = React.useState<RosterValue[]>([shifts[0]?.id ?? "off", shifts[0]?.id ?? "off", shifts[1]?.id ?? "off", shifts[1]?.id ?? "off", "off"]);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startT] = React.useTransition();
  const options = [{ value: "__keep", label: "Keep regular" }, { value: "off", label: "Off" }, ...shifts.map((s) => ({ value: s.id, label: `${s.name} (${s.code})` }))];
  const toOpt = (v: RosterValue) => (v === null ? "__keep" : v);
  const fromOpt = (v: string): RosterValue => (v === "__keep" ? null : v);
  const apply = () => startT(async () => {
    setError(null);
    const r = await applyRotationAction({ employeeIds: people, rotation: kind === "weekly" ? { kind, week } : { kind, sequence: seq }, start: from, days: Number(days) });
    if (!r.ok) { setError(r.error); return; }
    toast.success(`Rotation applied: ${r.data?.changed ?? 0} days rostered`); onClose(true);
  });
  const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return (
    <Modal open onOpenChange={(o) => !o && onClose(false)} size="lg" title={`Apply a rotation to ${people.length} ${people.length === 1 ? "person" : "people"}`}
      description="A weekly pattern repeats by weekday; a cycle repeats from the start date (e.g. 2 days, 2 nights, 1 off). Days set to Keep regular are left alone."
      footer={<><Button variant="secondary" onClick={() => onClose(false)}>Cancel</Button><Button loading={pending} onClick={apply}><CalendarRange />Apply</Button></>}>
      <div className="flex flex-col gap-4">
        {error && <Banner tone="danger">{error}</Banner>}
        <Segmented label="Pattern type" value={kind} onChange={setKind} options={[{ value: "weekly", label: "Weekly pattern" }, { value: "cycle", label: "Repeating cycle" }]} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="From" required><Input type="date" value={from} min={addDays(today, -31)} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="For (days)" required help="Up to a year"><Input type="number" inputMode="numeric" min={1} max={366} value={days} onChange={(e) => setDays(e.target.value)} /></Field>
        </div>
        {kind === "weekly" ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {WD.map((d, i) => <Field key={d} label={d}><Select value={toOpt(week[i])} onValueChange={(v) => setWeek((w) => w.map((x, j) => j === i ? fromOpt(v) : x))} options={options} /></Field>)}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {seq.map((v, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-14 text-sm text-text-muted">Day {i + 1}</span>
                <div className="flex-1"><Select value={toOpt(v)} onValueChange={(nv) => setSeq((s) => s.map((x, j) => j === i ? fromOpt(nv) : x))} options={options} /></div>
                <Button type="button" variant="ghost" size="sm" disabled={seq.length <= 2} onClick={() => setSeq((s) => s.filter((_, j) => j !== i))}>Remove</Button>
              </div>
            ))}
            {seq.length < 60 && <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setSeq((s) => [...s, "off"])}>Add a day</Button>}
          </div>
        )}
      </div>
    </Modal>
  );
}
