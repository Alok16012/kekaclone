"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ClipboardList } from "lucide-react";
import { Card, CardBody, CardHeader, StatTile } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { EmptyState } from "@/ui/feedback";
import type { ExitSurveyResults as Results } from "@/server/modules/exits/survey";

const fmt = (d: string) => new Date(d.slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** /org/exits/survey: per-question summaries plus every leaver's answers. */
export function ExitSurveyResults({ results, departments, filters }: { results: Results; departments: { id: string; name: string }[]; filters: { from: string | null; to: string | null; departmentId: string | null } }) {
  const router = useRouter();
  const [f, setF] = React.useState({ from: filters.from ?? "", to: filters.to ?? "", department: filters.departmentId ?? "" });
  const [open, setOpen] = React.useState<string | null>(null);
  const apply = () => { const q = new URLSearchParams(); if (f.from) q.set("from", f.from); if (f.to) q.set("to", f.to); if (f.department) q.set("department", f.department); router.push(`/org/exits/survey${q.size ? `?${q}` : ""}`); };
  const pct = results.sent ? Math.round((results.answered / results.sent) * 100) : 0;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="Last working day from" className="w-40"><Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
          <Field label="to" className="w-40"><Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
          <Field label="Department" className="w-56"><Select value={f.department || undefined} onValueChange={(v) => setF({ ...f, department: v })} placeholder="All departments" options={departments.map((d) => ({ value: d.id, label: d.name }))} /></Field>
          <Button variant="secondary" onClick={apply}>Apply</Button>
          {(f.from || f.to || f.department) && <Button variant="ghost" onClick={() => { setF({ from: "", to: "", department: "" }); router.push("/org/exits/survey"); }}>Clear</Button>}
        </CardBody>
      </Card>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <StatTile label="Surveys sent" value={results.sent} icon={<ClipboardList />} />
        <StatTile label="Answered" value={results.answered} hint={`${pct}% response rate`} />
        <StatTile label="Questions" value={results.questions.length} />
      </div>
      {results.answered === 0 ? <Card><EmptyState icon={<ClipboardList />} title="No answers yet" description="Leavers get the survey when their exit starts. Results show here as soon as the first person answers." /></Card> : (
        <div className="grid gap-4 lg:grid-cols-2">
          {results.questions.map((q) => (
            <Card key={q.id}>
              <CardHeader title={q.prompt} description={`${q.summary.count} ${q.summary.count === 1 ? "answer" : "answers"}${q.archived ? " · no longer asked" : ""}`} />
              <CardBody>
                {q.summary.type === "rating" && (
                  <div className="flex flex-col gap-2">
                    <p className="text-2xl font-semibold tabular">{q.summary.average ?? "—"}<span className="text-sm font-normal text-text-muted"> / 5 average</span></p>
                    <Bars rows={q.summary.distribution.map((n, i) => ({ label: `${i + 1}`, n })).reverse()} total={q.summary.count} />
                  </div>
                )}
                {q.summary.type === "yes_no" && <Bars rows={[{ label: "Yes", n: q.summary.yes }, { label: "No", n: q.summary.no }]} total={q.summary.count} />}
                {q.summary.type === "choice" && <Bars rows={q.summary.counts.map((c) => ({ label: c.option, n: c.n }))} total={q.summary.count} />}
                {q.summary.type === "text" && (q.summary.answers.length === 0 ? <p className="text-sm text-text-muted">No written answers.</p> : (
                  <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto">{q.summary.answers.map((a, i) => <li key={i} className="rounded-md bg-surface-sunken px-3 py-2 text-base">“{a}”</li>)}</ul>
                ))}
              </CardBody>
            </Card>
          ))}
        </div>
      )}
      <Card>
        <CardHeader title="By person" description="Open a row to read their full answers." />
        {results.people.length === 0 ? <EmptyState compact title="Nobody in this period" /> : (
          <ul className="divide-y divide-border border-t border-border">
            {results.people.map((p) => (
              <li key={p.exit_id} className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <Link href={`/people/${p.employee_id}`} className="block truncate text-base font-medium hover:underline">{p.name}</Link>
                    <p className="text-sm text-text-muted">{p.department ?? "No department"} · last day {fmt(p.last_working_date)}</p>
                  </div>
                  <Badge tone={p.submitted_at ? "success" : "neutral"}>{p.submitted_at ? `Answered ${fmt(p.submitted_at)}` : "Not answered"}</Badge>
                  {p.submitted_at && <Button size="sm" variant="ghost" onClick={() => setOpen(open === p.exit_id ? null : p.exit_id)}>{open === p.exit_id ? "Hide" : "Read"}</Button>}
                </div>
                {open === p.exit_id && (
                  <dl className="mt-3 grid gap-2 rounded-md bg-surface-sunken p-3 sm:grid-cols-[1fr_2fr]">
                    {results.questions.map((q) => (
                      <React.Fragment key={q.id}>
                        <dt className="text-sm text-text-muted">{q.prompt}</dt>
                        <dd className="text-base">{q.id in p.answers ? String(p.answers[q.id] === true ? "Yes" : p.answers[q.id] === false ? "No" : p.answers[q.id]) : <span className="text-text-muted">—</span>}</dd>
                      </React.Fragment>
                    ))}
                  </dl>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Bars({ rows, total }: { rows: { label: string; n: number }[]; total: number }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <ul className="flex flex-col gap-1.5" aria-label="Answer counts">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[minmax(0,8rem)_1fr_3.5rem] items-center gap-2">
          <span className="truncate text-sm">{r.label}</span>
          <span className="h-3 rounded-r-xs bg-chart-1" style={{ width: `${Math.max(2, (r.n / max) * 100)}%` }} aria-hidden />
          <span className="text-right text-sm tabular text-text-muted">{r.n}{total ? ` · ${Math.round((r.n / total) * 100)}%` : ""}</span>
        </li>
      ))}
    </ul>
  );
}
