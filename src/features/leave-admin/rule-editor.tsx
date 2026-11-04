"use client";
import * as React from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/ui/button";
import { Field, Input } from "@/ui/field";
import { Checkbox, RadioGroup, Switch } from "@/ui/choice";
import { Select } from "@/ui/select";
import { Drawer } from "@/ui/overlay";
import { Banner } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { saveRuleAction } from "@/app/(app)/settings/leave/actions";
import { APPROVER_LABEL, FREQ_LABEL } from "./labels";

export type RuleRow = {
  id: string; leave_type_id: string; name: string; code: string; kind: string; color: string; is_paid: boolean;
  yearly_quota: string | null; accrual: Record<string, unknown>; application: Record<string, unknown>; year_end: Record<string, unknown>;
  approval: { auto?: boolean; levels?: { approver: string; role?: string }[] };
};

type Level = { approver: "manager" | "l2_manager" | "role"; role?: string };
const LEVEL_OPTIONS = [
  { value: "manager", label: APPROVER_LABEL.manager }, { value: "l2_manager", label: APPROVER_LABEL.l2_manager },
  { value: "role:hr_admin", label: APPROVER_LABEL.hr_admin }, { value: "role:global_admin", label: APPROVER_LABEL.global_admin },
];
const levelKey = (l: Level) => (l.approver === "role" ? `role:${l.role}` : l.approver);
const levelFrom = (k: string): Level => (k.startsWith("role:") ? { approver: "role", role: k.slice(5) } : { approver: k as Level["approver"] });

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Number box that keeps what's typed and reports a number (or undefined when empty). */
function NumberField({ label, value, onChange, help, suffix = "days", step = 0.5, max = 365, disabled }: {
  label: string; value: number | undefined; onChange: (v: number | undefined) => void; help?: string; suffix?: string; step?: number; max?: number; disabled?: boolean;
}) {
  return (
    <Field label={label} help={help}>
      <Input type="number" inputMode="decimal" min={0} max={max} step={step} value={value ?? ""} disabled={disabled}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        trailing={<span className="text-sm">{suffix}</span>} />
    </Field>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-b border-border pb-6 last:border-0 last:pb-0" aria-labelledby={`sec-${title}`}>
      <div>
        <h3 id={`sec-${title}`} className="text-md font-semibold">{title}</h3>
        {description && <p className="mt-0.5 text-sm text-text-muted">{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function RuleEditor({ rule, onClose }: { rule: RuleRow; onClose: () => void }) {
  const isCompOff = rule.kind === "comp_off";
  const acc = rule.accrual, app = rule.application, ye = rule.year_end;
  const [unlimited, setUnlimited] = React.useState(rule.yearly_quota == null);
  const [quota, setQuota] = React.useState<number | undefined>(rule.yearly_quota == null ? 12 : Number(rule.yearly_quota));
  const [frequency, setFrequency] = React.useState<string>(acc.upfront ? "upfront" : (acc.frequency as string) ?? "monthly");
  const [day, setDay] = React.useState<number | undefined>(n(acc.day) ?? 1);
  const [prorate, setProrate] = React.useState(acc.prorate_joining !== false);
  const [stopProbation, setStopProbation] = React.useState(!!acc.stop_in_probation);
  const [capBalance, setCapBalance] = React.useState<number | undefined>(typeof acc.cap_balance === "number" ? acc.cap_balance : undefined);
  const [stopAfterTaken, setStopAfterTaken] = React.useState<number | undefined>(typeof acc.stop_after_days_taken === "number" ? acc.stop_after_days_taken : undefined);
  const [halfDay, setHalfDay] = React.useState(!!app.allowHalfDay);
  const [notice, setNotice] = React.useState(n(app.noticeDays));
  const [pastAllowed, setPastAllowed] = React.useState(app.backdateDays !== null);
  const [backdate, setBackdate] = React.useState(n(app.backdateDays) ?? 7);
  const [maxDays, setMaxDays] = React.useState(n(app.maxConsecutiveDays));
  const [negative, setNegative] = React.useState(n(app.negativeLimit));
  const [attach, setAttach] = React.useState(n(app.attachmentAfterDays));
  const sw = (app.sandwich ?? {}) as { enabled?: boolean; ignoreHalfDays?: boolean };
  const [sandwich, setSandwich] = React.useState(!!sw.enabled);
  const [ignoreHalf, setIgnoreHalf] = React.useState(!!sw.ignoreHalfDays);
  const [expiry, setExpiry] = React.useState(n(app.compOffExpiryDays) ?? 60);
  const [windowDays, setWindowDays] = React.useState(n(app.compOffWindowDays) ?? 30);
  const [carry, setCarry] = React.useState<string>((ye.carry as string) ?? (ye.action === "carry" ? "all" : "none"));
  const [carryMax, setCarryMax] = React.useState(n(ye.carry_max));
  const [encashMax, setEncashMax] = React.useState(n(ye.encash_max));
  const [approvalMode, setApprovalMode] = React.useState<string>(rule.approval?.auto ? "auto" : rule.approval?.levels?.length ? "custom" : "default");
  const [levels, setLevels] = React.useState<Level[]>((rule.approval?.levels as Level[] | undefined)?.length ? (rule.approval!.levels as Level[]) : [{ approver: "manager" }]);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();

  const save = () => start(async () => {
    setError(null);
    const r = await saveRuleAction(rule.id, {
      quota: isCompOff || unlimited ? null : quota ?? 0,
      accrual: { frequency, day: day ?? 1, prorate_joining: prorate, stop_in_probation: stopProbation, cap_balance: capBalance ?? null, stop_after_days_taken: stopAfterTaken ?? null },
      application: {
        allowHalfDay: halfDay, noticeDays: notice, backdateDays: pastAllowed ? backdate ?? 0 : null, maxConsecutiveDays: maxDays, negativeLimit: negative,
        attachmentAfterDays: attach, sandwich: { enabled: sandwich, ignoreHalfDays: sandwich && ignoreHalf },
        ...(isCompOff ? { compOffExpiryDays: expiry, compOffWindowDays: windowDays } : {}),
      },
      year_end: isCompOff ? { carry: "all" } : { carry, carry_max: carry === "upto" ? carryMax : undefined, encash_max: encashMax },
      approval: approvalMode === "auto" ? { auto: true } : approvalMode === "custom" ? { levels } : {},
    });
    if (!r.ok) { setError(r.error); return; }
    toast.success(`${rule.name} rules saved`, { description: "New credits follow these rules from the next accrual run." });
    onClose();
  });

  const accrues = !isCompOff && !unlimited;
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={`${rule.name} rules`} description="Changes apply to everyone on this plan."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>Save rules</Button></>}>
      <form className="flex flex-col gap-6" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && <Banner tone="danger">{error}</Banner>}

        <Section title="Quota and accrual" description={isCompOff ? "Comp-off has no yearly quota: people earn it by working on weekly offs and holidays." : "How many days people get in a leave year, and when they're credited."}>
          {isCompOff ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField label="Use within" value={expiry} onChange={(v) => setExpiry(v ?? 0)} step={1} max={730} help="Days after approval. 0 means it never expires." />
              <NumberField label="Claim within" value={windowDays} onChange={(v) => setWindowDays(v ?? 0)} step={1} help="How long after working the day people can still claim it." />
            </div>
          ) : (
            <>
              <Switch label="No limit (people can take as much as they need)" checked={unlimited} onCheckedChange={setUnlimited} />
              {!unlimited && <NumberField label="Days per leave year" value={quota} onChange={setQuota} />}
              {accrues && (
                <>
                  <Field label="Credit">
                    <Select value={frequency} onValueChange={setFrequency} options={Object.entries(FREQ_LABEL).map(([value, label]) => ({ value, label }))} />
                  </Field>
                  {frequency !== "upfront" && <NumberField label="On day of the month" value={day} onChange={setDay} step={1} max={28} suffix="" help="1 to 28. Joining-date plans credit on each period's start instead." />}
                  <Switch label="Prorate for people who join mid-year" checked={prorate} onCheckedChange={setProrate} />
                  <Switch label="Pause accrual while on probation" checked={stopProbation} onCheckedChange={setStopProbation} />
                  <div className="grid gap-4 sm:grid-cols-2">
                    <NumberField label="Stop accruing above" value={capBalance} onChange={setCapBalance} max={999} help="Balance cap in days. Credits that would push the balance over it lapse. Empty for no cap." />
                    <NumberField label="Stop after taking" value={stopAfterTaken} onChange={setStopAfterTaken} max={999} help="Days taken in a leave year after which nothing more accrues that year. Empty for no limit." />
                  </div>
                </>
              )}
            </>
          )}
        </Section>

        <Section title="Applying" description="What people can ask for. Blocking rules stop the request; the balance warning doesn't.">
          <Switch label="Allow half days" checked={halfDay} onCheckedChange={setHalfDay} />
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField label="Apply at least" value={notice} onChange={setNotice} step={1} help="Days in advance. Empty for no notice." />
            <NumberField label="At most in one request" value={maxDays} onChange={setMaxDays} help="Empty for no limit." />
          </div>
          <Switch label="Allow applying for past dates" checked={pastAllowed} onCheckedChange={setPastAllowed} />
          {pastAllowed && <NumberField label="Up to" value={backdate} onChange={(v) => setBackdate(v ?? 0)} step={1} help="Days in the past." />}
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField label="Ask for a document after" value={attach} onChange={setAttach} help="Requests longer than this need an attachment. Empty for never." />
            {!isCompOff && !unlimited && <NumberField label="Can go below zero by" value={negative} onChange={setNegative} help="Borrow from future credits. Empty for none." />}
          </div>
          <Switch label="Sandwich rule: count weekly offs and holidays between leave days" checked={sandwich} onCheckedChange={setSandwich} />
          {sandwich && <div className="pl-11"><Checkbox label="Not when the day next to the gap is a half day" checked={ignoreHalf} onCheckedChange={(c) => setIgnoreHalf(c === true)} /></div>}
        </Section>

        {!isCompOff && !unlimited && (
          <Section title="Year end" description="What happens to unused days when the leave year closes. Carry first, then encash, the rest lapses.">
            <RadioGroup value={carry} onValueChange={setCarry} options={[
              { value: "none", label: "Reset: unused days lapse" }, { value: "all", label: "Carry everything forward" }, { value: "upto", label: "Carry forward up to a limit" },
            ]} />
            {carry === "upto" && <NumberField label="Carry at most" value={carryMax} onChange={setCarryMax} />}
            {carry !== "all" && <NumberField label="Encash at most" value={encashMax} onChange={setEncashMax} help="Paid out in a payroll month you pick when you run year end. Empty for no encashment." />}
          </Section>
        )}

        <Section title="Approval" description="Who has to approve requests for this leave type.">
          <RadioGroup value={approvalMode} onValueChange={setApprovalMode} options={[
            { value: "default", label: "Company default", hint: "The leave approval workflow, usually the reporting manager" },
            { value: "auto", label: "Approve automatically", hint: "No one needs to approve" },
            { value: "custom", label: "Custom chain", hint: "Up to 5 levels, in order" },
          ]} />
          {approvalMode === "custom" && (
            <ol className="flex flex-col gap-2">
              {levels.map((l, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="w-14 shrink-0 text-sm text-text-muted">Level {i + 1}</span>
                  <div className="min-w-0 flex-1"><Select value={levelKey(l)} onValueChange={(v) => setLevels((ls) => ls.map((x, j) => (j === i ? levelFrom(v) : x)))} options={LEVEL_OPTIONS} /></div>
                  <IconButton label={`Move level ${i + 1} up`} size="icon-sm" variant="ghost" disabled={i === 0} onClick={() => setLevels((ls) => { const c = [...ls]; [c[i - 1], c[i]] = [c[i], c[i - 1]]; return c; })}><ArrowUp /></IconButton>
                  <IconButton label={`Move level ${i + 1} down`} size="icon-sm" variant="ghost" disabled={i === levels.length - 1} onClick={() => setLevels((ls) => { const c = [...ls]; [c[i + 1], c[i]] = [c[i], c[i + 1]]; return c; })}><ArrowDown /></IconButton>
                  <IconButton label={`Remove level ${i + 1}`} size="icon-sm" variant="ghost" disabled={levels.length === 1} onClick={() => setLevels((ls) => ls.filter((_, j) => j !== i))}><Trash2 /></IconButton>
                </li>
              ))}
              {levels.length < 5 && <li><Button type="button" size="sm" variant="ghost" onClick={() => setLevels((ls) => [...ls, { approver: "role", role: "hr_admin" }])}><Plus />Add level</Button></li>}
              <li className="text-sm text-text-muted">If someone has no one at a level (for example, no manager), that level is skipped. The same person never approves twice.</li>
            </ol>
          )}
        </Section>
        <button type="submit" hidden />
      </form>
    </Drawer>
  );
}
