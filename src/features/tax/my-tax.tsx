"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { FileDown, FileText, Lock, Send } from "lucide-react";
import { Card, CardBody, CardHeader, StatTile } from "@/ui/card";
import { Button } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { Segmented } from "@/ui/choice";
import { Banner, EmptyState } from "@/ui/feedback";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { toast } from "@/ui/toast";
import { savePanAction, saveRegimeAction, submitDeclarationAction } from "@/app/(app)/me/tax/actions";
import type { MyTax } from "@/server/modules/tax/service";
import { inr } from "@/server/modules/tax/rules";
import { Money, shortDate } from "./shared";
import { DeductionsTab } from "./deductions";
import { HouseTab } from "./house";
import { OtherIncomeTab } from "./other-income";
import { ProofsTab } from "./proofs";

type Tab = "overview" | "deductions" | "house" | "other" | "proofs" | "forms";

export function MyTaxView({ d, tab }: { d: MyTax; tab: Tab }) {
  const router = useRouter();
  const path = usePathname();
  const [current, setCurrent] = React.useState<Tab>(tab);
  const go = (next: { fy?: string; tab?: Tab }) => {
    const q = new URLSearchParams({ fy: next.fy ?? d.fy, tab: next.tab ?? current });
    router.replace(`${path}?${q}`, { scroll: false });
  };
  const editable = d.window.open;
  const pendingProofs = d.items.filter((i) => i.proofStatus === "submitted").length;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Financial year" className="w-44">
          <Select value={d.fyStart} onValueChange={(v) => go({ fy: d.fyOptions.find((o) => o.value === v)?.label.replace("FY ", "") })} options={d.fyOptions} />
        </Field>
        <DeclarationStatus status={d.declaration.status} submittedAt={d.declaration.submittedAt} />
        <span className="text-sm text-text-muted">{d.window.message}</span>
      </div>
      {!editable && <Banner tone="info" title="Declarations are closed"><Lock aria-hidden className="mr-1 inline size-3.5" />{d.window.message}</Banner>}
      {d.declaration.status === "draft" && d.items.length > 0 && editable && (
        <Banner tone="warning" title="Not sent to payroll yet"
          action={<SubmitButton fy={d.fyStart} />}>
          Payroll uses the {d.declaration.regime === "new" ? "new" : "old"} regime you picked and these amounts only after you submit. You can still make changes afterwards while the window is open.
        </Banner>
      )}

      <Tabs value={current} onValueChange={(v) => { setCurrent(v as Tab); go({ tab: v as Tab }); }}>
        <TabsList items={[
          { value: "overview", label: "Overview" }, { value: "deductions", label: "Investments" }, { value: "house", label: "Rent and home loan" },
          { value: "other", label: "Other income" }, { value: "proofs", label: "Proofs", count: pendingProofs || undefined }, { value: "forms", label: "Forms" },
        ]} />
        <TabsContent value="overview"><Overview d={d} /></TabsContent>
        <TabsContent value="deductions"><DeductionsTab d={d} /></TabsContent>
        <TabsContent value="house"><HouseTab d={d} /></TabsContent>
        <TabsContent value="other"><OtherIncomeTab d={d} /></TabsContent>
        <TabsContent value="proofs"><ProofsTab d={d} /></TabsContent>
        <TabsContent value="forms"><Forms d={d} /></TabsContent>
      </Tabs>
    </div>
  );
}

function DeclarationStatus({ status, submittedAt }: { status: string; submittedAt: string | null }) {
  if (status === "draft") return <Badge tone="neutral">Draft, not submitted</Badge>;
  return <Badge tone="success">Submitted{submittedAt ? ` ${shortDate(submittedAt)}` : ""}</Badge>;
}

function SubmitButton({ fy, block }: { fy: string; block?: boolean }) {
  const [pending, start] = React.useTransition();
  return (
    <Button size="sm" block={block} loading={pending} onClick={() => start(async () => {
      const r = await submitDeclarationAction(fy);
      if (r.ok) toast.success("Declaration submitted", { description: "Payroll will use it from the next salary run." }); else toast.error(r.error);
    })}><Send />Submit to payroll</Button>
  );
}

