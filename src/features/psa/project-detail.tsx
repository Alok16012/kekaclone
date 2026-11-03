"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, Circle, ListChecks, MoreHorizontal, Pencil, Plus, Trash2, UserPlus, Users } from "lucide-react";
import { Card, CardHeader, StatTile } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Avatar } from "@/ui/avatar";
import { Modal, ConfirmDialog, Menu } from "@/ui/overlay";
import { Field, Input, MoneyInput } from "@/ui/field";
import { Select } from "@/ui/select";
import { Checkbox } from "@/ui/choice";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { deleteMilestoneAction, deleteTaskAction, removeMemberAction, saveMemberAction, saveMilestoneAction, saveTaskAction, setProjectStatusAction } from "@/app/(app)/psa/actions";
import { BILLING_LABEL, formatINR, formatMinutes, PROJECT_STATUS_LABEL, PROJECT_STATUSES, type ProjectStatus } from "@/server/modules/psa/rules";
import { ProjectDialog, type ProjectCard, type ProjectForm } from "./projects";

export type Detail = {
  project: ProjectCard & { description: string | null; approver_employee_ids: string[]; approvers: { id: string; name: string }[]; invoiced_paise: number };
  members: { employee_id: string; name: string; title: string | null; role: string | null; bill_rate_paise: number | null; allocation_pct: number | null; logged_minutes: number }[];
  tasks: { id: string; name: string; is_billable: boolean; phase: string | null; start_date: string | null; end_date: string | null; logged_minutes: number }[];
  milestones: { id: string; name: string; phase: string | null; due_date: string | null; amount_paise: number; status: "planned" | "done"; done_at: string | null; invoice_id: string | null; invoice_number: string | null }[];
  canEdit: boolean; canBill: boolean;
};
const TONE: Record<ProjectStatus, "success" | "warning" | "neutral" | "accent"> = { active: "success", on_hold: "warning", completed: "accent", archived: "neutral" };
const fmt = (d: string | null) => (d ? new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "–");

