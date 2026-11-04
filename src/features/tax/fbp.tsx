"use client";
import * as React from "react";
import { Lock, Save, Sparkles } from "lucide-react";
import { Card, CardBody, CardHeader, StatTile } from "@/ui/card";
import { Button } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Field } from "@/ui/field";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { saveFbpAction } from "@/app/(app)/me/tax/actions";
import type { MyFbp } from "@/server/modules/tax/fbp";
import { Money, paiseText, RupeeInput, shortDate, toPaise } from "./shared";

/** The person's flexible benefit plan for the year: one amount per FBP component, within its limit. */
export function FbpTab({ d, regime }: { d: MyFbp; regime: "old" | "new" }) {
  const [v, setV] = React.useState<Record<string, string>>(() => Object.fromEntries(d.items.map((i) => [i.code, paiseText(i.declaredPaise)])));
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const parsed = Object.fromEntries(d.items.map((i) => [i.code, v[i.code]?.trim() ? toPaise(v[i.code]) : 0]));
  const total = Object.values(parsed).reduce<number>((t, p) => t + (p ?? 0), 0);
  const exempt = d.items.reduce((t, i) => t + (i.countedPaise > 0 || d.status === "none" ? Math.min(parsed[i.code] ?? 0, i.limitPaise) : 0), 0);
  const save = () => start(async () => {
    const items: Record<string, number> = {};
    for (const i of d.items) {
      const p = v[i.code]?.trim() ? toPaise(v[i.code]) : 0;
      if (p == null) { setError({ message: `${i.name}: enter an amount in rupees, like 2000.`, field: i.code }); return; }
      items[i.code] = p;
    }
    const r = await saveFbpAction(d.fyStart, items);
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    setError(null); toast.success("Flexible benefits saved", { description: "Payroll uses them from the next salary run." });
  });
  if (!d.hasPlan) return <Card><EmptyState icon={<Sparkles />} title="No flexible benefit plan" description="Your company hasn't marked any salary components as flexible benefits. Ask your payroll team if you expect one." /></Card>;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile label="Declared for the year" value={<Money paise={total} />} hint={d.status === "submitted" && d.submittedAt ? `Saved ${shortDate(d.submittedAt)}` : "Not saved yet"} />
        <StatTile label="Tax exemption it brings" value={<Money paise={exempt} />} hint={regime === "new" ? "Counted in the old regime only" : "Old regime"} />
        <StatTile label="Components in the plan" value={String(d.items.length)} />
      </div>
      {!d.window.open && <Banner tone="info" title="Flexible benefits are closed"><Lock aria-hidden className="mr-1 inline size-3.5" />{d.window.message}</Banner>}
      {regime === "new" && <Banner tone="info">You&apos;ve picked the new tax regime, which ignores these exemptions. Your choices are still paid as part of your salary.</Banner>}
      <Card>
        <CardHeader title={`Flexible benefits for FY ${d.fy}`} description="Decide how much of each benefit you want for the year, up to its limit. Claim them later with bills under My finances → Claims; what you declare is exempt from tax in the old regime." />
        <CardBody>
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
            {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
            <fieldset disabled={!d.window.open} className="grid gap-4 sm:grid-cols-2">
              {d.items.map((i) => (
                <Field key={i.code} label={i.name} error={error?.field === i.code ? error.message : undefined}
                  help={i.limitPaise ? `Up to ${paiseText(i.limitPaise) ? "₹" + paiseText(i.limitPaise) : "₹0"} a year${i.monthlyPaise ? ` (${"₹" + paiseText(i.monthlyPaise)} a month in your salary)` : ""}` : "Not part of your salary structure"}>
                  <RupeeInput value={v[i.code] ?? ""} onChange={(x) => setV((s) => ({ ...s, [i.code]: x }))} disabled={!i.limitPaise} placeholder="0" />
                </Field>
              ))}
            </fieldset>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-text-muted">{d.window.message}</p>
              {d.window.open && <Button type="submit" loading={pending}><Save />{d.status === "submitted" ? "Save changes" : "Save and submit"}</Button>}
            </div>
            {d.status === "submitted" && <Badge tone="success">Submitted to payroll</Badge>}
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
