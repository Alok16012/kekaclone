import Link from "next/link";
import { Cake, CalendarDays, PartyPopper, Sparkles, UserPlus } from "lucide-react";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { addDaysISO, type ISODate } from "@/lib/dates";
import type { Celebrant } from "@/server/modules/engage/rules";
import type { PraiseReceived } from "@/server/modules/engage/service";
import { BadgeIcon } from "./badge-icon";

const day = (d: ISODate, opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" }) =>
  new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { ...opts, timeZone: "UTC" });
const when = (d: ISODate, today: ISODate) => (d === today ? "Today" : d === addDaysISO(today, 1) ? "Tomorrow" : day(d));
const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;

function PersonRow({ p, today, note }: { p: Celebrant; today: ISODate; note: string }) {
  return (
    <li className="flex items-center gap-3">
      <Avatar name={p.name} size="sm" />
      <span className="min-w-0 flex-1">
        {p.private
          ? <span className="block truncate text-base font-medium">{p.name}</span>
          : <Link href={`/people/${p.id}`} className="block truncate text-base font-medium hover:underline">{p.name}</Link>}
        <span className="block truncate text-sm text-text-muted">{[note, p.designation].filter(Boolean).join(" · ")}</span>
      </span>
      {p.isToday ? <Badge tone="accent">Today</Badge> : <span className="shrink-0 text-sm text-text-muted">{when(p.on, today)}</span>}
    </li>
  );
}

/** Birthdays and work anniversaries this week, and people who just joined. Private profiles show only a name. */
export function CelebrationsCard({ data, today }: { data: { birthdays: Celebrant[]; anniversaries: Celebrant[]; newJoiners: Celebrant[] }; today: ISODate }) {
  const sections = [
    { key: "b", title: "Birthdays", icon: <Cake />, items: data.birthdays, note: () => "Birthday" },
    { key: "a", title: "Work anniversaries", icon: <PartyPopper />, items: data.anniversaries, note: (p: Celebrant) => `${ordinal(p.years ?? 1)} anniversary` },
    { key: "n", title: "New joiners", icon: <UserPlus />, items: data.newJoiners, note: (p: Celebrant) => (p.isToday ? "Joined today" : `Joined ${day(p.on, { day: "numeric", month: "short" })}`) },
  ].filter((s) => s.items.length);
  return (
    <Card>
      <CardHeader title="Celebrations" description="This week" />
      {sections.length === 0 ? (
        <EmptyState compact icon={<Sparkles />} title="Nothing to celebrate this week" description="Birthdays, work anniversaries and new joiners show up here." />
      ) : (
        <CardBody className="flex flex-col gap-4">
          {sections.map((s) => (
            <section key={s.key} aria-label={s.title}>
              <h4 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-text-muted [&_svg]:size-4">{s.icon}{s.title}</h4>
              <ul className="flex flex-col gap-3">{s.items.slice(0, 6).map((p) => <PersonRow key={s.key + p.id} p={p} today={today} note={s.note(p)} />)}</ul>
              {s.items.length > 6 && <p className="mt-2 text-sm text-text-muted">and {s.items.length - 6} more</p>}
            </section>
          ))}
        </CardBody>
      )}
    </Card>
  );
}

export function HolidaysCard({ holidays, today }: { holidays: { id: string; name: string; date: string; is_floater: boolean }[]; today: ISODate }) {
  return (
    <Card>
      <CardHeader title="Upcoming holidays" />
      {holidays.length === 0 ? (
        <EmptyState compact icon={<CalendarDays />} title="No holidays coming up" description="Your holiday list for the year has none left." />
      ) : (
        <ul className="flex flex-col gap-3 px-5 pb-5">
          {holidays.map((h) => (
            <li key={h.id} className="flex items-center gap-3">
              <span className="flex size-10 shrink-0 flex-col items-center justify-center rounded-md bg-surface-hover leading-none" aria-hidden>
                <span className="text-xs uppercase text-text-muted">{day(h.date, { month: "short" })}</span>
                <span className="text-md font-semibold tabular">{day(h.date, { day: "numeric" })}</span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base font-medium">{h.name}</span>
                <span className="block text-sm text-text-muted">{h.date === today ? "Today" : day(h.date, { weekday: "long" })}{h.is_floater ? " · optional" : ""}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** "Praise received" on a profile's About tab. */
export function PraiseReceivedCard({ items, self, employeeId }: { items: PraiseReceived[]; self: boolean; employeeId?: string }) {
  return (
    <Card className="lg:col-span-2">
      <CardHeader title="Praise received" description={items.length ? `${items.length} ${items.length === 1 ? "time" : "times"}` : undefined} />
      {items.length === 0 ? (
        <EmptyState compact icon={<Sparkles />} title="No praise yet" description={self ? "When colleagues praise your work on the Home wall, it shows up here." : "Praise from colleagues on the Home wall shows up here."} />
      ) : (
        <ul className="flex flex-col divide-y divide-border px-5 pb-3">
          {items.map((p) => (
            <li key={p.id} className="flex gap-3 py-3">
              {p.badge ? <BadgeIcon icon={p.badge.icon} /> : <Avatar name={p.from.name} />}
              <div className="min-w-0 flex-1">
                <p className="text-base">
                  {p.badge && <span className="font-semibold">{p.badge.name}</span>}
                  <span className="text-text-muted">{p.badge ? " from " : "From "}</span>
                  <Link href={`/people/${p.from.id}`} className="font-medium hover:underline">{p.from.name}</Link>
                  {p.others > 0 && <span className="text-text-muted"> · shared with {p.others} {p.others === 1 ? "other" : "others"}</span>}
                </p>
                <p className="mt-0.5 whitespace-pre-line break-words text-base text-text-muted">{p.message}</p>
                <p className="mt-1 text-sm text-text-muted">{new Date(p.at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}
                  {employeeId && <> · <a href={`/engage/praise/${p.id}/certificate?to=${employeeId}`} target="_blank" rel="noopener" className="font-medium text-accent-text hover:underline">Certificate (PDF)</a></>}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