/** S130 detail: billing model, team with bill rates and allocation, tasks by phase, milestones, approvers. */
export function ProjectDetail({ d, clients, people }: { d: Detail; clients: { id: string; name: string }[]; people: Person[] }) {
  const p = d.project;
  const [editing, setEditing] = React.useState(false);
  const [member, setMember] = React.useState<Detail["members"][number] | "new" | null>(null);
  const [task, setTask] = React.useState<Detail["tasks"][number] | "new" | null>(null);
  const [milestone, setMilestone] = React.useState<Detail["milestones"][number] | "new" | null>(null);
  const [confirm, setConfirm] = React.useState<{ title: string; description: string; run: () => Promise<{ ok: boolean; error?: string }> } | null>(null);
  const [busy, start] = React.useTransition();
  const form: ProjectForm = { id: p.id, name: p.name, code: p.code, clientId: p.client_id, billingModel: p.billing_model, retainerPaise: p.retainer_paise, currency: p.currency, startDate: p.start_date, endDate: p.end_date, description: p.description, approverIds: p.approver_employee_ids, budgetMinutes: p.budget_minutes };
  const setStatus = (s: ProjectStatus) => start(async () => { const r = await setProjectStatusAction(p.id, s); if (r.ok) toast.success(`Project ${PROJECT_STATUS_LABEL[s].toLowerCase()}`); else toast.error(r.error); });
  const phases = [...new Set(d.tasks.map((t) => t.phase ?? ""))];
  const milestoneTotal = d.milestones.reduce((t, m) => t + m.amount_paise, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm"><Link href="/psa/projects"><ArrowLeft />All projects</Link></Button>
        <div className="ml-auto flex gap-2">
          {d.canBill && p.billing_model !== "non_billable" && <Button asChild variant="secondary" size="sm"><Link href={`/psa/billing?project=${p.id}`}>Invoice</Link></Button>}
          {d.canEdit && <Button variant="secondary" size="sm" onClick={() => setEditing(true)}><Pencil />Edit</Button>}
          {d.canEdit && <Menu trigger={<IconButton size="icon-sm" label="Change status"><MoreHorizontal /></IconButton>} items={PROJECT_STATUSES.filter((s) => s !== p.status).map((s) => ({ label: `Mark ${PROJECT_STATUS_LABEL[s].toLowerCase()}`, onSelect: () => setStatus(s) }))} />}
        </div>
      </div>
      <Card className="p-5">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">{p.name}<Badge tone={TONE[p.status]}>{PROJECT_STATUS_LABEL[p.status]}</Badge></h2>
            <p className="mt-0.5 text-sm text-text-muted">{p.code}{p.client ? ` · ${p.client}` : " · Internal"} · {BILLING_LABEL[p.billing_model]}{p.billing_model === "retainer" && p.retainer_paise ? ` ${formatINR(p.retainer_paise)}/month` : ""}</p>
            {p.description && <p className="mt-3 max-w-prose text-base">{p.description}</p>}
          </div>
        </div>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-4">
          <div><dt className="text-text-muted">Dates</dt><dd className="font-medium">{fmt(p.start_date)} – {fmt(p.end_date)}</dd></div>
          <div><dt className="text-text-muted">Approvers</dt><dd className="font-medium">{p.approvers.length ? p.approvers.map((a) => a.name).join(", ") : "Each person's manager"}</dd></div>
          <div><dt className="text-text-muted">Budget</dt><dd className="font-medium tabular">{p.budget_minutes ? formatMinutes(p.budget_minutes) : "No limit"}</dd></div>
          <div><dt className="text-text-muted">Invoiced so far</dt><dd className="font-medium tabular">{formatINR(p.invoiced_paise)}</dd></div>
        </dl>
      </Card>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Team" value={d.members.length} icon={<Users />} />
        <StatTile label="Hours logged" value={formatMinutes(p.logged_minutes)} hint={`${formatMinutes(p.approved_minutes)} approved`} />
        <StatTile label="To invoice" value={p.billing_model === "time_and_materials" ? formatMinutes(p.uninvoiced_minutes) : p.billing_model === "fixed" ? formatINR(d.milestones.filter((m) => m.status === "done" && !m.invoice_id).reduce((t, m) => t + m.amount_paise, 0)) : "–"} hint={p.billing_model === "time_and_materials" ? "approved billable hours" : p.billing_model === "fixed" ? "milestones done" : BILLING_LABEL[p.billing_model]} />
        <StatTile label="Tasks" value={d.tasks.length} icon={<ListChecks />} hint={`${d.tasks.filter((t) => t.is_billable).length} billable`} />
      </div>

      <Tabs defaultValue="team">
        <TabsList items={[{ value: "team", label: "Team", count: d.members.length }, { value: "tasks", label: "Tasks", count: d.tasks.length }, { value: "milestones", label: "Milestones", count: d.milestones.length }]} />
        <TabsContent value="team">
          <Card>
            <CardHeader title="Team" description="Bill rates are per hour and drive T&M invoices. Allocation is how much of their week this project takes." action={d.canEdit ? <Button size="sm" onClick={() => setMember("new")}><UserPlus />Add person</Button> : undefined} />
            {d.members.length === 0 ? <EmptyState compact icon={<Users />} title="Nobody on this project yet" description="Add people so they can log hours against it." /> : (
              <ul className="divide-y divide-border border-t border-border">
                {d.members.map((m) => (
                  <li key={m.employee_id} className="flex items-center gap-3 px-5 py-3">
                    <Avatar name={m.name} size="sm" />
                    <div className="min-w-0 flex-1"><p className="truncate text-base font-medium">{m.name}</p><p className="text-sm text-text-muted">{[m.role, m.title].filter(Boolean).join(" · ") || "Member"}</p></div>
                    <div className="hidden text-right text-sm sm:block"><p className="tabular">{m.bill_rate_paise != null ? `${formatINR(m.bill_rate_paise)}/h` : <span className="text-warning-text">No rate</span>}</p><p className="text-text-muted">{m.allocation_pct != null ? `${m.allocation_pct}% allocated` : "–"}</p></div>
                    <span className="w-16 text-right text-sm tabular text-text-muted">{formatMinutes(m.logged_minutes)}</span>
                    {d.canEdit && <Menu trigger={<IconButton size="icon-sm" label={`More for ${m.name}`}><MoreHorizontal /></IconButton>}
                      items={[{ label: "Edit", icon: <Pencil />, onSelect: () => setMember(m) }, { label: "Remove", icon: <Trash2 />, danger: true, disabled: m.logged_minutes > 0, onSelect: () => setConfirm({ title: `Remove ${m.name}?`, description: "They won't be able to log hours on this project.", run: () => removeMemberAction(p.id, m.employee_id) }) }]} />}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </TabsContent>
        <TabsContent value="tasks">
          <Card>
            <CardHeader title="Tasks" description="What people pick on their timesheet. Group them by phase; mark internal ones not billable." action={d.canEdit ? <Button size="sm" onClick={() => setTask("new")}><Plus />Add task</Button> : undefined} />
            {d.tasks.length === 0 ? <EmptyState compact icon={<ListChecks />} title="No tasks yet" description="Without tasks, hours are logged against the project as a whole." /> : (
              <div className="border-t border-border">
                {phases.map((ph) => (
                  <div key={ph}>
                    {phases.length > 1 && <p className="bg-surface-sunken px-5 py-1.5 text-xs font-medium uppercase tracking-wide text-text-muted">{ph || "No phase"}</p>}
                    <ul className="divide-y divide-border">
                      {d.tasks.filter((t) => (t.phase ?? "") === ph).map((t) => (
                        <li key={t.id} className="flex items-center gap-3 px-5 py-3">
                          <div className="min-w-0 flex-1"><p className="flex flex-wrap items-center gap-2 text-base font-medium">{t.name}{!t.is_billable && <Badge tone="neutral">Not billable</Badge>}</p><p className="text-sm text-text-muted">{t.start_date || t.end_date ? `${fmt(t.start_date)} – ${fmt(t.end_date)}` : "No dates"}</p></div>
                          <span className="text-sm tabular text-text-muted">{formatMinutes(t.logged_minutes)}</span>
                          {d.canEdit && <Menu trigger={<IconButton size="icon-sm" label={`More for ${t.name}`}><MoreHorizontal /></IconButton>}
                            items={[{ label: "Edit", icon: <Pencil />, onSelect: () => setTask(t) }, { label: "Delete", icon: <Trash2 />, danger: true, disabled: t.logged_minutes > 0, onSelect: () => setConfirm({ title: `Delete ${t.name}?`, description: "Only tasks without logged hours can be deleted.", run: () => deleteTaskAction(p.id, t.id) }) }]} />}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </TabsContent>
        <TabsContent value="milestones">
          <Card>
            <CardHeader title="Milestones" description={p.billing_model === "fixed" ? `Fixed-price work is invoiced per milestone once it's done. Total ${formatINR(milestoneTotal)}.` : "Key dates for the project; amounts only matter for fixed-price projects."} action={d.canEdit ? <Button size="sm" onClick={() => setMilestone("new")}><Plus />Add milestone</Button> : undefined} />
            {d.milestones.length === 0 ? <EmptyState compact icon={<CheckCircle2 />} title="No milestones yet" /> : (
              <ul className="divide-y divide-border border-t border-border">
                {d.milestones.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 px-5 py-3">
                    {m.status === "done" ? <CheckCircle2 className="size-5 text-success-text" aria-label="Done" /> : <Circle className="size-5 text-text-muted" aria-label="Planned" />}
                    <div className="min-w-0 flex-1"><p className="text-base font-medium">{m.name}</p><p className="text-sm text-text-muted">{[m.phase, m.due_date ? `due ${fmt(m.due_date)}` : null, m.done_at ? `done ${fmt(m.done_at)}` : null].filter(Boolean).join(" · ")}</p></div>
                    <div className="text-right text-sm"><p className="font-medium tabular">{m.amount_paise ? formatINR(m.amount_paise) : "–"}</p>{m.invoice_number && <p className="text-text-muted">{m.invoice_number}</p>}</div>
                    {d.canEdit && !m.invoice_id && <Menu trigger={<IconButton size="icon-sm" label={`More for ${m.name}`}><MoreHorizontal /></IconButton>}
                      items={[{ label: "Edit", icon: <Pencil />, onSelect: () => setMilestone(m) }, { label: m.status === "done" ? "Mark planned" : "Mark done", icon: <CheckCircle2 />, onSelect: () => start(async () => { const r = await saveMilestoneAction(p.id, m.id, { name: m.name, phase: m.phase, dueDate: m.due_date, amountPaise: m.amount_paise, status: m.status === "done" ? "planned" : "done" }); if (!r.ok) toast.error(r.error); }) },
                        { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setConfirm({ title: `Delete ${m.name}?`, description: "This can't be undone.", run: () => deleteMilestoneAction(p.id, m.id) }) }]} />}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </TabsContent>
      </Tabs>

      {editing && <ProjectDialog project={form} clients={clients} people={people} onClose={() => setEditing(false)} />}
      {member && <MemberDialog key={member === "new" ? "new" : member.employee_id} projectId={p.id} member={member === "new" ? null : member} people={people.filter((x) => member !== "new" || !d.members.some((m) => m.employee_id === x.id))} billable={p.billing_model !== "non_billable"} onClose={() => setMember(null)} />}
      {task && <TaskDialog key={task === "new" ? "new" : task.id} projectId={p.id} task={task === "new" ? null : task} billable={p.billing_model !== "non_billable"} onClose={() => setTask(null)} />}
      {milestone && <MilestoneDialog key={milestone === "new" ? "new" : milestone.id} projectId={p.id} milestone={milestone === "new" ? null : milestone} onClose={() => setMilestone(null)} />}
      <ConfirmDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)} title={confirm?.title ?? ""} description={confirm?.description ?? ""} confirmLabel="Confirm"
        onConfirm={async () => { if (!confirm) return; const r = await confirm.run(); if (r.ok) toast.success("Done"); else toast.error(r.error ?? "Something went wrong."); setConfirm(null); }} />
      {busy && <span className="sr-only" aria-live="polite">Saving…</span>}
    </div>
  );
}

function MemberDialog({ projectId, member, people, billable, onClose }: { projectId: string; member: Detail["members"][number] | null; people: Person[]; billable: boolean; onClose: () => void }) {
  const [ids, setIds] = React.useState<string[]>(member ? [member.employee_id] : []);
  const [role, setRole] = React.useState(member?.role ?? "");
  const [rate, setRate] = React.useState<number | null>(member?.bill_rate_paise ?? null);
  const [alloc, setAlloc] = React.useState(member?.allocation_pct == null ? "" : String(member.allocation_pct));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, start] = React.useTransition();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ids[0]) { setErrors({ employeeId: "Pick a person." }); return; }
    start(async () => {
      const r = await saveMemberAction(projectId, { employeeId: ids[0], role: role || null, billRatePaise: billable ? rate : null, allocationPct: alloc === "" ? null : Number(alloc) });
      if (!r.ok) { setErrors({ [r.field ?? "form"]: r.error }); return; }
      toast.success(member ? "Saved" : "Added to the project"); onClose();
    });
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={member ? `Edit ${member.name}` : "Add someone to the project"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="member-form" loading={busy}>Save</Button></>}>
      <form id="member-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {errors.form && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{errors.form}</p>}
        {!member && <Field label="Person" required error={errors.employeeId}><EmployeePicker people={people} value={ids} onChange={setIds} /></Field>}
        <Field label="Role on the project"><Input value={role} onChange={(e) => setRole(e.target.value)} maxLength={80} placeholder="e.g. Backend engineer" /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          {billable && <Field label="Bill rate per hour" help="Used for T&M invoices" error={errors.billRatePaise}><MoneyInput valuePaise={rate} onChangePaise={setRate} /></Field>}
          <Field label="Allocation %" error={errors.allocationPct}><Input type="number" min={0} max={100} inputMode="numeric" value={alloc} onChange={(e) => setAlloc(e.target.value)} /></Field>
        </div>
      </form>
    </Modal>
  );
}

function TaskDialog({ projectId, task, billable, onClose }: { projectId: string; task: Detail["tasks"][number] | null; billable: boolean; onClose: () => void }) {
  const [f, setF] = React.useState({ name: task?.name ?? "", isBillable: task?.is_billable ?? billable, phase: task?.phase ?? "", startDate: task?.start_date ?? "", endDate: task?.end_date ?? "" });
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, start] = React.useTransition();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.name.trim()) { setErrors({ name: "Give the task a name." }); return; }
    start(async () => {
      const r = await saveTaskAction(projectId, task?.id ?? null, { name: f.name, isBillable: f.isBillable, phase: f.phase || null, startDate: f.startDate || null, endDate: f.endDate || null });
      if (!r.ok) { setErrors({ [r.field ?? "form"]: r.error }); return; }
      toast.success(task ? "Task saved" : "Task added"); onClose();
    });
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={task ? `Edit ${task.name}` : "Add a task"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="task-form" loading={busy}>Save</Button></>}>
      <form id="task-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {errors.form && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{errors.form}</p>}
        <Field label="Name" required error={errors.name}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={120} /></Field>
        <Field label="Phase" help="Optional grouping, e.g. Discovery, Build, Launch"><Input value={f.phase} onChange={(e) => setF({ ...f, phase: e.target.value })} maxLength={80} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Start"><Input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
          <Field label="End" error={errors.endDate}><Input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
        </div>
        {billable && <Checkbox label="Hours on this task are billable" checked={f.isBillable} onCheckedChange={(c) => setF({ ...f, isBillable: !!c })} />}
      </form>
    </Modal>
  );
}

function MilestoneDialog({ projectId, milestone, onClose }: { projectId: string; milestone: Detail["milestones"][number] | null; onClose: () => void }) {
  const [f, setF] = React.useState({ name: milestone?.name ?? "", phase: milestone?.phase ?? "", dueDate: milestone?.due_date ?? "", amountPaise: milestone?.amount_paise ?? 0, status: milestone?.status ?? "planned" });
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, start] = React.useTransition();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.name.trim()) { setErrors({ name: "Give the milestone a name." }); return; }
    start(async () => {
      const r = await saveMilestoneAction(projectId, milestone?.id ?? null, { name: f.name, phase: f.phase || null, dueDate: f.dueDate || null, amountPaise: f.amountPaise, status: f.status });
      if (!r.ok) { setErrors({ [r.field ?? "form"]: r.error }); return; }
      toast.success(milestone ? "Milestone saved" : "Milestone added"); onClose();
    });
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={milestone ? `Edit ${milestone.name}` : "Add a milestone"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="ms-form" loading={busy}>Save</Button></>}>
      <form id="ms-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {errors.form && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{errors.form}</p>}
        <Field label="Name" required error={errors.name}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={120} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Phase"><Input value={f.phase} onChange={(e) => setF({ ...f, phase: e.target.value })} maxLength={80} /></Field>
          <Field label="Due"><Input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount" help="Invoiced when the milestone is done" error={errors.amountPaise}><MoneyInput valuePaise={f.amountPaise} onChangePaise={(p) => setF({ ...f, amountPaise: p ?? 0 })} /></Field>
          <Field label="Status"><Select value={f.status} onValueChange={(v) => setF({ ...f, status: v as "planned" | "done" })} options={[{ value: "planned", label: "Planned" }, { value: "done", label: "Done" }]} /></Field>
        </div>
      </form>
    </Modal>
  );
}
