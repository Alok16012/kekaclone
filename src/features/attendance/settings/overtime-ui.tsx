"use client";
import * as React from "react";
import { BadgeIndianRupee, Calculator, MoreHorizontal, Pencil, Plus, Timer, Trash2, Zap } from "lucide-react";
import { Button, IconButton } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Checkbox, Segmented, Switch } from "@/ui/choice";
import { Field, Input, MoneyInput, formatINR } from "@/ui/field";
import { Select } from "@/ui/select";
import { Banner, EmptyState } from "@/ui/feedback";
import { ConfirmDialog, Menu, Modal } from "@/ui/overlay";
import { DataTable, type Column } from "@/ui/table";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { toast } from "@/ui/toast";
import {
  deleteAllowancePolicyAction, deleteOvertimePolicyAction, deletePayCodeAction, saveAllowancePolicyAction, saveOvertimePolicyAction, savePayCodeAction, settleMonthAction,
} from "@/app/(app)/settings/time/actions";
import type { AllowanceRow, MonthOvertimeRow, OvertimePolicyRow, PayCodeRow, SettleLine, AllowanceLine } from "@/server/modules/attendance/overtime";
import { DEFAULT_OVERTIME_RULES, OT_DAY_KEYS, type OtDayKey, type OtDayRule, type OvertimeRules } from "@/server/modules/attendance/overtime-rules";

const hm = (m: number) => (m ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : "—");
const DAY_LABEL: Record<OtDayKey, string> = { working: "Working days", weekly_off: "Weekly offs", holiday: "Holidays" };
const KIND_LABEL: Record<PayCodeRow["kind"], string> = { multiplier: "× hourly wage", fixed_per_hour: "₹ per hour", lump_sum: "₹ per day" };
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });

export function OvertimeSettings({ policies, payCodes, allowances, shifts, canEdit, month, monthRows, tab }: {
  policies: OvertimePolicyRow[]; payCodes: PayCodeRow[]; allowances: AllowanceRow[]; shifts: { id: string; name: string; code: string }[]; canEdit: boolean;
  month: string; monthRows: MonthOvertimeRow[]; tab?: string;
}) {
  return (
    <Tabs defaultValue={["policies", "paycodes", "allowances", "settle"].includes(tab ?? "") ? tab! : "policies"}>
      <TabsList items={[{ value: "policies", label: "Overtime policies", count: policies.length || undefined }, { value: "paycodes", label: "Pay codes" }, { value: "allowances", label: "Shift allowances" }, { value: "settle", label: "Monthly settlement" }]} />
      <TabsContent value="policies"><PoliciesCard rows={policies} payCodes={payCodes} canEdit={canEdit} /></TabsContent>
      <TabsContent value="paycodes"><PayCodesCard rows={payCodes} canEdit={canEdit} /></TabsContent>
      <TabsContent value="allowances"><AllowancesCard rows={allowances} shifts={shifts} canEdit={canEdit} /></TabsContent>
      <TabsContent value="settle"><SettleCard month={month} rows={monthRows} canEdit={canEdit} /></TabsContent>
    </Tabs>
  );
}

// ---------------------------------------------------------------- policies

