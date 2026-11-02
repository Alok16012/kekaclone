import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, FileCheck2, Users } from "lucide-react";
import { load } from "@/server/page-data";
import { canRunPayroll } from "@/server/modules/payrun/access";
import { payrollHome } from "@/server/modules/payrun/runs";
import { PageHeader } from "@/ui/app-shell";
import { Card, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { buttonStyles } from "@/ui/button";
import { EmptyState } from "@/ui/feedback";
import { UnverifiedRatesBanner } from "@/features/statutory/rates-banner";
import { PayrunNoAccess } from "@/features/payrun/no-access";
import { StartRunButton } from "@/features/payrun/home";
import { CostTrend } from "@/features/payrun/trend";
import { fmtMonth, money, RUN_LABEL, RUN_TONE } from "@/features/payrun/format";

export const metadata: Metadata = { title: "Payroll" };

export default async function PayrollPage() {
  const d = await load(async (tx, actor) => (canRunPayroll(actor) ? { ok: true as const, ...(await payrollHome(tx, actor)) } : { ok: false as const }));
  if (!d.ok) return <PayrunNoAccess />;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Payroll" description="Run monthly payroll for each pay group, release payslips and pay salaries."
        actions={<Link href="/payroll/settlements" className={buttonStyles({ variant: "secondary", size: "md" })}><FileCheck2 className="size-4" aria-hidden />Final settlements{d.fnfPending ? <Badge tone="warning">{d.fnfPending}</Badge> : null}</Link>} />
      <UnverifiedRatesBanner status={d.verification} />
      {d.cards.length === 0 ? (
        <Card><EmptyState icon={<Users />} title="No pay groups yet" description="Set up a pay group and salary structures before running payroll."
          action={<Link href="/settings/payroll/pay-groups" className="text-accent-text underline-offset-4 hover:underline">Open payroll settings</Link>} /></Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {d.cards.map((c) => (
            <Card key={c.id} className="flex flex-col">
              <CardHeader title={c.name} description={`${c.legalEntity} · ${c.people} ${c.people === 1 ? "person" : "people"} · attendance cut-off on day ${c.cutoff}`} />
              <div className="flex flex-col gap-4 px-5 pb-5">
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-surface-sunken px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm text-text-muted">{fmtMonth(c.openMonth)}</p>
                    {c.run ? (
                      <p className="flex flex-wrap items-center gap-2 text-base font-medium">
                        <Badge tone={RUN_TONE[c.run.status]}>{RUN_LABEL[c.run.status]}</Badge>
                        {c.run.headcount > 0 && <span className="tabular">{money(c.run.net)} net · {c.run.headcount} people</span>}
                      </p>
                    ) : <p className="text-base font-medium">Not started</p>}
                  </div>
                  {c.run ? (
                    <Link href={`/payroll/runs/${c.run.id}`} className={buttonStyles({ variant: "primary", size: "md" })}>Open run<ArrowRight className="size-4" aria-hidden /></Link>
                  ) : c.canStart ? <StartRunButton payGroupId={c.id} month={c.openMonth} label={`Start ${fmtMonth(c.openMonth)}`} />
                    : <p className="text-sm text-text-muted">Opens nearer the month</p>}
                </div>
                <CostTrend points={c.trend} />
              </div>
            </Card>
          ))}
        </div>
      )}
      <Card>
        <CardHeader title="Recent runs" description="Every run, newest first. Rolled-back runs stay here for the record." />
        {d.recent.length === 0 ? <EmptyState compact title="No runs yet" description="Start the first run from a pay group above." /> : (
          <ul className="divide-y divide-border border-t border-border">
            {d.recent.map((r) => (
              <li key={r.id}>
                <Link href={`/payroll/runs/${r.id}`} className="flex flex-wrap items-center gap-3 px-5 py-3 hover:bg-surface-hover">
                  <span className="min-w-0 flex-1"><span className="block text-base font-medium">{fmtMonth(r.period_month)}</span><span className="block text-sm text-text-muted">{r.pay_group}</span></span>
                  {r.headcount > 0 && <span className="text-sm tabular text-text-muted">{r.headcount} people · {money(r.net)}</span>}
                  <Badge tone={RUN_TONE[r.status]}>{RUN_LABEL[r.status]}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
