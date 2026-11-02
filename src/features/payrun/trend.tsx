import { fmtMonth, money } from "./format";

/** Monthly cost to company for the last finalised runs, as simple bars with the figures as text. */
export function CostTrend({ points }: { points: { month: string; cost: number; net: number }[] }) {
  if (!points.length) return <p className="text-sm text-text-muted">The cost trend appears once a run is finalised.</p>;
  const max = Math.max(...points.map((p) => p.cost), 1);
  return (
    <figure>
      <figcaption className="mb-2 text-sm text-text-muted">Cost to company, last {points.length} {points.length === 1 ? "month" : "months"}</figcaption>
      <ul className="flex h-28 items-end gap-2" aria-label="Cost to company by month">
        {points.map((p) => (
          <li key={p.month} className="flex min-w-0 flex-1 flex-col items-center gap-1">
            <span className="text-xs tabular text-text-muted">{money(Math.round(p.cost / 100_000) * 100_000).replace(/\.00$/, "")}</span>
            <span className="w-full max-w-12 rounded-t-sm bg-accent" style={{ height: `${Math.max(4, (p.cost / max) * 72)}px` }} aria-hidden />
            <span className="text-xs text-text-muted">{fmtMonth(p.month).slice(0, 3)}</span>
            <span className="sr-only">{fmtMonth(p.month)}: {money(p.cost)} cost, {money(p.net)} net pay</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
