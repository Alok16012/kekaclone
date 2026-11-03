"use client";
import * as React from "react";
import { Library, Pencil, Plus, Trash2 } from "lucide-react";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { Card } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Modal, ConfirmDialog } from "@/ui/overlay";
import { Field, Input, Textarea } from "@/ui/field";
import { EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { deleteCompetencyAction, saveCompetencyAction } from "@/app/(app)/performance/actions";

type Kind = "competency" | "core_value" | "skill";
type Item = { id: string; kind: Kind; name: string; description: string | null; levels: { level: number; description: string }[] | null; people: number };
const TABS: { value: Kind; label: string; one: string }[] = [{ value: "competency", label: "Competencies", one: "competency" }, { value: "core_value", label: "Core values", one: "core value" }, { value: "skill", label: "Skills", one: "skill" }];

export function SkillsLibrary({ items }: { items: Item[] }) {
  const [tab, setTab] = React.useState<Kind>("competency");
  const [edit, setEdit] = React.useState<{ id: string | null; kind: Kind; name: string; description: string; levels: string[] } | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const open = (i: Item | null, kind: Kind) => { setErr(null); setEdit({ id: i?.id ?? null, kind, name: i?.name ?? "", description: i?.description ?? "", levels: [1, 2, 3, 4, 5].map((n) => i?.levels?.find((l) => l.level === n)?.description ?? "") }); };
  return (
    <>
      <Tabs value={tab} onValueChange={(v) => setTab(v as Kind)}>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <TabsList items={TABS.map((t) => ({ value: t.value, label: t.label, count: items.filter((i) => i.kind === t.value).length }))} />
          <Button size="sm" onClick={() => open(null, tab)}><Plus />Add {TABS.find((t) => t.value === tab)!.one}</Button>
        </div>
        {TABS.map((t) => {
          const rows = items.filter((i) => i.kind === t.value);
          return (
            <TabsContent key={t.value} value={t.value}>
              {!rows.length ? <Card><EmptyState icon={<Library />} title={`No ${t.label.toLowerCase()} yet`} action={<Button size="sm" onClick={() => open(null, t.value)}><Plus />Add {t.one}</Button>} /></Card> : (
                <Card><ul className="divide-y divide-border">{rows.map((i) => (
                  <li key={i.id} className="flex items-start gap-3 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-base font-medium">{i.name}{t.value === "skill" && <span className="ml-2 text-sm font-normal text-text-muted">{i.people} {i.people === 1 ? "person" : "people"}</span>}</p>
                      {i.description && <p className="text-sm text-text-muted">{i.description}</p>}
                      {i.levels?.length ? <p className="mt-1 text-xs text-text-muted">Levels: {i.levels.map((l) => `${l.level} ${l.description}`).join(" · ")}</p> : null}
                    </div>
                    <IconButton label={`Edit ${i.name}`} size="icon-sm" onClick={() => open(i, i.kind)}><Pencil /></IconButton>
                    <ConfirmDialog trigger={<IconButton label={`Delete ${i.name}`} size="icon-sm"><Trash2 /></IconButton>} title={`Delete ${i.name}?`} description="It's removed from people's profiles and from forms used by future cycles." confirmLabel="Delete"
                      onConfirm={async () => { const r = await deleteCompetencyAction(i.id); if (r.ok) toast.success("Deleted"); else toast.error(r.error); }} />
                  </li>
                ))}</ul></Card>
              )}
            </TabsContent>
          );
        })}
      </Tabs>
      {edit && (
        <Modal open onOpenChange={(o) => !o && setEdit(null)} title={`${edit.id ? "Edit" : "Add"} ${TABS.find((t) => t.value === edit.kind)!.one}`}
          footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button loading={busy} onClick={async () => {
            setBusy(true); setErr(null);
            const levels = edit.levels.map((d, n) => ({ level: n + 1, description: d.trim() })).filter((l) => l.description);
            const r = await saveCompetencyAction(edit.id, { kind: edit.kind, name: edit.name, description: edit.description || null, levels: levels.length ? levels : null });
            setBusy(false);
            if (r.ok) { toast.success("Saved"); setEdit(null); } else setErr(r.error);
          }}>Save</Button></>}>
          <div className="flex flex-col gap-4">
            {err && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{err}</p>}
            <Field label="Name" required><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={80} /></Field>
            <Field label="Description"><Textarea value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} rows={2} maxLength={500} /></Field>
            <fieldset className="flex flex-col gap-2"><legend className="mb-1 text-sm font-medium">What each level looks like (optional)</legend>
              {edit.levels.map((l, n) => <Input key={n} aria-label={`Level ${n + 1}`} placeholder={`Level ${n + 1}`} value={l} onChange={(e) => setEdit({ ...edit, levels: edit.levels.map((x, m) => (m === n ? e.target.value : x)) })} maxLength={200} />)}
            </fieldset>
          </div>
        </Modal>
      )}
    </>
  );
}
