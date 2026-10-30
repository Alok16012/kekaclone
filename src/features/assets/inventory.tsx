"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowDownToLine, ArrowUpFromLine, Package, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { DataTable, type Column } from "@/ui/table";
import { Button } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Modal, Drawer, ConfirmDialog } from "@/ui/overlay";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { EmptyState, Skeleton } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { assetHistoryAction, assignAssetsAction, deleteAssetAction, returnAssetsAction, saveAssetAction } from "@/app/(app)/org/assets/actions";
import { CONDITIONS, CONDITION_LABEL, formatPaise, MANUAL_STATUSES, rupeesToPaise, STATUS_LABEL, suggestedRecovery, type Condition } from "@/server/modules/assets/rules";
import type { AssetDTO, CategoryDTO } from "./types";
import { AssetStatusBadge, ConditionText, fmtDay } from "./bits";

const Labeled = ({ label, children }: { label: string; children: React.ReactNode }) => <Field label={<span className="sr-only">{label}</span>} className="gap-0">{children}</Field>;
const paiseToInput = (p: string | null) => (p == null ? "" : formatPaise(BigInt(p)).replace(/,/g, ""));

export function Inventory({ assets, structure, people, canEdit }: { assets: AssetDTO[]; structure: CategoryDTO[]; people: Person[]; canEdit: boolean }) {
  const [q, setQ] = React.useState("");
  const [status, setStatus] = React.useState("all");
  const [type, setType] = React.useState("all");
  const [editing, setEditing] = React.useState<AssetDTO | "new" | null>(null);
  const [viewing, setViewing] = React.useState<AssetDTO | null>(null);
  const [assigning, setAssigning] = React.useState<AssetDTO[] | null>(null);
  const [returning, setReturning] = React.useState<AssetDTO[] | null>(null);
  const types = structure.flatMap((c) => c.types.map((t) => ({ ...t, category: c.name })));
  const rows = assets.filter((a) => (status === "all" || a.status === status) && (type === "all" || a.type_id === type)
    && (!q || `${a.tag} ${a.name} ${a.serial_number ?? ""} ${a.holder ?? ""}`.toLowerCase().includes(q.toLowerCase())));
  const byId = new Map(assets.map((a) => [a.id, a]));

  const columns: Column<AssetDTO>[] = [
    { key: "tag", header: "Asset", sortValue: (a) => a.tag, cell: (a) => (
      <button type="button" onClick={(e) => { e.stopPropagation(); setViewing(a); }} className="flex min-w-0 flex-col text-left">
        <span className="font-medium hover:underline">{a.name}</span><span className="text-sm tabular text-text-muted">{a.tag}{a.serial_number ? ` · S/N ${a.serial_number}` : ""}</span>
      </button>
    ) },
    { key: "type", header: "Type", hideBelow: "md", sortValue: (a) => a.type, cell: (a) => <span className="flex flex-col"><span>{a.type}</span><span className="text-sm text-text-muted">{a.category}</span></span> },
    { key: "condition", header: "Condition", hideBelow: "lg", sortValue: (a) => CONDITIONS.indexOf(a.condition), cell: (a) => <ConditionText condition={a.condition} /> },
    { key: "holder", header: "With", sortValue: (a) => a.holder ?? "~", cell: (a) => a.holder ? (
      <span className="flex flex-col"><Link href={`/people/${a.holder_id}`} onClick={(e) => e.stopPropagation()} className="hover:underline">{a.holder}</Link>
        {a.requires_ack && !a.acknowledged_at && <Badge tone="warning" className="mt-0.5 w-fit">Not confirmed</Badge>}</span>
    ) : <span className="text-text-muted">—</span> },
    { key: "status", header: "Status", sortValue: (a) => a.status, cell: (a) => <AssetStatusBadge status={a.status} /> },
  ];

  return (
    <>
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="sm:w-64"><Input aria-label="Search assets" leading={<Search />} placeholder="Tag, name, serial or person" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="grid grid-cols-2 gap-3 sm:flex">
          <div className="sm:w-40"><Labeled label="Status"><Select value={status} onValueChange={setStatus} options={[{ value: "all", label: "All statuses" }, ...(["available", "assigned", "in_repair", "retired"] as const).map((s) => ({ value: s, label: STATUS_LABEL[s] }))]} /></Labeled></div>
          <div className="sm:w-44"><Labeled label="Type"><Select value={type} onValueChange={setType} options={[{ value: "all", label: "All types" }, ...types.map((t) => ({ value: t.id, label: t.name }))]} /></Labeled></div>
        </div>
        {canEdit && <Button className="sm:ml-auto" onClick={() => setEditing("new")} disabled={!types.length} title={types.length ? undefined : "Add an asset type first"}><Plus />Add asset</Button>}
      </div>
      <DataTable caption="Assets" rows={rows} columns={columns} rowKey={(a) => a.id} onRowClick={setViewing} selectable
        bulkActions={(ids, clear) => {
          const sel = ids.map((id) => byId.get(id)!).filter(Boolean);
          const free = sel.filter((a) => a.status === "available" && a.condition !== "damaged" && a.condition !== "lost");
          const held = sel.filter((a) => a.assignment_id && a.can_return);
          return (
            <>
              <Button size="sm" variant="secondary" disabled={!free.length} onClick={() => { setAssigning(free); clear(); }}><ArrowUpFromLine />Hand over{free.length ? ` (${free.length})` : ""}</Button>
              <Button size="sm" variant="secondary" disabled={!held.length} onClick={() => { setReturning(held); clear(); }}><ArrowDownToLine />Take back{held.length ? ` (${held.length})` : ""}</Button>
            </>
          );
        }}
        empty={q || status !== "all" || type !== "all" ? <EmptyState compact icon={<Search />} title="No assets match" />
          : <EmptyState icon={<Package />} title="No assets yet" description={canEdit ? "Add laptops, phones, ID cards and other equipment you hand out." : "Assets added by the asset team appear here."} />} />

      <AssetDrawer asset={viewing} canEdit={canEdit} onClose={() => setViewing(null)} onEdit={(a) => { setViewing(null); setEditing(a); }}
        onAssign={(a) => { setViewing(null); setAssigning([a]); }} onReturn={(a) => { setViewing(null); setReturning([a]); }} />
      {editing && <AssetDialog key={editing === "new" ? "new" : editing.id} asset={editing === "new" ? null : editing} types={types} onClose={() => setEditing(null)} />}
      {assigning && <AssignDialog assets={assigning} people={people} onClose={() => setAssigning(null)} />}
      {returning && <ReturnDialog assets={returning} onClose={() => setReturning(null)} />}
    </>
  );
}

