"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { LineChart } from "lucide-react";
import { GOAL_STATUS_LABEL, type GoalStatus, type Insight } from "@/server/modules/performance/rules";
import { Card, CardBody, CardHeader, StatTile } from "@/ui/card";
import { DataTable, type Column } from "@/ui/table";
import { Select } from "@/ui/select";
import { EmptyState } from "@/ui/feedback";
import { ProgressLine } from "./bits";

type Row = Insight & { id: string; name: string; department: string | null; goals: number };
const ORDER: GoalStatus[] = ["on_track", "at_risk", "behind", "not_started", "completed", "closed"];
const COLOR: Record<GoalStatus, string> = { on_track: "var(--chart-2)", at_risk: "var(--chart-4)", behind: "var(--chart-5)", not_started: "var(--chart-7)", completed: "var(--chart-1)", closed: "var(--chart-8)" };

/** Status mix (stacked bar with legend and a text list), overdue and stagnant goals, and per-person rows. */
export function GoalInsights({ data, periods, periodId }: { data: { overall: Insight; people: Row[]; isAdmin: boolean }; periods: { id: string; name: string }[]; periodId: string | null }) {
  const router = useRouter();
  const o = data.overall;
  const cols: Column<Row>[] = [
    { key: "name", header: "Person", cell: (r) => <div><p className="font-medium">{r.name}</p>{r.department && <p className="text-xs text-text-muted">{r.department}</p>}</div>, sortValue: (r) => r.name },
    { key: "goals", header: "Goals", align: "right", cell: (r) => r.goals, sortValue: (r) => r.goals },
    { key: "progress", header: "Average progress", cell: (r) => (r.goals ? <div className="w-40"><ProgressLine value={r.avgProgress} label={`${r.name} average progress`} /></div> : <span className="text-text-muted">No goals</span>), sortValue: (r) => r.avgProgress },
    { key: "risk", header: "At risk / behind", align: "right", cell: (r) => r.byStatus.at_risk + r.byStatus.behind, sortValue: (r) => r.byStatus.at_risk + r.byStatus.behind, hideBelow: "md" },
    { key: "overdue", header: "Overdue", align: "right", cell: (r) => (r.overdue ? <span className="font-medium text-danger-text">{r.overdue}</span> : 0), sortValue: (r) => r.overdue },
    { key: "stagnant", header: "No update in 2 weeks", align: "right", cell: (r) => r.stagnant, sortValue: (r) => r.stagnant, hideBelow: "md" },
  ];
  return (
    <div className="flex flex-col gap-4">
      {periods.length > 0 && <div className="w-56"><Select size="sm" value={periodId ?? undefined} onValueChange={(v) => router.push(`/performance/insights?period=${v}`)} options={periods.map((p) => ({ value: p.id, label: p.name }))} /></div>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Goals" value={o.total} />
        <StatTile label="Average progress" value={`${Math.round(o.avgProgress)}%`} />
        <StatTile label="Overdue" value={o.overdue} hint="Past due and not finished" />
        <StatTile label="Stagnant" value={o.stagnant} hint="No check-in for two weeks" />
      </div>
      <Card>
        <CardHeader title="Status mix" />
        <CardBody>
          {!o.total ? <p className="text-sm text-text-muted">No goals in this period.</p> : (
            <figure>
              <div className="flex h-4 w-full overflow-hidden rounded-pill" role="img" aria-label={`Status mix: ${ORDER.filter((s) => o.byStatus[s]).map((s) => `${GOAL_STATUS_LABEL[s]} ${o.byStatus[s]}`).join(", ")}`}>
                {ORDER.filter((s) => o.byStatus[s]).map((s) => <div key={s} style={{ width: `${(o.byStatus[s] / o.total) * 100}%`, background: COLOR[s] }} />)}
              </div>
              <figcaption className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
                {ORDER.filter((s) => o.byStatus[s]).map((s) => <span key={s} className="inline-flex items-center gap-1.5"><span aria-hidden className="size-3 rounded-sm" style={{ background: COLOR[s] }} />{GOAL_STATUS_LABEL[s]} <span className="tabular text-text-muted">{o.byStatus[s]}</span></span>)}
              </figcaption>
            </figure>
          )}
        </CardBody>
      </Card>
      <DataTable caption="Goals per person" rows={data.people} columns={cols} rowKey={(r) => r.id} empty={<EmptyState icon={<LineChart />} title="Nobody to show" />} />
    </div>
  );
}
