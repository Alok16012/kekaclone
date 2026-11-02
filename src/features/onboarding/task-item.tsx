"use client";
import * as React from "react";
import { Check, CheckCircle2, CircleDashed, FileUp, MinusCircle, MoreHorizontal, RotateCcw, ThumbsDown, ThumbsUp, UserRoundCog } from "lucide-react";
import { Badge } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Menu, Modal } from "@/ui/overlay";
import { Banner } from "@/ui/feedback";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { toast } from "@/ui/toast";
import { cn } from "@/lib/cn";
import { completeTaskAction, reassignTaskAction, setTaskStateAction, uploadTaskDocumentAction } from "@/app/(app)/org/onboarding/actions";
import { portalCompleteAction, portalUploadAction } from "@/app/join/actions";
import type { TaskView } from "@/server/modules/onboarding/service";
import { TASK_TYPE_LABEL } from "@/server/modules/onboarding/rules";

const fmt = (d: string | null) => (d ? new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }) : null);
const SELECTS: Record<string, { value: string; label: string }[]> = {
  gender: [{ value: "female", label: "Female" }, { value: "male", label: "Male" }, { value: "non_binary", label: "Non-binary" }, { value: "undisclosed", label: "Prefer not to say" }],
  marital_status: [{ value: "single", label: "Single" }, { value: "married", label: "Married" }, { value: "divorced", label: "Divorced" }, { value: "widowed", label: "Widowed" }, { value: "undisclosed", label: "Prefer not to say" }],
  blood_group: ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"].map((v) => ({ value: v, label: v })),
};

type Mode = { kind: "app" } | { kind: "portal"; token: string };
type Result = { ok: true; data?: unknown } | { ok: false; error: string; field?: string };

function useRun(onDone?: () => void) {
  const [pending, start] = React.useTransition();
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const run = (fn: () => Promise<Result>, success: string) => start(async () => {
    setError(null);
    const r = await fn();
    if (!r.ok) { setError({ message: r.error, field: r.field }); toast.error(r.error); return; }
    toast.success((r.data as { completed?: boolean } | undefined)?.completed ? "All done: onboarding complete" : success);
    onDone?.();
  });
  return { pending, error, run };
}

