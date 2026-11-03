"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Modal } from "@/ui/overlay";
import { Button, IconButton } from "@/ui/button";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Segmented, Switch } from "@/ui/choice";
import { Banner, Skeleton } from "@/ui/feedback";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { toast } from "@/ui/toast";
import { EMAIL_TEMPLATE_KEYS } from "@/server/modules/hire/rules";
import {
  convertAction, convertDefaultsAction, createOfferAction, emailDraftAction, reviseOfferAction, scheduleAction, sendEmailAction,
} from "@/app/(app)/hire/actions";
import { Html } from "./shared";

/** Local date + time inputs → ISO, read as IST. */
const istIso = (date: string, time: string) => (date && time ? new Date(`${date}T${time}:00+05:30`).toISOString() : "");
const addMins = (iso: string, mins: number) => (iso ? new Date(new Date(iso).getTime() + mins * 60_000).toISOString() : "");

/** S140: schedule an interview at a fixed time, or offer slots for the candidate to pick. */
export function ScheduleDialog({ applicationId, candidate, people, scorecards, onClose }: {
  applicationId: string; candidate: string; people: Person[]; scorecards: { id: string; name: string }[]; onClose: () => void;
}) {
  const [f, setF] = React.useState({ title: "Interview", mode: "online", scheduling: "fixed" as "fixed" | "self_schedule", date: "", time: "10:00", duration: "60", meetingUrl: "", location: "", notes: "", scorecardId: scorecards[0]?.id ?? "", notify: true });
  const [slots, setSlots] = React.useState([{ date: "", time: "10:00" }, { date: "", time: "15:00" }]);
  const [panel, setPanel] = React.useState<string[]>([]);
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [busy, start] = React.useTransition();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const submit = (allowConflict = false) => start(async () => {
    setError(null);
    const mins = Number(f.duration) || 60;
    const start0 = istIso(f.date, f.time);
    const r = await scheduleAction(applicationId, {
      title: f.title, mode: f.mode, scheduling: f.scheduling, start: start0 || null, end: addMins(start0, mins) || null,
      slots: slots.filter((s) => s.date).map((s) => { const st = istIso(s.date, s.time); return { start: st, end: addMins(st, mins) }; }),
      meetingUrl: f.meetingUrl || null, location: f.location || null, panel, scorecardId: f.scorecardId || null, notes: f.notes || null, notifyCandidate: f.notify, allowConflict,
    });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success(f.scheduling === "fixed" ? "Interview scheduled" : "Scheduling link sent to the candidate");
    onClose();
  });
  const err = (k: string) => (error?.field === k ? error.message : undefined);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="lg" title="Schedule an interview" description={candidate}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={() => submit(false)}>{f.scheduling === "fixed" ? "Schedule" : "Send slots"}</Button></>}>
      <div className="flex flex-col gap-4">
        {error?.field === "conflict" && <Banner tone="warning" title="Panel clash" action={<Button size="sm" variant="secondary" loading={busy} onClick={() => submit(true)}>Schedule anyway</Button>}>{error.message}</Banner>}
        {error && !["conflict", "panel", "start", "slots", "meetingUrl", "location", "mode"].includes(error.field ?? "") && <Banner tone="danger">{error.message}</Banner>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Round"><Input value={f.title} onChange={(e) => set("title", e.target.value)} maxLength={120} /></Field>
          <Field label="How" error={err("mode")}><Select value={f.mode} onValueChange={(v) => set("mode", v)} options={[{ value: "online", label: "Video call" }, { value: "in_person", label: "In person" }, { value: "phone", label: "Phone call" }]} /></Field>
        </div>
        {f.mode === "online" && <Field label="Meeting link" error={err("meetingUrl")} help="Paste a Google Meet, Zoom or Teams link."><Input type="url" value={f.meetingUrl} onChange={(e) => set("meetingUrl", e.target.value)} placeholder="https://" /></Field>}
        {f.mode === "in_person" && <Field label="Where" required error={err("location")}><Input value={f.location} onChange={(e) => set("location", e.target.value)} maxLength={200} placeholder="e.g. Head office, meeting room 2" /></Field>}
        <Field label="Interviewers" required error={err("panel")}><EmployeePicker people={people} value={panel} onChange={setPanel} multiple placeholder="Add interviewers" /></Field>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">When</span>
          <Segmented label="When" value={f.scheduling} onChange={(v) => set("scheduling", v)} options={[{ value: "fixed", label: "Pick a time" }, { value: "self_schedule", label: "Let the candidate choose" }]} />
        </div>
        {f.scheduling === "fixed" ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Date (IST)" error={err("start")}><Input type="date" value={f.date} onChange={(e) => set("date", e.target.value)} /></Field>
            <Field label="Start"><Input type="time" value={f.time} onChange={(e) => set("time", e.target.value)} /></Field>
            <Field label="Length"><Select value={f.duration} onValueChange={(v) => set("duration", v)} options={["30", "45", "60", "90", "120"].map((m) => ({ value: m, label: `${m} min` }))} /></Field>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-text-muted">The candidate gets a link and picks one of these times (IST). Each lasts {f.duration} minutes.</p>
            {slots.map((s, i) => (
              <div key={i} className="flex items-end gap-2">
                <Field label={i === 0 ? "Date" : undefined} className="flex-1"><Input type="date" aria-label={`Slot ${i + 1} date`} value={s.date} onChange={(e) => setSlots((x) => x.map((y, j) => (j === i ? { ...y, date: e.target.value } : y)))} /></Field>
                <Field label={i === 0 ? "Start" : undefined}><Input type="time" aria-label={`Slot ${i + 1} start`} value={s.time} onChange={(e) => setSlots((x) => x.map((y, j) => (j === i ? { ...y, time: e.target.value } : y)))} /></Field>
                <IconButton label={`Remove slot ${i + 1}`} disabled={slots.length === 1} onClick={() => setSlots((x) => x.filter((_, j) => j !== i))}><Trash2 /></IconButton>
              </div>
            ))}
            <div className="flex items-center gap-3">
              <Button size="sm" variant="ghost" disabled={slots.length >= 10} onClick={() => setSlots((x) => [...x, { date: "", time: "11:00" }])}><Plus />Add a slot</Button>
              <Field label="Length" className="ml-auto w-32"><Select value={f.duration} onValueChange={(v) => set("duration", v)} options={["30", "45", "60", "90"].map((m) => ({ value: m, label: `${m} min` }))} /></Field>
            </div>
            {err("slots") && <p role="alert" className="text-sm text-danger-text">{err("slots")}</p>}
          </div>
        )}
        <Field label="Scorecard"><Select value={f.scorecardId} onValueChange={(v) => set("scorecardId", v)} options={scorecards.map((s) => ({ value: s.id, label: s.name }))} placeholder="No scorecard" /></Field>
        <Field label="Notes for the panel"><Textarea value={f.notes} onChange={(e) => set("notes", e.target.value)} maxLength={2000} /></Field>
        {f.scheduling === "fixed" && <Switch checked={f.notify} onCheckedChange={(c) => set("notify", !!c)} label="Email the candidate the details" />}
        <p className="text-sm text-text-muted">Interviewers get a notification and an email with a link to send feedback.</p>
      </div>
    </Modal>
  );
}

