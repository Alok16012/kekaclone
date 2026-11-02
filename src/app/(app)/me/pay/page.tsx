import type { Metadata } from "next";
import { Download, FileCheck2, FileText, ReceiptText } from "lucide-react";
import { load } from "@/server/page-data";
import { myPay } from "@/server/modules/payrun/payslips";
import { PageHeader } from "@/ui/app-shell";
import { Card, CardHeader, StatTile } from "@/ui/card";
import { Banner, EmptyState } from "@/ui/feedback";
import { IconButton } from "@/ui/button";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { FinancesTab } from "@/features/payroll/finances-tab";
import { fmtDate, money } from "@/features/payrun/format";

export const metadata: Metadata = { title: "My finances" };

export default async function MyPayPage() {
  const d = await load(async (tx, actor) => ({ ...(await myPay(tx, actor)), employeeId: actor.employeeId }));
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="My finances" description="Your payslips, year-to-date pay and salary breakup." />
      {d.fnf && (
        <Banner tone="info" title="Your full and final settlement is ready"
          action={d.fnf.fileId ? <a href={`/payroll/files/${d.fnf.fileId}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-base font-medium text-accent-text hover:underline"><FileCheck2 className="size-4" aria-hidden />Open statement</a> : undefined}>
          Net settlement {money(d.fnf.net)}, finalised on {fmtDate(d.fnf.at.slice(0, 10))}.
        </Banner>
      )}
      <Tabs defaultValue="payslips">
        <TabsList items={[{ value: "payslips", label: "Payslips", count: d.slips.length }, { value: "salary", label: "Salary" }]} />
        <TabsContent value="payslips" className="flex flex-col gap-6">
          {d.ytd && (
            <section aria-label="Year to date" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile label={`Gross, FY ${d.ytd.fy}`} value={<span className="tabular">{money(d.ytd.gross)}</span>} hint={`${d.ytd.months} ${d.ytd.months === 1 ? "month" : "months"}`} />
              <StatTile label="Net pay so far" value={<span className="tabular">{money(d.ytd.net)}</span>} />
              <StatTile label="Income tax deducted" value={<span className="tabular">{money(d.ytd.tds)}</span>} />
              <StatTile label="Provident fund" value={<span className="tabular">{money(d.ytd.pf)}</span>} hint="Your share" />
            </section>
          )}
          <Card>
            <CardHeader title="Payslips" description="A payslip appears here once payroll releases it for the month." />
            {d.slips.length === 0 ? (
              <EmptyState icon={<ReceiptText />} title="No payslips yet" description="Your first payslip will show up here after your first payroll month is released." />
            ) : (
              <ul className="divide-y divide-border border-t border-border">
                {d.slips.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                    <FileText className="size-4 shrink-0 text-text-muted" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="text-base font-medium">{s.label}</p>
                      <p className="text-sm text-text-muted tabular">Gross {money(s.gross)} · deductions {money(s.deductions)} · {s.payableDays} of {s.periodDays} days paid</p>
                    </div>
                    <span className="text-base font-semibold tabular" aria-label={`Net pay ${money(s.net)}`}>{money(s.net)}</span>
                    {s.fileId ? (
                      <span className="flex items-center gap-1">
                        <a href={`/payroll/files/${s.fileId}`} target="_blank" rel="noreferrer" className="rounded-sm px-2 py-1 text-base text-accent-text hover:underline">View<span className="sr-only"> {s.label} payslip</span></a>
                        <IconButton asChild size="icon-sm" label={`Download ${s.label} payslip`}><a href={`/payroll/files/${s.fileId}?download=1`}><Download /></a></IconButton>
                      </span>
                    ) : <span className="text-sm text-text-muted">Being prepared</span>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </TabsContent>
        <TabsContent value="salary">
          {d.finances ? <FinancesTab employeeId={d.employeeId} d={d.finances} /> : (
            <Card><EmptyState icon={<ReceiptText />} title="No salary details yet" description="Your salary breakup appears here once payroll adds it." /></Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
