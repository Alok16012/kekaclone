"use client";
import * as React from "react";
import { Archive, MoreHorizontal, Pencil, Plus, Send, Trash2, RotateCcw, ListPlus } from "lucide-react";
import { Button, IconButton } from "@/ui/button";
import { Card, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Checkbox, Switch } from "@/ui/choice";
import { Menu, Modal } from "@/ui/overlay";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { deleteFieldDefAction, saveFieldDefAction, setFieldStatusAction } from "@/app/(app)/corehr/actions";
import { CUSTOM_FIELD_TYPES, CUSTOM_FIELD_TYPE_LABELS, FIELD_ROLES, FIELD_ROLE_LABELS, type CustomFieldDef } from "@/server/modules/corehr/rules";

/** Company-defined profile fields: draft → published (shown on profiles, in the add wizard and Excel) → archived. */
export function CustomFieldsSettings({ defs }: { defs: CustomFieldDef[] }) {
  const [editing, setEditing] = React.useState<CustomFieldDef | "new" | null>(null);
  const sections = [...new Set(defs.map((d) => d.section))];
  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) => { const r = await fn(); if (r.ok) toast.success(ok); else toast.error(r.error); };
  return (
    <Card>
      <CardHeader title="Custom fields" description="Extra details your company keeps about people, grouped into sections on the Profile tab. Publish a field to start using it."
        action={<Button size="sm" onClick={() => setEditing("new")}><Plus />Add field</Button>} />
      {defs.length === 0 ? <EmptyState icon={<ListPlus />} title="No custom fields yet" description="For example a T-shirt size, a cost centre or an emergency contact." action={<Button onClick={() => setEditing("new")}><Plus />Add field</Button>} /> : (
        <div className="border-t border-border">
          {sections.map((s) => (
            <section key={s} className="border-b border-border last:border-0">
              <h4 className="bg-surface-sunken px-5 py-2 text-sm font-semibold">{s}</h4>
              <ul className="divide-y divide-border">
                {defs.filter((d) => d.section === s).map((d) => (
                  <li key={d.id} className="flex items-center gap-3 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-base font-medium">{d.label}
                        <Badge tone={d.status === "published" ? "success" : d.status === "draft" ? "warning" : "neutral"}>{d.status === "published" ? "Published" : d.status === "draft" ? "Draft" : "Archived"}</Badge>
                        {d.required && <Badge>Required</Badge>}
                      </p>
                      <p className="text-sm text-text-muted">{CUSTOM_FIELD_TYPE_LABELS[d.type]}{d.options?.length ? ` · ${d.options.join(", ")}` : ""} · edited by {d.edit_roles.map((r) => FIELD_ROLE_LABELS[r as keyof typeof FIELD_ROLE_LABELS] ?? r).join(", ")}</p>
                    </div>
                    <Menu trigger={<IconButton label={`Actions for ${d.label}`} size="icon-sm"><MoreHorizontal /></IconButton>} items={[
                      { label: "Edit", icon: <Pencil />, onSelect: () => setEditing(d) },
                      ...(d.status === "draft" ? [{ label: "Publish", icon: <Send />, onSelect: () => act(() => setFieldStatusAction(d.id, "published"), `${d.label} published`) }, { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => act(() => deleteFieldDefAction(d.id), "Field deleted") }] : []),
                      ...(d.status === "published" ? [{ label: "Archive", icon: <Archive />, onSelect: () => act(() => setFieldStatusAction(d.id, "archived"), `${d.label} archived`) }] : []),
                      ...(d.status === "archived" ? [{ label: "Publish again", icon: <RotateCcw />, onSelect: () => act(() => setFieldStatusAction(d.id, "published"), `${d.label} published`) }] : []),
                    ]} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {editing && <FieldDialog d={editing === "new" ? null : editing} sections={sections} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function FieldDialog({ d, sections, onClose }: { d: CustomFieldDef | null; sections: string[]; onClose: () => void }) {
  const [v, setV] = React.useState({ label: d?.label ?? "", section: d?.section ?? sections[0] ?? "Other details", type: d?.type ?? "text", options: (d?.options ?? []).join("\n"), required: d?.required ?? false });
  const [view, setView] = React.useState<string[]>(d?.view_roles ?? ["employee", "manager", "hr_admin"]);
  const [edit, setEdit] = React.useState<string[]>(d?.edit_roles ?? ["hr_admin"]);
  const [pending, start] = React.useTransition();
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const toggle = (list: string[], set: (x: string[]) => void, r: string, on: boolean) => set(on ? [...new Set([...list, r])] : list.filter((x) => x !== r));
  const choice = v.type === "select" || v.type === "multi_select";
  const submit = () => start(async () => {
    const r = await saveFieldDefAction(d?.id ?? null, { label: v.label, section: v.section, type: v.type as CustomFieldDef["type"], options: choice ? v.options.split("\n") : null, required: v.required, viewRoles: view, editRoles: edit });
    if (!r.ok) { setError({ message: r.error, field: "field" in r ? r.field : undefined }); return; }
    toast.success(d ? "Field saved" : "Field added as a draft", { description: d ? undefined : "Publish it when you're ready." });
    onClose();
  });
  const err = (f: string) => (error?.field === f ? error.message : undefined);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={d ? `Edit ${d.label}` : "New custom field"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={submit}>Save</Button></>}>
      <div className="flex flex-col gap-4">
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Label" required error={err("label")}><Input value={v.label} onChange={(e) => setV((s) => ({ ...s, label: e.target.value }))} placeholder="T-shirt size" /></Field>
          <Field label="Section" required help="New name = new section" error={err("section")}><Input value={v.section} onChange={(e) => setV((s) => ({ ...s, section: e.target.value }))} list="cf-sections" /></Field>
          <datalist id="cf-sections">{sections.map((s) => <option key={s} value={s} />)}</datalist>
          <Field label="Type" help={d && d.status !== "draft" ? "Fixed once published" : undefined} error={err("type")}>
            <Select value={v.type} disabled={!!d && d.status !== "draft"} onValueChange={(x) => setV((s) => ({ ...s, type: x as CustomFieldDef["type"] }))} options={CUSTOM_FIELD_TYPES.map((t) => ({ value: t, label: CUSTOM_FIELD_TYPE_LABELS[t] }))} />
          </Field>
          <div className="flex items-end pb-2"><Switch label="Required" checked={v.required} onCheckedChange={(c) => setV((s) => ({ ...s, required: !!c }))} /></div>
        </div>
        {choice && <Field label="Options" help="One per line" error={err("options")}><Textarea rows={4} value={v.options} onChange={(e) => setV((s) => ({ ...s, options: e.target.value }))} placeholder={"S\nM\nL"} /></Field>}
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <div><legend className="mb-2 text-sm font-medium">Who can see it</legend>{FIELD_ROLES.map((r) => <Checkbox key={r} label={FIELD_ROLE_LABELS[r]} checked={r === "hr_admin" || view.includes(r) || edit.includes(r)} disabled={r === "hr_admin" || edit.includes(r)} onCheckedChange={(c) => toggle(view, setView, r, !!c)} />)}</div>
          <div><legend className="mb-2 text-sm font-medium">Who can edit it</legend>{FIELD_ROLES.map((r) => <Checkbox key={r} label={FIELD_ROLE_LABELS[r]} checked={r === "hr_admin" || edit.includes(r)} disabled={r === "hr_admin"} onCheckedChange={(c) => toggle(edit, setEdit, r, !!c)} />)}</div>
        </fieldset>
      </div>
    </Modal>
  );
}
