"use client";
import * as React from "react";
import { Home, Plus, Trash2 } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { Checkbox } from "@/ui/choice";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { saveHomeLoanAction, saveRentAction } from "@/app/(app)/me/tax/actions";
import { annualRent, fyMonths, inr, METRO_CITIES, type RentPeriod } from "@/server/modules/tax/rules";
import type { MyTax } from "@/server/modules/tax/service";
import { Money, monthName, paiseText, ProofStatus, RupeeInput, toPaise } from "./shared";

type Draft = { id?: string; fromMonth: string; toMonth: string; rent: string; landlordName: string; landlordPan: string; landlordAddress: string; city: string; metro: boolean };
const toDraft = (r: RentPeriod): Draft => ({ id: r.id, fromMonth: r.fromMonth, toMonth: r.toMonth, rent: paiseText(r.monthlyRentPaise), landlordName: r.landlordName, landlordPan: r.landlordPan ?? "", landlordAddress: r.landlordAddress, city: r.city, metro: r.metro });

export function HouseTab({ d }: { d: MyTax }) {
  return (
    <div className="flex flex-col gap-6">
      <RentCard d={d} />
      <HomeLoanCard d={d} />
    </div>
  );
}

function RentCard({ d }: { d: MyTax }) {
  const months = fyMonths(d.fyStart).map((m) => ({ value: m, label: monthName(m) }));
  const [rows, setRows] = React.useState<Draft[]>(() => d.house.rent.map(toDraft));
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const status = new Map(d.items.filter((i) => i.section === "HRA").map((i) => [i.item, i]));
  const set = (i: number, patch: Partial<Draft>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const parsed = rows.map((r) => ({ ...r, monthlyRentPaise: toPaise(r.rent) ?? 0, landlordPan: r.landlordPan || null }));
  const yearly = annualRent(parsed.map((r) => ({ ...r, id: r.id ?? "new" })), d.fyStart);
  const needPan = yearly > d.limits.hra.landlordPanAboveAnnualPaise;
  const save = () => {
    if (rows.some((r) => toPaise(r.rent) == null || !toPaise(r.rent))) { setError("Enter the monthly rent for each period, in rupees."); return; }
    start(async () => {
      const r = await saveRentAction(d.fyStart, parsed.map(({ rent: _r, ...x }) => { void _r; return { ...x, landlordPan: x.landlordPan }; }));
      if (!r.ok) { setError(r.error); return; }
      setError(null); toast.success("Rent saved");
    });
  };
  const locked = (r: Draft) => !!(r.id && status.get(r.id)?.locked);
  return (
    <Card>
      <CardHeader title="Rent you pay (HRA)" description="If part of your salary is house rent allowance, the rent you pay can make some of it tax-free in the old regime."
        action={<span className="text-sm text-text-muted">Exempt: <Money paise={d.hraExemptPaise} className="font-medium text-text" /></span>} />
      <CardBody className="flex flex-col gap-4">
        {error && <Banner tone="danger">{error}</Banner>}
        {d.projection.hasSalary && !d.projection.hraPaise && <Banner tone="info">Your salary has no HRA, so rent doesn&apos;t reduce your tax through HRA.</Banner>}
        {rows.length === 0 && <EmptyState compact icon={<Home />} title="No rent declared" description="Add each home you rented this year, with the months you lived there." />}
        {rows.map((r, i) => (
          <fieldset key={r.id ?? `new-${i}`} className="flex flex-col gap-3 rounded-md border border-border p-4" disabled={!d.window.open || locked(r)}>
            <legend className="flex items-center gap-2 px-1 text-sm font-medium">Home {i + 1}{r.id && status.get(r.id) && status.get(r.id)!.proofStatus !== "not_submitted" && <ProofStatus status={status.get(r.id)!.proofStatus} />}</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="From"><Select value={r.fromMonth} onValueChange={(v) => set(i, { fromMonth: v })} options={months} /></Field>
              <Field label="To"><Select value={r.toMonth} onValueChange={(v) => set(i, { toMonth: v })} options={months} /></Field>
              <Field label="Rent a month" required><RupeeInput value={r.rent} onChange={(v) => set(i, { rent: v })} /></Field>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Landlord's name" required><Input value={r.landlordName} onChange={(e) => set(i, { landlordName: e.target.value })} maxLength={200} /></Field>
              <Field label="Landlord's PAN" required={needPan} help={needPan ? `Needed: rent is over ${inr(d.limits.hra.landlordPanAboveAnnualPaise)} a year` : `Needed only above ${inr(d.limits.hra.landlordPanAboveAnnualPaise)} a year`}>
                <Input value={r.landlordPan} onChange={(e) => set(i, { landlordPan: e.target.value.toUpperCase() })} maxLength={10} className="font-mono uppercase" autoComplete="off" />
              </Field>
              <Field label="Address of the rented home" required className="sm:col-span-2"><Input value={r.landlordAddress} onChange={(e) => set(i, { landlordAddress: e.target.value })} maxLength={300} /></Field>
              <Field label="City" required><Input value={r.city} onChange={(e) => { const city = e.target.value; set(i, { city, metro: METRO_CITIES.some((m) => m.toLowerCase() === city.trim().toLowerCase()) || r.metro }); }} maxLength={80} /></Field>
              <div className="flex items-end justify-between gap-3 pb-1">
                <Checkbox label="Metro city (Mumbai, Delhi, Kolkata or Chennai)" checked={r.metro} onCheckedChange={(c) => set(i, { metro: c === true })} />
                {!locked(r) && d.window.open && <IconButton label={`Remove home ${i + 1}`} variant="ghost" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}><Trash2 /></IconButton>}
              </div>
            </div>
          </fieldset>
        ))}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-text-muted">Rent this year: <Money paise={yearly} /></p>
          {d.window.open && (
            <div className="flex gap-2">
              {rows.length < 6 && <Button type="button" variant="secondary" onClick={() => setRows((x) => [...x, { fromMonth: months[0].value, toMonth: months[11].value, rent: "", landlordName: "", landlordPan: "", landlordAddress: "", city: "", metro: false }])}><Plus />Add a home</Button>}
              <Button onClick={save} loading={pending}>Save rent</Button>
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function HomeLoanCard({ d }: { d: MyTax }) {
  const item = d.items.find((i) => i.section === "24B");
  const hl = d.house.homeLoan;
  const [v, setV] = React.useState({ interest: paiseText(item?.declaredPaise), lenderName: hl?.lenderName ?? "", lenderPan: hl?.lenderPan ?? "", lenderAddress: hl?.lenderAddress ?? "", propertyAddress: hl?.propertyAddress ?? "" });
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => {
    const interestPaise = toPaise(v.interest);
    if (interestPaise == null) { setError({ message: "Enter the interest in rupees.", field: "interestPaise" }); return; }
    start(async () => {
      const r = await saveHomeLoanAction(d.fyStart, { interestPaise, lenderName: v.lenderName, lenderPan: v.lenderPan || null, lenderAddress: v.lenderAddress, propertyAddress: v.propertyAddress });
      if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
      setError(null); toast.success(interestPaise ? "Home loan saved" : "Home loan removed");
    });
  };
  const err = (f: string) => (error?.field === f ? error.message : undefined);
  return (
    <Card>
      <CardHeader title="Home loan interest (section 24(b))" description={`For a home you live in. Counted up to ${d.caps ? inr(d.caps.homeLoanInterestPaise) : "the yearly limit"} in the old regime. Principal repaid goes under 80C.`} />
      <CardBody>
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
          {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
          <fieldset disabled={!d.window.open || item?.locked} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Interest for the year" error={err("interestPaise")} help={item?.locked ? "Verified; ask payroll to change it" : "Leave empty or 0 to remove"}><RupeeInput value={v.interest} onChange={(x) => setV({ ...v, interest: x })} /></Field>
            <Field label="Lender" error={err("lenderName")}><Input value={v.lenderName} onChange={(e) => setV({ ...v, lenderName: e.target.value })} maxLength={200} placeholder="Bank or housing finance company" /></Field>
            <Field label="Lender's PAN" help="If the lender isn't a bank or financial institution" error={err("lenderPan")}><Input value={v.lenderPan} onChange={(e) => setV({ ...v, lenderPan: e.target.value.toUpperCase() })} maxLength={10} className="font-mono uppercase" /></Field>
            <Field label="Lender's address" error={err("lenderAddress")}><Input value={v.lenderAddress} onChange={(e) => setV({ ...v, lenderAddress: e.target.value })} maxLength={300} /></Field>
            <Field label="Property address" className="sm:col-span-2" error={err("propertyAddress")}><Input value={v.propertyAddress} onChange={(e) => setV({ ...v, propertyAddress: e.target.value })} maxLength={300} /></Field>
          </fieldset>
          {d.window.open && !item?.locked && <div className="flex justify-end"><Button type="submit" loading={pending}>Save home loan</Button></div>}
        </form>
      </CardBody>
    </Card>
  );
}
