"use client";
import * as React from "react";
import { Building2, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { Card, CardHeader } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Modal, ConfirmDialog, Menu } from "@/ui/overlay";
import { Field, Input } from "@/ui/field";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { deleteClientAction, saveClientAction } from "@/app/(app)/psa/actions";
import type { ClientRow } from "@/server/modules/psa/service";

/** S129: clients you bill. Name, GSTIN and billing address go on invoices. */
export function Clients({ clients, canEdit }: { clients: ClientRow[]; canEdit: boolean }) {
  const [editing, setEditing] = React.useState<ClientRow | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<ClientRow | null>(null);
  return (
    <div className="flex flex-col gap-4">
      {!canEdit && <Banner tone="info" title="View only">Only project admins for the whole company can add or change clients.</Banner>}
      <Card>
        <CardHeader title="Clients" description="Who you bill. The GSTIN and address print on invoices." action={canEdit ? <Button size="sm" onClick={() => setEditing("new")}><Plus />Add client</Button> : undefined} />
        {clients.length === 0 ? (
          <EmptyState compact icon={<Building2 />} title="No clients yet" description="Add the companies you do project work for, then create projects under them." />
        ) : (
          <ul className="divide-y divide-border border-t border-border">
            {clients.map((c) => (
              <li key={c.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1">
                  <p className="text-base font-medium">{c.name}</p>
                  <p className="mt-0.5 text-sm text-text-muted">{[c.gstin ? `GSTIN ${c.gstin}` : "No GSTIN", c.billing_address.city, c.currency].filter(Boolean).join(" · ")}</p>
                </div>
                <div className="flex items-center gap-3 text-sm text-text-muted">
                  <span className="tabular">{c.projects} {c.projects === 1 ? "project" : "projects"}</span>
                  <span className="tabular">{c.open_invoices} open {c.open_invoices === 1 ? "invoice" : "invoices"}</span>
                  {canEdit && <Menu trigger={<IconButton size="icon-sm" label={`More for ${c.name}`}><MoreHorizontal /></IconButton>}
                    items={[{ label: "Edit", icon: <Pencil />, onSelect: () => setEditing(c) }, { label: "Delete", icon: <Trash2 />, danger: true, disabled: c.projects > 0 || c.open_invoices > 0, onSelect: () => setDeleting(c) }]} />}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {editing && <ClientDialog key={editing === "new" ? "new" : editing.id} client={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting?.name ?? "client"}?`} description="This only works for clients without projects or invoices." confirmLabel="Delete"
        onConfirm={async () => { if (!deleting) return; const r = await deleteClientAction(deleting.id); if (r.ok) toast.success("Client deleted"); else toast.error(r.error); setDeleting(null); }} />
    </div>
  );
}

function ClientDialog({ client, onClose }: { client: ClientRow | null; onClose: () => void }) {
  const a = client?.billing_address ?? {};
  const [f, setF] = React.useState({ name: client?.name ?? "", gstin: client?.gstin ?? "", currency: client?.currency ?? "INR", line1: a.line1 ?? "", line2: a.line2 ?? "", city: a.city ?? "", state: a.state ?? "", pincode: a.pincode ?? "", email: a.email ?? "" });
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, start] = React.useTransition();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.name.trim()) { setErrors({ name: "Give the client a name." }); return; }
    start(async () => {
      const r = await saveClientAction(client?.id ?? null, { name: f.name, gstin: f.gstin || null, currency: f.currency.toUpperCase(), address: { line1: f.line1, line2: f.line2, city: f.city, state: f.state, pincode: f.pincode, email: f.email } });
      if (!r.ok) { setErrors({ [r.field ?? "form"]: r.error }); return; }
      toast.success(client ? "Client saved" : "Client added"); onClose();
    });
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={client ? `Edit ${client.name}` : "Add a client"} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="client-form" loading={busy}>Save</Button></>}>
      <form id="client-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {errors.form && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{errors.form}</p>}
        <Field label="Name" required error={errors.name}><Input value={f.name} onChange={set("name")} maxLength={120} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="GSTIN" help="15 characters, optional" error={errors.gstin}><Input value={f.gstin} onChange={set("gstin")} maxLength={15} className="uppercase" /></Field>
          <Field label="Currency" error={errors.currency}><Input value={f.currency} onChange={set("currency")} maxLength={3} className="uppercase" /></Field>
        </div>
        <Field label="Billing email"><Input type="email" value={f.email} onChange={set("email")} maxLength={200} /></Field>
        <Field label="Address line 1"><Input value={f.line1} onChange={set("line1")} maxLength={200} /></Field>
        <Field label="Address line 2"><Input value={f.line2} onChange={set("line2")} maxLength={200} /></Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="City"><Input value={f.city} onChange={set("city")} maxLength={100} /></Field>
          <Field label="State"><Input value={f.state} onChange={set("state")} maxLength={100} /></Field>
          <Field label="PIN code"><Input value={f.pincode} onChange={set("pincode")} maxLength={10} inputMode="numeric" /></Field>
        </div>
      </form>
    </Modal>
  );
}
