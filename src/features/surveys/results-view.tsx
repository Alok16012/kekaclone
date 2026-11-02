import Link from "next/link";
import { Download, EyeOff, Filter, Gauge, Users } from "lucide-react";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card, CardBody, CardHeader, StatTile } from "@/ui/card";
import { Banner, EmptyState } from "@/ui/feedback";
import { controlBase } from "@/ui/field";
import { cn } from "@/lib/cn";
import type { Results } from "@/server/modules/surveys/service";
import type { QuestionSummary } from "@/server/modules/surveys/rules";

function Bars({ counts, total }: { counts: { label: string; count: number }[]; total: number }) {
  const top = Math.max(1, ...counts.map((c) => c.count));
  return (
    <ul className="flex flex-col gap-2">
      {counts.map((c) => (
        <li key={c.label} className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-3 text-sm sm:grid-cols-[minmax(0,12rem)_1fr_auto]">
          <span className="truncate" title={c.label}>{c.label}</span>
          <span className="h-2.5 overflow-hidden rounded-pill bg-surface-hover" aria-hidden><span className="block h-full rounded-pill bg-chart-1" style={{ width: `${(c.count / top) * 100}%` }} /></span>
          <span className="tabular text-text-muted">{c.count}{total ? ` · ${Math.round((c.count / total) * 100)}%` : ""}</span>
        </li>
      ))}
    </ul>
  );
}

function Summary({ s }: { s: QuestionSummary }) {
  if (s.total === 0) return <p className="text-sm text-text-muted">No answers to this question yet.</p>;
  switch (s.kind) {
    case "choices": case "dates": return <Bars counts={s.counts} total={s.total} />;
    case "scale": return (
      <div className="flex flex-col gap-3">
        <p className="text-sm"><span className="text-xl font-semibold tabular">{s.average}</span><span className="text-text-muted"> average of {s.max} · {s.total} answers</span>
          {s.enps && s.enps.score != null && <span className="ml-2"><Badge tone={s.enps.score >= 0 ? "success" : "danger"}>eNPS {s.enps.score > 0 ? "+" : ""}{s.enps.score}</Badge></span>}</p>
        <Bars counts={s.counts} total={s.total} />
      </div>
    );
    case "text": return (
      <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto">
        {s.answers.map((a, i) => <li key={i} className="rounded-md bg-surface-sunken px-3 py-2 text-sm whitespace-pre-line break-words">{a}</li>)}
      </ul>
    );
  }
}

const select = cn(controlBase, "h-9 px-3");

/** Results for one round: response rate, eNPS, a chart per question, filters by department and location, CSV. */
export function ResultsView({ r }: { r: Results }) {
  const rate = r.audience ? Math.round((r.participated / r.audience) * 100) : 0;
  const threshold = Math.max(3, r.survey.minResponses);
  const filtered = !!(r.filters.departmentId || r.filters.locationId);
  const exportHref = `/engage/surveys/${r.survey.id}/export?round=${r.filters.round}`;
  return (
    <div className="flex flex-col gap-6">
      <form method="get" className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 sm:flex-row sm:flex-wrap sm:items-end" aria-label="Filter results">
        {r.rounds.length > 1 && (
          <label className="flex flex-col gap-1.5 text-sm font-medium">Round
            <select name="round" defaultValue={r.filters.round} className={select}>{r.rounds.map((n) => <option key={n} value={n}>Round {n}{n === r.survey.round ? " (current)" : ""}</option>)}</select>
          </label>
        )}
        <label className="flex flex-col gap-1.5 text-sm font-medium">Department
          <select name="department" defaultValue={r.filters.departmentId ?? ""} className={select}><option value="">All departments</option>{r.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">Location
          <select name="location" defaultValue={r.filters.locationId ?? ""} className={select}><option value="">All locations</option>{r.locations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        </label>
        <div className="flex gap-2">
          <Button type="submit" variant="secondary"><Filter />Apply</Button>
          {filtered && <Button asChild variant="ghost"><Link href={`/engage/surveys/${r.survey.id}/results?round=${r.filters.round}`}>Clear</Link></Button>}
        </div>
        <div className="sm:ml-auto">
          {!r.hidden && r.responses > 0 && !filtered ? <Button asChild variant="secondary"><a href={exportHref} download><Download />Export CSV</a></Button> : null}
        </div>
      </form>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile label="Response rate" value={`${rate}%`} hint={`${r.participated} of ${r.audience} people`} icon={<Users />} />
        <StatTile label="eNPS" value={r.enps?.score != null ? `${r.enps.score > 0 ? "+" : ""}${r.enps.score}` : "—"} hint={r.enps ? `${r.enps.promoters} promoters · ${r.enps.passives} passive · ${r.enps.detractors} detractors` : "Needs a 0–10 recommend question"} icon={<Gauge />} />
        <StatTile label={filtered ? "Answers in this group" : "Answers"} value={r.hidden ? "Hidden" : r.responses} hint={r.survey.anonymous ? `Anonymous · shown from ${threshold}` : "Named"} icon={<EyeOff />} />
      </div>

      {r.trend.length > 1 && (
        <Card>
          <CardHeader title="Pulse over time" description="eNPS by round" />
          <CardBody>
            <ul className="flex flex-col gap-2 text-sm">
              {r.trend.map((t) => (
                <li key={t.round} className="flex justify-between gap-3"><span>Round {t.round}</span>
                  <span className="tabular text-text-muted">{t.hidden ? "Too few answers to show" : `${t.responses} answers${t.enps != null ? ` · eNPS ${t.enps > 0 ? "+" : ""}${t.enps}` : ""}`}</span></li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {r.hidden ? (
        <Banner tone="info" title="Not enough answers to show yet">
          This survey is anonymous. Results {filtered ? "for this group " : ""}appear once at least {threshold} people have answered, so no one can be singled out.
        </Banner>
      ) : r.questions.length === 0 ? <Card><EmptyState compact title="This survey has no questions" /></Card> : (
        r.questions.map((q, i) => (
          <Card key={q.id}>
            <CardHeader title={`${i + 1}. ${q.prompt}`} description={q.typeLabel} />
            <CardBody>{q.summary && <Summary s={q.summary} />}</CardBody>
          </Card>
        ))
      )}
    </div>
  );
}
