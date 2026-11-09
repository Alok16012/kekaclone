"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarDays, ChevronLeft, ChevronRight, Clock, RotateCcw, Users } from "lucide-react";
import { Button, IconButton } from "@/ui/button";
import { Card, CardBody, CardHeader, StatTile } from "@/ui/card";
import { Badge, StatusChip } from "@/ui/badge";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { Checkbox, RadioGroup } from "@/ui/choice";
import { Modal } from "@/ui/overlay";
import { Banner, EmptyState, Skeleton } from "@/ui/feedback";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { toast } from "@/ui/toast";
import { rehireAction, timeTabAction } from "@/app/(app)/corehr/actions";

export type TimeData = {
  month: string;
  balances: { id: string; name: string; color: string; available: number | null; used: number; pending: number; credited: number }[];
  summary: { present: number; absent: number; halfDay: number; leave: number; wfh: number; offDays: number; lateDays: number; lateMinutes: number; avgEffectiveMinutes: number };
  leaveRequests: { id: string; type: string; color: string; from: string; to: string; days: number; status: string }[];
  attendanceRequests: { id: string; kind: string; from_date: string; to_date: string; status: string; reason: string | null }[];
  clockIns: { id: string; at: string; direction: string; source: string; status: string; selfieFileId: string | null; lat: number | null; lng: number | null; accuracy: number | null; device: string | null }[];
};
const SOURCE: Record<string, string> = { web: "Browser", mobile: "Location", biometric: "Device", api: "API", regularization: "Regularized" };
const PUNCH_STATUS: Record<string, string> = { valid: "", pending_approval: "waiting for approval", rejected: "declined" };
const clockTime = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
const fmt = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const KIND: Record<string, string> = { regularization: "Regularization", partial_day: "Partial day", wfh: "Work from home", on_duty: "On duty", remote_clock_in: "New device clock-in", shift_change: "Shift change", weekly_off_change: "Weekly-off change", overtime: "Overtime" };
const hm = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
const shiftMonth = (m: string, by: number) => { const d = new Date(m + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + by); return d.toISOString().slice(0, 10); };