/** S146: draft an offer (or a revised version) from an offer letter template. */
export function OfferDialog({ applicationId, reviseOfferId, templates, designations, initial, onClose }: {
  applicationId: string; reviseOfferId?: string; templates: { id: string; name: string }[]; designations: { id: string; name: string }[];
  initial?: { templateId: string | null; designationId: string | null; ctc: string; joiningDate: string; expiresOn: string }; onClose: () => void;
}) {
  const [f, setF] = React.useState({ templateId: initial?.templateId ?? templates[0]?.id ?? "", designationId: initial?.designationId ?? "", ctc: initial?.ctc ?? "", joiningDate: initial?.joiningDate ?? "", expiresOn: initial?.expiresOn ?? "", note: "" });
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [busy, start] = React.useTransition();
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const go = (submit: boolean) => start(async () => {
    setError(null);
    const input = { templateId: f.templateId, designationId: f.designationId || null, ctc: f.ctc, joiningDate: f.joiningDate, expiresOn: f.expiresOn || null, note: f.note || null };
    const r = reviseOfferId ? await reviseOfferAction(reviseOfferId, input) : await createOfferAction(applicationId, input, submit);
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success(reviseOfferId ? "New version drafted. Send it for approval." : submit ? ((r.data as { approved?: boolean }).approved ? "Offer approved and ready to send" : "Offer sent for approval") : "Offer saved as a draft");
    onClose();
  });
  const err = (k: string) => (error?.field === k ? error.message : undefined);
  if (!templates.length) return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="No offer letter templates">
      <p className="text-base text-text-muted">A hiring admin needs to add an offer letter template in Hiring settings first.</p>
    </Modal>
  );
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={reviseOfferId ? "Revise the offer" : "Make an offer"} description={reviseOfferId ? "Creates a new version. The current one stops working for the candidate." : "Offers need approval before they're sent."}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>{!reviseOfferId && <Button variant="secondary" loading={busy} onClick={() => go(false)}>Save draft</Button>}<Button loading={busy} onClick={() => go(true)}>{reviseOfferId ? "Create new version" : "Send for approval"}</Button></>}>
      <div className="flex flex-col gap-4">
        {error && !["templateId", "ctc", "joiningDate", "expiresOn", "designationId"].includes(error.field ?? "") && <Banner tone="danger">{error.message}</Banner>}
        <Field label="Letter template" error={err("templateId")}><Select value={f.templateId} onValueChange={(v) => set("templateId", v)} options={templates.map((t) => ({ value: t.id, label: t.name }))} /></Field>
        <Field label="Designation" error={err("designationId")} help="Shown in the letter; the job title is used if empty."><Select value={f.designationId} onValueChange={(v) => set("designationId", v)} placeholder="Pick a designation" options={designations.map((d) => ({ value: d.id, label: d.name }))} /></Field>
        <Field label="Annual CTC (₹)" required error={err("ctc")}><Input inputMode="numeric" value={f.ctc} onChange={(e) => set("ctc", e.target.value)} placeholder="e.g. 1800000" /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Joining date" required error={err("joiningDate")}><Input type="date" value={f.joiningDate} onChange={(e) => set("joiningDate", e.target.value)} /></Field>
          <Field label="Accept by" error={err("expiresOn")}><Input type="date" value={f.expiresOn} onChange={(e) => set("expiresOn", e.target.value)} /></Field>
        </div>
        <Field label="Note for approvers"><Textarea value={f.note} onChange={(e) => set("note", e.target.value)} maxLength={2000} /></Field>
      </div>
    </Modal>
  );
}