/** One onboarding task: what it is, who owns it, when it's due, and the control its type needs (for its owner). */
export function TaskItem({ task, mode = { kind: "app" }, showAssignee = true, people, subjectId }: {
  task: TaskView; mode?: Mode; showAssignee?: boolean; people?: Person[]; subjectId?: string;
}) {
  const closed = task.status !== "open";
  const [reassign, setReassign] = React.useState(false);
  const state = useRun();
  return (
    <li className="flex gap-3 px-5 py-4">
      <span className="mt-0.5 shrink-0" aria-hidden>
        {task.status === "done" ? <CheckCircle2 className="size-5 text-success" /> : task.status === "skipped" ? <MinusCircle className="size-5 text-text-muted" /> : <CircleDashed className="size-5 text-text-muted" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className={cn("text-base font-medium", task.status === "skipped" && "text-text-muted line-through")}>{task.title}</p>
          {task.status === "done" && <Badge tone="success">Done</Badge>}
          {task.status === "skipped" && <Badge>Skipped</Badge>}
          {task.overdue && <Badge tone="danger">Overdue</Badge>}
          {task.config.decision === "declined" && <Badge tone="danger">Declined</Badge>}
        </div>
        {task.description && <p className="mt-0.5 text-sm text-text-muted">{task.description}</p>}
        <p className="mt-1 text-sm text-text-muted">
          {[TASK_TYPE_LABEL[task.type], showAssignee ? (task.assignee ? `${task.owner}: ${task.assignee.name}` : `${task.owner}: nobody yet`) : null, task.due_date ? `Due ${fmt(task.due_date)}` : null].filter(Boolean).join(" · ")}
        </p>
        {task.config.decisionNote && <p className="mt-1 text-sm">“{task.config.decisionNote}”</p>}
        {!closed && task.can.complete && <div className="mt-3"><TaskControl task={task} mode={mode} /></div>}
      </div>
      {task.can.manage && mode.kind === "app" && (
        <Menu trigger={<IconButton size="icon-sm" label={`More for ${task.title}`}><MoreHorizontal /></IconButton>}
          items={closed
            ? [{ label: "Reopen", icon: <RotateCcw />, onSelect: () => state.run(() => setTaskStateAction(task.id, "open"), "Task reopened") }]
            : [
              ...(people && task.type !== "profile_field" && task.type !== "document_upload" ? [{ label: "Hand to someone else", icon: <UserRoundCog />, onSelect: () => setReassign(true) }] : []),
              { label: "Skip", icon: <MinusCircle />, onSelect: () => state.run(() => setTaskStateAction(task.id, "skipped"), "Task skipped") },
            ]} />
      )}
      {reassign && people && <ReassignDialog task={task} people={people.filter((p) => task.type !== "approval" || p.id !== subjectId)} onClose={() => setReassign(false)} />}
    </li>
  );
}

function TaskControl({ task, mode }: { task: TaskView; mode: Mode }) {
  const { pending, error, run } = useRun();
  const [value, setValue] = React.useState("");
  const [declining, setDeclining] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const complete = (input: { kind: "done" } | { kind: "acknowledge" } | { kind: "field"; value: string }) =>
    mode.kind === "portal" ? portalCompleteAction(mode.token, task.id, input) : completeTaskAction(task.id, input);

  switch (task.type) {
    case "simple":
      return <Button size="sm" loading={pending} onClick={() => run(() => complete({ kind: "done" }), "Marked as done")}><Check />Mark as done</Button>;
    case "acknowledge":
      return (
        <div className="flex flex-col gap-2">
          {task.config.ackText && <p className="rounded-md bg-surface-sunken px-3 py-2 text-sm">{task.config.ackText}</p>}
          <div><Button size="sm" loading={pending} onClick={() => run(() => complete({ kind: "acknowledge" }), "Acknowledged")}><Check />I acknowledge</Button></div>
        </div>
      );
    case "approval":
      if (mode.kind === "portal") return null;
      return (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" loading={pending} onClick={() => run(() => completeTaskAction(task.id, { kind: "decide", decision: "approved" }), "Approved")}><ThumbsUp />Approve</Button>
          <Button size="sm" variant="secondary" onClick={() => setDeclining(true)}><ThumbsDown />Decline</Button>
          {declining && <DeclineDialog task={task} onClose={() => setDeclining(false)} />}
        </div>
      );
    case "profile_field": {
      const opts = task.config.field ? SELECTS[task.config.field] : undefined;
      const submit = () => run(() => complete({ kind: "field", value }), mode.kind === "portal" ? "Saved. HR will check it." : "Sent. HR will check it if needed.");
      return (
        <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <Field label={task.fieldLabel ?? "Value"} className="sm:w-72" error={error?.field === "value" ? error.message : undefined}>
            {opts ? <Select value={value} onValueChange={setValue} options={opts} placeholder="Choose…" />
              : <Input value={value} onChange={(e) => setValue(e.target.value)} type={task.config.field === "dob" ? "date" : task.config.field === "personal_email" ? "email" : task.config.field === "mobile" ? "tel" : "text"}
                maxLength={task.config.field === "nationality" ? 2 : 120} autoComplete={task.config.field === "personal_email" ? "email" : task.config.field === "mobile" ? "tel" : "off"} />}
          </Field>
          <div className="flex gap-2">
            <Button type="submit" size="sm" loading={pending} disabled={!value.trim()}>Save</Button>
            {task.fieldFilled && <Button size="sm" variant="secondary" onClick={() => run(() => complete({ kind: "done" }), "Marked as done")}>Already filled in</Button>}
          </div>
        </form>
      );
    }
    case "document_upload": {
      const upload = (f: File) => {
        const form = new FormData();
        form.set("taskId", task.id); form.set("file", f);
        if (mode.kind === "portal") form.set("token", mode.token);
        run(() => (mode.kind === "portal" ? portalUploadAction(form) : uploadTaskDocumentAction(form)), "Uploaded. HR will verify it.");
      };
      return (
        <div className="flex flex-col gap-1">
          <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg" className="sr-only" aria-label={`Choose ${task.config.docType ?? "document"}`}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
          <div><Button size="sm" loading={pending} onClick={() => fileRef.current?.click()}><FileUp />Upload {task.config.docType ?? "document"}</Button></div>
          <p className="text-sm text-text-muted">PDF, PNG or JPG, up to 5 MB.</p>
          {error && <p role="alert" className="text-sm text-danger-text">{error.message}</p>}
        </div>
      );
    }
  }
}

function DeclineDialog({ task, onClose }: { task: TaskView; onClose: () => void }) {
  const [note, setNote] = React.useState("");
  const { pending, error, run } = useRun(() => onClose());
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="sm" title="Decline this step?" description={task.title}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" loading={pending} onClick={() => run(() => completeTaskAction(task.id, { kind: "decide", decision: "declined", note }), "Declined. HR has been told.")}>Decline</Button></>}>
      <Field label="Why?" required error={error?.message}><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} autoFocus placeholder="What needs to change" /></Field>
    </Modal>
  );
}

function ReassignDialog({ task, people, onClose }: { task: TaskView; people: Person[]; onClose: () => void }) {
  const [ids, setIds] = React.useState<string[]>(task.assignee ? [task.assignee.id] : []);
  const { pending, error, run } = useRun(() => onClose());
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="sm" title="Hand this task to someone else" description={task.title}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!ids[0]} onClick={() => run(() => reassignTaskAction(task.id, ids[0]), "Task handed over")}>Save</Button></>}>
      {error && <Banner tone="danger" className="mb-3">{error.message}</Banner>}
      <Field label="New owner"><EmployeePicker people={people} value={ids} onChange={setIds} /></Field>
    </Modal>
  );
}
