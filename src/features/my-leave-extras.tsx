"use client";
import * as React from "react";
import { CalendarHeart, Hourglass, Sparkles, Timer } from "lucide-react";
import { Button } from "@/ui/button";
import { Card, CardHeader } from "@/ui/card";
import { Badge, StatusChip } from "@/ui/badge";
import { Field, Textarea } from "@/ui/field";
import { Switch } from "@/ui/choice";
import { ConfirmDialog, Modal } from "@/ui/overlay";
import { Banner, EmptyState } from "@/ui/feedback";
import { Calendar, type DayMark, type Range } from "@/ui/calendar";
import { toast } from "@/ui/toast";
import { useToday } from "@/lib/use-today";
import { cancelCompOffAction, chooseFloaterAction, requestCompOffAction } from "@/app/(app)/me/leave/actions";

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fmt = (d: string, o: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" }) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { ...o, timeZone: "UTC" });

// ---------------------------------------------------------------- holidays

export type HolidayItem = { id: string; name: string; date: string; floater: boolean; chosen: boolean; listId: string };
export type Allowance = { listId: string; year: number; limit: number; used: number };

/** Upcoming holidays with opt-in switches for optional (floater) days, within the yearly allowance. */
export function UpcomingHolidays({ listName, holidays, allowance }: { listName: string | null; holidays: HolidayItem[]; allowance: Allowance[] }) {
  const [showAll, setShowAll] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const shown = showAll ? holidays : holidays.slice(0, 6);
  const toggle = async (h: HolidayItem, on: boolean) => {
    setBusy(h.id);
    const r = await chooseFloaterAction(h.id, on);
    setBusy(null);
    if (r.ok) toast.success(on ? `${h.name} is now a day off for you` : `You'll work on ${h.name}`); else toast.error(r.error);
  };
  return (
    <Card>
      <CardHeader title="Upcoming holidays" description={listName ? `${listName} holiday list` : undefined} />
      {allowance.filter((a) => a.limit > 0).map((a) => (
        <p key={a.listId} className="mx-5 mb-3 flex items-center gap-2 rounded-md bg-accent-soft px-3 py-2 text-sm text-accent-text">
          <Sparkles className="size-4 shrink-0" aria-hidden />You’ve picked {a.used} of {a.limit} optional {a.limit === 1 ? "holiday" : "holidays"} for {a.year}.
        </p>
      ))}
      {holidays.length === 0 ? (
        <EmptyState compact icon={<CalendarHeart />} title="No holidays coming up" description="Your holiday list for the next 12 months is empty." />
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {shown.map((h) => {
            const a = allowance.find((x) => x.listId === h.listId);
            const full = !!a && a.used >= a.limit && !h.chosen;
            return (
              <li key={h.id} className="flex items-center gap-3 px-5 py-2.5">
                <span className="flex w-12 shrink-0 flex-col items-center rounded-md bg-surface-sunken py-1 text-center leading-tight" aria-hidden>
                  <span className="text-xs uppercase text-text-muted">{fmt(h.date, { month: "short" })}</span>
                  <span className="text-md font-semibold tabular">{Number(h.date.slice(8))}</span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base">{h.name}</span>
                  <span className="block text-sm text-text-muted">{fmt(h.date, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}{h.floater ? " · optional" : ""}</span>
                </span>
                {h.floater && (
                  <Switch aria-label={`Take ${h.name} off`} checked={h.chosen} disabled={busy === h.id || full || !a?.limit}
                    onCheckedChange={(c) => toggle(h, c)} />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {holidays.length > 6 && <div className="border-t border-border px-5 py-2"><Button variant="ghost" size="sm" onClick={() => setShowAll((s) => !s)}>{showAll ? "Show fewer" : `Show all ${holidays.length}`}</Button></div>}
    </Card>
  );
}

// ---------------------------------------------------------------- comp-off

export type CompOffItem = { id: string; dates: string[]; days: number; note: string | null; status: "pending" | "approved" | "rejected" | "cancelled"; expiresOn: string | null; expired: boolean };

export function ClaimCompOff({ marks, windowDays, expiryDays, defaultOpen = false }: { marks: Record<string, DayMark>; windowDays: number; expiryDays: number | null; defaultOpen?: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen);
  const today = useToday();
  const [range, setRange] = React.useState<Range>({ from: null, to: null });
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const picked: string[] = [];
  let skipped = 0;
  if (range.from) {
    const end = range.to ?? range.from;
    for (let d = new Date(range.from); d <= end && picked.length + skipped < 62; d.setDate(d.getDate() + 1)) {
      const k = iso(d);
      if (marks[k] === "holiday" || marks[k] === "weekly_off") picked.push(k); else skipped++;
    }
  }
  const reset = () => { setRange({ from: null, to: null }); setNote(""); setError(null); };
  const submit = () => start(async () => {
    const r = await requestCompOffAction({ dates: picked, note: note || undefined });
    if (!r.ok) { setError(r.error); return; }
    toast.success(r.data!.status === "approved" ? "Comp-off credited" : "Comp-off claim sent", { description: r.data!.status === "approved" ? "It's in your balance now." : "Your manager will review it." });
    setOpen(false); reset();
  });
  const minDate = today ? new Date(today.getTime() - windowDays * 864e5) : null;
  return (
    <Modal open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }} title="Claim comp-off"
      description={`Worked on a weekly off or holiday? Claim a day off for each one, within ${windowDays} days.${expiryDays ? ` Approved comp-off must be used within ${expiryDays} days.` : ""}`}
      trigger={<Button variant="secondary"><Timer />Claim comp-off</Button>}
      footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={pending} disabled={!picked.length} onClick={submit}>{picked.length ? `Claim ${picked.length} ${picked.length === 1 ? "day" : "days"}` : "Claim"}</Button></>}>
      <div className="flex flex-col gap-4">
        {error && <Banner tone="danger">{error}</Banner>}
        <div className="flex justify-center">
          <Calendar range={range} onRangeChange={(r) => { setRange(r); setError(null); }} marks={marks}
            disabled={(d) => !today || d > today || (!!minDate && d < minDate)} />
        </div>
        <div aria-live="polite" className="text-base">
          {!range.from ? <p className="text-text-muted">Pick the day you worked, or a range of days. Only weekly offs and holidays count.</p> : picked.length === 0 ? (
            <Banner tone="warning">These are working days for you. Pick a weekly off or a holiday.</Banner>
          ) : (
            <>
              <p className="font-medium">You’ll claim:</p>
              <ul className="mt-1 flex flex-wrap gap-1.5">{picked.map((d) => <li key={d}><Badge size="md">{fmt(d)}</Badge></li>)}</ul>
              {skipped > 0 && <p className="mt-2 text-sm text-text-muted">{skipped} working {skipped === 1 ? "day was" : "days were"} left out.</p>}
            </>
          )}
        </div>
        <Field label="What did you work on?" help="Helps your manager approve it."><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} /></Field>
      </div>
    </Modal>
  );
}

export function CompOffList({ items }: { items: CompOffItem[] }) {
  const [withdraw, setWithdraw] = React.useState<CompOffItem | null>(null);
  if (!items.length) return null;
  return (
    <Card>
      <CardHeader title="Comp-off claims" description="Days off earned for working weekly offs and holidays" />
      <ul className="divide-y divide-border border-t border-border">
        {items.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
            <Hourglass className="size-4 shrink-0 text-text-muted" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-base font-medium">Worked {c.dates.map((d) => fmt(d)).join(", ")}</p>
              <p className="text-sm text-text-muted tabular">{c.days} {c.days === 1 ? "day" : "days"}{c.status === "approved" && c.expiresOn ? ` · ${c.expired ? "expired" : "use by"} ${fmt(c.expiresOn, { day: "numeric", month: "short", year: "numeric" })}` : ""}{c.note ? ` · “${c.note}”` : ""}</p>
            </div>
            {c.expired ? <Badge>Expired</Badge> : <StatusChip status={c.status} />}
            {c.status === "pending" && <Button variant="ghost" size="sm" onClick={() => setWithdraw(c)}>Withdraw</Button>}
          </li>
        ))}
      </ul>
      {withdraw && (
        <ConfirmDialog open onOpenChange={(o) => !o && setWithdraw(null)} title="Withdraw this comp-off claim?" description="Your manager won't need to review it anymore. You can claim the day again later, within the claim window."
          confirmLabel="Withdraw" onConfirm={async () => { const r = await cancelCompOffAction(withdraw.id); if (r.ok) toast.success("Claim withdrawn"); else toast.error(r.error); setWithdraw(null); }} />
      )}
    </Card>
  );
}
