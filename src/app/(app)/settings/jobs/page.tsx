import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { AppError } from "@/server/db";
import { canSeeRuns, recentRuns, STEPS } from "@/server/modules/corehr/scheduler";
import { Card, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { EmptyState } from "@/ui/feedback";

export const metadata: Metadata = { title: "Scheduled jobs" };

const show = (r: Record<string, unknown>) => Object.entries(r).filter(([, v]) => typeof v === "number" || typeof v === "string").map(([k, v]) => `${k.replace(/([A-Z])/g, " $1").toLowerCase()}: ${v}`).join(" · ");

/** What the nightly run (`pnpm jobs:daily`) did for this company over the last week. */
export default async function JobsPage() {
  const runs = await load(async (tx, actor) => {
    if (!canSeeRuns(actor)) throw new AppError("forbidden", "You don't have access to this page.");
    return recentRuns(tx);
  });
  const dates = [...new Set(runs.map((r) => r.run_date))];
  const label = Object.fromEntries(STEPS.map((s) => [s.key, s.label]));
  return (
    <Card>
      <CardHeader title="Scheduled jobs" description="Every night erp relieves people whose last day has passed, applies dated job changes, confirms probation, processes attendance, credits leave, escalates waiting approvals and sends the approver digest." />
      {dates.length === 0 ? <EmptyState compact title="No runs recorded yet" description="Once the daily job runs, each step shows here." /> : (
        <div className="border-t border-border">
          {dates.map((d) => (
            <section key={d}>
              <h4 className="bg-surface-sunken px-5 py-2 text-sm font-semibold">{new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}</h4>
              <ul className="divide-y divide-border">
                {runs.filter((r) => r.run_date === d).map((r) => (
                  <li key={r.job} className="flex flex-wrap items-center gap-3 px-5 py-2.5">
                    <span className="min-w-0 flex-1"><span className="block text-base">{label[r.job] ?? r.job}</span><span className="block text-sm text-text-muted">{show(r.result) || "Nothing to do"}</span></span>
                    {r.status === "ok" ? <Badge tone="success">Done</Badge> : <Badge tone="danger">Failed</Badge>}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}