type History = Extract<Awaited<ReturnType<typeof assetHistoryAction>>, { ok: true }>["data"];

function AssetDrawer({ asset, canEdit, onClose, onEdit, onAssign, onReturn }: { asset: AssetDTO | null; canEdit: boolean; onClose: () => void; onEdit: (a: AssetDTO) => void; onAssign: (a: AssetDTO) => void; onReturn: (a: AssetDTO) => void }) {
  const [hist, setHist] = React.useState<{ id: string; rows?: History; error?: string } | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  React.useEffect(() => {
    if (!asset) return;
    let live = true;
    assetHistoryAction(asset.id).then((r) => { if (live) setHist(r.ok ? { id: asset.id, rows: r.data } : { id: asset.id, error: r.error }); });
    return () => { live = false; };
  }, [asset]);
  const h = hist?.id === asset?.id ? hist : null;
  const usable = asset && asset.status === "available" && asset.condition !== "damaged" && asset.condition !== "lost";
  return (
    <Drawer open={!!asset} onOpenChange={(o) => !o && onClose()} title={asset?.name ?? "Asset"} description={asset ? `${asset.tag} · ${asset.type}` : undefined}
      footer={asset && (
        <>
          {canEdit && <Button variant="secondary" onClick={() => onEdit(asset)}><Pencil />Edit</Button>}
          {asset.assignment_id ? (asset.can_return && <Button onClick={() => onReturn(asset)}><ArrowDownToLine />Take back</Button>) : usable && <Button onClick={() => onAssign(asset)}><ArrowUpFromLine />Hand over</Button>}
        </>
      )}>
      {asset && (
        <div className="flex flex-col gap-5">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-base">
            <div><dt className="text-sm text-text-muted">Status</dt><dd className="mt-0.5"><AssetStatusBadge status={asset.status} /></dd></div>
            <div><dt className="text-sm text-text-muted">Condition</dt><dd><ConditionText condition={asset.condition} /></dd></div>
            <div><dt className="text-sm text-text-muted">Serial number</dt><dd>{asset.serial_number ?? <span className="text-text-muted">—</span>}</dd></div>
            <div><dt className="text-sm text-text-muted">Category</dt><dd>{asset.category}</dd></div>
            <div><dt className="text-sm text-text-muted">Bought on</dt><dd>{fmtDay(asset.purchase_date)}</dd></div>
            <div><dt className="text-sm text-text-muted">Cost</dt><dd className="tabular">{asset.cost_paise != null ? `₹${formatPaise(BigInt(asset.cost_paise))}` : <span className="text-text-muted">—</span>}</dd></div>
            {asset.holder && <div className="col-span-2"><dt className="text-sm text-text-muted">With</dt><dd><Link href={`/people/${asset.holder_id}`} className="hover:underline">{asset.holder}</Link> since {fmtDay(asset.assigned_at)}
              {asset.requires_ack && <span className="block text-sm text-text-muted">{asset.acknowledged_at ? `Receipt confirmed ${fmtDay(asset.acknowledged_at)}` : "Receipt not confirmed yet"}</span>}</dd></div>}
          </dl>
          <section className="flex flex-col gap-2 border-t border-border pt-4">
            <h3 className="text-sm font-semibold">History</h3>
            {!h ? <Skeleton className="h-16" /> : h.error ? <p className="text-base text-danger-text">{h.error}</p> : !h.rows?.length ? <p className="text-base text-text-muted">Never handed out.</p> : (
              <ol className="flex flex-col gap-2">
                {h.rows.map((r) => (
                  <li key={r.id} className="rounded-md bg-surface-sunken px-3 py-2 text-base">
                    <p><span className="font-medium">{r.employee}</span> · {fmtDay(r.assigned_at)} to {r.returned_at ? fmtDay(r.returned_at) : "now"}</p>
                    <p className="text-sm text-text-muted">
                      {r.assigned_by ? `Handed over by ${r.assigned_by}` : "Handed over"}{r.assign_condition ? ` in ${CONDITION_LABEL[r.assign_condition].toLowerCase()} condition` : ""}
                      {r.returned_at && <> · returned {r.return_condition ? CONDITION_LABEL[r.return_condition].toLowerCase() : ""}{r.returned_by ? ` to ${r.returned_by}` : ""}</>}
                      {BigInt(r.recovery_paise) > BigInt(0) && <> · recovery ₹{formatPaise(BigInt(r.recovery_paise))}</>}
                    </p>
                    {(r.notes || r.return_notes) && <p className="mt-0.5 text-sm">{[r.notes, r.return_notes].filter(Boolean).join(" · ")}</p>}
                  </li>
                ))}
              </ol>
            )}
          </section>
          {canEdit && h?.rows && h.rows.length === 0 && (
            <ConfirmDialog open={deleting} onOpenChange={setDeleting} title={`Delete ${asset.tag}?`} description="It has never been handed out, so nothing is lost." confirmLabel="Delete"
              trigger={<Button variant="ghost" size="sm" className="self-start text-danger-text"><Trash2 />Delete asset</Button>}
              onConfirm={async () => { const r = await deleteAssetAction(asset.id); if (r.ok) { toast.success("Asset deleted"); onClose(); } else toast.error(r.error); }} />
          )}
        </div>
      )}
    </Drawer>
  );
}

