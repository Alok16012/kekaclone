"use client";
import * as React from "react";
import { ArrowDown, ArrowUp, GitBranch, MoreHorizontal, Pencil, Plus, Trash2, UserRoundCheck, X } from "lucide-react";
import { Button, IconButton } from "@/ui/button";
import { Card, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Switch } from "@/ui/choice";
import { ConfirmDialog, Menu, Modal } from "@/ui/overlay";
import { Banner, EmptyState } from "@/ui/feedback";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { toast } from "@/ui/toast";
import { cancelDelegationAction, deleteWorkflowAction, saveDelegationAction, saveWorkflowAction } from "@/app/(app)/corehr/actions";
import { CONDITION_FIELDS, CONDITION_LABELS, type Condition, type ConditionField, type LevelSpec } from "@/server/modules/corehr/rules";

type Opt = { id: string; name: string };
export type WorkflowItem = { id: string; entity_type: string; name: string; conditions: Condition[]; levels: LevelSpec[]; auto_approve_after_days: number | null; escalation: { afterDays: number; to: LevelSpec } | null; priority: number; is_active: boolean; pending: number };
export type ApprovalOptions = { values: Record<ConditionField, Opt[]>; roles: { key: string; name: string }[]; people: Person[] };
export type Delegation = { id: string; delegator_id: string; delegator: string; delegate_id: string; delegate: string; from_date: string; to_date: string | null; reason: string | null; active: boolean };

const fmt = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
function levelLabel(l: LevelSpec, o: ApprovalOptions) {
  if (l.approver === "manager") return "Reporting manager";
  if (l.approver === "l2_manager") return "Second-level manager";
  if (l.approver === "role") return o.roles.find((r) => r.key === l.role)?.name ?? l.role ?? "Role";
  return o.people.find((p) => p.id === l.id)?.name ?? "Someone who left";
}

