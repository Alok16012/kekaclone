import Link from "next/link";
import { CalendarX2, ChevronLeft, ChevronRight } from "lucide-react";
import { Card, CardHeader } from "@/ui/card";
import { Avatar } from "@/ui/avatar";
import { EmptyState } from "@/ui/feedback";
import { cn } from "@/lib/cn";
import type { TeamMonth, TeamCell } from "@/server/modules/leave/team";

const MONTH = (ym: string) => new Date(ym + "-01T00:00:00Z").toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
const DAY = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const SHORT = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const W1 = { sun: "S", mon: "M", tue: "T", wed: "W", thu: "T", fri: "F", sat: "S" } as Record<string, string>;

function CellMark({ c }: { c: TeamCell | undefined }) {
  if (!c) return null;
  if (c.kind === "holiday") return <span aria-hidden className="text-xs font-medium text-text-muted">H</span>;
  if (c.kind === "weekly_off") return null;
  const pending = c.kind === "pending";
  return (
    <span aria-hidden className={cn("flex h-6 w-full items-center justify-center rounded-xs text-[10px] font-semibold leading-none", pending ? "border-2 border-dashed bg-surface text-text" : "text-on-accent")}
      style={pending ? { borderColor: c.color } : { background: c.half ? `linear-gradient(${c.half === "first" ? "90deg" : "270deg"}, ${c.color} 50%, transparent 50%)` : c.color }}>
      {!c.half && c.code}
    </span>
  );
}

/** Groups consecutive days with the same status into ranges for the text version. */
function ranges(cells: Record<string, TeamCell>, days: string[]) {
  const out: { from: string; to: string; label: string; n: number }[] = [];
  for (const d of days) {
    const c = cells[d];
    if (!c || c.kind === "holiday" || c.kind === "weekly_off") continue;
    const last = out[out.length - 1];
    if (last && last.label === c.label && days.indexOf(last.to) >= 0) {
      // extend across off days in between
      const between = days.slice(days.indexOf(last.to) + 1, days.indexOf(d));
      if (between.every((b) => cells[b]?.kind === "holiday" || cells[b]?.kind === "weekly_off")) { last.to = d; last.n += c.half ? 0.5 : 1; continue; }
    }
    out.push({ from: d, to: d, label: c.label, n: c.half ? 0.5 : 1 });
  }
  return out;
}