function AssetDialog({ asset, types, onClose }: { asset: AssetDTO | null; types: (CategoryDTO["types"][number] & { category: string })[]; onClose: () => void }) {
  const [f, setF] = React.useState({
    typeId: asset?.type_id ?? "", tag: asset?.tag ?? "", name: asset?.name ?? "", serialNumber: asset?.serial_number ?? "", condition: asset?.condition ?? "new",
    status: asset?.status ?? "available", purchaseDate: asset?.purchase_date ?? "", cost: paiseToInput(asset?.cost_paise ?? null),
  });
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, start] = React.useTransition();
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!f.typeId) errs.typeId = "Pick a type.";
    if (!f.tag.trim()) errs.tag = "Give it a tag, e.g. LAP-0012.";
    if (!f.name.trim()) errs.name = "Name the asset, e.g. MacBook Air 13.";
    if (f.cost.trim() && rupeesToPaise(f.cost) == null) errs.cost = "Enter rupees with at most two decimals.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    start(async () => {
      const r = await saveAssetAction(asset?.id ?? null, { ...f, condition: f.condition as Condition, status: f.status as AssetDTO["status"], serialNumber: f.serialNumber || null, purchaseDate: f.purchaseDate || null, cost: f.cost || null });
      if (!r.ok) { setErrors({ [r.field ?? "form"]: r.error }); return; }
      toast.success(asset ? "Asset saved" : "Asset added"); onClose();
    });
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={asset ? `Edit ${asset.tag}` : "Add an asset"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="asset-form" loading={busy}>Save</Button></>}>
      <form id="asset-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        {errors.form && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text sm:col-span-2">{errors.form}</p>}
        <Field label="Type" required error={errors.typeId} className="sm:col-span-2"><Select value={f.typeId || undefined} onValueChange={set("typeId")} placeholder="Pick a type" options={types.map((t) => ({ value: t.id, label: `${t.name} · ${t.category}` }))} /></Field>
        <Field label="Asset tag" required error={errors.tag} help="Unique, e.g. the sticker number"><Input value={f.tag} onChange={(e) => set("tag")(e.target.value)} maxLength={40} className="uppercase" /></Field>
        <Field label="Serial number" error={errors.serialNumber}><Input value={f.serialNumber} onChange={(e) => set("serialNumber")(e.target.value)} maxLength={80} /></Field>
        <Field label="Name" required error={errors.name} className="sm:col-span-2"><Input value={f.name} onChange={(e) => set("name")(e.target.value)} maxLength={80} placeholder="e.g. Dell Latitude 5440" /></Field>
        <Field label="Condition" error={errors.condition}><Select value={f.condition} onValueChange={set("condition")} options={CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABEL[c] }))} /></Field>
        <Field label="Status" error={errors.status} help={asset?.status === "assigned" ? "Take it back to change this." : undefined}>
          <Select value={f.status} onValueChange={set("status")} disabled={asset?.status === "assigned"}
            options={(asset?.status === "assigned" ? ["assigned" as const] : MANUAL_STATUSES).map((s) => ({ value: s, label: STATUS_LABEL[s] }))} />
        </Field>
        <Field label="Bought on" error={errors.purchaseDate}><Input type="date" value={f.purchaseDate} onChange={(e) => set("purchaseDate")(e.target.value)} /></Field>
        <Field label="Cost" error={errors.cost} help="Caps any damage recovery"><Input inputMode="decimal" leading={<span className="text-sm">₹</span>} value={f.cost} onChange={(e) => set("cost")(e.target.value)} className="tabular" placeholder="0.00" /></Field>
      </form>
    </Modal>
  );
}

