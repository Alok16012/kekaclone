"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, GitBranch } from "lucide-react";
import type { Goal } from "@/server/modules/performance/goals";
import { LEVEL_LABEL } from "@/server/modules/performance/rules";
import { Card } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Select } from "@/ui/select";
import { EmptyState } from "@/ui/feedback";
import { GoalStatusBadge, ProgressLine } from "./bits";

/** Goals nested by alignment as an ARIA tree: arrow keys aren't needed, each branch has its own expand button. */
export function OkrTree({ goals, periods, periodId }: { goals: Goal[]; periods: { id: string; name: string }[]; periodId: string | null }) {
  const router = useRouter();
  const ids = new Set(goals.map((g) => g.id));
  const children = React.useMemo(() => {
    const m = new Map<string, Goal[]>();
    for (const g of goals) if (g.parent_id && ids.has(g.parent_id)) m.set(g.parent_id, [...(m.get(g.parent_id) ?? []), g]);
    return m;
  }, [goals]); // eslint-disable-line react-hooks/exhaustive-deps
  const roots = goals.filter((g) => !g.parent_id || !ids.has(g.parent_id));
  const [closed, setClosed] = React.useState<Set<string>>(new Set());
  const toggle = (id: string) => setClosed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const node = (g: Goal, depth: number): React.ReactNode => {
    const kids = children.get(g.id) ?? [];
    const open = !closed.has(g.id);
    return (
      <li key={g.id} role="treeitem" aria-expanded={kids.length ? open : undefined} aria-level={depth + 1} aria-selected={false}>
        <div className="flex items-start gap-2 border-b border-border py-2.5" style={{ paddingLeft: `${depth * 1.25}rem` }}>
          {kids.length ? <button type="button" onClick={() => toggle(g.id)} aria-label={open ? `Collapse ${g.title}` : `Expand ${g.title}`} className="mt-0.5 text-text-muted hover:text-text">{open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</button> : <span className="w-4" />}
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-base"><span className="font-medium">{g.title}</span><Badge>{LEVEL_LABEL[g.level]}</Badge>
              <span className="text-sm text-text-muted">{g.level === "individual" ? g.owner : g.level === "department" ? g.department : "Company"}{kids.length ? ` · ${kids.length} aligned` : ""}</span></p>
            <div className="mt-1 flex flex-wrap items-center gap-3"><div className="w-48 max-w-full"><ProgressLine value={g.progress} label={`${g.title} progress`} /></div><GoalStatusBadge status={g.status} /></div>
          </div>
        </div>
        {kids.length > 0 && open && <ul role="group">{kids.map((k) => node(k, depth + 1))}</ul>}
      </li>
    );
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {periods.length > 0 && <div className="w-56"><Select size="sm" value={periodId ?? undefined} onValueChange={(v) => router.push(`/performance/okr-tree?period=${v}`)} options={periods.map((p) => ({ value: p.id, label: p.name }))} /></div>}
        <div className="ml-auto flex gap-2"><Button size="sm" variant="ghost" onClick={() => setClosed(new Set())}>Expand all</Button><Button size="sm" variant="ghost" onClick={() => setClosed(new Set(goals.map((g) => g.id)))}>Collapse all</Button></div>
      </div>
      {!goals.length ? <Card><EmptyState icon={<GitBranch />} title="No goals in this period" description="Company goals sit at the top; department and individual goals align beneath them." /></Card> : (
        <Card className="px-4"><ul role="tree" aria-label="Goal alignment">{roots.map((g) => node(g, 0))}</ul></Card>
      )}
    </div>
  );
}
