"use client";
import * as React from "react";
import { History, Plus, Trash2, Workflow, X } from "lucide-react";
import { Button, IconButton } from "@/ui/button";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Switch } from "@/ui/choice";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Banner, EmptyState } from "@/ui/feedback";
import { ConfirmDialog, Drawer } from "@/ui/overlay";
import { DataTable } from "@/ui/table";
import { toast } from "@/ui/toast";
import { ACTION_TYPES, CONDITION_FIELDS, DATE_FIELDS, OPS, OP_LABELS, PLACEHOLDERS, RECIPIENTS, TRIGGERS, describe, type Action, type Condition, type Trigger } from "@/server/modules/automations/rules";
import type { AutomationRow, RunRow, editorOptions } from "@/server/modules/automations/service";
import { deleteAutomationAction, runLogAction, saveAutomationAction, setAutomationActiveAction } from "@/app/(app)/settings/automations/actions";

type Options = Awaited<ReturnType<typeof editorOptions>>;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "—");

type Draft = { name: string; trigger: Trigger; trigger_config: { field: string; offset_days: string }; conditions: { field: string; op: string; value: string }[]; actions: Record<string, unknown>[]; is_active: boolean };
const blank = (): Draft => ({ name: "", trigger: "employee.joined", trigger_config: { field: "joining_date", offset_days: "-7" }, conditions: [], actions: [{ type: "notify", to: ["employee"], title: "", body: "" }], is_active: true });
const fromRow = (r: AutomationRow): Draft => ({
  name: r.name, trigger: r.trigger, trigger_config: { field: r.trigger_config.field ?? "joining_date", offset_days: String(r.trigger_config.offset_days ?? -7) },
  conditions: r.conditions.map((c: Condition) => ({ field: c.field, op: c.op, value: Array.isArray(c.value) ? c.value.join(", ") : String(c.value) })),
  actions: r.actions.map((a: Action) => ({ ...a })), is_active: r.is_active,
});

/** Settings → Automations: list with on/off, an editor drawer (trigger → conditions → actions) and the run log. */
export function AutomationsPage({ items, options, runs }: { items: AutomationRow[]; options: Options; runs: RunRow[] }) {
  const [editing, setEditing] = React.useState<{ id: string | null; draft: Draft } | null>(null);
  const [log, setLog] = React.useState<{ title: string; rows: RunRow[] } | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Automations</h2>
        <p className="text-base text-text-muted">When something happens (or on a date), check a few conditions, then notify people, send email, create tasks, add to groups, post an announcement or call a webhook.</p>
      </div>
      {!options.allowed && <Banner tone="info">The workflow builder is available on the Pro plan. Existing automations keep showing here but don&apos;t run until the plan includes it.</Banner>}
      <Card>
        <CardHeader title={<span className="flex items-center gap-2"><Workflow className="size-4 text-text-muted" aria-hidden />Your automations</span>} description={`${items.length} of 50`}
          action={<div className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => setLog({ title: "Recent runs", rows: runs })}><History />Run log</Button><Button size="sm" disabled={!options.allowed} onClick={() => setEditing({ id: null, draft: blank() })}><Plus />New automation</Button></div>} />
        {items.length === 0 ? <CardBody><EmptyState compact title="No automations yet" description="Try: welcome new joiners with a task for their manager, or wish people on their birthday on the Home wall." /></CardBody> : (
          <DataTable caption="Automations" rows={items} rowKey={(r) => r.id} onRowClick={(r) => setEditing({ id: r.id, draft: fromRow(r) })} columns={[
            { key: "name", header: "Name", cell: (r) => <span className="font-medium">{r.name}</span> },
            { key: "what", header: "What it does", hideBelow: "md", cell: (r) => <span className="text-sm text-text-muted">{describe(r)}</span> },
            { key: "runs", header: "Runs", hideBelow: "lg", cell: (r) => <span className="tabular">{r.run_count}{r.last_run_at ? <span className="text-text-muted"> · {when(r.last_run_at)}</span> : null}</span> },
            { key: "on", header: "On", cell: (r) => <span onClick={(e) => e.stopPropagation()}><Switch aria-label={`${r.is_active ? "Turn off" : "Turn on"} ${r.name}`} checked={r.is_active} onCheckedChange={async (on) => { const x = await setAutomationActiveAction(r.id, on); if (x.ok) toast.success(on ? "Turned on" : "Turned off"); else toast.error(x.error); }} /></span> },
            { key: "log", header: <span className="sr-only">Log</span>, align: "right", cell: (r) => <span onClick={(e) => e.stopPropagation()}><Button size="sm" variant="ghost" onClick={async () => { const x = await runLogAction(r.id); if (x.ok) setLog({ title: `Runs: ${r.name}`, rows: x.data ?? [] }); else toast.error(x.error); }}>Log</Button></span> },
          ]} />
        )}
      </Card>
      <Editor state={editing} options={options} onClose={() => setEditing(null)} />
      <Drawer open={!!log} onOpenChange={(o) => !o && setLog(null)} title={log?.title ?? "Runs"} description="Newest first. A failed run keeps the automation on; fix the cause and it runs on the next event.">
        {log && (log.rows.length === 0 ? <EmptyState compact title="No runs yet" /> : (
          <ul className="flex flex-col divide-y divide-border">
            {log.rows.map((r) => (
              <li key={r.id} className="flex flex-col gap-0.5 py-2 text-sm">
                <span className="flex items-center gap-2"><Badge tone={r.status === "ok" ? "success" : r.status === "failed" ? "danger" : "neutral"}>{r.status}</Badge><span className="font-medium">{r.automation}</span><span className="text-text-muted">· {r.subject ?? "—"}</span></span>
                <span className="text-text-muted">{when(r.created_at)} · {r.trigger}{r.status === "failed" && r.result.error ? ` · ${String(r.result.error)}` : ""}</span>
              </li>
            ))}
          </ul>
        ))}
      </Drawer>
    </div>
  );
}