function Overview({ d }: { d: MyTax }) {
  const [pending, start] = React.useTransition();
  const c = d.comparison;
  const setRegime = (r: "old" | "new") => start(async () => {
    const res = await saveRegimeAction(d.fyStart, r);
    if (!res.ok) toast.error(res.error); else toast.success(r === "new" ? "New regime chosen" : "Old regime chosen");
  });
  const rows: { label: string; old: number; new: number; strong?: boolean }[] = c ? [
    { label: "Income for the year", old: c.old.grossIncomePaise, new: c.new.grossIncomePaise },
    { label: "Standard deduction", old: c.old.standardDeductionPaise, new: c.new.standardDeductionPaise },
    { label: "Exemptions and deductions", old: c.old.deductionsPaise, new: c.new.deductionsPaise },
    { label: "Taxable income", old: c.old.taxableIncomePaise, new: c.new.taxableIncomePaise },
    { label: "Tax after rebate, surcharge and cess", old: c.old.totalTaxPaise, new: c.new.totalTaxPaise, strong: true },
  ] : [];
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile label="Projected taxable salary" value={<Money paise={d.projection.taxablePaise} />} hint={d.projection.hasSalary ? `FY ${d.fy}, from your salary structure` : "No salary set up yet"} />
        <StatTile label="Declared deductions" value={<Money paise={d.totals.section80CPaise + d.totals.section80DPaise + d.totals.section80CCD1BPaise + d.totals.section80EPaise + d.totals.homeLoanInterestPaise} />} hint="Counted in the old regime only" />
        <StatTile label="HRA exemption" value={<Money paise={d.hraExemptPaise} />} hint={d.totals.rentPaise ? `On rent of ${inr(d.totals.rentPaise)} a year` : "Add rent to claim it"} />
      </div>

      <Card>
        <CardHeader title="Your tax regime" description="The new regime has lower rates but ignores most deductions. The old regime counts your investments, rent and home loan."
          action={<Segmented label="Tax regime" value={d.declaration.regime} onChange={(v) => d.window.open && !pending && setRegime(v)} options={[{ value: "new", label: "New regime" }, { value: "old", label: "Old regime" }]} />} />
        <CardBody>
          {!d.window.open && <p className="mb-3 text-sm text-text-muted">The regime can&apos;t change while declarations are closed.</p>}
          {!c ? (
            <Banner tone="warning">{d.ratesError ?? "Tax rates for this year aren't set up, so the two regimes can't be compared."}</Banner>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[22rem] text-base">
                  <caption className="sr-only">Tax under each regime for FY {d.fy}</caption>
                  <thead><tr className="border-b border-border text-left text-sm text-text-muted"><th scope="col" className="py-2 font-medium">Estimate for FY {d.fy}</th><th scope="col" className="py-2 text-right font-medium">Old regime</th><th scope="col" className="py-2 text-right font-medium">New regime</th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.label} className={r.strong ? "font-semibold" : "border-b border-border"}>
                        <th scope="row" className="py-2 text-left font-normal">{r.label}</th>
                        <td className="py-2 text-right"><Money paise={r.old} /></td><td className="py-2 text-right"><Money paise={r.new} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-base">
                {c.savingPaise === 0 ? "Both regimes come to the same tax on these numbers." : <>The <strong>{c.better} regime</strong> saves about <Money paise={c.savingPaise} className="font-semibold" /> on these numbers.</>}
                {c.better !== d.declaration.regime && c.savingPaise > 0 && d.window.open && <Button variant="link" className="ml-2" onClick={() => setRegime(c.better)}>Switch to the {c.better} regime</Button>}
              </p>
              <p className="mt-2 text-sm text-text-muted">
                An estimate only{c.estimatesPaise.pf ? <>, including your PF of about <Money paise={c.estimatesPaise.pf} /> under 80C</> : ""}{c.estimatesPaise.pt ? <> and professional tax of about <Money paise={c.estimatesPaise.pt} /></> : ""}.
                Payroll works out the actual tax each month from what you&apos;re paid. erp&apos;s tax rates and limits haven&apos;t been checked by a chartered accountant.
              </p>
            </>
          )}
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <PanCard d={d} />
        <Card>
          <CardHeader title="Send to payroll" description="Payroll uses your regime and declarations once you submit them." />
          <CardBody className="flex flex-col gap-3">
            {d.declaration.status === "draft"
              ? <p className="text-base">{d.items.length ? `${d.items.length} item${d.items.length === 1 ? "" : "s"} declared so far.` : "Nothing declared yet. If you have no investments or rent, you can still submit to confirm your regime."}</p>
              : <p className="text-base">Submitted{d.declaration.submittedAt ? ` on ${shortDate(d.declaration.submittedAt)}` : ""}. Changes you save while the window is open reach payroll straight away.</p>}
            {d.declaration.status === "draft" && d.window.open && <div><SubmitButton fy={d.fyStart} /></div>}
            <p className="text-sm text-text-muted">{d.proofWindow.message}</p>
          </CardBody>
        </Card>
      </div>
      <p className="text-sm text-text-muted">Limits used: {d.limits.sourceNote}</p>
    </div>
  );
}

