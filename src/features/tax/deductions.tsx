"use client";
import * as React from "react";
import { Lock } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Button } from "@/ui/button";
import { Field } from "@/ui/field";
import { Banner } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { saveSectionAction } from "@/app/(app)/me/tax/actions";
import { inr, ITEMS, SECTION_LABEL, capped80D } from "@/server/modules/tax/rules";
import type { MyTax } from "@/server/modules/tax/service";
import { Money, paiseText, ProofStatus, RupeeInput, toPaise } from "./shared";

type SectionKey = keyof typeof ITEMS;

export function DeductionsTab({ d }: { d: MyTax }) {
  const capOf = (s: SectionKey) => s === "80C" ? (d.caps ? `Counted up to ${inr(d.caps.section80CPaise)} in total, together with your PF.` : null)
    : s === "80D" ? `Up to ${inr(d.limits.section80D.selfFamilyPaise)} for your family (${inr(d.limits.section80D.selfFamilySeniorPaise)} if anyone is 60+) and the same again for parents; check-ups up to ${inr(d.limits.section80D.preventiveCheckupPaise)} within that.`
      : s === "80CCD1B" ? `Up to ${inr(d.limits.section80CCD1BPaise)}, on top of 80C.` : "No upper limit; interest for up to 8 years.";
  return (
    <div className="flex flex-col gap-6">
      {d.declaration.regime === "new" && <Banner tone="info">You&apos;re on the new regime, which doesn&apos;t count these. Declaring them still helps if you switch, and lets payroll compare.</Banner>}
      {(Object.keys(ITEMS) as SectionKey[]).map((s) => <SectionCard key={s} d={d} section={s} capText={capOf(s)} />)}
    </div>
  );
}

function SectionCard({ d, section, capText }: { d: MyTax; section: SectionKey; capText: string | null }) {
  const items = ITEMS[section];
  const saved = new Map(d.items.filter((i) => i.section === section).map((i) => [i.item, i]));
  const initial = () => Object.fromEntries(items.map((i) => [i.key, paiseText(saved.get(i.key)?.declaredPaise)]));
  const [values, setValues] = React.useState<Record<string, string>>(initial);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const dirty = items.some((i) => (values[i.key] ?? "") !== paiseText(saved.get(i.key)?.declaredPaise));
  const parsed = items.map((i) => ({ item: i.key, paise: toPaise(values[i.key] ?? "") }));
  const total = parsed.reduce((s, x) => s + (x.paise ?? 0), 0);
  const counted = section === "80D" ? capped80D(parsed.map((x) => ({ item: x.item, paise: x.paise ?? 0 })), d.limits.section80D).totalPaise
    : section === "80CCD1B" ? Math.min(total, d.limits.section80CCD1BPaise) : section === "80C" && d.caps ? Math.min(total, d.caps.section80CPaise) : total;
  const save = () => {
    const bad = parsed.find((x) => x.paise == null);
    if (bad) { setError(`Enter amounts in rupees, like 15000 or 15000.50 (${items.find((i) => i.key === bad.item)?.label}).`); return; }
    start(async () => {
      const r = await saveSectionAction(d.fyStart, section, parsed.filter((x) => !saved.get(x.item)?.locked).map((x) => ({ item: x.item, declaredPaise: x.paise! })));
      if (!r.ok) { setError(r.error); return; }
      setError(null); toast.success(`${SECTION_LABEL[section]} saved`);
    });
  };
  return (
    <Card>
      <CardHeader title={SECTION_LABEL[section]} description={capText ?? undefined}
        action={<span className="text-sm text-text-muted">Counts: <Money paise={counted} className="font-medium text-text" /></span>} />
      <CardBody>
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
          {error && <Banner tone="danger">{error}</Banner>}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {items.map((i) => {
              const s = saved.get(i.key);
              return (
                <Field key={i.key} label={i.label} help={s?.locked ? <span className="inline-flex items-center gap-1"><Lock aria-hidden className="size-3" />Verified; ask payroll to change it</span> : i.hint}>
                  <div className="flex items-center gap-2">
                    <div className="flex-1"><RupeeInput value={values[i.key] ?? ""} onChange={(v) => setValues((x) => ({ ...x, [i.key]: v }))} disabled={!d.window.open || s?.locked} placeholder="0" /></div>
                    {s && s.proofStatus !== "not_submitted" && <ProofStatus status={s.proofStatus} />}
                  </div>
                </Field>
              );
            })}
          </div>
          {d.window.open && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {dirty && <Button type="button" variant="ghost" onClick={() => { setValues(initial()); setError(null); }}>Undo changes</Button>}
              <Button type="submit" loading={pending} disabled={!dirty}>Save</Button>
            </div>
          )}
        </form>
      </CardBody>
    </Card>
  );
}