function Editor({ state, options, onClose }: { state: { id: string | null; draft: Draft } | null; options: Options; onClose: () => void }) {
  const [d, setD] = React.useState<Draft>(blank());
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const [seen, setSeen] = React.useState(state);
  if (state !== seen) { setSeen(state); if (state) { setD(state.draft); setError(null); } }   // a new draft arrived: reset the form (React's "adjust state on prop change")
  const trig = TRIGGERS.find((t) => t.key === d.trigger)!;
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const save = () => start(async () => {
    setError(null);
    const payload = { ...d, trigger_config: d.trigger === "date_offset" ? { field: d.trigger_config.field, offset_days: Number(d.trigger_config.offset_days) } : {},
      conditions: d.conditions.map((c) => ({ ...c, value: c.op === "in" || c.op === "not_in" ? c.value.split(",").map((v) => v.trim()).filter(Boolean) : c.value })) };
    const r = await saveAutomationAction(state?.id ?? null, payload);
    if (r.ok) { toast.success(state?.id ? "Automation saved" : "Automation created"); onClose(); } else setError({ message: r.error, field: r.field });
  });
  const err = (f: string) => (error?.field === f ? error.message : undefined);
  const listFor = (type: string): { id: string; name: string }[] =>
    type === "department" ? options.departments : type === "location" ? options.locations : type === "designation" ? options.designations : type === "legal_entity" ? options.legalEntities : type === "business_unit" ? options.businessUnits : [];
  return (
    <Drawer open={!!state} onOpenChange={(o) => !o && onClose()} title={state?.id ? "Edit automation" : "New automation"} description={trig.hint}
      footer={<div className="flex w-full items-center justify-between gap-2">
        {state?.id ? <ConfirmDialog trigger={<Button variant="ghost" size="sm"><Trash2 />Delete</Button>} title="Delete this automation?" description="Its run log goes with it." confirmLabel="Delete"
          onConfirm={async () => { const r = await deleteAutomationAction(state.id!); if (r.ok) { toast.success("Deleted"); onClose(); } else toast.error(r.error); }} /> : <span />}
        <span className="flex gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>{state?.id ? "Save" : "Create"}</Button></span>
      </div>}>
      <div className="flex flex-col gap-5">
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <Field label="Name" required error={err("name")}><Input value={d.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} placeholder="e.g. Welcome new joiners" /></Field>
        <Field label="When" required error={err("trigger")}>
          <Select value={d.trigger} onValueChange={(v) => set({ trigger: v as Trigger })} options={TRIGGERS.map((t) => ({ value: t.key, label: t.label }))} />
        </Field>
        {d.trigger === "date_offset" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Counting from" error={err("trigger_config")}><Select value={d.trigger_config.field} onValueChange={(v) => set({ trigger_config: { ...d.trigger_config, field: v } })} options={DATE_FIELDS.map((f) => ({ value: f.key, label: f.label }))} /></Field>
            <Field label="Days (negative = before)" help="-7 runs a week before; 30 runs a month after."><Input type="number" inputMode="numeric" value={d.trigger_config.offset_days} onChange={(e) => set({ trigger_config: { ...d.trigger_config, offset_days: e.target.value } })} /></Field>
          </div>
        )}
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Only if <span className="font-normal text-text-muted">(all must hold)</span></legend>
          {err("conditions") && <p role="alert" className="text-sm text-danger-text">{err("conditions")}</p>}
          {d.conditions.map((c, i) => {
            const f = CONDITION_FIELDS.find((x) => x.key === c.field)!;
            const list = listFor(f.type);
            const multi = c.op === "in" || c.op === "not_in";
            return (
              <div key={i} className="grid grid-cols-[1fr_auto] gap-2 rounded-md border border-border p-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                <Select aria-label="Field" value={c.field} onValueChange={(v) => update(i, { field: v, value: "" })} options={CONDITION_FIELDS.map((x) => ({ value: x.key, label: x.label }))} />
                <Select aria-label="Comparison" value={c.op} onValueChange={(v) => update(i, { op: v })} options={OPS.filter((o) => f.type === "number" || (o !== "gte" && o !== "lte")).map((o) => ({ value: o, label: OP_LABELS[o] }))} />
                {list.length && !multi ? <Select aria-label="Value" value={c.value} onValueChange={(v) => update(i, { value: v })} options={list.map((x) => ({ value: x.id, label: x.name }))} placeholder="Pick one" />
                  : "values" in f && !multi ? <Select aria-label="Value" value={c.value} onValueChange={(v) => update(i, { value: v })} options={(f.values as readonly string[]).map((v) => ({ value: v, label: v.replace(/_/g, " ") }))} />
                  : <Input aria-label="Value" value={c.value} onChange={(e) => update(i, { value: e.target.value })} placeholder={multi ? (list.length ? "Pick ids below, comma separated" : "a, b, c") : f.type === "number" ? "0" : "value"} list={list.length ? `opts-${i}` : undefined} />}
                {list.length && multi ? <datalist id={`opts-${i}`}>{list.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</datalist> : null}
                <IconButton label="Remove condition" onClick={() => set({ conditions: d.conditions.filter((_, j) => j !== i) })}><X /></IconButton>
              </div>
            );
            function update(idx: number, patch: Partial<Draft["conditions"][number]>) { set({ conditions: d.conditions.map((x, j) => (j === idx ? { ...x, ...patch } : x)) }); }
          })}
          <div><Button size="sm" variant="secondary" disabled={d.conditions.length >= 10} onClick={() => set({ conditions: [...d.conditions, { field: "department_id", op: "eq", value: "" }] })}><Plus />Add condition</Button></div>
        </fieldset>
        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium">Then</legend>
          {err("actions") && <p role="alert" className="text-sm text-danger-text">{err("actions")}</p>}
          {d.actions.map((a, i) => <ActionEditor key={i} a={a} options={options} onChange={(next) => set({ actions: d.actions.map((x, j) => (j === i ? next : x)) })} onRemove={() => set({ actions: d.actions.filter((_, j) => j !== i) })} />)}
          <div><Button size="sm" variant="secondary" disabled={d.actions.length >= 8} onClick={() => set({ actions: [...d.actions, { type: "notify", to: ["employee"], title: "", body: "" }] })}><Plus />Add action</Button></div>
          <p className="text-sm text-text-muted">Placeholders: {PLACEHOLDERS.map((p) => <code key={p} className="mr-1 font-mono text-xs">{`{{${p}}}`}</code>)}</p>
        </fieldset>
        <Switch label="Turned on" checked={d.is_active} onCheckedChange={(v) => set({ is_active: v })} />
      </div>
    </Drawer>
  );
}