/** Approval chains per request type: who approves, for whom (conditions), timers. The engine uses the first match. */
export function ApprovalSettings({ rows, options, entities, defaults }: { rows: WorkflowItem[]; options: ApprovalOptions; entities: { value: string; label: string }[]; defaults: Record<string, LevelSpec[]> }) {
  const [editing, setEditing] = React.useState<WorkflowItem | { entity_type: string } | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="Approval workflows" description="For each kind of request, the first active workflow whose conditions match the requester decides who approves. Without one, the default applies."
          action={<Button size="sm" onClick={() => setEditing({ entity_type: entities[0]?.value ?? "leave" })}><Plus />Add workflow</Button>} />
        <ul className="divide-y divide-border border-t border-border">
          {entities.map((e) => {
            const mine = rows.filter((r) => r.entity_type === e.value);
            return (
              <li key={e.value} className="px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-base font-semibold">{e.label}</h4>
                  <Button variant="ghost" size="sm" onClick={() => setEditing({ entity_type: e.value })}><Plus />Add</Button>
                </div>
                {mine.length === 0 ? (
                  <p className="mt-1 text-sm text-text-muted">Default: {(defaults[e.value] ?? []).map((l) => levelLabel(l, options)).join(" → ") || "approved straight away"}</p>
                ) : (
                  <ul className="mt-2 flex flex-col gap-2">
                    {mine.map((w) => (
                      <li key={w.id} className="flex items-start gap-3 rounded-md border border-border p-3">
                        <GitBranch className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden />
                        <div className="min-w-0 flex-1">
                          <p className="flex flex-wrap items-center gap-2 text-base font-medium">{w.name}{!w.is_active && <Badge>Off</Badge>}{w.pending > 0 && <Badge tone="accent">{w.pending} pending</Badge>}</p>
                          <p className="text-sm text-text-muted">{w.levels.length ? w.levels.map((l) => levelLabel(l, options)).join(" → ") : "Approved straight away"}</p>
                          <p className="text-sm text-text-muted">
                            {w.conditions.length ? w.conditions.map((c) => `${CONDITION_LABELS[c.field]}: ${c.values.map((v) => options.values[c.field].find((x) => x.id === v)?.name ?? "?").join(", ")}`).join(" · ") : "Everyone"}
                            {w.auto_approve_after_days ? ` · auto-approves after ${w.auto_approve_after_days} days` : ""}
                            {w.escalation ? ` · escalates to ${levelLabel(w.escalation.to, options)} after ${w.escalation.afterDays} days` : ""}
                          </p>
                        </div>
                        <Menu trigger={<IconButton label={`Actions for ${w.name}`} size="icon-sm"><MoreHorizontal /></IconButton>} items={[
                          { label: "Edit", icon: <Pencil />, onSelect: () => setEditing(w) },
                          { label: "Delete", icon: <Trash2 />, danger: true, onSelect: async () => { const r = await deleteWorkflowAction(w.id); if (r.ok) toast.success("Workflow deleted", { description: "Requests already in progress keep their approvers." }); else toast.error(r.error); } },
                        ]} />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
      {editing && <WorkflowDialog w={"id" in editing ? editing : null} entity={editing.entity_type} entities={entities} options={options} onClose={() => setEditing(null)} />}
    </div>
  );
}

function LevelPicker({ value, onChange, options, label }: { value: LevelSpec; onChange: (l: LevelSpec) => void; options: ApprovalOptions; label: string }) {
  return (
    <div className="grid flex-1 gap-2 sm:grid-cols-2">
      <Select value={value.approver} onValueChange={(a) => onChange({ approver: a as LevelSpec["approver"], role: a === "role" ? options.roles[0]?.key : undefined })}
        options={[{ value: "manager", label: "Reporting manager" }, { value: "l2_manager", label: "Second-level manager" }, { value: "role", label: "Someone with a role" }, { value: "employee", label: "A specific person" }]} />
      {value.approver === "role" && <Select value={value.role} onValueChange={(r) => onChange({ approver: "role", role: r })} options={options.roles.map((r) => ({ value: r.key, label: r.name }))} placeholder="Choose a role" />}
      {value.approver === "employee" && <EmployeePicker people={options.people} value={value.id ? [value.id] : []} onChange={(ids) => onChange({ approver: "employee", id: ids[0] })} placeholder={`Choose ${label}`} />}
    </div>
  );
}

function WorkflowDialog({ w, entity: e0, entities, options, onClose }: { w: WorkflowItem | null; entity: string; entities: { value: string; label: string }[]; options: ApprovalOptions; onClose: () => void }) {
  const [entity, setEntity] = React.useState(w?.entity_type ?? e0);
  const [name, setName] = React.useState(w?.name ?? "");
  const [levels, setLevels] = React.useState<LevelSpec[]>(w?.levels ?? [{ approver: "manager" }]);
  const [conds, setConds] = React.useState<Partial<Record<ConditionField, string[]>>>(Object.fromEntries((w?.conditions ?? []).map((c) => [c.field, c.values])));
  const [auto, setAuto] = React.useState(w?.auto_approve_after_days ? String(w.auto_approve_after_days) : "");
  const [esc, setEsc] = React.useState<{ afterDays: string; to: LevelSpec } | null>(w?.escalation ? { afterDays: String(w.escalation.afterDays), to: w.escalation.to } : null);
  const [priority, setPriority] = React.useState(String(w?.priority ?? 0));
  const [active, setActive] = React.useState(w?.is_active ?? true);
  const [pending, start] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const move = (i: number, by: number) => setLevels((ls) => { const n = [...ls]; const [x] = n.splice(i, 1); n.splice(i + by, 0, x); return n; });
  const submit = () => start(async () => {
    setError(null);
    const r = await saveWorkflowAction(w?.id ?? null, {
      entityType: entity, name, levels, priority: Number(priority) || 0, isActive: active,
      conditions: CONDITION_FIELDS.filter((f) => conds[f]?.length).map((f) => ({ field: f, values: conds[f]! })),
      autoApproveAfterDays: auto ? Number(auto) : null, escalation: esc ? { afterDays: Number(esc.afterDays), to: esc.to } : null,
    });
    if (!r.ok) { setError(r.error); return; }
    toast.success(w ? "Workflow saved" : "Workflow added", { description: "New requests use it from now on." });
    onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="lg" title={w ? `Edit ${w.name}` : "New approval workflow"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={submit}>Save</Button></>}>
      <div className="flex flex-col gap-5">
        {error && <Banner tone="danger">{error}</Banner>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Sales leave: manager then HR" /></Field>
          <Field label="Applies to" help={w ? "Fixed once created" : undefined}><Select value={entity} onValueChange={setEntity} disabled={!!w} options={entities} /></Field>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Approvers, in order</legend>
          {levels.length === 0 && <p className="text-sm text-text-muted">No levels: requests are approved straight away.</p>}
          {levels.map((l, i) => (
            <div key={i} className="flex flex-wrap items-start gap-2 rounded-md bg-surface-sunken p-2">
              <span className="mt-2 w-6 text-center text-sm font-semibold tabular text-text-muted">{i + 1}</span>
              <LevelPicker value={l} onChange={(x) => setLevels((ls) => ls.map((y, j) => (j === i ? x : y)))} options={options} label="an approver" />
              <div className="flex gap-1">
                <IconButton label="Move up" size="icon-sm" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp /></IconButton>
                <IconButton label="Move down" size="icon-sm" disabled={i === levels.length - 1} onClick={() => move(i, 1)}><ArrowDown /></IconButton>
                <IconButton label={`Remove level ${i + 1}`} size="icon-sm" onClick={() => setLevels((ls) => ls.filter((_, j) => j !== i))}><X /></IconButton>
              </div>
            </div>
          ))}
          {levels.length < 6 && <Button variant="ghost" size="sm" className="self-start" onClick={() => setLevels((ls) => [...ls, { approver: "role", role: options.roles[0]?.key }])}><Plus />Add a level</Button>}
          <p className="text-xs text-text-muted">Nobody approves their own request: if a level would land on the requester, it&apos;s skipped. People who are away hand over to their delegate.</p>
        </fieldset>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-medium">Only for (leave empty for everyone)</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {CONDITION_FIELDS.filter((f) => options.values[f].length).map((f) => (
              <Field key={f} label={CONDITION_LABELS[f]}>
                <EmployeePicker multiple people={options.values[f].map((x) => ({ id: x.id, name: x.name }))} value={conds[f] ?? []} onChange={(ids) => setConds((c) => ({ ...c, [f]: ids }))} placeholder="Any" />
              </Field>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Auto-approve after (days)" help="Empty: wait for a decision"><Input type="number" min={1} max={90} value={auto} onChange={(e) => setAuto(e.target.value)} /></Field>
          <Field label="Priority" help="Higher wins when several match"><Input type="number" min={0} max={1000} value={priority} onChange={(e) => setPriority(e.target.value)} /></Field>
        </div>
        <div className="flex flex-col gap-3 rounded-md border border-border p-3">
          <Switch label="Escalate requests that wait too long" checked={!!esc} onCheckedChange={(c) => setEsc(c ? { afterDays: "3", to: { approver: "manager" } } : null)} />
          {esc && (
            <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
              <Field label="After (days)"><Input type="number" min={1} max={30} value={esc.afterDays} onChange={(e) => setEsc({ ...esc, afterDays: e.target.value })} /></Field>
              <Field label="Move it to" help="“Reporting manager” means the waiting approver's own manager"><LevelPicker value={esc.to} onChange={(to) => setEsc({ ...esc, to })} options={options} label="who gets it" /></Field>
            </div>
          )}
        </div>
        <Switch label="Active" checked={active} onCheckedChange={(c) => setActive(!!c)} />
      </div>
    </Modal>
  );
}

/** Hand-overs: while someone is away, their approvals go to a delegate. */
export function Delegations({ rows, people, meId, canAll, today }: { rows: Delegation[]; people: Person[]; meId: string; canAll: boolean; today: string }) {
  return (
    <Card>
      <CardHeader title="Approval hand-overs" description={canAll ? "Everyone's current and upcoming hand-overs. Requests waiting with someone away move to their delegate (or their manager when they're on leave or have left) every night." : "While you're away, your approvals go to someone you choose."}
        action={<DelegationDialog people={people} meId={meId} canAll={canAll} today={today} trigger={<Button size="sm"><UserRoundCheck />Hand over</Button>} />} />
      {rows.length === 0 ? <EmptyState compact icon={<UserRoundCheck />} title="No hand-overs" /> : (
        <ul className="divide-y divide-border border-t border-border">
          {rows.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-base font-medium">{d.delegator} → {d.delegate} {d.active && <Badge tone="success">Active</Badge>}</p>
                <p className="text-sm text-text-muted">{fmt(d.from_date)} – {d.to_date ? fmt(d.to_date) : "until cancelled"}{d.reason ? ` · ${d.reason}` : ""}</p>
              </div>
              {(canAll || d.delegator_id === meId) && (
                <ConfirmDialog title="Cancel this hand-over?" description="New requests go back to the original approver. Ones already moved stay where they are." confirmLabel="Cancel hand-over"
                  onConfirm={async () => { const r = await cancelDelegationAction(d.id); if (r.ok) toast.success("Hand-over cancelled"); else toast.error(r.error); }}
                  trigger={<Button variant="ghost" size="sm">Cancel</Button>} />
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function DelegationDialog({ people, meId, canAll, trigger, today }: { people: Person[]; meId: string; canAll: boolean; trigger: React.ReactNode; today: string }) {
  const [open, setOpen] = React.useState(false);
  const [v, setV] = React.useState({ delegatorId: meId, delegateId: "", from: today, to: "", reason: "" });
  const [pending, start] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const submit = () => start(async () => {
    setError(null);
    const r = await saveDelegationAction({ delegatorId: v.delegatorId, delegateId: v.delegateId, from: v.from, to: v.to || null, reason: v.reason || null });
    if (!r.ok) { setError(r.error); return; }
    toast.success("Hand-over saved", { description: r.data!.moved ? `${r.data!.moved} waiting ${r.data!.moved === 1 ? "request" : "requests"} moved now.` : undefined });
    setOpen(false);
  });
  return (
    <>
      <Modal trigger={trigger} open={open} onOpenChange={setOpen} title="Hand over approvals" description="Requests that come in while the hand-over is active go to the delegate."
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={pending} onClick={submit}>Save</Button></>}>
        <div className="grid gap-4 sm:grid-cols-2">
          {error && <Banner tone="danger" className="sm:col-span-2">{error}</Banner>}
          {canAll && <Field label="Whose approvals" className="sm:col-span-2"><EmployeePicker people={people} value={[v.delegatorId]} onChange={(ids) => setV((s) => ({ ...s, delegatorId: ids[0] ?? meId }))} /></Field>}
          <Field label="Goes to" required className="sm:col-span-2"><EmployeePicker people={people.filter((p) => p.id !== v.delegatorId)} value={v.delegateId ? [v.delegateId] : []} onChange={(ids) => setV((s) => ({ ...s, delegateId: ids[0] ?? "" }))} placeholder="Choose a colleague" /></Field>
          <Field label="From"><Input type="date" value={v.from} min={today} onChange={(e) => setV((s) => ({ ...s, from: e.target.value }))} /></Field>
          <Field label="Until" help="Empty: until you cancel it"><Input type="date" value={v.to} min={v.from} onChange={(e) => setV((s) => ({ ...s, to: e.target.value }))} /></Field>
          <Field label="Reason" className="sm:col-span-2"><Textarea value={v.reason} onChange={(e) => setV((s) => ({ ...s, reason: e.target.value }))} maxLength={300} placeholder="On leave for a family wedding" /></Field>
        </div>
      </Modal>
    </>
  );
}