type ConvertData = Extract<Awaited<ReturnType<typeof convertDefaultsAction>>, { ok: true }>["data"];

/** S147: an accepted candidate becomes an employee (their signed letter and approved documents go with them). */
export function ConvertDialog({ applicationId, candidate, onClose }: { applicationId: string; candidate: string; onClose: () => void }) {
  const router = useRouter();
  const [data, setData] = React.useState<ConvertData | null>(null);
  const [f, setF] = React.useState({ workEmail: "", employeeNumber: "", departmentId: "", designationId: "", locationId: "", managerId: "", joiningDate: "" });
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [busy, start] = React.useTransition();
  React.useEffect(() => {
    let live = true;
    convertDefaultsAction(applicationId).then((r) => {
      if (!live) return;
      if (!r.ok) { setError({ message: r.error }); return; }
      const d = r.data!.defaults;
      setData(r.data!);
      setF({ workEmail: d.workEmail, employeeNumber: "", departmentId: d.department_id ?? "", designationId: d.designation_id ?? "", locationId: d.location_id ?? "", managerId: d.managerId ?? "", joiningDate: d.joining_date ?? "" });
    });
    return () => { live = false; };
  }, [applicationId]);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const err = (k: string) => (error?.field === k ? error.message : undefined);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Make ${candidate} an employee`} description="Creates their employee record and moves their signed offer and approved documents to their profile."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!data} loading={busy} onClick={() => start(async () => {
        setError(null);
        const r = await convertAction(applicationId, { ...f, employeeNumber: f.employeeNumber || null, departmentId: f.departmentId || null, designationId: f.designationId || null, locationId: f.locationId || null, managerId: f.managerId || null });
        if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
        toast.success(r.data!.internal ? "Marked as hired" : `Employee ${r.data!.employeeNumber} created`, { description: r.data!.internal ? "They already work here. Record the move from their profile." : "Invite them from People when you're ready." });
        onClose();
        router.push(`/people/${r.data!.employeeId}`);
      })}>Create employee</Button></>}>
      {!data ? (error ? <Banner tone="danger">{error.message}</Banner> : <div className="flex flex-col gap-3"><Skeleton className="h-9" /><Skeleton className="h-9" /><Skeleton className="h-9" /></div>) : (
        <div className="flex flex-col gap-4">
          {error && !Object.keys(f).includes(error.field ?? "") && <Banner tone="danger">{error.message}</Banner>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Work email" required error={err("workEmail")}><Input type="email" value={f.workEmail} onChange={(e) => set("workEmail", e.target.value)} /></Field>
            <Field label="Employee number" error={err("employeeNumber")} help="Leave empty to number them automatically."><Input value={f.employeeNumber} onChange={(e) => set("employeeNumber", e.target.value)} maxLength={30} /></Field>
            <Field label="Joining date" required error={err("joiningDate")}><Input type="date" value={f.joiningDate} onChange={(e) => set("joiningDate", e.target.value)} /></Field>
            <Field label="Department" error={err("departmentId")}><Select value={f.departmentId} onValueChange={(v) => set("departmentId", v)} options={data.departments.map((d) => ({ value: d.id, label: d.name }))} /></Field>
            <Field label="Designation" error={err("designationId")}><Select value={f.designationId} onValueChange={(v) => set("designationId", v)} options={data.designations.map((d) => ({ value: d.id, label: d.name }))} /></Field>
            <Field label="Location" error={err("locationId")}><Select value={f.locationId} onValueChange={(v) => set("locationId", v)} options={data.locations.map((d) => ({ value: d.id, label: d.name }))} /></Field>
            <Field label="Reports to" className="sm:col-span-2" error={err("managerId")}><EmployeePicker people={data.people} value={f.managerId ? [f.managerId] : []} onChange={(ids) => set("managerId", ids[0] ?? "")} /></Field>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Email the candidate, starting from a template or blank. Placeholders are filled in when it's sent. */
export function EmailDialog({ applicationId, to, onClose }: { applicationId: string; to: string; onClose: () => void }) {
  const [key, setKey] = React.useState<string>("");
  const [subject, setSubject] = React.useState("");
  const [body, setBody] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, start] = React.useTransition();
  const pick = (k: string) => { setKey(k); start(async () => { const r = await emailDraftAction(applicationId, k); if (r.ok) { setSubject(r.data!.subject); setBody(r.data!.body); } }); };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="lg" title="Email the candidate" description={`To ${to}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={() => start(async () => {
        setError(null);
        const r = await sendEmailAction(applicationId, { templateKey: key || null, subject, body });
        if (!r.ok) { setError(r.error); return; }
        toast.success("Email sent"); onClose();
      })}>Send</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="Start from"><Select value={key} onValueChange={pick} placeholder="A blank email" options={EMAIL_TEMPLATE_KEYS.map((k) => ({ value: k.key, label: k.label }))} /></Field>
        <Field label="Subject" required><Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} /></Field>
        <Field label="Message" required help="You can use {{candidate.first_name}} and {{job.title}}."><Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10} maxLength={8000} /></Field>
        {error && <Banner tone="danger">{error}</Banner>}
      </div>
    </Modal>
  );
}

export function PreviewDialog({ title, html, missing, onClose }: { title: string; html: string; missing: string[]; onClose: () => void }) {
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="lg" title={title}>
      {missing.length > 0 && <Banner tone="warning" className="mb-3">Missing: {missing.join(", ")}. Fill these in before sending.</Banner>}
      <div className="rounded-md border border-border bg-surface p-5"><Html html={html} /></div>
    </Modal>
  );
}