function RecipientPicker({ value, multiple, options, onChange }: { value: string[]; multiple: boolean; options: Options; onChange: (v: string[]) => void }) {
  const opts = [
    ...RECIPIENTS.map((r) => ({ value: r.key, label: r.label })),
    ...options.roles.filter((r) => r.key !== "hr_admin").map((r) => ({ value: `role:${r.key}`, label: `Everyone with role: ${r.name}` })),
    ...options.people.map((p) => ({ value: `employee:${p.id}`, label: p.name })),
  ];
  if (!multiple) return <Select aria-label="Who" value={value[0] ?? ""} onValueChange={(v) => onChange([v])} options={opts} placeholder="Pick someone" />;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1">{value.map((v) => <Badge key={v} tone="neutral">{opts.find((o) => o.value === v)?.label ?? v}<button type="button" aria-label={`Remove ${v}`} className="ml-1" onClick={() => onChange(value.filter((x) => x !== v))}><X className="size-3" /></button></Badge>)}</div>
      <Select aria-label="Add recipient" value="" onValueChange={(v) => v && !value.includes(v) && onChange([...value, v])} options={opts.filter((o) => !value.includes(o.value))} placeholder="Add people…" />
    </div>
  );
}

function ActionEditor({ a, options, onChange, onRemove }: { a: Record<string, unknown>; options: Options; onChange: (a: Record<string, unknown>) => void; onRemove: () => void }) {
  const type = String(a.type);
  const to = Array.isArray(a.to) ? (a.to as string[]) : a.to ? [String(a.to)] : [];
  const patch = (p: Record<string, unknown>) => onChange({ ...a, ...p });
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <Select aria-label="Action" value={type} onValueChange={(v) => onChange({ type: v, to: v === "task" ? "manager" : ["employee"], title: "", body: "", subject: "", due_days: 3, url: "", group_id: "" })} options={ACTION_TYPES.map((t) => ({ value: t.key, label: t.label }))} className="flex-1" />
        <IconButton label="Remove action" onClick={onRemove}><X /></IconButton>
      </div>
      <p className="text-sm text-text-muted">{ACTION_TYPES.find((t) => t.key === type)?.hint}</p>
      {(type === "notify" || type === "email") && <Field label="To"><RecipientPicker value={to} multiple options={options} onChange={(v) => patch({ to: v })} /></Field>}
      {type === "task" && <Field label="Owner"><RecipientPicker value={to} multiple={false} options={options} onChange={(v) => patch({ to: v[0] })} /></Field>}
      {(type === "notify" || type === "task" || type === "announcement") && <Field label="Title"><Input value={String(a.title ?? "")} onChange={(e) => patch({ title: e.target.value })} maxLength={160} placeholder="e.g. Welcome {{employee.first_name}}!" /></Field>}
      {type === "email" && <Field label="Subject"><Input value={String(a.subject ?? "")} onChange={(e) => patch({ subject: e.target.value })} maxLength={160} /></Field>}
      {(type === "notify" || type === "email" || type === "announcement") && <Field label={type === "notify" ? "Message (optional)" : "Message"}><Textarea rows={3} value={String(a.body ?? "")} onChange={(e) => patch({ body: e.target.value })} maxLength={2000} /></Field>}
      {type === "task" && <Field label="Due in (days)"><Input type="number" inputMode="numeric" min={0} max={365} value={String(a.due_days ?? 3)} onChange={(e) => patch({ due_days: Number(e.target.value) })} /></Field>}
      {type === "group" && <Field label="Group">{options.groups.length ? <Select value={String(a.group_id ?? "")} onValueChange={(v) => patch({ group_id: v })} options={options.groups.map((g) => ({ value: g.id, label: g.name }))} placeholder="Pick a group" /> : <p className="text-sm text-text-muted">No groups yet. Create one under Settings → Groups.</p>}</Field>}
      {type === "webhook" && <Field label="URL" help="https only. Signed like every other webhook (see Settings → API & webhooks)."><Input type="url" value={String(a.url ?? "")} onChange={(e) => patch({ url: e.target.value })} placeholder="https://…" /></Field>}
    </div>
  );
}
