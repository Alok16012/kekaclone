"use client";
import * as React from "react";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Button } from "@/ui/button";
import { Field, Input } from "@/ui/field";
import { Banner } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { saveOtherIncomeAction, savePreviousEmployerAction } from "@/app/(app)/me/tax/actions";
import type { MyTax } from "@/server/modules/tax/service";
import { paiseText, RupeeInput, toPaise } from "./shared";

type Err = { message: string; field?: string } | null;

export function OtherIncomeTab({ d }: { d: MyTax }) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <PreviousEmployer d={d} />
      <OtherIncome d={d} />
    </div>
  );
}

function PreviousEmployer({ d }: { d: MyTax }) {
  const p = d.previous;
  const [v, setV] = React.useState({ employerName: p.employerName, tan: p.tan ?? "", income: paiseText(p.incomePaise), tds: paiseText(p.tdsPaise), pf: paiseText(p.pfPaise), pt: paiseText(p.ptPaise) });
  const [error, setError] = React.useState<Err>(null);
  const [pending, start] = React.useTransition();
  const save = () => {
    const [incomePaise, tdsPaise, pfPaise, ptPaise] = [v.income, v.tds, v.pf, v.pt].map(toPaise);
    if ([incomePaise, tdsPaise, pfPaise, ptPaise].some((x) => x == null)) { setError({ message: "Enter amounts in rupees, like 450000." }); return; }
    start(async () => {
      const r = await savePreviousEmployerAction(d.fyStart, { employerName: v.employerName, tan: v.tan || null, incomePaise, tdsPaise, pfPaise, ptPaise });
      if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
      setError(null); toast.success("Previous employer saved");
    });
  };
  const err = (f: string) => (error?.field === f ? error.message : undefined);
  return (
    <Card>
      <CardHeader title="Previous employer this year" description="If you worked somewhere else earlier this financial year, add what they paid you and the tax they took (from their Form 16 or Form 12B)." />
      <CardBody>
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); save(); }}>
          {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
          <fieldset disabled={!d.window.open} className="flex flex-col gap-3">
            <Field label="Employer's name" error={err("employerName")}><Input value={v.employerName} onChange={(e) => setV({ ...v, employerName: e.target.value })} maxLength={200} /></Field>
            <Field label="Employer's TAN" error={err("tan")} help="10 characters, like BLRA12345B"><Input value={v.tan} onChange={(e) => setV({ ...v, tan: e.target.value.toUpperCase() })} maxLength={10} className="font-mono uppercase" /></Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Taxable salary paid" error={err("incomePaise")}><RupeeInput value={v.income} onChange={(x) => setV({ ...v, income: x })} /></Field>
              <Field label="Tax deducted (TDS)" error={err("tdsPaise")}><RupeeInput value={v.tds} onChange={(x) => setV({ ...v, tds: x })} /></Field>
              <Field label="Your PF contribution"><RupeeInput value={v.pf} onChange={(x) => setV({ ...v, pf: x })} /></Field>
              <Field label="Professional tax paid"><RupeeInput value={v.pt} onChange={(x) => setV({ ...v, pt: x })} /></Field>
            </div>
          </fieldset>
          {d.window.open && <div className="flex justify-end"><Button type="submit" loading={pending}>Save</Button></div>}
        </form>
      </CardBody>
    </Card>
  );
}

function OtherIncome({ d }: { d: MyTax }) {
  const o = d.other;
  const [v, setV] = React.useState({ savings: paiseText(o.savingsInterestPaise), deposits: paiseText(o.depositInterestPaise), other: paiseText(o.otherPaise), otherDescription: o.otherDescription });
  const [error, setError] = React.useState<Err>(null);
  const [pending, start] = React.useTransition();
  const save = () => {
    const [savingsInterestPaise, depositInterestPaise, otherPaise] = [v.savings, v.deposits, v.other].map(toPaise);
    if ([savingsInterestPaise, depositInterestPaise, otherPaise].some((x) => x == null)) { setError({ message: "Enter amounts in rupees, like 12000." }); return; }
    start(async () => {
      const r = await saveOtherIncomeAction(d.fyStart, { savingsInterestPaise, depositInterestPaise, otherPaise, otherDescription: v.otherDescription });
      if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
      setError(null); toast.success("Other income saved");
    });
  };
  return (
    <Card>
      <CardHeader title="Other income" description="Income outside your salary that you'd like taxed through payroll, so you don't owe tax at the end of the year." />
      <CardBody>
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); save(); }}>
          {error && <Banner tone="danger">{error.message}</Banner>}
          <fieldset disabled={!d.window.open} className="flex flex-col gap-3">
            <Field label="Savings account interest"><RupeeInput value={v.savings} onChange={(x) => setV({ ...v, savings: x })} /></Field>
            <Field label="Fixed deposit interest"><RupeeInput value={v.deposits} onChange={(x) => setV({ ...v, deposits: x })} /></Field>
            <Field label="Anything else"><RupeeInput value={v.other} onChange={(x) => setV({ ...v, other: x })} /></Field>
            <Field label="What is the other income?" error={error?.field === "otherDescription" ? error.message : undefined}><Input value={v.otherDescription} onChange={(e) => setV({ ...v, otherDescription: e.target.value })} maxLength={300} placeholder="e.g. Rent from a flat I own" /></Field>
          </fieldset>
          {d.window.open && <div className="flex justify-end"><Button type="submit" loading={pending}>Save</Button></div>}
        </form>
      </CardBody>
    </Card>
  );
}
