"use client";
import * as React from "react";
import { FolderTree, PackagePlus, Pencil, Plus, Trash2 } from "lucide-react";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { Card, CardHeader } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Modal, ConfirmDialog } from "@/ui/overlay";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Switch } from "@/ui/choice";
import { Banner, EmptyState } from "@/ui/feedback";
import { PageHeader } from "@/ui/app-shell";
import { toast } from "@/ui/toast";
import type { Person } from "@/ui/employee-picker";
import { declineAssetRequestAction, deleteAssetCategoryAction, deleteAssetTypeAction, saveAssetCategoryAction, saveAssetTypeAction } from "@/app/(app)/org/assets/actions";
import type { AssetDTO, CategoryDTO, RequestDTO, TypeDTO } from "./types";
import { AssignDialog, Inventory } from "./inventory";
import { fmtDay, RequestStatusBadge } from "./bits";

/** Org → Assets: inventory, requests to hand over, and the category → type structure. */
export function AssetsAdmin({ assets, structure, requests, people, canEdit, initialTab }: {
  assets: AssetDTO[]; structure: CategoryDTO[]; requests: RequestDTO[]; people: Person[]; canEdit: boolean; initialTab: string;
}) {
  const [tab, setTab] = React.useState(initialTab);
  const toHand = requests.filter((r) => r.status === "approved");
  const counts = { available: assets.filter((a) => a.status === "available").length, assigned: assets.filter((a) => a.status === "assigned").length };
  return (
    <>
      <PageHeader title="Assets" description={`${assets.length} ${assets.length === 1 ? "asset" : "assets"} · ${counts.assigned} with people · ${counts.available} available`} />
      {!canEdit && <Banner tone="info" className="mb-4" title="You can hand assets to people in your scope">Adding or editing inventory needs company-wide asset access.</Banner>}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList items={[{ value: "inventory", label: "Inventory", count: assets.length }, { value: "requests", label: "Requests", count: toHand.length }, { value: "types", label: "Categories and types" }]} />
        <TabsContent value="inventory"><Inventory assets={assets} structure={structure} people={people} canEdit={canEdit} /></TabsContent>
        <TabsContent value="requests"><Requests requests={requests} assets={assets} people={people} /></TabsContent>
        <TabsContent value="types"><Structure structure={structure} canEdit={canEdit} /></TabsContent>
      </Tabs>
    </>
  );
}

