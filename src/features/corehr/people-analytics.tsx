"use client";
import * as React from "react";
import Link from "next/link";
import { TrendingDown, UserMinus, UserPlus, Users } from "lucide-react";
import { Card, CardBody, CardHeader, StatTile } from "@/ui/card";
import { Segmented } from "@/ui/choice";
import { EmptyState } from "@/ui/feedback";
import type { Analytics } from "@/server/modules/corehr/analytics";

/** Headcount and attrition: joins vs exits per month, attrition rate, by department and reason, tenure. SVG + tables (no chart library). */
export function PeopleAnalytics({ d, months }: { d: Analytics; months: number }) {
  const leftTotal = d.months.reduce((n, r) => n + r.left, 0), joinedTotal = d.months.reduce((n, r) => n + r.joined, 0);
  const label = (m: number) => (m === 6 ? "6 months" : m === 12 ? "12 months" : "24 months");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-text-muted">{d.months[0]?.label} to {d.months[d.months.length - 1]?.label}</p>
        <nav aria-label="Window"><Segmented label="Window" value={String(months) as "6" | "12" | "24"} onChange={() => {}} options={[6, 12, 24].map((m) => ({ value: String(m) as "6" | "12" | "24", label: <Link href={`/org/analytics?months=${m}`} aria-label={`Last ${label(m)}`}>{label(m)}</Link> }))} /></nav>
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Headcount today" value={d.headcount.total} icon={<Users />} hint={d.headcount.notice ? `${d.headcount.notice} on notice` : "nobody on notice"} />
        <StatTile label="Joined" value={joinedTotal} icon={<UserPlus />} hint={`in the last ${label(months)}`} />
        <StatTile label="Left" value={leftTotal} icon={<UserMinus />} hint={`in the last ${label(months)}`} />
        <StatTile label="Annualised attrition" value={d.annualised == null ? "—" : `${d.annualised}%`} icon={<TrendingDown />} hint="leavers ÷ average headcount, per year" />
      </div>

      <Card>
        <CardHeader title="Joins and exits by month" description="Bars: joiners (up) and leavers (down). Line: attrition rate against the headcount at the start of the month." />
        <CardBody>{d.months.length ? <JoinsExitsChart rows={d.months} /> : <EmptyState compact title="No data" />}</CardBody>
        <table className="sr-only"><caption>Joins and exits by month</caption><thead><tr><th>Month</th><th>Headcount at start</th><th>Joined</th><th>Left</th><th>Attrition %</th></tr></thead>
          <tbody>{d.months.map((r) => <tr key={r.month}><td>{r.label}</td><td>{r.start}</td><td>{r.joined}</td><td>{r.left}</td><td>{r.rate ?? "—"}</td></tr>)}</tbody></table>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Attrition by department" description="Leavers in the window against the department's headcount at its start." />
          {d.departments.length === 0 ? <EmptyState compact title="No departments" /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-base">
                <thead><tr className="text-left text-xs uppercase tracking-wide text-text-muted"><th className="px-5 py-2">Department</th><th className="px-2 py-2 text-right">Headcount</th><th className="px-2 py-2 text-right">Left</th><th className="px-5 py-2 text-right">Rate</th></tr></thead>
                <tbody className="divide-y divide-border">
                  {d.departments.map((r) => (
                    <tr key={r.name}><td className="px-5 py-2">{r.name}</td><td className="px-2 py-2 text-right tabular">{r.headcount}</td><td className="px-2 py-2 text-right tabular">{r.left}</td>
                      <td className="px-5 py-2 text-right tabular">{r.rate == null ? "—" : <span className={r.rate >= 20 ? "font-medium text-danger-text" : ""}>{r.rate}%</span>}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card>
          <CardHeader title="Why people left" description="Reasons recorded on exits in the window." />
          <CardBody>
            {d.reasons.length === 0 ? <EmptyState compact title="No exits in this window" /> : (
              <ul className="flex flex-col gap-2" aria-label="Exit reasons">
                {d.reasons.map((r) => (
                  <li key={r.reason} className="grid grid-cols-[minmax(0,12rem)_1fr_2.5rem] items-center gap-3">
                    <span className="truncate text-base">{r.reason} <span className="text-xs text-text-muted">{r.kind}</span></span>
                    <span className="h-3 rounded-r-xs bg-chart-2" style={{ width: `${Math.max(3, (r.n / Math.max(1, leftTotal)) * 100)}%` }} aria-hidden />
                    <span className="text-right text-base font-medium tabular">{r.n}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Average tenure" />
          <CardBody className="grid grid-cols-2 gap-4">
            <div><p className="text-sm text-text-muted">People here today</p><p className="text-2xl font-semibold tabular">{d.tenure.current == null ? "—" : `${d.tenure.current} yrs`}</p><p className="text-xs text-text-muted">{d.tenure.currentCount} people</p></div>
            <div><p className="text-sm text-text-muted">People who left in the window</p><p className="text-2xl font-semibold tabular">{d.tenure.leavers == null ? "—" : `${d.tenure.leavers} yrs`}</p><p className="text-xs text-text-muted">{d.tenure.leaverCount} people</p></div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Tenure of current staff" />
          <CardBody>
            <ul className="flex flex-col gap-2" aria-label="Tenure bands">
              {d.bands.map((b) => (
                <li key={b.label} className="grid grid-cols-[minmax(0,6rem)_1fr_2.5rem] items-center gap-3">
                  <span className="text-base">{b.label}</span>
                  <span className="h-3 rounded-r-xs bg-chart-1" style={{ width: `${Math.max(3, (b.n / Math.max(1, d.headcount.total)) * 100)}%` }} aria-hidden />
                  <span className="text-right text-base font-medium tabular">{b.n}</span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function JoinsExitsChart({ rows }: { rows: Analytics["months"] }) {
  const W = 720, H = 240, padL = 36, padR = 40, padB = 28, mid = 130, half = 90;
  const n = rows.length, bw = (W - padL - padR) / n;
  const maxBar = Math.max(1, ...rows.map((r) => Math.max(r.joined, r.left)));
  const maxRate = Math.max(5, ...rows.map((r) => r.rate ?? 0));
  const y = (v: number) => mid - (v / maxBar) * half;
  const yr = (v: number) => H - padB - (v / maxRate) * (H - padB - 16);
  const line = rows.map((r, i) => (r.rate == null ? null : `${padL + i * bw + bw / 2},${yr(r.rate)}`)).filter(Boolean).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Joins and exits per month with the attrition rate">
      <line x1={padL} x2={W - padR} y1={mid} y2={mid} className="stroke-border" strokeWidth="1" />
      {rows.map((r, i) => {
        const x = padL + i * bw + bw * 0.2, w = bw * 0.6;
        return (
          <g key={r.month}>
            {r.joined > 0 && <rect x={x} y={y(r.joined)} width={w} height={mid - y(r.joined)} rx="2" className="fill-chart-1"><title>{r.label}: {r.joined} joined</title></rect>}
            {r.left > 0 && <rect x={x} y={mid} width={w} height={(r.left / maxBar) * half} rx="2" className="fill-chart-2"><title>{r.label}: {r.left} left</title></rect>}
            <text x={x + w / 2} y={H - 8} textAnchor="middle" className="fill-text-muted" fontSize="10">{r.label}</text>
            {r.joined > 0 && <text x={x + w / 2} y={y(r.joined) - 3} textAnchor="middle" className="fill-text" fontSize="10">{r.joined}</text>}
            {r.left > 0 && <text x={x + w / 2} y={mid + (r.left / maxBar) * half + 11} textAnchor="middle" className="fill-text" fontSize="10">{r.left}</text>}
          </g>
        );
      })}
      {line && <polyline points={line} fill="none" className="stroke-chart-3" strokeWidth="2" strokeLinejoin="round" />}
      {rows.map((r, i) => r.rate != null && <circle key={r.month} cx={padL + i * bw + bw / 2} cy={yr(r.rate)} r="3" className="fill-chart-3"><title>{r.label}: {r.rate}% attrition</title></circle>)}
      <text x={W - padR + 4} y={yr(maxRate) + 4} fontSize="10" className="fill-text-muted">{maxRate}%</text>
      <text x={W - padR + 4} y={yr(0) + 4} fontSize="10" className="fill-text-muted">0%</text>
      <text x={4} y={y(maxBar) + 4} fontSize="10" className="fill-text-muted">+{maxBar}</text>
      <text x={4} y={mid + half + 4} fontSize="10" className="fill-text-muted">−{maxBar}</text>
    </svg>
  );
}