export function TeamLeaveCalendar({ data, today }: { data: TeamMonth; today: string }) {
  const q = (month: string, view = data.view) => `?month=${month}${view === "all" ? "&view=all" : ""}`;
  const dates = data.days.map((d) => d.date);
  const off = data.people.map((p) => ({ p, r: ranges(p.cells, dates) })).filter((x) => x.r.length);
  const holidays = data.days.filter((d) => data.people[0]?.cells[d.date]?.kind === "holiday");
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <Link href={q(data.prev)} aria-label={`Previous month, ${MONTH(data.prev)}`} className="flex size-9 items-center justify-center rounded-md hover:bg-surface-hover"><ChevronLeft className="size-4" /></Link>
          <h2 className="min-w-40 text-center text-lg font-semibold" aria-live="polite">{MONTH(data.month)}</h2>
          <Link href={q(data.next)} aria-label={`Next month, ${MONTH(data.next)}`} className="flex size-9 items-center justify-center rounded-md hover:bg-surface-hover"><ChevronRight className="size-4" /></Link>
          {data.month !== today.slice(0, 7) && <Link href={q(today.slice(0, 7))} className="ml-1 rounded-md px-2 py-1 text-sm text-accent-text hover:bg-surface-hover">This month</Link>}
        </div>
        {data.canSeeAll && (
          <nav aria-label="Whose leave" className="inline-flex rounded-md bg-surface-hover p-0.5 sm:ml-auto">
            {(["team", "all"] as const).map((v) => (
              <Link key={v} href={q(data.month, v)} aria-current={data.view === v ? "page" : undefined}
                className={cn("h-7 rounded-sm px-3 text-sm font-medium leading-7 text-text-muted", data.view === v && "bg-surface text-text shadow-card")}>{v === "team" ? "My team" : "Everyone I manage"}</Link>
            ))}
          </nav>
        )}
      </div>

      <Card>
        <ul aria-label="Legend" className="flex flex-wrap gap-x-5 gap-y-2 border-b border-border px-5 py-3 text-sm text-text-muted">
          {data.types.map((t) => <li key={t.code} className="flex items-center gap-1.5"><span aria-hidden className="size-3 rounded-xs" style={{ background: t.color }} />{t.name} ({t.code})</li>)}
          <li className="flex items-center gap-1.5"><span aria-hidden className="size-3 rounded-xs border-2 border-dashed border-text-muted" />Waiting for approval</li>
          <li className="flex items-center gap-1.5"><span aria-hidden className="h-3 w-3 rounded-xs bg-surface-sunken" />Weekly off</li>
          <li className="flex items-center gap-1.5"><span aria-hidden className="text-xs font-medium">H</span>Holiday</li>
          <li className="flex items-center gap-1.5"><span aria-hidden className="size-3 rounded-xs" style={{ background: "linear-gradient(90deg, var(--chart-1) 50%, transparent 50%)" }} />Half day</li>
        </ul>
        {data.people.length === 0 ? (
          <EmptyState compact icon={<CalendarX2 />} title="No one to show" description="People you manage or work alongside appear here." />
        ) : (
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={`Leave calendar for ${MONTH(data.month)}. The list below has the same information as text.`}>
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Leave by person and day, {MONTH(data.month)}</caption>
              <thead>
                <tr>
                  <th scope="col" className="sticky left-0 z-10 min-w-40 bg-surface px-4 py-2 text-left font-medium text-text-muted">Person</th>
                  {data.days.map((d) => (
                    <th key={d.date} scope="col" abbr={DAY(d.date)} className={cn("min-w-8 px-0.5 py-1 text-center font-normal", d.date === today ? "text-accent-text" : "text-text-muted")}>
                      <span className="block text-[10px] uppercase">{W1[d.weekday]}</span>
                      <span className={cn("mx-auto flex size-6 items-center justify-center rounded-pill tabular", d.date === today && "bg-accent text-on-accent font-semibold")}>{d.day}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.people.map((p) => (
                  <tr key={p.id} className="border-t border-border">
                    <th scope="row" className="sticky left-0 z-10 bg-surface px-4 py-1.5 text-left font-normal">
                      <span className="flex items-center gap-2"><Avatar name={p.name} size="xs" /><span className="max-w-36 truncate">{p.name}{p.isMe && <span className="text-text-muted"> (you)</span>}</span></span>
                    </th>
                    {data.days.map((d) => {
                      const c = p.cells[d.date];
                      return (
                        <td key={d.date} title={c ? `${p.name} · ${DAY(d.date)} · ${c.label}` : undefined}
                          className={cn("h-9 px-0.5 text-center", c?.kind === "weekly_off" || c?.kind === "holiday" ? "bg-surface-sunken" : "", d.date === today && "bg-accent-soft/40")}>
                          <CellMark c={c} />{c && <span className="sr-only">{c.label}</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Who's off this month" description={off.length ? `${off.length} ${off.length === 1 ? "person" : "people"}` : undefined} />
        {off.length === 0 ? (
          <p className="px-5 pb-5 text-base text-text-muted">No one has leave in {MONTH(data.month)}.</p>
        ) : (
          <ul className="divide-y divide-border border-t border-border">
            {off.map(({ p, r }) => (
              <li key={p.id} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:gap-4">
                <span className="w-44 shrink-0 font-medium">{p.name}{p.isMe && <span className="font-normal text-text-muted"> (you)</span>}</span>
                <ul className="flex flex-col gap-0.5 text-base">
                  {r.map((x) => <li key={x.from}>{x.from === x.to ? SHORT(x.from) : `${SHORT(x.from)} – ${SHORT(x.to)}`}: {x.label} <span className="text-text-muted tabular">({x.n} {x.n === 1 ? "day" : "days"})</span></li>)}
                </ul>
              </li>
            ))}
          </ul>
        )}
        {holidays.length > 0 && <p className="border-t border-border px-5 py-3 text-sm text-text-muted">Holidays: {holidays.map((h) => `${SHORT(h.date)}`).join(", ")}</p>}
      </Card>
    </div>
  );
}
