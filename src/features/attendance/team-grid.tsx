import { cn } from "@/lib/cn";
import { eachDay } from "@/lib/dates";
import type { GridCell, TeamMember } from "@/server/modules/attendance/team";
import { DAY_STATUS, TONE_CELL, dayLabel, statusOf } from "./status";

const LEGEND = ["present", "absent", "leave", "half_leave", "half_day", "wfh", "on_duty", "weekly_off", "holiday"] as const;

/**
 * People × days grid. Every cell carries a short code as well as a colour, plus a full text label for screen readers;
 * a plain-text summary per person sits underneath. The grid scrolls sideways inside its card, never the page.
 */
export function TeamGrid({ members, grid, first, last, today }: { members: TeamMember[]; grid: Record<string, Record<string, GridCell>>; first: string; last: string; today: string }) {
  const days = eachDay(first, last);
  const summary = (id: string) => {
    const cells = Object.values(grid[id] ?? {});
    const n = (s: string[]) => cells.filter((c) => s.includes(c.status)).length;
    return { present: n(["present"]), remote: n(["wfh", "on_duty"]), leave: n(["leave", "half_leave"]), absent: n(["absent"]), late: cells.filter((c) => c.late).length, penalties: cells.filter((c) => c.penalty).length };
  };
  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-border bg-surface" tabIndex={0} role="region" aria-label="Team attendance grid, scrolls sideways">
        <table className="border-collapse text-sm">
          <caption className="sr-only">Team attendance by day. Each cell shows a status code; P present, A absent, L leave, W work from home, OD on duty, WO weekly off, H holiday.</caption>
          <thead>
            <tr className="border-b border-border bg-surface-sunken">
              <th scope="col" className="sticky left-0 z-10 min-w-36 bg-surface-sunken px-3 py-2 text-left font-medium text-text-muted">Person</th>
              {days.map((d) => (
                <th key={d} scope="col" className={cn("w-9 min-w-9 px-0.5 py-1.5 text-center font-medium text-text-muted", d === today && "text-accent-text")}>
                  <abbr title={dayLabel(d, { weekday: "long", day: "numeric", month: "long" })} className="no-underline">
                    <span className="block text-xs">{dayLabel(d, { weekday: "narrow" })}</span>
                    <span className="block tabular">{Number(d.slice(8))}</span>
                  </abbr>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className="border-b border-border last:border-0">
                <th scope="row" className="sticky left-0 z-10 max-w-44 truncate bg-surface px-3 py-1.5 text-left font-medium">{m.name}</th>
                {days.map((d) => {
                  const c = grid[m.id]?.[d];
                  if (!c || c.status === "upcoming") return <td key={d} className="p-0.5"><span className="block h-8 rounded-sm" /></td>;
                  const s = statusOf(c.status);
                  const extra = [c.late && "late", c.missingSwipe && "missing swipe", c.penalty && "penalty", c.pending && "request pending"].filter(Boolean).join(", ");
                  const label = `${m.name}, ${dayLabel(d)}: ${s.label}${extra ? `, ${extra}` : ""}`;
                  return (
                    <td key={d} className="p-0.5">
                      <span role="img" title={label} aria-label={label}
                        className={cn("relative flex h-8 items-center justify-center rounded-sm text-xs font-semibold", TONE_CELL[s.tone], d === today && "ring-2 ring-focus")}>
                        <span aria-hidden>{s.code}</span>
                        {(c.late || c.missingSwipe || c.penalty) && <span aria-hidden className="absolute right-0.5 top-0.5 size-1.5 rounded-pill bg-danger" />}
                        {c.pending && <span aria-hidden className="absolute bottom-0.5 left-0.5 size-1.5 rounded-pill bg-accent" />}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm text-text-muted" aria-label="Legend">
        {LEGEND.map((k) => (
          <li key={k} className="flex items-center gap-1.5">
            <span aria-hidden className={cn("inline-flex h-5 min-w-7 items-center justify-center rounded-sm px-1 text-xs font-semibold", TONE_CELL[DAY_STATUS[k].tone])}>{DAY_STATUS[k].code}</span>
            {DAY_STATUS[k].label}
          </li>
        ))}
        <li className="flex items-center gap-1.5"><span aria-hidden className="size-2 rounded-pill bg-danger" />Late, missing swipe or penalty</li>
        <li className="flex items-center gap-1.5"><span aria-hidden className="size-2 rounded-pill bg-accent" />Request pending</li>
      </ul>
      <details className="mt-4 rounded-md border border-border bg-surface px-4 py-3">
        <summary className="cursor-pointer text-base font-medium">Month summary as text</summary>
        <ul className="mt-3 flex flex-col gap-1.5 text-base">
          {members.map((m) => {
            const s = summary(m.id);
            return <li key={m.id}><span className="font-medium">{m.name}:</span> {s.present} present, {s.remote} remote, {s.leave} on leave, {s.absent} absent, {s.late} late{s.penalties ? `, ${s.penalties} with penalties` : ""}.</li>;
          })}
        </ul>
      </details>
    </div>
  );
}
