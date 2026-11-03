"use client";
import * as React from "react";
import { Button } from "@/ui/button";
import { Field, Input, Textarea } from "@/ui/field";
import { Segmented } from "@/ui/choice";
import { Select } from "@/ui/select";
import { Banner } from "@/ui/feedback";
import { Modal } from "@/ui/overlay";
import { toast } from "@/ui/toast";
import { createAttendanceRequestAction } from "@/app/(app)/me/attendance/actions";

export type RequestKindUI = "regularization" | "partial_day" | "remote" | "overtime" | "shift_change" | "weekly_off_change";
export type Allowance = {
  limits: { regularization_per_month: number; regularization_past_days: number; partial_day_minutes_per_month: number };
  remote: { wfh: boolean; od: boolean };
  usedRegularizations: number; usedPartialMinutes: number;
  overtime: "request" | "auto" | "none";
  shiftChange: { allowed: { id: string; name: string }[]; windowDays: number | null; maxPerMonth: number | null; used: number; offDaysOk: boolean };
};

const TITLES: Record<RequestKindUI, string> = {
  regularization: "Regularize attendance", partial_day: "Partial day", remote: "Work from home or on duty",
  overtime: "Claim overtime", shift_change: "Change my shift", weekly_off_change: "Swap a weekly off",
};
const hrs = (m: number) => (m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`);

/**
 * One dialog for every request type. The server checks every limit again; the hints here just save a round trip.
 * `date` pre-fills from the row the person opened it from; `today` comes from the server so nothing reads the clock in render.
 */
export function RequestDialog({ kind, date, today, allowance, current, onClose }: {
  kind: RequestKindUI; date: string; today: string; allowance: Allowance;
  current?: { firstIn: string | null; lastOut: string | null; overtime?: number };
  onClose: () => void;
}) {
  const toHHMM = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Kolkata" }) : "");
  const [day, setDay] = React.useState(date);
  const [to, setTo] = React.useState(date);
  const [inTime, setIn] = React.useState(toHHMM(current?.firstIn) || "09:30");
  const [outTime, setOut] = React.useState(toHHMM(current?.lastOut) || "18:30");
  const [remote, setRemote] = React.useState<"wfh" | "on_duty">(allowance.remote.wfh ? "wfh" : "on_duty");
  const [half, setHalf] = React.useState<"full" | "first" | "second">("full");
  const [type, setType] = React.useState<"late_arrival" | "early_leave">("late_arrival");
  const [minutes, setMinutes] = React.useState(kind === "overtime" ? Math.max(60, current?.overtime ?? 60) : 60);
  const [shiftId, setShiftId] = React.useState(allowance.shiftChange.allowed[0]?.id ?? "");
  const [workDate, setWorkDate] = React.useState(date);
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();

  const regsLeft = Math.max(0, allowance.limits.regularization_per_month - allowance.usedRegularizations);
  const minutesLeft = Math.max(0, allowance.limits.partial_day_minutes_per_month - allowance.usedPartialMinutes);
  const remoteOff = !allowance.remote.wfh && !allowance.remote.od;
  const sc = allowance.shiftChange;
  const changesLeft = sc.maxPerMonth == null ? null : Math.max(0, sc.maxPerMonth - sc.used);
  const blocked = (kind === "remote" && remoteOff) || (kind === "overtime" && allowance.overtime !== "request")
    || ((kind === "shift_change" || kind === "weekly_off_change") && changesLeft === 0) || (kind === "shift_change" && !sc.allowed.length);

  const submit = () => start(async () => {
    setError(null);
    if (!reason.trim()) { setError("Add a reason for your manager."); return; }
    const input = kind === "regularization" ? { kind, date: day, inTime, outTime, reason }
      : kind === "partial_day" ? { kind, date: day, type, minutes, reason }
      : kind === "overtime" ? { kind, date: day, minutes, reason }
      : kind === "shift_change" ? { kind, from: day, to: day === to ? day : to, shiftId, reason }
      : kind === "weekly_off_change" ? { kind, offDate: day, workDate, reason }
      : { kind: remote, from: day, to: day === to ? day : to, half: day === to && half !== "full" ? half : null, reason };
    const r = await createAttendanceRequestAction(input);
    if (!r.ok) { setError(r.error); return; }
    toast.success(r.data?.status === "approved" ? "Request approved" : "Request sent to your manager");
    onClose();
  });

  const description = kind === "regularization" ? `Fix your clock-in and clock-out for a past day. ${regsLeft} of ${allowance.limits.regularization_per_month} left this month.`
    : kind === "partial_day" ? `Come in late or leave early. ${hrs(minutesLeft)} of ${hrs(allowance.limits.partial_day_minutes_per_month)} left this month.`
    : kind === "overtime" ? "Extra hours you worked beyond your shift. Your manager approves them; your overtime policy decides pay or comp-off."
    : kind === "shift_change" ? `Work a different shift on some days.${changesLeft != null ? ` ${changesLeft} of ${sc.maxPerMonth} changes left this month.` : ""}`
    : kind === "weekly_off_change" ? "Take a working day off and work one of your weekly offs instead, in the same month."
    : "Let your manager know where you'll be working.";

  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={TITLES[kind]} description={description}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={submit} disabled={blocked}>Send request</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {error && <Banner tone="danger">{error}</Banner>}
        {kind === "remote" && remoteOff && <Banner tone="warning">Work from home and on-duty requests are turned off in your attendance policy.</Banner>}
        {kind === "overtime" && allowance.overtime === "none" && <Banner tone="warning">You&apos;re not on an overtime policy. Ask HR if you think you should be.</Banner>}
        {kind === "overtime" && allowance.overtime === "auto" && <Banner tone="info">Your overtime is counted automatically from your clock-ins; there&apos;s nothing to request.</Banner>}
        {kind === "shift_change" && !sc.allowed.length && <Banner tone="warning">No shifts can be requested right now. Ask HR.</Banner>}
        {(kind === "shift_change" || kind === "weekly_off_change") && changesLeft === 0 && <Banner tone="warning">You&apos;ve used all {sc.maxPerMonth} changes for this month.</Banner>}
        {kind === "remote" && !remoteOff && (
          <Segmented label="Request type" value={remote} onChange={setRemote}
            options={[...(allowance.remote.wfh ? [{ value: "wfh" as const, label: "Work from home" }] : []), ...(allowance.remote.od ? [{ value: "on_duty" as const, label: "On duty" }] : [])]} />
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={kind === "remote" || kind === "shift_change" ? "From" : kind === "weekly_off_change" ? "Day to take off" : "Date"} required
            help={kind === "regularization" ? `Up to ${allowance.limits.regularization_past_days} days back` : kind === "weekly_off_change" ? "A working day" : kind === "shift_change" && sc.windowDays != null ? `Up to ${sc.windowDays} days ahead` : undefined}>
            <Input type="date" value={day} max={kind === "regularization" || kind === "overtime" ? today : undefined} min={kind === "shift_change" || kind === "weekly_off_change" ? today : undefined}
              onChange={(e) => { setDay(e.target.value); if (to < e.target.value) setTo(e.target.value); }} />
          </Field>
          {(kind === "remote" || kind === "shift_change") && <Field label="To" required><Input type="date" value={to} min={day} onChange={(e) => setTo(e.target.value)} /></Field>}
          {kind === "weekly_off_change" && <Field label="Weekly off to work instead" required help="One of your weekly offs in the same month"><Input type="date" value={workDate} min={today} onChange={(e) => setWorkDate(e.target.value)} /></Field>}
        </div>
        {kind === "remote" && day === to && (
          <Segmented label="How long" value={half} onChange={setHalf} options={[{ value: "full", label: "Full day" }, { value: "first", label: "First half" }, { value: "second", label: "Second half" }]} />
        )}
        {kind === "regularization" && (
          <div className="grid grid-cols-2 gap-4">
            <Field label="Clock-in" required><Input type="time" value={inTime} onChange={(e) => setIn(e.target.value)} /></Field>
            <Field label="Clock-out" required help={outTime && inTime && outTime <= inTime ? "Ends the next morning" : undefined}><Input type="time" value={outTime} onChange={(e) => setOut(e.target.value)} /></Field>
          </div>
        )}
        {kind === "partial_day" && (
          <>
            <Segmented label="What happens" value={type} onChange={setType} options={[{ value: "late_arrival", label: "Coming in late" }, { value: "early_leave", label: "Leaving early" }]} />
            <Field label="How long (minutes)" required help="Between 15 minutes and 4 hours">
              <Input type="number" inputMode="numeric" min={15} max={240} step={15} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
            </Field>
          </>
        )}
        {kind === "overtime" && (
          <Field label="Overtime (minutes)" required help={current?.overtime ? `Your clock-ins show ${hrs(current.overtime)} beyond the shift that day. Approval can't exceed what was recorded.` : "Between 15 minutes and 16 hours; never more than your clock-ins show."}>
            <Input type="number" inputMode="numeric" min={15} max={960} step={15} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
          </Field>
        )}
        {kind === "shift_change" && sc.allowed.length > 0 && (
          <Field label="Shift" required help={sc.offDaysOk ? undefined : "Working days only; weekly offs and holidays can't be included."}>
            <Select value={shiftId} onValueChange={setShiftId} options={sc.allowed.map((s) => ({ value: s.id, label: s.name }))} />
          </Field>
        )}
        <Field label="Reason" required help="Your manager sees this"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} /></Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
