"use client";
import * as React from "react";
import { ArrowDown, ArrowUp, ListChecks, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { Card, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Checkbox } from "@/ui/choice";
import { ConfirmDialog, Menu, Modal } from "@/ui/overlay";
import { Banner, EmptyState } from "@/ui/feedback";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { toast } from "@/ui/toast";
import {
  deleteOnboardingItemAction, deleteOnboardingTemplateAction, moveOnboardingItemAction, saveOnboardingItemAction, saveOnboardingTemplateAction,
} from "@/app/(app)/org/onboarding/actions";
import type { TemplateItemRow, TemplateRow } from "@/server/modules/onboarding/service";
import { DOC_CATEGORIES, PROFILE_FIELDS, TASK_TYPES, TASK_TYPE_LABEL, offsetLabel, ownerLabel, type Criteria, type TaskOwner, type TaskType } from "@/server/modules/onboarding/rules";

type Opt = { id: string; name: string };
export type Lookups = { departments: Opt[]; locations: Opt[]; designations: Opt[]; legal_entities: Opt[]; roles: { key: string; name: string }[]; people: Person[] };
const CRIT: { key: keyof Criteria; label: string; from: keyof Lookups }[] = [
  { key: "department_ids", label: "Departments", from: "departments" }, { key: "location_ids", label: "Locations", from: "locations" },
  { key: "designation_ids", label: "Designations", from: "designations" }, { key: "legal_entity_ids", label: "Legal entities", from: "legal_entities" },
];
const CATEGORY_LABEL: Record<string, string> = { identity: "Identity", education: "Education", experience: "Experience", other: "Other" };

/** Onboarding checklists: who each applies to (criteria) and its tasks (owner, due offset from joining, type). */
export function OnboardingTemplates({ templates, lookups, canEdit }: { templates: TemplateRow[]; lookups: Lookups; canEdit: boolean }) {
  const [editing, setEditing] = React.useState<TemplateRow | "new" | null>(null);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Onboarding tasks</h2>
          <p className="text-base text-text-muted">When onboarding starts, the most specific checklist that fits the person is used.</p>
        </div>
        {canEdit && <Button size="sm" onClick={() => setEditing("new")}><Plus />New checklist</Button>}
      </div>
      {!canEdit && <Banner tone="info">Only admins with company-wide onboarding access can change checklists.</Banner>}
      {templates.length === 0 ? <Card><EmptyState icon={<ListChecks />} title="No checklists yet" description={canEdit ? "Create one to start onboarding people." : undefined} /></Card>
        : templates.map((t) => <TemplateCard key={t.id} t={t} lookups={lookups} canEdit={canEdit} onEdit={() => setEditing(t)} canDelete={templates.length > 1} />)}
      {editing && <TemplateDialog t={editing === "new" ? null : editing} lookups={lookups} onClose={() => setEditing(null)} />}
    </div>
  );
}

function criteriaText(c: Criteria, l: Lookups) {
  const parts = CRIT.filter((k) => c[k.key]?.length).map((k) => (c[k.key] ?? []).map((id) => (l[k.from] as Opt[]).find((o) => o.id === id)?.name ?? "removed").join(", "));
  return parts.length ? parts.join(" · ") : "Everyone";
}