function Requests({ requests, assets, people }: { requests: RequestDTO[]; assets: AssetDTO[]; people: Person[] }) {
  const [handing, setHanding] = React.useState<RequestDTO | null>(null);
  const [declining, setDeclining] = React.useState<RequestDTO | null>(null);
  const [note, setNote] = React.useState("");
  if (!requests.length) return <Card><EmptyState icon={<PackagePlus />} title="No requests" description="When someone asks for an asset and their manager approves, it shows up here to hand over." /></Card>;
  const free = (typeId: string) => assets.filter((a) => a.type_id === typeId && a.status === "available" && a.condition !== "damaged" && a.condition !== "lost");
  return (
    <Card>
      <ul className="divide-y divide-border">
        {requests.map((r) => (
          <li key={r.id} className="flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <p className="text-base font-medium">{r.employee} <span className="font-normal text-text-muted">needs a {r.type.toLowerCase()}{r.kind === "replacement" ? " (replacement)" : ""}</span></p>
              <p className="text-sm text-text-muted">{fmtDay(r.created_at)}{r.reason ? ` · ${r.reason}` : ""}{r.status === "approved" ? ` · ${r.available} available` : ""}</p>
            </div>
            <RequestStatusBadge status={r.status} />
            {r.status === "approved" && !r.mine && (
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => { setNote(""); setDeclining(r); }}>Close</Button>
                <Button size="sm" onClick={() => setHanding(r)}>Hand over</Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {handing && <AssignDialog assets={[]} choices={free(handing.type_id)} requestId={handing.id} employeeId={handing.employee_id}
        people={[{ id: handing.employee_id, name: handing.employee }, ...people]} onClose={() => setHanding(null)} />}
      <Modal open={!!declining} onOpenChange={(o) => !o && setDeclining(null)} title="Close without handing over?" description={declining ? `${declining.employee} will be told the request was closed.` : undefined}
        footer={<><Button variant="secondary" onClick={() => setDeclining(null)}>Keep it open</Button><Button variant="danger" onClick={async () => {
          if (!declining) return; const r = await declineAssetRequestAction(declining.id, note); if (r.ok) toast.success("Request closed"); else toast.error(r.error); setDeclining(null);
        }}>Close request</Button></>}>
        <Field label="Message to the employee" help="Optional, e.g. out of stock until next month"><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
      </Modal>
    </Card>
  );
}

function Structure({ structure, canEdit }: { structure: CategoryDTO[]; canEdit: boolean }) {
  const [cat, setCat] = React.useState<CategoryDTO | "new" | null>(null);
  const [type, setType] = React.useState<{ categoryId: string; t: TypeDTO | null } | null>(null);
  const [del, setDel] = React.useState<{ kind: "category" | "type"; id: string; name: string } | null>(null);
  return (
    <div className="flex flex-col gap-4">
      {canEdit && <Button className="self-start" variant="secondary" onClick={() => setCat("new")}><Plus />Add category</Button>}
      {structure.length === 0 ? <Card><EmptyState icon={<FolderTree />} title="No categories yet" description="Group assets into categories (e.g. Computers), then types (e.g. Laptop)." /></Card> : structure.map((c) => (
        <Card key={c.id}>
          <CardHeader title={c.name} action={canEdit ? (
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => setType({ categoryId: c.id, t: null })}><Plus />Type</Button>
              <IconButton size="icon-sm" label={`Rename ${c.name}`} onClick={() => setCat(c)}><Pencil /></IconButton>
              {c.types.length === 0 && <IconButton size="icon-sm" label={`Delete ${c.name}`} onClick={() => setDel({ kind: "category", id: c.id, name: c.name })}><Trash2 /></IconButton>}
            </div>
          ) : undefined} />
          {c.types.length === 0 ? <p className="border-t border-border px-5 py-3 text-base text-text-muted">No types yet.</p> : (
            <ul className="divide-y divide-border border-t border-border">
              {c.types.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2 px-5 py-3">
                  <span className="min-w-0 flex-1 text-base font-medium">{t.name}</span>
                  <span className="text-sm tabular text-text-muted">{t.available} of {t.total} available</span>
                  {t.requires_ack && <Badge>Needs receipt</Badge>}
                  {t.requestable ? <Badge tone="accent">Can be requested</Badge> : <Badge>HR issues only</Badge>}
                  {canEdit && <IconButton size="icon-sm" label={`Edit ${t.name}`} onClick={() => setType({ categoryId: c.id, t })}><Pencil /></IconButton>}
                  {canEdit && t.total === 0 && <IconButton size="icon-sm" label={`Delete ${t.name}`} onClick={() => setDel({ kind: "type", id: t.id, name: t.name })}><Trash2 /></IconButton>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}
      {cat && <CategoryDialog key={cat === "new" ? "new" : cat.id} cat={cat === "new" ? null : cat} onClose={() => setCat(null)} />}
      {type && <TypeDialog key={type.t?.id ?? "new"} categoryId={type.categoryId} type={type.t} categories={structure} onClose={() => setType(null)} />}
      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} title={`Delete ${del?.name ?? ""}?`} description="This can't be undone." confirmLabel="Delete"
        onConfirm={async () => { if (!del) return; const r = del.kind === "category" ? await deleteAssetCategoryAction(del.id) : await deleteAssetTypeAction(del.id); if (r.ok) toast.success("Deleted"); else toast.error(r.error); setDel(null); }} />
    </div>
  );
}

function CategoryDialog({ cat, onClose }: { cat: CategoryDTO | null; onClose: () => void }) {
  const [name, setName] = React.useState(cat?.name ?? "");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, start] = React.useTransition();
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={cat ? `Rename ${cat.name}` : "Add a category"} size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="asset-cat" loading={busy}>Save</Button></>}>
      <form id="asset-cat" onSubmit={(e) => { e.preventDefault(); start(async () => { const r = await saveAssetCategoryAction(cat?.id ?? null, name); if (!r.ok) setError(r.error); else { toast.success("Saved"); onClose(); } }); }}>
        <Field label="Name" required error={error ?? undefined}><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Computers" /></Field>
      </form>
    </Modal>
  );
}

function TypeDialog({ categoryId, type, categories, onClose }: { categoryId: string; type: TypeDTO | null; categories: CategoryDTO[]; onClose: () => void }) {
  const [f, setF] = React.useState({ categoryId, name: type?.name ?? "", requiresAck: type?.requires_ack ?? true, requestable: type?.requestable ?? true });
  const [error, setError] = React.useState<string | null>(null);
  const [busy, start] = React.useTransition();
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={type ? `Edit ${type.name}` : "Add an asset type"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="asset-type" loading={busy}>Save</Button></>}>
      <form id="asset-type" className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); start(async () => { const r = await saveAssetTypeAction(type?.id ?? null, f); if (!r.ok) setError(r.error); else { toast.success("Saved"); onClose(); } }); }}>
        {error && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{error}</p>}
        <Field label="Category"><Select value={f.categoryId} onValueChange={(v) => setF({ ...f, categoryId: v })} options={categories.map((c) => ({ value: c.id, label: c.name }))} /></Field>
        <Field label="Name" required><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} placeholder="e.g. Laptop" /></Field>
        <Switch label="People must confirm they received it" checked={f.requiresAck} onCheckedChange={(c) => setF({ ...f, requiresAck: !!c })} />
        <Switch label="Employees can request it" checked={f.requestable} onCheckedChange={(c) => setF({ ...f, requestable: !!c })} />
      </form>
    </Modal>
  );
}
