import type { Metadata } from "next";
import { BadgeCheck, Scale, ShieldAlert } from "lucide-react";
import { load } from "@/server/page-data";
import { todayIn } from "@/lib/dates";
import {
  canRecordVerification, canViewRates, listRates, listVerifications, loadRates, verificationStatus, type Rate,
} from "@/server/modules/statutory/service";
import type { IncomeTaxConfig, LwfConfig, PtConfig, PtSlab, TaxSlab } from "@/server/modules/statutory/config";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Banner, EmptyState } from "@/ui/feedback";
import { formatINR } from "@/ui/field";
import { UnverifiedRatesBanner } from "@/features/statutory/rates-banner";
import { RecordVerification } from "@/features/statutory/record-verification";

export const metadata: Metadata = { title: "Statutory rates" };

const inr = (p: number) => formatINR(p, { decimals: p % 100 ? 2 : 0 });
const pct = (bp: number) => `${(bp / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;
const date = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const months = (m: number[]) => m.map((x) => MONTHS[x - 1]).join(", ");

export default async function StatutoryRatesPage(props: PageProps<"/settings/payroll/statutory">) {
  const sp = await props.searchParams;
  const asked = typeof sp.on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.on) ? sp.on : null;
  const d = await load(async (tx, actor) => {
    if (!canViewRates(actor)) return null;
    const today = todayIn();
    const on = asked ?? today;
    const [all, status, history] = await Promise.all([listRates(tx), verificationStatus(tx), listVerifications(tx)]);
    let national: Awaited<ReturnType<typeof loadRates>> | null = null, missing: string | null = null;
    try { national = await loadRates(tx, on); } catch (e) { missing = e instanceof Error ? e.message : "Rates are missing for this date."; }
    const effective = (r: Rate<unknown>) => r.effectiveFrom <= on && (!r.effectiveTo || r.effectiveTo >= on);
    return {
      today, on, status, history, national, missing, canRecord: canRecordVerification(actor),
      pt: all.filter((r) => r.kind === "pt" && effective(r)) as Rate<PtConfig>[],
      lwf: all.filter((r) => r.kind === "lwf" && effective(r)) as Rate<LwfConfig>[],
      versions: all.length,
    };
  });
  if (!d) {
    return (
      <Card>
        <EmptyState icon={<ShieldAlert />} title="You don't have access to statutory rates"
          description="Ask a Global admin for a role with “Run payroll and manage payroll settings”." />
      </Card>
    );
  }
  const n = d.national;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-text">Statutory rates</h2>
          <p className="mt-0.5 text-base text-text-muted">The PF, ESI, professional tax, LWF, gratuity and income-tax figures payroll uses. erp keeps every version; you can&apos;t edit them here.</p>
        </div>
        {d.canRecord && !d.status.verified && d.versions > 0 && <div className="shrink-0"><RecordVerification fingerprint={d.status.fingerprint} count={d.status.count} today={d.today} /></div>}
      </div>

      <UnverifiedRatesBanner status={d.status} link={false} />
      {d.status.verified && d.status.latest && (
        <Banner tone="success" title="Checked by a CA">
          {d.status.latest.verified_by_name} signed off these rates on {date(d.status.latest.verified_on)} (recorded by {d.status.latest.recorded_by_name ?? "someone no longer here"}).
        </Banner>
      )}
      {!d.canRecord && !d.status.verified && <p className="text-sm text-text-muted">A payroll admin with company-wide access can record the CA&apos;s check here.</p>}

      <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Choose a date">
        <label className="flex flex-col gap-1.5 text-sm font-medium text-text">
          Rates in effect on
          <input type="date" name="on" defaultValue={d.on} className="h-9 rounded-md border border-border-input bg-surface px-3 text-base text-text" />
        </label>
        <Button type="submit" variant="secondary">Show</Button>
        {d.on !== d.today && <a href="?" className="h-9 px-1 text-sm leading-9 text-accent-text underline-offset-4 hover:underline">Back to today</a>}
      </form>

      {d.versions === 0 ? (
        <Card><EmptyState icon={<Scale />} title="No statutory rates loaded" description="Run “pnpm jobs:statutory-rates” to load erp's rate tables, then ask a CA to check them." /></Card>
      ) : !n ? (
        <Banner tone="danger" title="Some rates are missing for this date">{d.missing} Payroll can&apos;t run for this date until they&apos;re added.</Banner>
      ) : (
        <>
          <Section title="Provident fund (EPF)" rate={n.pf}>
            <Facts items={[
              ["Employee", `${pct(n.pf.config.employeeBp)} of PF wages`],
              ["Employer", `${pct(n.pf.config.employerBp)} of PF wages`],
              ["Wage ceiling", `${inr(n.pf.config.wageCeilingPaise)} a month, unless the company contributes on full wages`],
              ["Pension (EPS) part", `${pct(n.pf.config.epsBp)} of wages up to the ceiling, at most ${inr(n.pf.config.epsMaxPaise)}; the rest of the employer share goes to EPF`],
              ["Admin charges", `${pct(n.pf.config.adminChargeBp)} (employer)`],
              ["EDLI", `${pct(n.pf.config.edliBp)} of wages up to ${inr(n.pf.config.edliWageCeilingPaise)} (employer)`],
              ["Rounding", "Each contribution to the nearest rupee"],
            ]} />
          </Section>
          <Section title="Employees' State Insurance (ESI)" rate={n.esi}>
            <Facts items={[
              ["Employee", pct(n.esi.config.employeeBp)],
              ["Employer", pct(n.esi.config.employerBp)],
              ["Covered when gross is", `${inr(n.esi.config.wageCeilingPaise)} a month or less (${inr(n.esi.config.disabledWageCeilingPaise)} for persons with disability)`],
              ["Contribution periods", "April–September and October–March. Whoever is covered at the start of a period (or on joining) stays covered until it ends."],
              ["Low wages", `At or below ${inr(n.esi.config.employeeExemptDailyWagePaise)} a day, only the employer pays`],
              ["Rounding", "Up to the next rupee"],
            ]} />
          </Section>
          <Card>
            <CardHeader title="Professional tax" description="By state, on monthly gross unless noted. Deducted from the employee." />
            <CardBody className="flex flex-col gap-4">
              {d.pt.length === 0 ? <p className="text-base text-text-muted">No professional tax tables for this date.</p> : d.pt.map((r) => <PtTable key={r.id} rate={r} />)}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Labour welfare fund" description="By state. Deducted only in the months shown." />
            <CardBody>
              {d.lwf.length === 0 ? <p className="text-base text-text-muted">No LWF tables for this date.</p> : <LwfTable rates={d.lwf} />}
            </CardBody>
          </Card>
          <Section title="Gratuity" rate={n.gratuity}>
            <Facts items={[
              ["Formula", `${n.gratuity.config.daysPerYear}/${n.gratuity.config.monthDivisor} × last monthly basic + DA × years of service`],
              ["Years of service", `Completed years; a part year of more than ${n.gratuity.config.roundUpAfterMonths} months counts as a full year`],
              ["Eligible after", `${n.gratuity.config.minYears} years of continuous service (${n.gratuity.config.fixedTermMinYears} for fixed-term staff; none on death or disablement)`],
              ["Ceiling and tax exemption", inr(n.gratuity.config.exemptionCapPaise)],
            ]} />
          </Section>
          <TaxCard rates={[n.incomeTax.new, n.incomeTax.old]} fy={n.fy} />
        </>
      )}

      <Card>
        <CardHeader title="CA verifications" description="Each record covers the rates as they were when it was made." />
        <CardBody>
          {d.history.length === 0 ? (
            <EmptyState compact icon={<BadgeCheck />} title="No CA check recorded yet" description="Once a chartered accountant has reviewed these rates, record it here so payroll stops showing the warning." />
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {d.history.map((v) => (
                <li key={v.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-text">{v.verified_by_name}</span>
                    <span className="text-sm text-text-muted">signed off {date(v.verified_on)}</span>
                    {v.rates_fingerprint === d.status.fingerprint ? <Badge tone="success">Current rates</Badge> : <Badge>Earlier rates</Badge>}
                  </div>
                  <p className="text-base text-text break-words">{v.note}</p>
                  <p className="text-xs text-text-muted">Recorded by {v.recorded_by_name ?? "someone no longer here"} · {v.rates_count} rate tables</p>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Source({ rate }: { rate: Rate<unknown> }) {
  return (
    <p className="mt-4 border-t border-border pt-3 text-xs text-text-muted">
      In effect from {date(rate.effectiveFrom)}{rate.effectiveTo ? ` to ${date(rate.effectiveTo)}` : ""}. {rate.sourceNote}
    </p>
  );
}

function Section({ title, rate, children }: { title: string; rate: Rate<unknown>; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} />
      <CardBody>{children}<Source rate={rate} /></CardBody>
    </Card>
  );
}

function Facts({ items }: { items: [string, string][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[12rem_1fr]">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-sm text-text-muted">{k}</dt>
          <dd className="text-base text-text tabular">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function bands<T extends { upToPaise: number | null }>(slabs: T[]) {
  return slabs.map((s, i) => {
    const from = i === 0 ? 0 : (slabs[i - 1].upToPaise ?? 0) + 1;
    return { s, label: s.upToPaise == null ? `Above ${inr(from - 1)}` : i === 0 ? `Up to ${inr(s.upToPaise)}` : `${inr(from)} – ${inr(s.upToPaise)}` };
  });
}

const th = "px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-text-muted";
const td = "px-3 py-2 text-base text-text tabular";

function PtSlabs({ slabs, caption }: { slabs: PtSlab[]; caption: string }) {
  const feb = slabs.some((s) => s.februaryAmountPaise != null);
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-80">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-surface-hover"><tr><th scope="col" className={th}>Gross</th><th scope="col" className={th}>Tax</th>{feb && <th scope="col" className={th}>In February</th>}</tr></thead>
        <tbody className="divide-y divide-border">
          {bands(slabs).map(({ s, label }) => (
            <tr key={label}><td className={td}>{label}</td><td className={td}>{s.amountPaise ? inr(s.amountPaise) : "Nil"}</td>{feb && <td className={td}>{s.februaryAmountPaise != null ? inr(s.februaryAmountPaise) : "—"}</td>}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PtTable({ rate }: { rate: Rate<PtConfig> }) {
  const c = rate.config;
  return (
    <section aria-label={`${c.stateName} professional tax`} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-semibold text-text">{c.stateName}</h4>
        <Badge>{rate.stateCode}</Badge>
        {c.period === "half_yearly" && <Badge tone="accent">Half-yearly, deducted in {months(c.deductMonths ?? [])}</Badge>}
        <span className="text-sm text-text-muted">At most {inr(c.annualCapPaise)} a year</span>
      </div>
      {c.femaleSlabs ? (
        <div className="grid gap-3 md:grid-cols-2">
          <div><p className="mb-1 text-sm text-text-muted">Men</p><PtSlabs slabs={c.slabs} caption={`${c.stateName}, men`} /></div>
          <div><p className="mb-1 text-sm text-text-muted">Women</p><PtSlabs slabs={c.femaleSlabs} caption={`${c.stateName}, women`} /></div>
        </div>
      ) : <PtSlabs slabs={c.slabs} caption={`${c.stateName} slabs${c.period === "half_yearly" ? " on half-yearly gross" : ""}`} />}
      <p className="text-xs text-text-muted">From {date(rate.effectiveFrom)}. {rate.sourceNote}</p>
    </section>
  );
}

function LwfTable({ rates }: { rates: Rate<LwfConfig>[] }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-120">
          <caption className="sr-only">Labour welfare fund by state</caption>
          <thead className="bg-surface-hover"><tr>{["State", "Deducted in", "Wages", "Employee", "Employer"].map((h) => <th key={h} scope="col" className={th}>{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-border">
            {rates.flatMap((r) => bands(r.config.slabs).map(({ s, label }, i) => (
              <tr key={`${r.id}-${i}`}>
                <td className={td}>{i === 0 ? r.config.stateName : ""}</td>
                <td className={td}>{i === 0 ? months(r.config.deductMonths) : ""}</td>
                <td className={td}>{r.config.slabs.length === 1 ? "Any" : label}</td>
                <td className={td}>{inr(s.employeePaise)}</td>
                <td className={td}>{inr(s.employerPaise)}</td>
              </tr>
            )))}
          </tbody>
        </table>
      </div>
      <details className="text-xs text-text-muted">
        <summary className="cursor-pointer">Sources</summary>
        <ul className="mt-2 flex flex-col gap-1">{rates.map((r) => <li key={r.id}>{r.sourceNote}</li>)}</ul>
      </details>
    </div>
  );
}

function TaxSlabs({ slabs, caption }: { slabs: TaxSlab[]; caption: string }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-64">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-surface-hover"><tr><th scope="col" className={th}>Taxable income</th><th scope="col" className={th}>Rate</th></tr></thead>
        <tbody className="divide-y divide-border">
          {bands(slabs).map(({ s, label }) => <tr key={label}><td className={td}>{label}</td><td className={td}>{s.rateBp ? pct(s.rateBp) : "Nil"}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

function TaxCard({ rates, fy }: { rates: Rate<IncomeTaxConfig>[]; fy: string }) {
  return (
    <Card>
      <CardHeader title={`Income tax, FY ${fy}`} description="Used to project yearly tax and spread TDS over the months left." />
      <CardBody className="grid gap-6 lg:grid-cols-2">
        {rates.map((r) => {
          const c = r.config;
          return (
            <section key={r.id} aria-label={`${c.regime} regime`} className="flex min-w-0 flex-col gap-3">
              <h4 className="font-semibold text-text">{c.regime === "new" ? "New regime" : "Old regime"}</h4>
              <TaxSlabs slabs={c.slabs.below_60} caption={`${c.regime} regime slabs`} />
              {c.regime === "old" && (
                <p className="text-sm text-text-muted">Nil-rate band: {inr(c.slabs.senior[0].upToPaise ?? 0)} for ages 60–79, {inr(c.slabs.super_senior[0].upToPaise ?? 0)} for 80 and above.</p>
              )}
              <Facts items={[
                ["Standard deduction", inr(c.standardDeductionPaise)],
                ["Rebate", `Up to ${inr(c.rebate.maxRebatePaise)} when taxable income is ${inr(c.rebate.maxIncomePaise)} or less${c.rebate.marginalRelief ? ", with marginal relief just above" : ""}`],
                ["Surcharge", c.surcharge.map((s) => `${pct(s.rateBp)} above ${inr(s.overPaise)}`).join("; ")],
                ["Cess", pct(c.cessBp)],
                ["Deductions", c.deductions === "all" ? "Declared deductions and exemptions count (80C up to " + inr(c.caps.section80CPaise) + ", home loan interest up to " + inr(c.caps.homeLoanInterestPaise) + ")" : "Only the employer's NPS contribution"],
              ]} />
              <p className="text-xs text-text-muted">From {date(r.effectiveFrom)}{r.effectiveTo ? ` to ${date(r.effectiveTo)}` : ""}. {r.sourceNote}</p>
            </section>
          );
        })}
      </CardBody>
    </Card>
  );
}
