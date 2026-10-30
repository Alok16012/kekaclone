"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { BarChart3, Download } from "lucide-react";
import { Card, CardHeader, StatTile } from "@/ui/card";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/choice";
import { Field, Input } from "@/ui/field";
import { EmptyState } from "@/ui/feedback";
import { inr, monthLabel, type Group } from "@/server/modules/expenses/rules";

type Summary = { totalPaise: number; count: number; byCategory: Group[]; byDepartment: Group[]; byMonth: Group[] };

/** Totals by category, department and month, with the filters in the URL so a report can be shared. */
export function ExpenseReports({ summary, from, to, includePending }: { summary: Summary; from: string; to: string; includePending: boolean }) {
  const router = useRouter();
  const [f, setF] = React.useState({ from, to, pending: includePending });
  const qs = (x: typeof f) => new URLSearchParams({ from: x.from, to: x.to, ...(x.pending ? { pending: "1" } : {}) }).toString();
  return (
    <div className="flex flex-col gap-6">
      <Card className="p-4">
        <form className="flex flex-col gap-4 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); router.push(`/expenses/reports?${qs(f)}`); }}>
          <Field label="From" className="sm:w-44"><Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} required /></Field>
          <Field label="To" className="sm:w-44"><Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} required /></Field>
          <Checkbox className="sm:mb-2" label="Include claims still in review" checked={f.pending} onCheckedChange={(c) => setF({ ...f, pending: !!c })} />
          <div className="flex gap-2 sm:ml-auto">
            <Button type="submit" variant="secondary">Show</Button>
            <Button asChild><a href={`/expenses/reports/export?${qs({ from, to, pending: includePending })}`} download><Download />CSV</a></Button>
          </div>
        </form>
        <p className="mt-3 text-sm text-text-muted">By the date the money was spent. {includePending ? "Includes claims in review." : "Approved and paid claims only."} Only people you look after are counted.</p>
      </Card>
      {summary.count === 0 ? (
        <Card><EmptyState icon={<BarChart3 />} title="No expenses in this period" description="Try a wider date range, or include claims still in review." /></Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatTile label="Total" value={inr(summary.totalPaise)} />
            <StatTile label="Expenses" value={summary.count} />
            <StatTile label="Average" value={inr(Math.round(summary.totalPaise / summary.count))} />
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <Breakdown title="By category" groups={summary.byCategory} total={summary.totalPaise} />
            <Breakdown title="By department" groups={summary.byDepartment} total={summary.totalPaise} />
          </div>
          <Breakdown title="By month" groups={summary.byMonth.map((g) => ({ ...g, key: monthLabel(g.key + "-01") }))} total={summary.totalPaise} />
        </>
      )}
    </div>
  );
}

function Breakdown({ title, groups, total }: { title: string; groups: Group[]; total: number }) {
  const max = Math.max(...groups.map((g) => g.totalPaise), 1);
  return (
    <Card>
      <CardHeader title={title} />
      <table className="w-full text-base">
        <caption className="sr-only">{title}</caption>
        <thead><tr className="border-y border-border text-left text-sm text-text-muted"><th scope="col" className="px-5 py-2 font-medium">Name</th><th scope="col" className="hidden px-2 py-2 font-medium sm:table-cell"><span className="sr-only">Share</span></th><th scope="col" className="px-5 py-2 text-right font-medium">Amount</th></tr></thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.key} className="border-b border-border last:border-0">
              <td className="px-5 py-2"><span className="font-medium">{g.key}</span><span className="block text-sm text-text-muted">{g.count} {g.count === 1 ? "expense" : "expenses"} · {Math.round((g.totalPaise / total) * 100)}%</span></td>
              <td className="hidden w-2/5 px-2 sm:table-cell"><div aria-hidden className="h-2 rounded-pill bg-accent" style={{ width: `${Math.max(2, (g.totalPaise / max) * 100)}%` }} /></td>
              <td className="px-5 py-2 text-right tabular">{inr(g.totalPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