function PanCard({ d }: { d: MyTax }) {
  const [editing, setEditing] = React.useState(!d.pan);
  const [pan, setPan] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    const r = await savePanAction(pan);
    if (!r.ok) { setError(r.error); return; }
    toast.success("PAN saved"); setEditing(false); setPan(""); setError(null);
  });
  return (
    <Card>
      <CardHeader title="Your PAN" description="Needed for your Form 16 and so tax isn't taken at a higher rate." />
      <CardBody>
        {!editing && d.pan ? (
          <div className="flex items-center justify-between gap-3"><span className="font-mono text-base">••••••{d.pan.last4}</span><Button variant="secondary" size="sm" onClick={() => setEditing(true)}>Change</Button></div>
        ) : (
          <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); save(); }}>
            <Field label="PAN" className="flex-1" error={error ?? undefined} help="10 characters, like ABCDE1234F">
              <Input value={pan} onChange={(e) => setPan(e.target.value.toUpperCase())} maxLength={10} autoComplete="off" className="font-mono uppercase" />
            </Field>
            <div className="flex gap-2">
              {d.pan && <Button type="button" variant="secondary" onClick={() => { setEditing(false); setError(null); }}>Cancel</Button>}
              <Button type="submit" loading={pending}>Save PAN</Button>
            </div>
          </form>
        )}
      </CardBody>
    </Card>
  );
}

function Forms({ d }: { d: MyTax }) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader title="Declaration summary (Form 12BB details)" description="Your rent, home loan and investments in one PDF, to check and sign for your employer." />
        <CardBody>
          {d.declaration.exists ? (
            <Button variant="secondary" asChild><a href={`/me/tax/form-12bb?fy=${d.fy}`}><FileDown />Download PDF</a></Button>
          ) : <EmptyState compact icon={<FileText />} title="Nothing declared yet" description="Declare investments or rent first." />}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Form 16" description="Your employer's certificate of tax deducted, issued after the year ends." />
        <CardBody>
          {d.form16 ? (
            <div className="flex flex-col gap-2">
              <p className="text-base">Part A for FY {d.fy}, shared on {shortDate(d.form16.publishedAt)}.</p>
              <div><Button variant="secondary" asChild><a href={`/tax/files/${d.form16.fileId}?download`}><FileDown />Download Part A</a></Button></div>
              <p className="text-sm text-text-muted">Part B (salary details) isn&apos;t generated in erp yet; ask your payroll team for it.</p>
            </div>
          ) : <EmptyState compact icon={<FileText />} title="Not available yet" description={`Your payroll team uploads Form 16 for FY ${d.fy} after the year ends, usually by mid-June.`} />}
        </CardBody>
      </Card>
      <p className="text-sm text-text-muted lg:col-span-2">Looking for your loans? <Link className="text-accent-text underline-offset-4 hover:underline" href="/me/loans">See My loans</Link>.</p>
    </div>
  );
}
