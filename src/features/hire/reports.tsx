"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardBody, CardHeader, StatTile } from "@/ui/card";
import { Button } from "@/ui/button";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { EmptyState } from "@/ui/feedback";
import type { hiringReport } from "@/server/modules/hire/reports";

type Report = Awaited<ReturnType<typeof hiringReport>>;

/** One horizontal bar per row, single hue (magnitude only), value labelled in text ink beside the bar. */
function Bars({ rows, max, caption }: { rows: { key: string; label: string; value: number; note?: string }[]; max: number; caption: string }) {
  return (
    <table className="w-full text-base">
      <caption className="sr-only">{caption}</caption>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="group" title={`${r.label}: ${r.value}${r.note ? ` (${r.note})` : ""}`}>
            <th scope="row" className="w-32 py-1.5 pr-3 text-left text-sm font-normal text-text-muted sm:w-40">{r.label}</th>
            <td className="py-1.5">
              <div className="flex items-center gap-2">
                <div className="h-3 flex-1 rounded-r-sm bg-surface-sunken">
                  <div className="h-full rounded-r-sm bg-accent transition-opacity group-hover:opacity-80" style={{ width: `${max ? Math.max(r.value ? 2 : 0, (r.value / max) * 100) : 0}%` }} />
                </div>
                <span className="w-24 text-right text-sm tabular text-text">{r.value}{r.note ? <span className="text-text-muted"> · {r.note}</span> : null}</span>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** S152: hiring analytics for a date range (applications created in it), optionally one job. */
export function HiringReports({ report, range }: { report: Report; range: { from: string; to: string; jobId: string | null } }) {
  const router = useRouter();
  const [f, setF] = React.useState({ from: range.from, to: range.to, job: range.jobId ?? "all" });
  const apply = () => { const p = new URLSearchParams({ from: f.from, to: f.to }); if (f.job !== "all") p.set("job", f.job); router.push(`/hire/reports?${p}`); };
  const top = report.funnel[0]?.count ?? 0;
  return (
    <div className="flex flex-col gap-5">
      <Card className="p-4">
        <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); apply(); }}>
          <Field label="Applied from"><Input type="date" value={f.from} onChange={(e) => setF((x) => ({ ...x, from: e.target.value }))} /></Field>
          <Field label="to"><Input type="date" value={f.to} onChange={(e) => setF((x) => ({ ...x, to: e.target.value }))} /></Field>
          <Field label="Job" className="sm:w-64"><Select value={f.job} onValueChange={(v) => setF((x) => ({ ...x, job: v }))} options={[{ value: "all", label: "All jobs" }, ...report.jobs.map((j) => ({ value: j.id, label: j.title }))]} /></Field>
          <Button type="submit" variant="secondary">Update</Button>
        </form>
      </Card>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Applications" value={report.total} hint={`${report.active} still active`} />
        <StatTile label="Hires" value={report.timeToHire.hires} />
        <StatTile label="Average time to hire" value={report.timeToHire.average == null ? "—" : `${report.timeToHire.average} days`} hint={report.timeToHire.median == null ? undefined : `median ${report.timeToHire.median} days`} />
        <StatTile label="Offer acceptance" value={report.offers.rate == null ? "—" : `${report.offers.rate}%`} hint={`${report.offers.accepted} accepted, ${report.offers.declined} declined or expired`} />
      </div>
      {report.total === 0 ? <Card><EmptyState title="No applications in this period" description="Try a wider date range." /></Card> : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Funnel" description="How many applications reached each stage, and the share that moved on from the stage before." />
            <CardBody><Bars caption="Applications reaching each stage" max={top} rows={report.funnel.map((s) => ({ key: s.group, label: s.label, value: s.count, note: s.conversion == null ? undefined : `${s.conversion}%` }))} /></CardBody>
          </Card>
          <Card>
            <CardHeader title="Where candidates come from" description="Applications by source, with hires." />
            <CardBody><Bars caption="Applications by source" max={Math.max(...report.sources.map((s) => s.applied), 0)} rows={report.sources.map((s) => ({ key: s.source, label: s.label, value: s.applied, note: s.hired ? `${s.hired} hired` : undefined }))} /></CardBody>
          </Card>
          <Card>
            <CardHeader title="Time in each stage" description="Average days before moving on." />
            <CardBody>{report.stageTime.length ? <Bars caption="Average days in each stage" max={Math.max(...report.stageTime.map((s) => s.days))} rows={report.stageTime.map((s) => ({ key: s.group, label: s.label, value: s.days }))} /> : <p className="text-base text-text-muted">No stage moves yet.</p>}</CardBody>
          </Card>
          <Card>
            <CardHeader title="Why candidates were turned down" />
            <CardBody>{report.reasons.length ? <Bars caption="Rejection reasons" max={Math.max(...report.reasons.map((r) => r.n))} rows={report.reasons.map((r) => ({ key: r.reason, label: r.reason, value: r.n }))} /> : <p className="text-base text-text-muted">No rejections in this period.</p>}</CardBody>
          </Card>
          <Card className="lg:col-span-2">
            <CardHeader title="Recruiter load" description="Open and on-hold jobs each recruiter is on." />
            {report.load.length === 0 ? <EmptyState compact title="No recruiters on open jobs" /> : (
              <div className="overflow-x-auto border-t border-border">
                <table className="w-full text-base">
                  <caption className="sr-only">Recruiter load</caption>
                  <thead className="bg-surface-sunken text-left text-sm text-text-muted"><tr><th scope="col" className="px-5 py-2 font-medium">Recruiter</th><th scope="col" className="px-5 py-2 text-right font-medium">Jobs</th><th scope="col" className="px-5 py-2 text-right font-medium">Active candidates</th><th scope="col" className="px-5 py-2 text-right font-medium">Interviews pending</th></tr></thead>
                  <tbody>{report.load.map((r) => <tr key={r.name} className="border-t border-border"><td className="px-5 py-2">{r.name}</td><td className="px-5 py-2 text-right tabular">{r.jobs}</td><td className="px-5 py-2 text-right tabular">{r.active}</td><td className="px-5 py-2 text-right tabular">{r.interviews}</td></tr>)}</tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