/** Leave balances, a month of attendance in numbers, and recent requests, for one person. */
export function TimeTab({ employeeId, initial, thisMonth }: { employeeId: string; initial: TimeData; thisMonth: string }) {
  const [d, setD] = React.useState(initial);
  const [busy, start] = React.useTransition();
  const go = (by: number) => start(async () => { const r = await timeTabAction(employeeId, shiftMonth(d.month, by)); if (r.ok && r.data) setD(r.data as TimeData); else if (!r.ok) toast.error(r.error); });
  const label = new Date(d.month + "T00:00:00Z").toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="Leave balances" description="Available now, after pending requests" />
        <CardBody>
          {d.balances.length === 0 ? <p className="text-base text-text-muted">No leave plan assigned.</p> : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {d.balances.map((b) => (
                <li key={b.id} className="rounded-md border border-border p-3">
                  <p className="flex items-center gap-2 text-sm text-text-muted"><span aria-hidden className="size-2.5 rounded-pill" style={{ background: b.color }} />{b.name}</p>
                  <p className="mt-1 text-2xl font-semibold tabular">{b.available == null ? "No limit" : b.available}</p>
                  <p className="text-xs text-text-muted">{b.used} used{b.pending ? ` · ${b.pending} pending` : ""}</p>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-md font-semibold">Attendance · {label}</h3>
        <div className="flex items-center gap-1">
          <IconButton label="Previous month" onClick={() => go(-1)} disabled={busy}><ChevronLeft /></IconButton>
          <IconButton label="Next month" onClick={() => go(1)} disabled={busy || d.month >= thisMonth}><ChevronRight /></IconButton>
        </div>
      </div>
      <div className={busy ? "opacity-60" : undefined} aria-busy={busy}>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Days present" value={d.summary.present} hint={d.summary.wfh ? `${d.summary.wfh} from home` : undefined} icon={<Clock />} />
          <StatTile label="Absent" value={d.summary.absent} hint={d.summary.halfDay ? `${d.summary.halfDay} half days` : undefined} />
          <StatTile label="On leave" value={d.summary.leave} icon={<CalendarDays />} />
          <StatTile label="Late arrivals" value={d.summary.lateDays} hint={d.summary.lateMinutes ? `${d.summary.lateMinutes} min in all` : undefined} />
        </div>
        <p className="mt-2 text-sm text-text-muted">Average effective hours on worked days: {d.summary.avgEffectiveMinutes ? hm(d.summary.avgEffectiveMinutes) : "—"} · weekly offs and holidays: {d.summary.offDays}</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Leave requests" />
          {d.leaveRequests.length === 0 ? <EmptyState compact title="No leave requests yet" /> : (
            <ul className="divide-y divide-border border-t border-border">{d.leaveRequests.map((l) => (
              <li key={l.id} className="flex items-center gap-3 px-5 py-3"><span aria-hidden className="size-2.5 shrink-0 rounded-pill" style={{ background: l.color }} />
                <span className="min-w-0 flex-1"><span className="block truncate text-base font-medium">{l.type}</span><span className="text-sm text-text-muted">{l.from === l.to ? fmt(l.from) : `${fmt(l.from)} – ${fmt(l.to)}`} · {l.days} {l.days === 1 ? "day" : "days"}</span></span>
                <StatusChip status={l.status as "pending"} /></li>
            ))}</ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Attendance requests" />
          {d.attendanceRequests.length === 0 ? <EmptyState compact title="No attendance requests yet" /> : (
            <ul className="divide-y divide-border border-t border-border">{d.attendanceRequests.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-5 py-3">
                <span className="min-w-0 flex-1"><span className="block truncate text-base font-medium">{KIND[a.kind] ?? a.kind}</span><span className="text-sm text-text-muted">{a.from_date === a.to_date ? fmt(a.from_date) : `${fmt(a.from_date)} – ${fmt(a.to_date)}`}{a.reason ? ` · ${a.reason}` : ""}</span></span>
                <StatusChip status={a.status as "pending"} /></li>
            ))}</ul>
          )}
        </Card>
      </div>
      <Card>
        <CardHeader title="Clock-ins from locations and devices" description="This month's clock-ins that came from a phone's location, a biometric device, or are waiting for approval. Selfies are for a person to look at; erp never matches faces." />
        {d.clockIns.length === 0 ? <EmptyState compact title="Nothing from locations or devices this month" /> : (
          <ul className="divide-y divide-border border-t border-border">{d.clockIns.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-5 py-3">
              {c.selfieFileId ? (
                // eslint-disable-next-line @next/next/no-img-element -- private, permission-checked image served by our own route
                <a href={`/files/${c.selfieFileId}`} target="_blank" rel="noopener" className="shrink-0 rounded-md focus-visible:outline-offset-2"><img src={`/files/${c.selfieFileId}`} alt={`Selfie at clock-${c.direction === "out" ? "out" : "in"} on ${clockTime(c.at)}`} className="size-12 rounded-md object-cover" /></a>
              ) : <span aria-hidden className="size-12 shrink-0 rounded-md bg-surface-sunken" />}
              <span className="min-w-0 flex-1">
                <span className="block text-base font-medium tabular">{clockTime(c.at)} · {c.direction === "out" ? "out" : c.direction === "in" ? "in" : "punch"}</span>
                <span className="block text-sm text-text-muted">{SOURCE[c.source] ?? c.source}{c.device ? ` · ${c.device}` : ""}{c.lat != null && c.lng != null ? ` · ${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}${c.accuracy != null ? ` (±${Math.round(c.accuracy)} m)` : ""}` : ""}{PUNCH_STATUS[c.status] ? ` · ${PUNCH_STATUS[c.status]}` : ""}</span>
              </span>
              {c.status !== "valid" && <Badge tone={c.status === "rejected" ? "danger" : "warning"}>{c.status === "rejected" ? "Declined" : "Pending"}</Badge>}
            </li>
          ))}</ul>
        )}
      </Card>
    </div>
  );
}

export function TimeTabSkeleton() { return <div className="flex flex-col gap-3"><Skeleton className="h-28" /><Skeleton className="h-24" /></div>; }

/** Policies that apply to the person, on the Job tab. */
export function AssignedPolicies({ p }: { p: Record<string, unknown> & { groups: { type: string; name: string }[] } }) {
  const rows: [string, string][] = [["leave_plan", "Leave plan"], ["holiday_list", "Holiday list"], ["shift", "Shift"], ["weekly_off", "Weekly off"], ["capture", "Clock-in rules"], ["penalty", "Penalty policy"], ["pay_group", "Pay group"], ["probation", "Probation policy"], ["notice", "Notice period"], ["expense", "Expense policy"]];
  return (
    <Card className="lg:col-span-2">
      <CardHeader title="Policies and groups" description="What applies to them today" />
      <CardBody>
        <dl className="grid gap-x-6 sm:grid-cols-2">
          {rows.map(([k, label]) => (
            <div key={k} className="grid grid-cols-[minmax(0,9rem)_1fr] gap-3 border-b border-border py-2">
              <dt className="text-sm text-text-muted">{label}</dt><dd className="min-w-0 break-words text-base">{(p[k] as string | null) ?? <span className="text-text-muted">{k === "holiday_list" ? "Company default" : "None"}</span>}</dd>
            </div>
          ))}
        </dl>
        {p.groups.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5"><Users className="size-4 text-text-muted" aria-label="Groups" />{p.groups.map((g) => <Badge key={`${g.type}:${g.name}`}>{g.type}: {g.name}</Badge>)}</div>}
      </CardBody>
    </Card>
  );
}

type Opt = { id: string; name: string };
/** Bring back someone who left: reuse their record, or start a new one linked to it. */
export function RehireDialog({ employeeId, name, today, lookups, notRehirable }: { employeeId: string; name: string; today: string; lookups: { departments: Opt[]; designations: Opt[]; locations: Opt[]; people: Person[] }; notRehirable: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<"reactivate" | "new_record">("reactivate");
  const [v, setV] = React.useState({ joiningDate: today, workEmail: "", employeeNumber: "", departmentId: "", designationId: "", locationId: "", managerId: "" });
  const [override, setOverride] = React.useState(false);
  const [invite, setInvite] = React.useState(true);
  const [pending, start] = React.useTransition();
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const opt = (xs: Opt[]) => [{ value: "__keep", label: "Keep as before" }, ...xs.map((x) => ({ value: x.id, label: x.name }))];
  const sel = (k: keyof typeof v) => (x: string) => setV((s) => ({ ...s, [k]: x === "__keep" ? "" : x }));
  const submit = () => start(async () => {
    setError(null);
    const r = await rehireAction(employeeId, { mode, joiningDate: v.joiningDate, workEmail: v.workEmail || null, employeeNumber: v.employeeNumber || null,
      departmentId: v.departmentId || undefined, designationId: v.designationId || undefined, locationId: v.locationId || undefined, managerId: v.managerId || undefined, overrideNotRehirable: override, sendInvite: invite });
    if (!r.ok) { setError({ message: r.error, field: "field" in r ? r.field : undefined }); return; }
    toast.success(`${name} rehired`, { description: r.data!.invited ? "Invite emailed." : undefined });
    setOpen(false);
    router.push(`/people/${r.data!.employeeId}`);
  });
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}><RotateCcw />Rehire</Button>
      <Modal open={open} onOpenChange={setOpen} title={`Rehire ${name}`} description="Their earlier employment stays on record."
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={pending} onClick={submit} disabled={notRehirable && !override}>Rehire</Button></>}>
        <div className="flex flex-col gap-4">
          {error && <Banner tone="danger">{error.message}</Banner>}
          {notRehirable && <Banner tone="warning" title="Marked “not OK to rehire” at exit"><Checkbox label="I've checked, go ahead anyway" checked={override} onCheckedChange={(c) => setOverride(!!c)} /></Banner>}
          <RadioGroup value={mode} onValueChange={(x) => setMode(x as typeof mode)} options={[
            { value: "reactivate", label: "Bring back the same record", hint: "Same employee number and email; history stays on their timeline." },
            { value: "new_record", label: "Start a new employment record", hint: "New number and work email, linked to the old record." },
          ]} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Joining date" required error={error?.field === "joiningDate" ? error.message : undefined}><Input type="date" value={v.joiningDate} onChange={(e) => setV((s) => ({ ...s, joiningDate: e.target.value }))} /></Field>
            {mode === "new_record" && <>
              <Field label="Work email" required error={error?.field === "workEmail" ? error.message : undefined}><Input type="email" value={v.workEmail} onChange={(e) => setV((s) => ({ ...s, workEmail: e.target.value }))} /></Field>
              <Field label="Employee number" help="Empty: generate one"><Input value={v.employeeNumber} onChange={(e) => setV((s) => ({ ...s, employeeNumber: e.target.value }))} /></Field>
            </>}
            <Field label="Department"><Select value={v.departmentId || "__keep"} onValueChange={sel("departmentId")} options={opt(lookups.departments)} /></Field>
            <Field label="Designation"><Select value={v.designationId || "__keep"} onValueChange={sel("designationId")} options={opt(lookups.designations)} /></Field>
            <Field label="Location"><Select value={v.locationId || "__keep"} onValueChange={sel("locationId")} options={opt(lookups.locations)} /></Field>
            <Field label="Reporting manager"><EmployeePicker people={lookups.people} value={v.managerId ? [v.managerId] : []} onChange={(ids) => setV((s) => ({ ...s, managerId: ids[0] ?? "" }))} placeholder="Choose a manager" /></Field>
          </div>
          <Checkbox label="Email them an invite to sign in" checked={invite} onCheckedChange={(c) => setInvite(!!c)} />
        </div>
      </Modal>
    </>
  );
}

export function IdCardLink({ employeeId }: { employeeId: string }) {
  return <Button asChild variant="secondary" size="sm"><Link href={`/people/${employeeId}/id-card`}>ID card</Link></Button>;
}