function PoliciesCard({ rows, payCodes, canEdit }: { rows: OvertimePolicyRow[]; payCodes: PayCodeRow[]; canEdit: boolean }) {
  const [editing, setEditing] = React.useState<OvertimePolicyRow | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<OvertimePolicyRow | null>(null);
  const codeName = (id: string | null) => payCodes.find((c) => c.id === id)?.name ?? "no pay code";
  const summary = (r: OvertimeRules) => OT_DAY_KEYS.filter((k) => r[k].enabled).map((k) => `${DAY_LABEL[k].toLowerCase()}: ${r[k].mode === "pay" ? `pay (${codeName(r[k].pay_code_id)})` : "comp-off"}`).join(" · ") || "Nothing counts";
  return (
    <Card>
      <CardHeader title="Overtime policies" description="Which days earn overtime, whether it's paid or turns into comp-off, thresholds, caps and rounding. Assign people to a policy from Assignments."
        action={canEdit ? <Button size="sm" onClick={() => setEditing("new")}><Plus />Add policy</Button> : undefined} />
      {rows.length === 0 ? <EmptyState compact icon={<Zap />} title="No overtime policies yet" description={canEdit ? "Add one, then assign people to it. Until then nobody earns overtime." : undefined} /> : (
        <ul className="divide-y divide-border border-t border-border">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-base font-medium">{r.name} <Badge>{r.rules.approval === "required" ? "Needs approval" : "Automatic"}</Badge></p>
                <p className="text-sm text-text-muted">{summary(r.rules)} · {r.people} {r.people === 1 ? "person" : "people"}</p>
              </div>
              {canEdit && <Menu trigger={<IconButton label={`Actions for ${r.name}`} size="icon-sm"><MoreHorizontal /></IconButton>}
                items={[{ label: "Edit", icon: <Pencil />, onSelect: () => setEditing(r) }, { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setDeleting(r) }]} />}
            </li>
          ))}
        </ul>
      )}
      {editing && <PolicyDialog row={editing === "new" ? null : editing} payCodes={payCodes} onClose={() => setEditing(null)} />}
      {deleting && <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting.name}?`} description="People on this policy must be moved first. Past settlements stay as they are." confirmLabel="Delete"
        onConfirm={async () => { const r = await deleteOvertimePolicyAction(deleting.id); if (r.ok) toast.success("Policy deleted"); else toast.error(r.error); setDeleting(null); }} />}
    </Card>
  );
}

function PolicyDialog({ row, payCodes, onClose }: { row: OvertimePolicyRow | null; payCodes: PayCodeRow[]; onClose: () => void }) {
  const [name, setName] = React.useState(row?.name ?? "");
  const [rules, setRules] = React.useState<OvertimeRules>(row?.rules ?? { ...DEFAULT_OVERTIME_RULES, working: { ...DEFAULT_OVERTIME_RULES.working, pay_code_id: payCodes[0]?.id ?? null } });
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const set = <K extends keyof OvertimeRules>(k: K, v: OvertimeRules[K]) => setRules((r) => ({ ...r, [k]: v }));
  const setDay = (k: OtDayKey, patch: Partial<OtDayRule>) => setRules((r) => ({ ...r, [k]: { ...r[k], ...patch } }));
  const save = () => start(async () => {
    setError(null);
    const r = await saveOvertimePolicyAction(row?.id ?? null, { name, rules });
    if (!r.ok) { setError(r.error); return; }
    toast.success(row ? "Policy updated" : "Policy added"); onClose();
  });
  const num = (v: string) => (v === "" ? 0 : Number(v));
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="lg" title={row ? "Edit overtime policy" : "Add overtime policy"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>{row ? "Save" : "Add policy"}</Button></>}>
      <form className="flex flex-col gap-5" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus placeholder="e.g. Factory floor" /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5"><span className="text-sm font-medium">Approval</span>
            <Segmented label="Approval" value={rules.approval} onChange={(v) => set("approval", v)} options={[{ value: "required", label: "Employee requests, manager approves" }, { value: "none", label: "Automatic" }]} />
          </div>
          <div className="flex flex-col gap-1.5"><span className="text-sm font-medium">Hours counted from</span>
            <Segmented label="Basis" value={rules.basis} onChange={(v) => set("basis", v)} options={[{ value: "effective", label: "Worked (effective)" }, { value: "gross", label: "First in to last out" }]} />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5"><span className="text-sm font-medium">Hourly wage from</span>
            <Segmented label="Wage basis" value={rules.wage_basis} onChange={(v) => set("wage_basis", v)} options={[{ value: "basic", label: "Basic" }, { value: "gross", label: "Gross" }]} />
          </div>
          <Field label="Hours per month" help="Divides the monthly wage (208 = 26 × 8)"><Input type="number" inputMode="numeric" min={100} max={400} value={rules.hours_per_month} onChange={(e) => set("hours_per_month", num(e.target.value))} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Comp-off: half day" help="minutes"><Input type="number" inputMode="numeric" min={30} max={720} value={rules.comp_off.half_day_minutes} onChange={(e) => set("comp_off", { ...rules.comp_off, half_day_minutes: num(e.target.value) })} /></Field>
            <Field label="Full day" help="minutes"><Input type="number" inputMode="numeric" min={60} max={960} value={rules.comp_off.full_day_minutes} onChange={(e) => set("comp_off", { ...rules.comp_off, full_day_minutes: num(e.target.value) })} /></Field>
          </div>
        </div>
        {OT_DAY_KEYS.map((k) => {
          const d = rules[k];
          return (
            <fieldset key={k} className="rounded-md border border-border p-4">
              <legend className="px-1 text-sm font-semibold">{DAY_LABEL[k]}</legend>
              <div className="flex flex-col gap-3">
                <Switch label={d.enabled ? "Counts as overtime" : "Doesn't count"} checked={d.enabled} onCheckedChange={(c) => setDay(k, { enabled: c })} />
                {d.enabled && (
                  <>
                    <div className="flex flex-wrap items-center gap-4">
                      <Segmented label={`${DAY_LABEL[k]}: pay or comp-off`} value={d.mode} onChange={(v) => setDay(k, { mode: v })} options={[{ value: "pay", label: "Pay" }, { value: "comp_off", label: "Comp-off" }]} />
                      {d.mode === "pay" && (
                        <div className="min-w-48">
                          <Select aria-label="Pay code" value={d.pay_code_id ?? ""} onValueChange={(v) => setDay(k, { pay_code_id: v || null })} placeholder="Pay code"
                            options={payCodes.map((c) => ({ value: c.id, label: `${c.name} (${c.value ?? ""} ${KIND_LABEL[c.kind]})` }))} />
                        </div>
                      )}
                      {k === "working" && (
                        <div className="flex gap-4">
                          <Checkbox label="Before shift" checked={d.coverage.pre} onCheckedChange={(c) => setDay(k, { coverage: { ...d.coverage, pre: !!c } })} />
                          <Checkbox label="After shift" checked={d.coverage.post} onCheckedChange={(c) => setDay(k, { coverage: { ...d.coverage, post: !!c } })} />
                        </div>
                      )}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-4">
                      <Field label="Minimum (minutes)" help="Less than this is ignored"><Input type="number" inputMode="numeric" min={0} max={480} value={d.min_minutes} onChange={(e) => setDay(k, { min_minutes: num(e.target.value) })} /></Field>
                      <Field label="Daily cap (minutes)" help="Blank = no cap"><Input type="number" inputMode="numeric" min={15} max={960} value={d.max_minutes ?? ""} onChange={(e) => setDay(k, { max_minutes: e.target.value === "" ? null : Number(e.target.value) })} /></Field>
                      <Field label="Round to"><Select value={String(d.rounding.to)} onValueChange={(v) => setDay(k, { rounding: { ...d.rounding, to: Number(v) as 1 | 15 | 30 | 60 } })} options={[{ value: "1", label: "Minute" }, { value: "15", label: "15 minutes" }, { value: "30", label: "30 minutes" }, { value: "60", label: "Hour" }]} /></Field>
                      <Field label="Rounding"><Select value={d.rounding.mode} onValueChange={(v) => setDay(k, { rounding: { ...d.rounding, mode: v as "down" | "nearest" } })} options={[{ value: "down", label: "Down" }, { value: "nearest", label: "Nearest" }]} /></Field>
                    </div>
                    {d.mode === "pay" && (
                      <div className="flex flex-col gap-2">
                        <span className="text-sm font-medium">Tiers <span className="font-normal text-text-muted">(a higher multiplier after N minutes in a day)</span></span>
                        {d.tiers.map((t, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <span className="text-sm text-text-muted">After</span>
                            <Input type="number" inputMode="numeric" aria-label="After minutes" className="w-24" min={1} max={960} value={t.after_minutes} onChange={(e) => setDay(k, { tiers: d.tiers.map((x, j) => j === i ? { ...x, after_minutes: num(e.target.value) } : x) })} />
                            <span className="text-sm text-text-muted">minutes, pay</span>
                            <Input type="number" inputMode="decimal" aria-label="Multiplier" className="w-20" min={0.5} max={5} step={0.25} value={t.multiplier} onChange={(e) => setDay(k, { tiers: d.tiers.map((x, j) => j === i ? { ...x, multiplier: Number(e.target.value) } : x) })} />
                            <span className="text-sm text-text-muted">× hourly</span>
                            <IconButton label="Remove tier" size="icon-sm" variant="ghost" onClick={() => setDay(k, { tiers: d.tiers.filter((_, j) => j !== i) })}><Trash2 /></IconButton>
                          </div>
                        ))}
                        {d.tiers.length < 5 && <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setDay(k, { tiers: [...d.tiers, { after_minutes: (d.tiers[d.tiers.length - 1]?.after_minutes ?? 0) + 120, multiplier: 2 }] })}><Plus />Add tier</Button>}
                      </div>
                    )}
                  </>
                )}
              </div>
            </fieldset>
          );
        })}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- pay codes

function PayCodesCard({ rows, canEdit }: { rows: PayCodeRow[]; canEdit: boolean }) {
  const [editing, setEditing] = React.useState<PayCodeRow | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<PayCodeRow | null>(null);
  return (
    <Card>
      <CardHeader title="Pay codes" description="What an hour of overtime is worth: a multiple of the hourly wage (2× is the Factories Act rate), a fixed amount per hour, or a lump sum per day."
        action={canEdit ? <Button size="sm" onClick={() => setEditing("new")}><Plus />Add pay code</Button> : undefined} />
      {rows.length === 0 ? <EmptyState compact icon={<BadgeIndianRupee />} title="No pay codes yet" description="Add one before a policy can pay overtime." /> : (
        <ul className="divide-y divide-border border-t border-border">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-base font-medium">{r.name}</p>
                <p className="text-sm text-text-muted">{r.kind === "multiplier" ? `${r.value}× hourly wage` : `${formatINR(Math.round((r.value ?? 0) * 100))} ${r.kind === "fixed_per_hour" ? "per hour" : "per day"}`} · used by {r.used_by} {r.used_by === 1 ? "policy" : "policies"}</p>
              </div>
              {canEdit && <Menu trigger={<IconButton label={`Actions for ${r.name}`} size="icon-sm"><MoreHorizontal /></IconButton>}
                items={[{ label: "Edit", icon: <Pencil />, onSelect: () => setEditing(r) }, { label: "Delete", icon: <Trash2 />, danger: true, disabled: r.used_by > 0, onSelect: () => setDeleting(r) }]} />}
            </li>
          ))}
        </ul>
      )}
      {editing && <PayCodeDialog row={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting.name}?`} description="Settlements already made keep their amounts." confirmLabel="Delete"
        onConfirm={async () => { const r = await deletePayCodeAction(deleting.id); if (r.ok) toast.success("Pay code deleted"); else toast.error(r.error); setDeleting(null); }} />}
    </Card>
  );
}

