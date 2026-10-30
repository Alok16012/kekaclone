"use client";
import * as React from "react";
import { Modal } from "@/ui/overlay";
import { Button } from "@/ui/button";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Checkbox, Segmented } from "@/ui/choice";
import { Banner } from "@/ui/feedback";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { toast } from "@/ui/toast";
import { initiateExitAction, noticePreviewAction } from "@/app/(app)/org/exits/actions";

export type Reason = { id: string; kind: "resignation" | "termination" | "other"; name: string };
type Notice = { policy: string | null; days: number; inProbation: boolean; lastWorkingDate: string };
const fmt = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** S45: HR starts an exit. The last working day comes from the person's notice period and can be overridden. */
export function InitiateExit({ people, reasons, today, trigger, defaultEmployeeId }: { people: Person[]; reasons: Reason[]; today: string; trigger: React.ReactNode; defaultEmployeeId?: string }) {
  const [open, setOpen] = React.useState(false);
  const [employee, setEmployee] = React.useState<string[]>(defaultEmployeeId ? [defaultEmployeeId] : []);
  const [kind, setKind] = React.useState<"resignation" | "company_action">("resignation");
  const [reasonId, setReasonId] = React.useState<string | undefined>();
  const [resignationDate, setResignationDate] = React.useState(today);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const [override, setOverride] = React.useState(false);
  const [lwd, setLwd] = React.useState("");
  const [rehire, setRehire] = React.useState<"yes" | "no" | "undecided">("undecided");
  const [comments, setComments] = React.useState("");
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const seq = React.useRef(0);

  const preview = (emp: string | undefined, date: string) => {
    setNotice(null);
    if (!emp || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const n = ++seq.current;
    noticePreviewAction(emp, date).then((r) => { if (n === seq.current && r.ok) { setNotice(r.data!); setLwd((v) => (override && v ? v : r.data!.lastWorkingDate)); } });
  };
  const reset = () => {
    setEmployee(defaultEmployeeId ? [defaultEmployeeId] : []); setKind("resignation"); setReasonId(undefined); setResignationDate(today); setNotice(null);
    setOverride(false); setLwd(""); setRehire("undecided"); setComments(""); setError(null);
  };
  const shownReasons = reasons.filter((r) => (kind === "resignation" ? r.kind === "resignation" || r.kind === "other" : r.kind !== "resignation"));

  const submit = () => start(async () => {
    setError(null);
    if (!employee[0]) { setError({ message: "Pick the person who is leaving.", field: "employee" }); return; }
    const r = await initiateExitAction({
      employeeId: employee[0], kind, reasonId: reasonId ?? null, resignationDate, lastWorkingDate: override ? lwd : null,
      okToRehire: rehire === "undecided" ? null : rehire === "yes", comments: comments || null,
    });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success("Exit started", { description: `Last working day ${fmt(r.data!.lastWorkingDate)}. The exit checklist has been created.` });
    setOpen(false); reset();
  });

  return (
    <Modal open={open} onOpenChange={(o) => { setOpen(o); if (o) { reset(); if (defaultEmployeeId) preview(defaultEmployeeId, today); } }} trigger={trigger} size="md"
      title="Initiate exit" description="Record a resignation you've received, or start an exit on the company's side."
      footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={pending} onClick={submit}>Start exit</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {error && !["lastWorkingDate", "resignationDate"].includes(error.field ?? "") && <Banner tone="danger">{error.message}</Banner>}
        <Field label="Who is leaving?" required>
          <EmployeePicker people={people} value={employee} onChange={(ids) => { setEmployee(ids); preview(ids[0], resignationDate); }} placeholder="Search people" />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Exit type</span>
          <Segmented label="Exit type" value={kind} onChange={(v) => { setKind(v); setReasonId(undefined); }} options={[{ value: "resignation", label: "Resignation" }, { value: "company_action", label: "Company action" }]} />
        </div>
        <Field label="Reason">
          <Select value={reasonId} onValueChange={setReasonId} placeholder={shownReasons.length ? "Pick a reason" : "No reasons set up"} disabled={!shownReasons.length} options={shownReasons.map((r) => ({ value: r.id, label: r.name }))} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={kind === "resignation" ? "Resignation date" : "Notice given on"} required error={error?.field === "resignationDate" ? error.message : undefined}>
            <Input type="date" value={resignationDate} onChange={(e) => { setResignationDate(e.target.value); preview(employee[0], e.target.value); }} />
          </Field>
          <Field label="Last working day" required error={error?.field === "lastWorkingDate" ? error.message : undefined}
            help={notice ? (notice.policy ? `${notice.policy} notice${notice.inProbation ? " (probation)" : ""}: ${notice.days} days` : "No notice period set") : employee[0] ? "Working it out…" : "Pick a person first"}>
            <Input type="date" value={lwd} min={resignationDate} readOnly={!override} onChange={(e) => setLwd(e.target.value)} aria-readonly={!override} />
          </Field>
        </div>
        <Checkbox label="Use a different last working day" checked={override} onCheckedChange={(c) => { setOverride(!!c); if (!c && notice) setLwd(notice.lastWorkingDate); }} />
        {override && notice && lwd && lwd < notice.lastWorkingDate && (
          <p className="text-sm text-text-muted">{Math.round((Date.parse(notice.lastWorkingDate) - Date.parse(lwd)) / 864e5)} days of notice will be waived.</p>
        )}
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">OK to rehire?</span>
          <Segmented label="OK to rehire" value={rehire} onChange={setRehire} options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }, { value: "undecided", label: "Not decided" }]} />
        </div>
        <Field label="Comments" help="Kept on the exit record"><Textarea value={comments} onChange={(e) => setComments(e.target.value)} maxLength={2000} /></Field>
      </form>
    </Modal>
  );
}