export function AssignDialog({ assets, people, onClose, requestId, employeeId, choices }: {
  assets: AssetDTO[]; people: Person[]; onClose: () => void; requestId?: string; employeeId?: string;
  /** for a request: available assets of the requested type to pick from */
  choices?: AssetDTO[];
}) {
  const [who, setWho] = React.useState<string[]>(employeeId ? [employeeId] : []);
  const [pick, setPick] = React.useState(choices?.[0]?.id ?? "");
  const [notes, setNotes] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, start] = React.useTransition();
  const list = choices ? choices.filter((c) => c.id === pick) : assets;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!who[0]) { setError("Pick who gets it."); return; }
    if (!list.length) { setError("Pick an asset."); return; }
    start(async () => {
      const r = await assignAssetsAction({ assetIds: list.map((a) => a.id), employeeId: who[0], requestId: requestId ?? null, notes: notes || null });
      if (!r.ok) { setError(r.error); return; }
      toast.success(`${r.data?.count === 1 ? "Asset" : `${r.data?.count} assets`} handed over`, { description: "They'll be asked to confirm receipt." }); onClose();
    });
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={choices ? "Hand over for this request" : `Hand over ${assets.length === 1 ? assets[0].tag : `${assets.length} assets`}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="assign-form" loading={busy}>Hand over</Button></>}>
      <form id="assign-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {error && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{error}</p>}
        {choices ? (
          <Field label="Asset" required help={choices.length ? undefined : "Nothing of this type is available. Add one to the inventory first."}>
            <Select value={pick || undefined} onValueChange={setPick} disabled={!choices.length} placeholder="Pick an available asset" options={choices.map((c) => ({ value: c.id, label: `${c.tag} · ${c.name}` }))} />
          </Field>
        ) : (
          <ul className="flex flex-col gap-1 rounded-md bg-surface-sunken px-3 py-2 text-base">{assets.map((a) => <li key={a.id}><span className="tabular text-text-muted">{a.tag}</span> · {a.name}</li>)}</ul>
        )}
        <Field label="Give to" required help={employeeId ? undefined : "You can't hand assets to yourself."}>
          {employeeId ? <p className="text-base font-medium">{people.find((p) => p.id === employeeId)?.name ?? "The requester"}</p> : <EmployeePicker people={people} value={who} onChange={(v) => setWho(v.slice(-1))} placeholder="Search people" />}
        </Field>
        <Field label="Notes" help="Optional, e.g. charger included"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} rows={2} /></Field>
      </form>
    </Modal>
  );
}

function ReturnDialog({ assets, onClose }: { assets: AssetDTO[]; onClose: () => void }) {
  const [items, setItems] = React.useState(assets.map((a) => ({ a, condition: (a.condition === "new" ? "good" : a.condition) as Condition, recovery: "", notes: "" })));
  const [error, setError] = React.useState<string | null>(null);
  const [busy, start] = React.useTransition();
  const upd = (i: number, patch: Partial<(typeof items)[number]>) => setItems((x) => x.map((it, j) => {
    if (j !== i) return it;
    const next = { ...it, ...patch };
    if (patch.condition) {
      const s = suggestedRecovery(patch.condition, it.a.cost_paise == null ? null : BigInt(it.a.cost_paise));
      next.recovery = patch.condition === "damaged" || patch.condition === "lost" ? (s > BigInt(0) ? formatPaise(s).replace(/,/g, "") : it.recovery) : "";
    }
    return next;
  }));
  const total = items.reduce((s, it) => s + (rupeesToPaise(it.recovery || "0") ?? BigInt(0)), BigInt(0));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const badRow = items.find((it) => it.recovery.trim() && rupeesToPaise(it.recovery) == null);
    if (badRow) { setError(`${badRow.a.tag}: enter rupees with at most two decimals.`); return; }
    start(async () => {
      const r = await returnAssetsAction(items.map((it) => ({ assignmentId: it.a.assignment_id!, condition: it.condition, recovery: it.recovery || null, notes: it.notes || null })));
      if (!r.ok) { setError(r.error); return; }
      toast.success(`${r.data?.returned === 1 ? "Asset" : `${r.data?.returned} assets`} taken back`, { description: BigInt(r.data?.recoveryPaise ?? "0") > BigInt(0) ? `Recovery of ₹${formatPaise(BigInt(r.data!.recoveryPaise))} recorded for the settlement.` : undefined });
      onClose();
    });
  };
  return (
    <Modal size="lg" open onOpenChange={(o) => !o && onClose()} title={`Take back ${assets.length === 1 ? assets[0].tag : `${assets.length} assets`}`} description="Record the condition each one came back in. Damaged or lost assets can carry a recovery amount for the final settlement."
      footer={<><span className="mr-auto self-center text-sm text-text-muted tabular">Total recovery ₹{formatPaise(total)}</span><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="return-form" loading={busy}>Take back</Button></>}>
      <form id="return-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {error && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{error}</p>}
        {items.map((it, i) => {
          const charge = it.condition === "damaged" || it.condition === "lost";
          return (
            <fieldset key={it.a.id} className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
              <legend className="px-1 text-sm font-medium">{it.a.tag} · {it.a.name}{it.a.holder ? ` · from ${it.a.holder}` : ""}</legend>
              <Field label="Came back"><Select value={it.condition} onValueChange={(v) => upd(i, { condition: v as Condition })} options={CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABEL[c] }))} /></Field>
              <Field label="Recovery" help={charge ? (it.a.cost_paise ? `Up to ₹${formatPaise(BigInt(it.a.cost_paise))}` : "No cost on record") : "Only for damaged or lost"}>
                <Input inputMode="decimal" leading={<span className="text-sm">₹</span>} value={it.recovery} disabled={!charge} onChange={(e) => upd(i, { recovery: e.target.value })} className="tabular" placeholder="0.00" />
              </Field>
              <Field label="Notes"><Input value={it.notes} onChange={(e) => upd(i, { notes: e.target.value })} maxLength={1000} placeholder="e.g. cracked screen" /></Field>
            </fieldset>
          );
        })}
      </form>
    </Modal>
  );
}