function PayCodeDialog({ row, onClose }: { row: PayCodeRow | null; onClose: () => void }) {
  const [name, setName] = React.useState(row?.name ?? "");
  const [kind, setKind] = React.useState<PayCodeRow["kind"]>(row?.kind ?? "multiplier");
  const [value, setValue] = React.useState(row?.value == null ? "2" : String(row.value));
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    setError(null);
    const r = await savePayCodeAction(row?.id ?? null, { name, kind, value: value === "" ? null : Number(value) });
    if (!r.ok) { setError(r.error); return; }
    toast.success(row ? "Pay code updated" : "Pay code added"); onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={row ? "Edit pay code" : "Add pay code"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>{row ? "Save" : "Add"}</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus placeholder="e.g. Double time" /></Field>
        <div className="flex flex-col gap-1.5"><span className="text-sm font-medium">Type</span>
          <Segmented label="Pay code type" value={kind} onChange={setKind} options={[{ value: "multiplier", label: "× hourly wage" }, { value: "fixed_per_hour", label: "₹ per hour" }, { value: "lump_sum", label: "₹ per day" }]} />
        </div>
        <Field label={kind === "multiplier" ? "Multiplier" : kind === "fixed_per_hour" ? "Rupees per hour" : "Rupees per day"} required help={kind === "multiplier" ? "2 = double the hourly wage" : undefined}>
          <Input type="number" inputMode="decimal" min={0} step={kind === "multiplier" ? 0.25 : 1} value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- shift allowances

function AllowancesCard({ rows, shifts, canEdit }: { rows: AllowanceRow[]; shifts: { id: string; name: string; code: string }[]; canEdit: boolean }) {
  const [editing, setEditing] = React.useState<AllowanceRow | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<AllowanceRow | null>(null);
  return (
    <Card>
      <CardHeader title="Shift allowances" description="A fixed amount for every day someone works one of the listed shifts (night allowance, for example). Settled monthly into payroll as a shift-allowance input."
        action={canEdit ? <Button size="sm" onClick={() => setEditing("new")}><Plus />Add allowance</Button> : undefined} />
      {rows.length === 0 ? <EmptyState compact icon={<Timer />} title="No shift allowances" description="Add one to pay extra for night or rotating shifts." /> : (
        <ul className="divide-y divide-border border-t border-border">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-base font-medium">{r.name} <span className="text-sm font-normal text-text-muted">{r.component_code}</span></p>
                <p className="text-sm text-text-muted">{formatINR(r.amount_paise)} per {r.per} · {r.shifts.join(", ") || "no shifts"}</p>
              </div>
              {canEdit && <Menu trigger={<IconButton label={`Actions for ${r.name}`} size="icon-sm"><MoreHorizontal /></IconButton>}
                items={[{ label: "Edit", icon: <Pencil />, onSelect: () => setEditing(r) }, { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setDeleting(r) }]} />}
            </li>
          ))}
        </ul>
      )}
      {editing && <AllowanceDialog row={editing === "new" ? null : editing} shifts={shifts} onClose={() => setEditing(null)} />}
      {deleting && <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting.name}?`} description="Inputs already settled into payroll stay." confirmLabel="Delete"
        onConfirm={async () => { const r = await deleteAllowancePolicyAction(deleting.id); if (r.ok) toast.success("Allowance deleted"); else toast.error(r.error); setDeleting(null); }} />}
    </Card>
  );
}

function AllowanceDialog({ row, shifts, onClose }: { row: AllowanceRow | null; shifts: { id: string; name: string; code: string }[]; onClose: () => void }) {
  const [name, setName] = React.useState(row?.name ?? "");
  const [shiftIds, setShiftIds] = React.useState<string[]>(row?.shift_ids ?? []);
  const [amount, setAmount] = React.useState<number | null>(row?.amount_paise ?? 20000);
  const [per, setPer] = React.useState<"day" | "shift">(row?.per ?? "day");
  const [code, setCode] = React.useState(row?.component_code ?? "SHIFT_ALLOWANCE");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    setError(null);
    const r = await saveAllowancePolicyAction(row?.id ?? null, { name, shiftIds, amountPaise: amount ?? 0, per, componentCode: code });
    if (!r.ok) { setError(r.error); return; }
    toast.success(row ? "Allowance updated" : "Allowance added"); onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={row ? "Edit shift allowance" : "Add shift allowance"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>{row ? "Save" : "Add"}</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus placeholder="e.g. Night shift allowance" /></Field>
        <fieldset className="flex flex-col gap-2"><legend className="mb-1 text-sm font-medium">Shifts that earn it</legend>
          {shifts.map((s) => <Checkbox key={s.id} label={`${s.name} (${s.code})`} checked={shiftIds.includes(s.id)} onCheckedChange={(c) => setShiftIds((ids) => c ? [...ids, s.id] : ids.filter((x) => x !== s.id))} />)}
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount" required><MoneyInput valuePaise={amount} onChangePaise={setAmount} /></Field>
          <div className="flex flex-col gap-1.5"><span className="text-sm font-medium">Per</span><Segmented label="Per" value={per} onChange={setPer} options={[{ value: "day", label: "Day worked" }, { value: "shift", label: "Shift" }]} /></div>
        </div>
        <Field label="Salary component code" required help="Shown on the payslip under this component when one exists"><Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={31} className="uppercase" /></Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- monthly settlement

function SettleCard({ month, rows, canEdit }: { month: string; rows: MonthOvertimeRow[]; canEdit: boolean }) {
  const [m, setM] = React.useState(month);
  const [result, setResult] = React.useState<{ overtime: SettleLine[]; allowances: AllowanceLine[] } | null>(null);
  const [pending, start] = React.useTransition();
  const run = () => start(async () => {
    const r = await settleMonthAction(m);
    if (!r.ok) { toast.error(r.error); return; }
    setResult(r.data ?? null);
    const n = (r.data?.overtime ?? []).filter((l) => l.result === "updated").length + (r.data?.allowances ?? []).filter((l) => l.result === "updated").length;
    toast.success(n ? `${n} payroll ${n === 1 ? "line" : "lines"} updated for ${monthName(m)}` : `Nothing changed for ${monthName(m)}`);
  });
  const cols: Column<MonthOvertimeRow>[] = [
    { key: "name", header: "Person", sortValue: (r) => r.name, cell: (r) => <span className="block"><span className="font-medium">{r.name}</span><span className="block text-sm text-text-muted">{r.policy ?? "No policy"}</span></span> },
    { key: "min", header: "Overtime", align: "right", sortValue: (r) => r.minutes, cell: (r) => hm(r.minutes) },
    { key: "pending", header: "Waiting", align: "right", cell: (r) => r.pending ? <Badge tone="warning">{r.pending} pending</Badge> : <span className="text-text-muted">—</span>, hideBelow: "md" },
    { key: "settled", header: "Settled", cell: (r) => r.settled ? <span className="block text-sm">{r.settled.amountPaise ? formatINR(r.settled.amountPaise) : ""}{r.settled.amountPaise && r.settled.compOffDays ? " + " : ""}{r.settled.compOffDays ? `${r.settled.compOffDays} comp-off ${r.settled.compOffDays === 1 ? "day" : "days"}` : ""}{!r.settled.amountPaise && !r.settled.compOffDays ? "Nothing" : ""}<span className="block text-text-muted">{new Date(r.settled.at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span></span> : <span className="text-text-muted">Not yet</span> },
  ];
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="Monthly settlement" description="Turns the month's overtime into payroll inputs (pay) or comp-off credits, and pays shift allowances for shifts worked. Safe to run again: amounts update, nothing doubles. Months whose payroll is finalised are skipped." />
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="Month"><Input type="month" value={m} max={month} onChange={(e) => setM(e.target.value)} className="w-44" /></Field>
          {canEdit && <Button onClick={run} loading={pending} disabled={!/^\d{4}-\d{2}$/.test(m)}><Calculator />Settle {monthName(m)}</Button>}
          {!canEdit && <p className="text-sm text-text-muted">Only company-wide attendance admins can settle a month.</p>}
        </CardBody>
        {result && (
          <CardBody className="flex flex-col gap-3 border-t border-border pt-4">
            <p className="text-sm font-medium">Result for {monthName(m)}</p>
            {result.overtime.length === 0 && result.allowances.length === 0 && <p className="text-sm text-text-muted">Nobody had overtime or allowance days this month.</p>}
            <ul className="flex flex-col gap-1 text-sm">
              {result.overtime.map((l) => (
                <li key={l.employeeId} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{l.name}</span><span className="text-text-muted">{hm(l.minutes)}</span>
                  {l.amountPaise > 0 && <span>{formatINR(l.amountPaise)}</span>}{l.compOffDays > 0 && <span>{l.compOffDays} comp-off</span>}
                  <Badge tone={l.result === "updated" ? "success" : l.result === "skipped" ? "warning" : "neutral"}>{l.result}{l.why ? ` · ${l.why}` : ""}</Badge>
                </li>
              ))}
              {result.allowances.map((l, i) => (
                <li key={`${l.employeeId}-${i}`} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{l.name}</span><span className="text-text-muted">{l.policy} · {l.days} {l.days === 1 ? "day" : "days"}</span><span>{formatINR(l.amountPaise)}</span>
                  <Badge tone={l.result === "updated" ? "success" : l.result === "skipped" ? "warning" : "neutral"}>{l.result}{l.why ? ` · ${l.why}` : ""}</Badge>
                </li>
              ))}
            </ul>
          </CardBody>
        )}
      </Card>
      <DataTable caption={`Overtime recorded in ${monthName(month)}`} rows={rows} columns={cols} rowKey={(r) => r.employeeId}
        empty={<EmptyState compact icon={<Zap />} title="No overtime this month" description="People on an overtime policy appear here once their days are processed." />} />
    </div>
  );
}
