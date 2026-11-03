import Link from "next/link";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import type { GoalStatus } from "@/server/modules/performance/rules";
import { fmtDate, GoalStatusBadge, ProgressLine } from "./bits";

const LEVELS = ["Learning", "Working knowledge", "Skilled", "Advanced", "Expert"];
type D = {
  self: boolean; manage: boolean; period: string | null; skills: { competency_id: string; name: string; proficiency: number }[];
  goals: { id: string; title: string; progress: number; status: GoalStatus }[]; ratings: { cycle: string; rating: number | null; band: string | null; published_at: string | null }[];
};

/** Profile → Performance: skills, current goals and (for the person, their managers and HR) published ratings. */
export function PerformanceTab({ d, name }: { d: D; name: string }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Skills" action={d.self ? <Button size="sm" variant="ghost" asChild><Link href="/me/performance/skills">Edit</Link></Button> : undefined} />
        <CardBody>
          {!d.skills.length ? <p className="text-sm text-text-muted">{d.self ? "You haven't added any skills yet." : `${name} hasn't added any skills.`}</p> : (
            <ul className="flex flex-wrap gap-2">{d.skills.map((s) => <li key={s.competency_id}><Badge tone="neutral" size="md">{s.name} · {LEVELS[s.proficiency - 1]}</Badge></li>)}</ul>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title={`Goals${d.period ? ` · ${d.period}` : ""}`} action={d.self ? <Button size="sm" variant="ghost" asChild><Link href="/me/performance">Open</Link></Button> : undefined} />
        <CardBody>
          {!d.goals.length ? <p className="text-sm text-text-muted">No goals in this period.</p> : (
            <ul className="flex flex-col gap-3">{d.goals.map((g) => (
              <li key={g.id}><div className="flex items-center gap-2"><p className="min-w-0 flex-1 truncate text-base">{g.title}</p><GoalStatusBadge status={g.status} /></div><ProgressLine value={g.progress} label={`${g.title} progress`} /></li>
            ))}</ul>
          )}
        </CardBody>
      </Card>
      {(d.self || d.manage) && (
        <Card className="lg:col-span-2">
          <CardHeader title="Review results" description={d.self ? "Only you, your managers and HR see these" : undefined} />
          <CardBody>
            {!d.ratings.length ? <p className="text-sm text-text-muted">No published results yet.</p> : (
              <ul className="divide-y divide-border">{d.ratings.map((r, i) => (
                <li key={i} className="flex items-center gap-3 py-2"><span className="flex-1 text-base">{r.cycle}</span><span className="text-sm text-text-muted">{fmtDate(r.published_at)}</span>
                  <span className="w-10 text-right font-semibold tabular">{r.rating ?? "—"}</span>{r.band && <Badge tone="accent">{r.band}</Badge>}</li>
              ))}</ul>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
