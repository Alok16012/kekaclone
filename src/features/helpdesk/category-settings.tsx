"use client";
import * as React from "react";
import { LifeBuoy, MoreHorizontal, Pencil, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { Card, CardHeader } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Modal, ConfirmDialog, Menu } from "@/ui/overlay";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { deleteTicketCategoryAction, saveTicketCategoryAction } from "@/app/(app)/settings/helpdesk/actions";
import { formatMinutes, PRIORITIES, PRIORITY_LABEL, type Priority } from "@/server/modules/helpdesk/rules";
import { PriorityBadge } from "./bits";

export type CategorySetting = {
  id: string; name: string; priority: Priority; first_response_sla_mins: number | null; resolution_sla_mins: number | null;
  assignee_employee_ids: string[]; escalate_to_employee_id: string | null; escalate_to: string | null; agents: string[]; open_tickets: number; total_tickets: number;
};

/** Settings → Helpdesk: categories with their agents, priority, response and resolution targets and escalation contact. */
export function HelpdeskSettings({ categories, people, canEdit }: { categories: CategorySetting[]; people: Person[]; canEdit: boolean }) {
  const [editing, setEditing] = React.useState<CategorySetting | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<CategorySetting | null>(null);
  return (
    <div className="flex flex-col gap-4">
      {!canEdit && <Banner tone="info" title="View only">Only helpdesk admins for the whole company can change these categories.</Banner>}
      <Card>
        <CardHeader title="Helpdesk categories" description="New tickets go to the least busy agent of their category. Missed targets are escalated to the escalation contact."
          action={canEdit ? <Button size="sm" onClick={() => setEditing("new")}><Plus />Add category</Button> : undefined} />
        {categories.length === 0 ? (
          <EmptyState compact icon={<LifeBuoy />} title="No categories yet" description="Add one so people can raise tickets, e.g. IT support or HR questions." />
        ) : (
          <ul className="divide-y divide-border border-t border-border">
            {categories.map((c) => (
              <li key={c.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-base font-medium">{c.name}<PriorityBadge priority={c.priority} /></p>
                  <p className="mt-0.5 text-sm text-text-muted">First response {formatMinutes(c.first_response_sla_mins).toLowerCase()} · resolution {formatMinutes(c.resolution_sla_mins).toLowerCase()}</p>
                  <p className="mt-0.5 text-sm text-text-muted">{c.agents.length ? `Agents: ${c.agents.join(", ")}` : "No agents yet: helpdesk admins handle these tickets"}{c.escalate_to ? ` · escalates to ${c.escalate_to}` : ""}</p>
                </div>
                <div className="flex items-center gap-2 text-sm text-text-muted">
                  <span className="tabular">{c.open_tickets} open</span>
                  {canEdit && (
                    <Menu trigger={<IconButton size="icon-sm" label={`More for ${c.name}`}><MoreHorizontal /></IconButton>}
                      items={[{ label: "Edit", icon: <Pencil />, onSelect: () => setEditing(c) }, { label: "Delete", icon: <Trash2 />, danger: true, disabled: c.total_tickets > 0, onSelect: () => setDeleting(c) }]} />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <p className="flex items-start gap-2 text-sm text-text-muted"><ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />Run <code className="rounded bg-surface-sunken px-1">pnpm jobs:helpdesk</code> every 15 minutes to send escalations for missed targets. Each breach is escalated once.</p>
      {editing && <CategoryDialog key={editing === "new" ? "new" : editing.id} category={editing === "new" ? null : editing} people={people} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting?.name ?? "category"}?`} description="People won't be able to raise tickets in it any more." confirmLabel="Delete"
        onConfirm={async () => { if (!deleting) return; const r = await deleteTicketCategoryAction(deleting.id); if (r.ok) toast.success("Category deleted"); else toast.error(r.error); setDeleting(null); }} />
    </div>
  );
}

type Unit = "min" | "h" | "d";
const UNIT_MIN: Record<Unit, number> = { min: 1, h: 60, d: 1440 };
function split(m: number | null): { n: string; unit: Unit } {
  if (!m) return { n: "", unit: "h" };
  if (m % 1440 === 0) return { n: String(m / 1440), unit: "d" };
  if (m % 60 === 0) return { n: String(m / 60), unit: "h" };
  return { n: String(m), unit: "min" };
}

function Duration({ label, help, value, onChange, error }: { label: string; help: string; value: { n: string; unit: Unit }; onChange: (v: { n: string; unit: Unit }) => void; error?: string }) {
  return (
    <Field label={label} help={help} error={error}>
      <div className="flex gap-2">
        <Input type="number" min={1} inputMode="numeric" value={value.n} onChange={(e) => onChange({ ...value, n: e.target.value })} placeholder="No target" className="w-28" />
        <div className="w-32"><Select value={value.unit} onValueChange={(u) => onChange({ ...value, unit: u as Unit })} options={[{ value: "min", label: "minutes" }, { value: "h", label: "hours" }, { value: "d", label: "days" }]} /></div>
      </div>
    </Field>
  );
}

function CategoryDialog({ category, people, onClose }: { category: CategorySetting | null; people: Person[]; onClose: () => void }) {
  const [name, setName] = React.useState(category?.name ?? "");
  const [priority, setPriority] = React.useState<Priority>(category?.priority ?? "medium");
  const [first, setFirst] = React.useState(split(category?.first_response_sla_mins ?? 240));
  const [res, setRes] = React.useState(split(category?.resolution_sla_mins ?? 2880));
  const [agents, setAgents] = React.useState<string[]>(category?.assignee_employee_ids ?? []);
  const [esc, setEsc] = React.useState<string[]>(category?.escalate_to_employee_id ? [category.escalate_to_employee_id] : []);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, start] = React.useTransition();
  const toMins = (v: { n: string; unit: Unit }) => (v.n.trim() === "" ? null : Number(v.n) * UNIT_MIN[v.unit]);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const f = toMins(first), r = toMins(res);
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = "Give the category a name.";
    if (f != null && (!Number.isInteger(f) || f <= 0)) errs.firstResponseMins = "Use a whole number above zero.";
    if (r != null && (!Number.isInteger(r) || r <= 0)) errs.resolutionMins = "Use a whole number above zero.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    start(async () => {
      const out = await saveTicketCategoryAction(category?.id ?? null, { name, priority, firstResponseMins: f, resolutionMins: r, assigneeIds: agents, escalateToId: esc[0] ?? null });
      if (!out.ok) { setErrors({ [out.field ?? "form"]: out.error }); return; }
      toast.success(category ? "Category saved" : "Category added"); onClose();
    });
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={category ? `Edit ${category.name}` : "Add a category"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="ticket-category" loading={busy}>Save</Button></>}>
      <form id="ticket-category" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {errors.form && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{errors.form}</p>}
        <Field label="Name" required error={errors.name}><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. IT support" /></Field>
        <Field label="Priority" help="New tickets in this category get this priority.">
          <Select value={priority} onValueChange={(v) => setPriority(v as Priority)} options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Duration label="First response within" help="Leave empty for no target." value={first} onChange={setFirst} error={errors.firstResponseMins} />
          <Duration label="Resolve within" help="Counted from when the ticket is raised." value={res} onChange={setRes} error={errors.resolutionMins} />
        </div>
        <Field label="Agents" help="They see this category's tickets and get new ones assigned." error={errors.assigneeIds}>
          <EmployeePicker people={people} value={agents} onChange={setAgents} multiple placeholder="Add agents" />
        </Field>
        <Field label="Escalate missed targets to" help="Optional. Usually a team lead. They can also see these tickets.">
          <EmployeePicker people={people} value={esc} onChange={(v) => setEsc(v.slice(-1))} placeholder="Pick a person" />
        </Field>
        {esc.length > 0 && <Button variant="ghost" size="sm" className="self-start" onClick={() => setEsc([])}>Remove escalation contact</Button>}
      </form>
    </Modal>
  );
}
