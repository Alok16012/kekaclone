"use client";
import * as React from "react";
import { CalendarPlus } from "lucide-react";
import { Button } from "@/ui/button";
import { Modal } from "@/ui/overlay";
import { Field, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Segmented } from "@/ui/choice";
import { Banner } from "@/ui/feedback";
import { Calendar, type DayMark, type Range } from "@/ui/calendar";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { toast } from "@/ui/toast";
import { applyLeaveAction, previewLeaveAction } from "@/app/(app)/actions";
import type { DayPart } from "@/server/modules/leave/rules";

export type LeaveTypeOption = { id: string; name: string; available: number | null; allowHalfDay: boolean };
type Preview = { days: number; violations: { code: string; message: string; blocking: boolean }[]; breakdown: { date: string; why: string }[]; available: number | null };

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fmtDays = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)} ${n === 1 ? "day" : "days"}`;

export function ApplyLeave({ types, marks, people, trigger }: { types: LeaveTypeOption[]; marks: Record<string, DayMark>; people: Person[]; trigger?: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const [typeId, setTypeId] = React.useState<string | undefined>(types[0]?.id);
  const [range, setRange] = React.useState<Range>({ from: null, to: null });
  const [single, setSingle] = React.useState<"full" | "first" | "second">("full");
  const [startPart, setStartPart] = React.useState<"full" | "second">("full");
  const [endPart, setEndPart] = React.useState<"full" | "first">("full");
  const [note, setNote] = React.useState("");
  const [notify, setNotify] = React.useState<string[]>([]);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [checking, startCheck] = React.useTransition();
  const [submitting, startSubmit] = React.useTransition();

  const type = types.find((t) => t.id === typeId);
  const from = range.from ? iso(range.from) : null;
  const to = range.to ? iso(range.to) : from;
  const isSingle = !!from && from === to;
  const parts: { fromPart: DayPart; toPart: DayPart } = isSingle ? { fromPart: single, toPart: single } : { fromPart: startPart, toPart: endPart };

  React.useEffect(() => {
    if (!typeId || !from || !to) return;
    const t = setTimeout(() => startCheck(async () => {
      const r = await previewLeaveAction({ leaveTypeId: typeId, from, to, ...parts });
      setPreview(r.ok ? (r.data as Preview) : null);
    }), 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeId, from, to, parts.fromPart, parts.toPart]);

  const reset = () => { setRange({ from: null, to: null }); setSingle("full"); setStartPart("full"); setEndPart("full"); setNote(""); setNotify([]); setPreview(null); };
  const blocking = preview?.violations.filter((v) => v.blocking) ?? [];
  const warnings = preview?.violations.filter((v) => !v.blocking) ?? [];
  const sandwich = preview?.breakdown.filter((d) => d.why === "sandwich").length ?? 0;
  const canSubmit = !!typeId && !!from && !!preview && blocking.length === 0 && !checking;

  const submit = () => startSubmit(async () => {
    const r = await applyLeaveAction({ leaveTypeId: typeId!, from: from!, to: to!, ...parts, note: note || undefined, notify });
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(r.data!.status === "approved" ? "Leave approved" : "Leave requested", { description: r.data!.status === "approved" ? "No approver is set up for you, so it was approved right away." : "Your manager has been notified." });
    setOpen(false); reset();
  });

  return (
    <Modal open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }} size="lg" title="Apply for leave"
      description={type ? (type.available == null ? `${type.name} · no limit` : `${type.name} · ${fmtDays(type.available)} available`) : undefined}
      trigger={trigger ?? <Button><CalendarPlus />Apply leave</Button>}
      footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={submit} disabled={!canSubmit} loading={submitting}>Request {preview && from ? fmtDays(preview.days) : "leave"}</Button></>}>
      <div className="grid gap-6 md:grid-cols-[auto_1fr]">
        <div>
          <Calendar range={range} onRangeChange={setRange} marks={marks} />
          <p className="mt-2 text-sm text-text-muted">{!from ? "Pick the first day, then the last day." : !range.to ? "Pick the last day, or keep one day." : ""}</p>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <Field label="Leave type" required>
            <Select value={typeId} onValueChange={setTypeId} options={types.map((t) => ({ value: t.id, label: t.available == null ? t.name : `${t.name} (${fmtDays(t.available)} left)` }))} />
          </Field>
          {from && type?.allowHalfDay && (isSingle ? (
            <Field label="Day part"><Segmented label="Day part" value={single} onChange={setSingle} options={[{ value: "full", label: "Full day" }, { value: "first", label: "First half" }, { value: "second", label: "Second half" }]} /></Field>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="First day"><Segmented label="First day" value={startPart} onChange={setStartPart} options={[{ value: "full", label: "Full" }, { value: "second", label: "From 2nd half" }]} /></Field>
              <Field label="Last day"><Segmented label="Last day" value={endPart} onChange={setEndPart} options={[{ value: "full", label: "Full" }, { value: "first", label: "Till 1st half" }]} /></Field>
            </div>
          ))}
          {from && preview && (
            <div className="flex flex-col gap-2" aria-live="polite">
              <div className="flex items-baseline justify-between rounded-md bg-surface-sunken px-4 py-3">
                <span className="text-base text-text-muted">This request</span>
                <span className="text-xl font-semibold tabular">{fmtDays(preview.days)}</span>
              </div>
              {sandwich > 0 && <Banner tone="info">{sandwich} weekly off/holiday {sandwich === 1 ? "day sits" : "days sit"} between your leave days, so {sandwich === 1 ? "it counts" : "they count"} as leave too.</Banner>}
              {blocking.map((v) => <Banner key={v.code} tone="danger">{v.message}</Banner>)}
              {warnings.map((v) => <Banner key={v.code} tone="warning">{v.message}</Banner>)}
            </div>
          )}
          <Field label="Note for your manager"><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Optional" /></Field>
          <Field label="Also let these people know" help="They get a notification. They don't need to approve."><EmployeePicker multiple people={people} value={notify} onChange={setNotify} /></Field>
        </div>
      </div>
    </Modal>
  );
}