function TemplateCard({ t, lookups, canEdit, canDelete, onEdit }: { t: TemplateRow; lookups: Lookups; canEdit: boolean; canDelete: boolean; onEdit: () => void }) {
  const [item, setItem] = React.useState<TemplateItemRow | "new" | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [pending, start] = React.useTransition();
  const move = (id: string, dir: "up" | "down") => start(async () => { const r = await moveOnboardingItemAction(id, dir); if (!r.ok) toast.error(r.error); });
  return (
    <Card>
      <CardHeader title={t.name} description={<>Applies to: {criteriaText(t.criteria, lookups)}{t.in_use ? ` · running for ${t.in_use} ${t.in_use === 1 ? "person" : "people"}` : ""}</>}
        action={canEdit ? (
          <div className="flex gap-1">
            <Button size="sm" variant="secondary" onClick={() => setItem("new")}><Plus />Task</Button>
            <Menu trigger={<IconButton size="icon-sm" label={`Actions for ${t.name}`}><MoreHorizontal /></IconButton>}
              items={[{ label: "Edit name and criteria", icon: <Pencil />, onSelect: onEdit }, "separator", { label: "Delete", icon: <Trash2 />, danger: true, disabled: !canDelete, onSelect: () => setDeleting(true) }]} />
          </div>
        ) : undefined} />
      {t.items.length === 0 ? <EmptyState compact title="No tasks yet" description={canEdit ? "Add the first task." : undefined} /> : (
        <ol className="divide-y divide-border border-t border-border" aria-busy={pending || undefined}>
          {t.items.map((it, i) => (
            <li key={it.id} className="flex items-start gap-3 px-5 py-3">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-pill bg-surface-hover text-sm tabular">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-base font-medium">{it.title}<Badge>{TASK_TYPE_LABEL[it.type]}</Badge></p>
                {it.description && <p className="text-sm text-text-muted">{it.description}</p>}
                <p className="mt-0.5 text-sm text-text-muted">Owner: {it.owner.type === "employee" ? it.owner_name ?? "someone who left" : roleName(it.owner, lookups)} · {offsetLabel(it.due_offset_days)}
                  {it.type === "profile_field" && it.config.field ? ` · ${PROFILE_FIELDS[it.config.field]?.label}` : ""}{it.type === "document_upload" && it.config.docType ? ` · ${it.config.docType}` : ""}</p>
              </div>
              {canEdit && (
                <Menu trigger={<IconButton size="icon-sm" label={`Actions for ${it.title}`}><MoreHorizontal /></IconButton>}
                  items={[
                    { label: "Edit", icon: <Pencil />, onSelect: () => setItem(it) },
                    { label: "Move up", icon: <ArrowUp />, disabled: i === 0, onSelect: () => move(it.id, "up") },
                    { label: "Move down", icon: <ArrowDown />, disabled: i === t.items.length - 1, onSelect: () => move(it.id, "down") },
                    "separator",
                    { label: "Delete", icon: <Trash2 />, danger: true, onSelect: async () => { const r = await deleteOnboardingItemAction(it.id); if (r.ok) toast.success("Task removed"); else toast.error(r.error); } },
                  ]} />
              )}
            </li>
          ))}
        </ol>
      )}
      {item && <ItemDialog templateId={t.id} item={item === "new" ? null : item} lookups={lookups} onClose={() => setItem(null)} />}
      {deleting && (
        <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(false)} title={`Delete ${t.name}?`} description="Onboarding already running keeps its tasks. This can't be undone." confirmLabel="Delete"
          onConfirm={async () => { const r = await deleteOnboardingTemplateAction(t.id); if (r.ok) toast.success("Checklist deleted"); else toast.error(r.error); setDeleting(false); }} />
      )}
    </Card>
  );
}

const roleName = (o: TaskOwner, l: Lookups) => (o.type === "role" ? l.roles.find((r) => r.key === o.role)?.name ?? ownerLabel(o) : ownerLabel(o));

function TemplateDialog({ t, lookups, onClose }: { t: TemplateRow | null; lookups: Lookups; onClose: () => void }) {
  const [name, setName] = React.useState(t?.name ?? "");
  const [crit, setCrit] = React.useState<Criteria>(t?.criteria ?? {});
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const toggle = (k: keyof Criteria, id: string, on: boolean) => setCrit((c) => ({ ...c, [k]: on ? [...(c[k] ?? []), id] : (c[k] ?? []).filter((x) => x !== id) }));
  const save = () => start(async () => {
    const r = await saveOnboardingTemplateAction(t?.id ?? null, { name, criteria: crit });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success(t ? "Checklist updated" : "Checklist created"); onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t ? "Edit checklist" : "New checklist"} description="Leave a criterion empty to include everyone."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>Save</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <Field label="Name" required error={error?.field === "name" ? error.message : undefined}><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. Engineering onboarding" autoFocus /></Field>
        {error?.field === "criteria" && <Banner tone="danger">{error.message}</Banner>}
        {CRIT.map((k) => {
          const opts = lookups[k.from] as Opt[];
          if (!opts.length) return null;
          return (
            <fieldset key={k.key} className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">{k.label} <span className="font-normal text-text-muted">({crit[k.key]?.length ? `${crit[k.key]!.length} picked` : "any"})</span></legend>
              <div className="grid max-h-36 grid-cols-1 gap-2 overflow-y-auto rounded-md border border-border p-3 sm:grid-cols-2">
                {opts.map((o) => <Checkbox key={o.id} label={o.name} checked={!!crit[k.key]?.includes(o.id)} onCheckedChange={(c) => toggle(k.key, o.id, !!c)} />)}
              </div>
            </fieldset>
          );
        })}
      </form>
    </Modal>
  );
}

function ownerValue(o: TaskOwner | undefined) {
  if (!o) return "self";
  return o.type === "role" ? `role:${o.role}` : o.type;
}

