"use client";
import * as React from "react";
import { Card, CardHeader } from "@/ui/card";
import { Button } from "@/ui/button";
import { Field, Input } from "@/ui/field";
import { RadioGroup, Switch } from "@/ui/choice";
import { Banner } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { saveTimesheetPolicyAction } from "@/app/(app)/settings/timesheets/actions";
import type { Policy } from "@/server/modules/psa/rules";

const toH = (m: number | null) => (m == null ? "" : String(Math.round((m / 60) * 100) / 100));
const toMin = (h: string) => (h.trim() === "" ? 0 : Math.round(Number(h) * 60));

/** S132: one policy for the company: cadence and minimums, daily cap, who approves, when past weeks lock. */
export function TimesheetPolicySettings({ policy, canEdit }: { policy: Policy; canEdit: boolean }) {
  const [f, setF] = React.useState({ cadence: policy.cadence, minDay: toH(policy.min_minutes_per_day), minWeek: toH(policy.min_minutes_per_week), maxDay: toH(policy.max_minutes_per_day), lock: policy.lock_after_days == null ? "" : String(policy.lock_after_days), approver: policy.approver, allowFuture: policy.allow_future, requireNote: policy.require_note });
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, start] = React.useTransition();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await saveTimesheetPolicyAction({ cadence: f.cadence, min_minutes_per_day: toMin(f.minDay), min_minutes_per_week: toMin(f.minWeek), max_minutes_per_day: toMin(f.maxDay), lock_after_days: f.lock.trim() === "" ? null : Number(f.lock), approver: f.approver, allow_future: f.allowFuture, require_note: f.requireNote });
      if (!r.ok) { setErrors({ [r.field ?? "form"]: r.error }); toast.error(r.error); return; }
      setErrors({}); toast.success("Timesheet policy saved");
    });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      {!canEdit && <Banner tone="info" title="View only">Only project admins for the whole company can change the timesheet policy.</Banner>}
      <Card>
        <CardHeader title="Hours" description="What a week needs before it can be submitted, and the most anyone can log in a day." />
        <fieldset disabled={!canEdit} className="flex flex-col gap-4 px-5 pb-5">
          <Field label="Minimums are checked" error={errors.cadence}>
            <RadioGroup value={f.cadence} onValueChange={(v) => setF({ ...f, cadence: v as Policy["cadence"] })} options={[{ value: "weekly", label: "Per week", hint: "Only the weekly minimum applies." }, { value: "daily", label: "Per day", hint: "Each weekday that has passed must meet the daily minimum." }]} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Minimum per day (hours)" help="0 for none" error={errors.min_minutes_per_day}><Input type="number" min={0} max={24} step="0.5" inputMode="decimal" value={f.minDay} onChange={(e) => setF({ ...f, minDay: e.target.value })} /></Field>
            <Field label="Minimum per week (hours)" help="0 for none" error={errors.min_minutes_per_week}><Input type="number" min={0} max={168} step="0.5" inputMode="decimal" value={f.minWeek} onChange={(e) => setF({ ...f, minWeek: e.target.value })} /></Field>
            <Field label="Daily limit (hours)" error={errors.max_minutes_per_day}><Input type="number" min={1} max={24} step="0.5" inputMode="decimal" value={f.maxDay} onChange={(e) => setF({ ...f, maxDay: e.target.value })} /></Field>
          </div>
          <Switch label="Allow logging hours for days that haven't happened yet" checked={f.allowFuture} onCheckedChange={(c) => setF({ ...f, allowFuture: !!c })} />
          <Switch label="Every row with hours needs a note" checked={f.requireNote} onCheckedChange={(c) => setF({ ...f, requireNote: !!c })} />
        </fieldset>
      </Card>
      <Card>
        <CardHeader title="Approval and locking" />
        <fieldset disabled={!canEdit} className="flex flex-col gap-4 px-5 pb-5">
          <Field label="Who approves a week" error={errors.approver}>
            <RadioGroup value={f.approver} onValueChange={(v) => setF({ ...f, approver: v as Policy["approver"] })} options={[{ value: "project", label: "The approvers of each project on the sheet", hint: "Falls back to the person's manager when a project has no approvers." }, { value: "manager", label: "The person's reporting manager" }]} />
          </Field>
          <Field label="Lock weeks after (days)" help="Weeks whose last day is older than this can't be edited or submitted any more. Leave empty to never lock." error={errors.lock_after_days} className="sm:w-60">
            <Input type="number" min={0} max={365} inputMode="numeric" value={f.lock} onChange={(e) => setF({ ...f, lock: e.target.value })} />
          </Field>
        </fieldset>
      </Card>
      {canEdit && <div className="flex justify-end"><Button type="submit" loading={busy}>Save policy</Button></div>}
    </form>
  );
}
