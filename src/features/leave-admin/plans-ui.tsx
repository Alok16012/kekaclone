"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookOpenText, ChevronRight, ClipboardList, Lock, MoreHorizontal, Pencil, Plus, Trash2, UserPlus, Users } from "lucide-react";
import { Button, IconButton } from "@/ui/button";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Field, Input, Textarea } from "@/ui/field";
import { RadioGroup, Switch } from "@/ui/choice";
import { Select } from "@/ui/select";
import { ConfirmDialog, Menu, Modal } from "@/ui/overlay";
import { Banner, EmptyState } from "@/ui/feedback";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { Avatar } from "@/ui/avatar";
import { toast } from "@/ui/toast";
import { addTypeToPlanAction, assignPlanAction, deletePlanAction, removeRuleAction, savePlanAction } from "@/app/(app)/settings/leave/actions";
import { FREQ_LABEL, KIND_LABEL, YEAR_START_LABEL, fmtNum } from "./labels";
import { RuleEditor, type RuleRow } from "./rule-editor";

export type PlanRow = { id: string; name: string; description: string | null; year_start: "jan" | "apr" | "joining_date"; is_default: boolean; people: number; types: number };

export function PlanList({ plans }: { plans: PlanRow[] }) {
  const [adding, setAdding] = React.useState(false);
  return (
    <Card>
      <CardHeader title="Leave plans" description="A plan bundles leave types with their quotas and rules. Everyone is on exactly one plan."
        action={<Button size="sm" onClick={() => setAdding(true)}><Plus />Add plan</Button>} />
      {plans.length === 0 ? (
        <EmptyState compact icon={<ClipboardList />} title="No leave plans yet" description="Create a plan, add leave types to it, then move people onto it." />
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {plans.map((p) => (
            <li key={p.id}>
              <Link href={`/settings/leave/plans/${p.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-sunken focus-visible:outline-offset-[-2px]">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-base font-medium"><span className="truncate">{p.name}</span>{p.is_default && <Badge tone="accent">Default for new joiners</Badge>}</p>
                  <p className="text-sm text-text-muted">{YEAR_START_LABEL[p.year_start]} · {p.types} leave {p.types === 1 ? "type" : "types"} · {p.people} {p.people === 1 ? "person" : "people"}</p>
                </div>
                <ChevronRight className="size-4 text-text-muted" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {adding && <PlanDialog plan={null} onClose={() => setAdding(false)} />}
    </Card>
  );
}

function PlanDialog({ plan, onClose }: { plan: PlanRow | null; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = React.useState(plan?.name ?? "");
  const [description, setDescription] = React.useState(plan?.description ?? "");
  const [yearStart, setYearStart] = React.useState<string>(plan?.year_start ?? "jan");
  const [isDefault, setIsDefault] = React.useState(plan?.is_default ?? false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    const r = await savePlanAction(plan?.id ?? null, plan ? { name, description, isDefault } : { name, description, yearStart, isDefault });
    if (!r.ok) { setError(r.error); return; }
    toast.success(plan ? "Plan saved" : `${name} created`, { description: plan ? undefined : "Now add leave types to it." });
    onClose();
    if (!plan && r.data) router.push(`/settings/leave/plans/${r.data.id}`);
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={plan ? "Edit plan" : "New leave plan"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>{plan ? "Save" : "Create plan"}</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={80} placeholder="Standard" /></Field>
        <Field label="Description" help="Optional. Who this plan is for."><Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={2} /></Field>
        {plan ? (
          <div className="flex items-start gap-2 rounded-md bg-surface-sunken px-3 py-2 text-sm text-text-muted"><Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>Leave year: <span className="font-medium text-text">{YEAR_START_LABEL[plan.year_start]}</span>. It’s locked once a plan exists, so balances stay consistent.</span></div>
        ) : (
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Leave year</legend>
            <RadioGroup value={yearStart} onValueChange={setYearStart} options={[
              { value: "jan", label: YEAR_START_LABEL.jan, hint: "Calendar year" },
              { value: "apr", label: YEAR_START_LABEL.apr, hint: "Financial year" },
              { value: "joining_date", label: YEAR_START_LABEL.joining_date, hint: "Each person's year starts on their work anniversary" },
            ]} />
            <p className="mt-2 text-sm text-text-muted">You can’t change this after the plan is created.</p>
          </fieldset>
        )}
        <Switch label="Default plan for new joiners" checked={isDefault} disabled={!!plan?.is_default} onCheckedChange={setIsDefault} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

const ruleSummary = (r: RuleRow) => {
  const a = r.accrual as { frequency?: string; upfront?: boolean };
  const freq = a.upfront ? "upfront" : a.frequency ?? "monthly";
  if (r.kind === "comp_off") return "Earned by working off days";
  if (r.yearly_quota == null) return "No limit";
  return `${fmtNum(Number(r.yearly_quota))} days a year · ${freq === "upfront" ? "credited up front" : `${FREQ_LABEL[freq].toLowerCase()} accrual`}`;
};

export function PlanEditor({ plan, rules, members, types, people }: { plan: PlanRow; rules: RuleRow[]; members: Person[]; types: { id: string; name: string; kind: string }[]; people: Person[] }) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [rule, setRule] = React.useState<RuleRow | null>(null);
  const [removing, setRemoving] = React.useState<RuleRow | null>(null);
  const [addType, setAddType] = React.useState<string | undefined>();
  const [move, setMove] = React.useState<string[]>([]);
  const [busy, start] = React.useTransition();
  const available = types.filter((t) => !rules.some((r) => r.leave_type_id === t.id));
  const memberIds = new Set(members.map((m) => m.id));

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader title={<span className="flex flex-wrap items-center gap-2">{plan.name}{plan.is_default && <Badge tone="accent">Default for new joiners</Badge>}</span>}
          description={plan.description ?? undefined}
          action={<div className="flex items-center gap-1">
            <Button asChild variant="secondary" size="sm"><Link href={`/settings/leave/plans/${plan.id}/policy`}><BookOpenText />Policy document</Link></Button>
            <Menu trigger={<IconButton label="Plan actions" size="icon-sm" variant="ghost"><MoreHorizontal /></IconButton>}
            items={[{ label: "Edit details", icon: <Pencil />, onSelect: () => setEditing(true) }, { label: "Delete plan", icon: <Trash2 />, danger: true, onSelect: () => setDeleting(true) }]} /></div>} />
        <CardBody className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <span className="flex items-center gap-1.5 text-text-muted"><Lock className="size-3.5" aria-hidden />Leave year: <span className="font-medium text-text">{YEAR_START_LABEL[plan.year_start]}</span></span>
          <span className="text-text-muted"><span className="font-medium text-text tabular">{members.length}</span> {members.length === 1 ? "person" : "people"}</span>
        </CardBody>
      </Card>

      <Tabs defaultValue="types">
        <TabsList items={[{ value: "types", label: "Leave types", count: rules.length }, { value: "people", label: "People", count: members.length }]} />
        <TabsContent value="types">
          <Card>
            {rules.length === 0 ? (
              <EmptyState compact icon={<ClipboardList />} title="No leave types in this plan" description="Add the leave types people on this plan can take, then set each one's rules." />
            ) : (
              <ul className="divide-y divide-border">
                {rules.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                    <span aria-hidden className="size-3 shrink-0 rounded-pill" style={{ background: r.color }} />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-base font-medium">{r.name}<Badge>{r.code}</Badge><Badge tone="neutral">{KIND_LABEL[r.kind]}</Badge></p>
                      <p className="text-sm text-text-muted">{ruleSummary(r)}</p>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="secondary" onClick={() => setRule(r)}><Pencil />Rules</Button>
                      <IconButton label={`Remove ${r.name} from this plan`} size="icon-sm" variant="ghost" onClick={() => setRemoving(r)}><Trash2 /></IconButton>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-col gap-2 border-t border-border px-5 py-4 sm:flex-row sm:items-end">
              <Field label="Add a leave type" className="flex-1">
                <Select value={addType} onValueChange={setAddType} placeholder={available.length ? "Choose a leave type" : "Every leave type is already in this plan"} disabled={!available.length}
                  options={available.map((t) => ({ value: t.id, label: `${t.name} (${KIND_LABEL[t.kind]})` }))} />
              </Field>
              <Button variant="secondary" disabled={!addType} loading={busy} onClick={() => start(async () => {
                const r = await addTypeToPlanAction(plan.id, addType!);
                if (r.ok) { toast.success("Leave type added", { description: "It starts with sensible rules. Review them now." }); setAddType(undefined); } else toast.error(r.error);
              })}><Plus />Add</Button>
            </div>
            <p className="px-5 pb-4 text-sm text-text-muted">Need a new kind of leave? <Link href="/settings/leave/types" className="text-accent-text underline-offset-4 hover:underline">Create a leave type</Link> first.</p>
          </Card>
        </TabsContent>
        <TabsContent value="people">
          <Card>
            <div className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-end">
              <Field label="Move people to this plan" help="Their balances for the new plan's leave types are credited right away." className="flex-1">
                <EmployeePicker multiple people={people.filter((p) => !memberIds.has(p.id))} value={move} onChange={setMove} placeholder="Search people to move" />
              </Field>
              <Button disabled={!move.length} loading={busy} onClick={() => start(async () => {
                const r = await assignPlanAction(plan.id, move);
                if (r.ok) { toast.success(`${r.data!.moved} ${r.data!.moved === 1 ? "person" : "people"} moved to ${plan.name}`); setMove([]); } else toast.error(r.error);
              })}><UserPlus />Move {move.length ? move.length : ""}</Button>
            </div>
            {members.length === 0 ? (
              <EmptyState compact icon={<Users />} title="No one is on this plan yet" description="Use the picker above to move people here." />
            ) : (
              <ul className="divide-y divide-border border-t border-border">
                {members.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 px-5 py-2.5">
                    <Avatar name={m.name} size="sm" />
                    <span className="min-w-0 flex-1"><span className="block truncate text-base">{m.name}</span>
                      {(m.title || m.department) && <span className="block truncate text-sm text-text-muted">{[m.title, m.department].filter(Boolean).join(" · ")}</span>}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </TabsContent>
      </Tabs>

      {editing && <PlanDialog plan={plan} onClose={() => setEditing(false)} />}
      {rule && <RuleEditor rule={rule} onClose={() => setRule(null)} />}
      {removing && (
        <ConfirmDialog open onOpenChange={(o) => !o && setRemoving(null)} title={`Remove ${removing.name} from ${plan.name}?`}
          description="People on this plan won't be able to apply for it any more. Their history stays." confirmLabel="Remove"
          onConfirm={async () => { const r = await removeRuleAction(removing.id); if (r.ok) toast.success(`${removing.name} removed`); else toast.error(r.error); setRemoving(null); }} />
      )}
      {deleting && (
        <ConfirmDialog open onOpenChange={setDeleting} title={`Delete ${plan.name}?`}
          description={plan.is_default ? "This is the default plan for new joiners, so it can't be deleted." : members.length ? "Move everyone to another plan first." : "This can't be undone."}
          confirmLabel="Delete plan" onConfirm={async () => {
            const r = await deletePlanAction(plan.id);
            if (r.ok) { toast.success(`${plan.name} deleted`); router.push("/settings/leave/plans"); } else toast.error(r.error);
            setDeleting(false);
          }} />
      )}
    </div>
  );
}
