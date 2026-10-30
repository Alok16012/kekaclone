"use client";
import * as React from "react";
import Link from "next/link";
import { CalendarCheck2, CheckCircle2 } from "lucide-react";
import { Button } from "@/ui/button";
import { Card, CardBody, CardHeader, StatTile } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { RadioGroup } from "@/ui/choice";
import { ConfirmDialog } from "@/ui/overlay";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { cn } from "@/lib/cn";
import { yearEndRunAction } from "@/app/(app)/settings/leave/actions";
import { YEAR_START_LABEL, fmtDate, fmtMonth, fmtNum } from "./labels";

type Row = { employeeId: string; name: string; number: string; payGroup: boolean; typeId: string; type: string; cycleStart: string; cycleEnd: string; closing: number; pending: number; carry: number; encash: number; lapse: number; done: boolean };
type Plan = { id: string; name: string; year_start: string };

export function YearEnd({ plans, plan, rows, totals, months }: {
  plans: Plan[]; plan: Plan | null; rows: Row[]; months: string[];
  totals: { carry: number; encash: number; lapse: number; people: number };
}) {
  const [month, setMonth] = React.useState(months[0]);
  const [confirm, setConfirm] = React.useState(false);
  const open = rows.filter((r) => !r.done && (r.carry || r.encash || r.lapse));
  const done = rows.filter((r) => r.done);
  const byPerson = new Map<string, Row[]>();
  for (const r of rows) byPerson.set(r.employeeId, [...(byPerson.get(r.employeeId) ?? []), r]);
  const years = [...new Set(rows.map((r) => `${r.cycleStart}|${r.cycleEnd}`))];
  const noPayGroup = open.filter((r) => r.encash > 0 && !r.payGroup).length;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader title="Year-end processing" description="Close last leave year for a plan: carry days forward, encash them in payroll, and let the rest lapse, as each leave type's rules say." />
        <CardBody>
          <nav aria-label="Leave plans" className="flex flex-wrap gap-2">
            {plans.map((p) => (
              <Link key={p.id} href={`?plan=${p.id}`} aria-current={plan?.id === p.id ? "page" : undefined}
                className={cn("rounded-pill border border-border px-3 py-1 text-sm hover:bg-surface-hover", plan?.id === p.id && "border-accent bg-accent-soft text-accent-text")}>{p.name}</Link>
            ))}
          </nav>
          {plan && <p className="mt-3 text-sm text-text-muted">Leave year: {YEAR_START_LABEL[plan.year_start]}{years.length === 1 ? ` · closing ${fmtDate(years[0].split("|")[0])} to ${fmtDate(years[0].split("|")[1])}` : years.length > 1 ? " · each person's last leave year" : ""}</p>}
        </CardBody>
      </Card>

      {!plan ? (
        <Card><EmptyState icon={<CalendarCheck2 />} title="No leave plans yet" description={<>Create a <Link href="/settings/leave/plans" className="text-accent-text underline-offset-4 hover:underline">leave plan</Link> first.</>} /></Card>
      ) : rows.length === 0 ? (
        <Card><EmptyState icon={<CalendarCheck2 />} title="Nothing to close" description="No one on this plan had a balance with a quota last leave year." /></Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatTile label="People to process" value={totals.people} />
            <StatTile label="Days carried forward" value={fmtNum(totals.carry)} />
            <StatTile label="Days encashed" value={fmtNum(totals.encash)} />
            <StatTile label="Days lapsing" value={fmtNum(totals.lapse)} />
          </div>

          {open.length === 0 ? (
            <Banner tone="success" title="This leave year is closed">Everyone on {plan.name} has been processed. Running again changes nothing.</Banner>
          ) : (
            <Card>
              <CardHeader title="Run year end" description="Pending requests from last year are set aside, so they still have days when they're approved." />
              <CardBody className="flex flex-col gap-4">
                {totals.encash > 0 && (
                  <fieldset>
                    <legend className="mb-2 text-sm font-medium">Pay encashment in</legend>
                    <RadioGroup value={month} onValueChange={setMonth} className="sm:flex-row sm:gap-6" options={months.map((m) => ({ value: m, label: fmtMonth(m) }))} />
                    {noPayGroup > 0 && <p className="mt-2 text-sm text-warning-text">{noPayGroup} {noPayGroup === 1 ? "person has" : "people have"} no pay group yet. Their encashment is recorded in the leave ledger and picked up once payroll is set up.</p>}
                  </fieldset>
                )}
                <div><Button onClick={() => setConfirm(true)}>Close the year for {totals.people} {totals.people === 1 ? "person" : "people"}</Button></div>
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader title="Preview" description={`${byPerson.size} ${byPerson.size === 1 ? "person" : "people"} · closing balance = what's left after pending requests`} />
            <div className="overflow-x-auto border-t border-border">
              <table className="w-full min-w-[40rem] text-base">
                <caption className="sr-only">Year-end preview for {plan.name}</caption>
                <thead className="bg-surface-sunken text-left text-sm text-text-muted">
                  <tr><th scope="col" className="px-4 py-2 font-medium">Person</th><th scope="col" className="px-4 py-2 font-medium">Leave type</th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">Closing</th><th scope="col" className="px-4 py-2 text-right font-medium">Carry</th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">Encash</th><th scope="col" className="px-4 py-2 text-right font-medium">Lapse</th><th scope="col" className="px-4 py-2 font-medium">Status</th></tr>
                </thead>
                <tbody>
                  {[...byPerson.values()].map((list) => list.map((r, i) => (
                    <tr key={r.employeeId + r.typeId} className={cn("border-t border-border", i > 0 && "border-dashed")}>
                      <td className="px-4 py-2">{i === 0 ? <><span className="font-medium">{r.name}</span><span className="block text-sm text-text-muted">{r.number}</span></> : <span className="sr-only">{r.name}</span>}</td>
                      <td className="px-4 py-2">{r.type}{r.pending ? <span className="block text-sm text-text-muted">{fmtNum(r.pending)} pending set aside</span> : null}</td>
                      <td className="px-4 py-2 text-right tabular">{fmtNum(r.closing)}</td>
                      <td className="px-4 py-2 text-right tabular">{fmtNum(r.carry)}</td>
                      <td className="px-4 py-2 text-right tabular">{fmtNum(r.encash)}</td>
                      <td className="px-4 py-2 text-right tabular">{fmtNum(r.lapse)}</td>
                      <td className="px-4 py-2">{r.done ? <Badge tone="success"><CheckCircle2 aria-hidden />Done</Badge> : r.carry || r.encash || r.lapse ? <Badge tone="warning">To do</Badge> : <span className="text-sm text-text-muted">Nothing to do</span>}</td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </div>
            {done.length > 0 && open.length > 0 && <p className="px-5 py-3 text-sm text-text-muted">{done.length} rows were already processed and will be skipped.</p>}
          </Card>
        </>
      )}
      {confirm && plan && (
        <ConfirmDialog open onOpenChange={setConfirm} tone="primary" title={`Close last leave year for ${plan.name}?`}
          description={`${fmtNum(totals.carry)} days carry forward, ${fmtNum(totals.encash)} are encashed${totals.encash ? ` in ${fmtMonth(month)} payroll` : ""} and ${fmtNum(totals.lapse)} lapse. This can't be undone, but running it again won't double anything.`}
          confirmLabel="Close the year" onConfirm={async () => {
            const r = await yearEndRunAction(plan.id, month);
            if (r.ok) toast.success(`Year end done for ${plan.name}`, { description: `${r.data!.processed} balances processed.` }); else toast.error(r.error);
            setConfirm(false);
          }} />
      )}
    </div>
  );
}
