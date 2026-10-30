"use client";
import * as React from "react";
import { BadgeCheck, Scale } from "lucide-react";
import { Button } from "@/ui/button";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Field, Input, Textarea } from "@/ui/field";
import { Checkbox } from "@/ui/choice";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { recordCaVerificationAction } from "@/app/(app)/settings/payroll/actions";
import { fmtDate } from "./labels";

type Rate = { id: string; kind: string; state_code: string | null; regime: string | null; effective_from: string; effective_to: string | null; source_note: string };
type Verification = { at: string; by: string | null; caName: string; firm: string | null; membershipNo: string | null; verifiedOn: string; note: string | null } | null;
const KIND: Record<string, string> = { pf: "Provident fund", esi: "ESI", pt: "Professional tax", lwf: "Labour welfare fund", income_tax: "Income tax", gratuity: "Gratuity", labour_code: "Labour codes" };

export function ComplianceAdmin({ rates, verification, current, canRecord, today }: { rates: Rate[]; verification: Verification; current: boolean; canRecord: boolean; today: string }) {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="Statutory rates" description="PF, ESI, PT, LWF, income tax and gratuity rates payroll uses, by the date they apply from. erp maintains these; they're read-only here." />
        {rates.length === 0 ? (
          <EmptyState compact icon={<Scale />} title="No statutory rates loaded yet" description="They arrive with payroll processing. Each one notes where it came from and whether a CA has checked it." />
        ) : (
          <ul className="divide-y divide-border border-t border-border">
            {rates.map((r) => (
              <li key={r.id} className="px-5 py-3">
                <p className="flex flex-wrap items-center gap-2 text-base font-medium">{KIND[r.kind] ?? r.kind}{r.state_code && <Badge>{r.state_code}</Badge>}{r.regime && <Badge>{r.regime} regime</Badge>}</p>
                <p className="text-sm text-text-muted">From {fmtDate(r.effective_from)}{r.effective_to ? ` to ${fmtDate(r.effective_to)}` : ""} · {r.source_note}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader title="CA review" description="Record when a chartered accountant has checked these rates against current law. The warning on payroll screens goes away until a rate changes." />
        <CardBody className="flex flex-col gap-4">
          {verification ? (
            <Banner tone={current ? "success" : "warning"} title={current ? "Reviewed" : "Rates changed since the last review"}>
              {verification.caName}{verification.firm ? `, ${verification.firm}` : ""}{verification.membershipNo ? ` (membership ${verification.membershipNo})` : ""} reviewed them on {fmtDate(verification.verifiedOn)}.
              {verification.by ? ` Recorded by ${verification.by}.` : ""}{verification.note ? ` “${verification.note}”` : ""}
            </Banner>
          ) : <Banner tone="warning" title="No CA review on record">Payroll screens show a warning until one is recorded.</Banner>}
          {canRecord ? <RecordForm today={today} /> : <p className="text-sm text-text-muted">Only payroll admins for the whole company can record a review.</p>}
        </CardBody>
      </Card>
    </div>
  );
}

function RecordForm({ today }: { today: string }) {
  const [v, setV] = React.useState({ caName: "", firm: "", membershipNo: "", verifiedOn: today, note: "", confirm: false });
  const set = <K extends keyof typeof v>(k: K, x: (typeof v)[K]) => setV((s) => ({ ...s, [k]: x }));
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const fe = (f: string) => (error?.field === f ? error.message : undefined);
  const save = () => start(async () => {
    const r = await recordCaVerificationAction({ ...v, firm: v.firm || null, membershipNo: v.membershipNo || null, note: v.note || null });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success("CA review recorded");
    setError(null); setV({ caName: "", firm: "", membershipNo: "", verifiedOn: today, note: "", confirm: false });
  });
  return (
    <form className="flex flex-col gap-4 border-t border-border pt-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
      {error && !["caName", "membershipNo", "verifiedOn"].includes(error.field ?? "") && <Banner tone="danger">{error.message}</Banner>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="CA's name" required error={fe("caName")}><Input value={v.caName} onChange={(e) => set("caName", e.target.value)} maxLength={120} /></Field>
        <Field label="Firm"><Input value={v.firm} onChange={(e) => set("firm", e.target.value)} maxLength={160} /></Field>
        <Field label="ICAI membership number" error={fe("membershipNo")}><Input value={v.membershipNo} onChange={(e) => set("membershipNo", e.target.value.replace(/\D/g, ""))} inputMode="numeric" maxLength={6} className="tabular" /></Field>
        <Field label="Reviewed on" required error={fe("verifiedOn")}><Input type="date" value={v.verifiedOn} max={today} onChange={(e) => set("verifiedOn", e.target.value)} /></Field>
      </div>
      <Field label="Notes"><Textarea value={v.note} onChange={(e) => set("note", e.target.value)} maxLength={1000} rows={2} placeholder="Which rates and states they checked" /></Field>
      <Checkbox checked={v.confirm} onCheckedChange={(c) => set("confirm", c === true)} label="A chartered accountant has reviewed every rate listed above against current law." />
      <Button type="submit" className="self-start" loading={pending}><BadgeCheck />Record review</Button>
    </form>
  );
}