function ItemDialog({ templateId, item, lookups, onClose }: { templateId: string; item: TemplateItemRow | null; lookups: Lookups; onClose: () => void }) {
  const [title, setTitle] = React.useState(item?.title ?? "");
  const [description, setDescription] = React.useState(item?.description ?? "");
  const [type, setType] = React.useState<TaskType>(item?.type ?? "simple");
  const [owner, setOwner] = React.useState(ownerValue(item?.owner));
  const [person, setPerson] = React.useState<string[]>(item?.owner.type === "employee" ? [item.owner.id] : []);
  const [offset, setOffset] = React.useState(String(item?.due_offset_days ?? 0));
  const [field, setField] = React.useState<string>(item?.config.field ?? "personal_email");
  const [docType, setDocType] = React.useState(item?.config.docType ?? "");
  const [category, setCategory] = React.useState<string>(item?.config.category ?? "identity");
  const [ackText, setAckText] = React.useState(item?.config.ackText ?? "");
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const selfOnly = type === "profile_field" || type === "document_upload";
  const ownerOpts = [
    { value: "self", label: "New joiner", disabled: type === "approval" },
    { value: "manager", label: "Their manager", disabled: selfOnly },
    ...lookups.roles.map((r) => ({ value: `role:${r.key}`, label: `${r.name} (role)`, disabled: selfOnly })),
    { value: "employee", label: "A specific person", disabled: selfOnly },
  ];
  const save = () => start(async () => {
    const n = Number(offset);
    if (!Number.isInteger(n)) { setError({ message: "Use whole days.", field: "dueOffsetDays" }); return; }
    const o: TaskOwner = selfOnly ? { type: "self" } : owner.startsWith("role:") ? { type: "role", role: owner.slice(5) } : owner === "employee" ? { type: "employee", id: person[0] ?? "" } : owner === "manager" ? { type: "manager" } : { type: "self" };
    if (o.type === "employee" && !o.id) { setError({ message: "Pick a person.", field: "owner" }); return; }
    const r = await saveOnboardingItemAction(templateId, item?.id ?? null, {
      title, description: description || null, type, owner: o, dueOffsetDays: n,
      config: type === "profile_field" ? { field: field as keyof typeof PROFILE_FIELDS } : type === "document_upload" ? { docType, category: category as (typeof DOC_CATEGORIES)[number] } : type === "acknowledge" ? { ackText } : {},
    });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success(item ? "Task updated" : "Task added"); onClose();
  });
  const err = (f: string) => (error?.field === f ? error.message : undefined);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={item ? "Edit task" : "Add task"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>Save</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && !["title", "owner", "dueOffsetDays", "field", "docType", "category", "type"].includes(error.field ?? "") && <Banner tone="danger">{error.message}</Banner>}
        <Field label="Title" required error={err("title")}><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} autoFocus placeholder="e.g. Order a laptop" /></Field>
        <Field label="Details" help="Optional. Shown to the owner."><Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type" error={err("type")}>
            <Select value={type} onValueChange={(v) => { setType(v as TaskType); if (v === "profile_field" || v === "document_upload") setOwner("self"); if (v === "approval" && owner === "self") setOwner("manager"); }}
              options={TASK_TYPES.map((t) => ({ value: t, label: TASK_TYPE_LABEL[t] }))} />
          </Field>
          <Field label="Due" help="Days from joining; negative means before the first day." error={err("dueOffsetDays")}>
            <Input type="number" inputMode="numeric" min={-90} max={180} value={offset} onChange={(e) => setOffset(e.target.value)} />
          </Field>
        </div>
        <Field label="Owner" error={err("owner")} help={selfOnly ? "Only the new joiner can fill in their own details or upload their documents." : undefined}>
          <Select value={selfOnly ? "self" : owner} onValueChange={setOwner} options={ownerOpts} disabled={selfOnly} />
        </Field>
        {!selfOnly && owner === "employee" && <Field label="Person"><EmployeePicker people={lookups.people} value={person} onChange={setPerson} /></Field>}
        {type === "profile_field" && (
          <Field label="Profile detail" error={err("field")}><Select value={field} onValueChange={setField} options={Object.entries(PROFILE_FIELDS).map(([value, f]) => ({ value, label: f.label }))} /></Field>
        )}
        {type === "document_upload" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Document" required error={err("docType")}><Input value={docType} onChange={(e) => setDocType(e.target.value)} maxLength={80} placeholder="e.g. Aadhaar card" /></Field>
            <Field label="Category" error={err("category")}><Select value={category} onValueChange={setCategory} options={DOC_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))} /></Field>
          </div>
        )}
        {type === "acknowledge" && <Field label="Statement to acknowledge" help="Optional. Defaults to the title."><Textarea value={ackText} onChange={(e) => setAckText(e.target.value)} maxLength={4000} /></Field>}
        {type === "approval" && <p className="text-sm text-text-muted">The owner approves or declines. Declining needs a reason and tells HR.</p>}
      </form>
    </Modal>
  );
}
