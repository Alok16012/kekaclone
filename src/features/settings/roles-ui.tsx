"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, Lock, Plus, ShieldCheck, Trash2, UserPlus, X } from "lucide-react";
import { Button, IconButton } from "@/ui/button";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Avatar } from "@/ui/avatar";
import { Checkbox } from "@/ui/choice";
import { Field, Input } from "@/ui/field";
import { ConfirmDialog, Modal } from "@/ui/overlay";
import { Banner, EmptyState } from "@/ui/feedback";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { toast } from "@/ui/toast";
import { PERMISSIONS, SCOPE_LABELS, type Scope, type ScopeType } from "@/server/auth/catalog";
import type { Member, RoleRow } from "@/server/modules/settings/roles";
import { assignRoleAction, deleteRoleAction, saveRoleAction, unassignRoleAction } from "@/app/(app)/actions";

const SYSTEM_ROLES: { key: string; what: string }[] = [
  { key: "global_admin", what: "Everything, including billing and sign-in security." },
  { key: "hr_admin", what: "People, leave, attendance, documents, exits, onboarding, hiring and performance set-up." },
  { key: "payroll_admin", what: "Salaries, bank and statutory details, payroll runs and settlements." },
  { key: "finance", what: "Second-level expense approval and payouts." },
  { key: "recruiter", what: "Jobs, candidates, interviews and offers for the jobs they're on." },
];

export function RoleList({ roles, canEdit }: { roles: RoleRow[]; canEdit: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [pending, start] = React.useTransition();
  const have = new Set(roles.map((r) => r.key));
  return (
    <div className="flex flex-col gap-4">
    <Banner tone="info" title="Built-in roles and the manager">
      <p>erp ships with {SYSTEM_ROLES.filter((s) => have.has(s.key)).map((s) => roles.find((r) => r.key === s.key)?.name).join(", ")}. {SYSTEM_ROLES.map((s) => `${roles.find((r) => r.key === s.key)?.name ?? s.key}: ${s.what}`).join(" ")}</p>
      <p className="mt-1"><strong>Manager</strong> isn&apos;t a role you assign: whoever is set as someone&apos;s reporting manager on their profile approves their requests, sees their team pages and gets their checklist tasks, automatically. Employees need no role at all for their own pages.</p>
    </Banner>
    <Card>
      <CardHeader title="Roles" description="A role is a set of permissions. Give it to people, optionally only for some departments or locations."
        action={canEdit ? (
          <Modal open={open} onOpenChange={setOpen} size="sm" title="New role" trigger={<Button size="sm"><Plus />New role</Button>}
            footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={pending} onClick={() => start(async () => {
              const r = await saveRoleAction(null, { name, permissions: [] });
              if (!r.ok) { toast.error(r.error); return; }
              setOpen(false); setName(""); router.push(`/settings/roles/${r.data!.id}`);
            })}>Create</Button></>}>
            <Field label="Role name" help="e.g. Payroll admin, Location HR"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={80} /></Field>
          </Modal>
        ) : undefined} />
      <ul className="divide-y divide-border border-t border-border">
        {roles.map((r) => (
          <li key={r.id}>
            <Link href={`/settings/roles/${r.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-sunken">
              <span className="flex size-9 items-center justify-center rounded-md bg-accent-soft text-accent-text"><ShieldCheck className="size-4" /></span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-base font-medium">{r.name}{r.is_system && <Badge>Built-in</Badge>}</span>
                <span className="block text-sm text-text-muted">{r.permissions.includes("*") ? "Everything" : `${r.permissions.length} ${r.permissions.length === 1 ? "permission" : "permissions"}`} · {r.members} {r.members === 1 ? "person" : "people"}</span>
              </span>
              <ChevronRight className="size-4 text-text-muted" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
    </div>
  );
}

type Option = { id: string; name: string };

export function RoleDetail({ role, members, people, options, canEdit }: {
  role: RoleRow; members: Member[]; people: Person[]; options: Record<ScopeType, Option[]>; canEdit: boolean;
}) {
  const router = useRouter();
  const all = role.permissions.includes("*");
  const locked = all || !canEdit;
  const [name, setName] = React.useState(role.name);
  const [perms, setPerms] = React.useState<Set<string>>(new Set(role.permissions));
  const [saving, startSave] = React.useTransition();
  const dirty = name !== role.name || perms.size !== role.permissions.length || [...perms].some((p) => !role.permissions.includes(p));
  const names = (type: ScopeType, ids: string[]) => ids.map((id) => options[type].find((o) => o.id === id)?.name ?? "?").join(", ");

  return (
    <div className="flex flex-col gap-4">
      <Link href="/settings/roles" className="text-sm text-text-muted hover:text-text">← All roles</Link>
      <Card>
        <CardHeader title={role.name} description={all ? "Global admins can do everything, including managing roles. There must always be at least one." : role.is_system ? "Built-in role. You can change its permissions." : "Custom role"}
          action={canEdit && !role.is_system ? (
            <ConfirmDialog title={`Delete ${role.name}?`} description={`${role.members} ${role.members === 1 ? "person loses" : "people lose"} these permissions.`} confirmLabel="Delete role"
              onConfirm={async () => { const r = await deleteRoleAction(role.id); if (r.ok) { toast.success("Role deleted"); router.push("/settings/roles"); } else toast.error(r.error); }}
              trigger={<Button variant="ghost" size="sm"><Trash2 />Delete</Button>} />
          ) : undefined} />
        <CardBody className="flex flex-col gap-5">
          {!role.is_system && canEdit && <Field label="Role name" className="max-w-sm"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>}
          {all ? (
            <Banner tone="info" title="Every permission">Including ones added to erp in the future.</Banner>
          ) : (
            <div className="grid gap-5 md:grid-cols-2">
              {PERMISSIONS.map((g) => (
                <fieldset key={g.group} className="flex flex-col gap-2.5">
                  <legend className="mb-1 text-sm font-semibold">{g.group}</legend>
                  {g.items.map((i) => (
                    <Checkbox key={i.key} label={i.label} disabled={locked} checked={perms.has(i.key)}
                      onCheckedChange={(c) => setPerms((s) => { const n = new Set(s); if (c) n.add(i.key); else n.delete(i.key); return n; })} />
                  ))}
                </fieldset>
              ))}
            </div>
          )}
          {!locked && (
            <div className="flex justify-end gap-2">
              <Button variant="secondary" disabled={!dirty} onClick={() => { setName(role.name); setPerms(new Set(role.permissions)); }}>Reset</Button>
              <Button disabled={!dirty} loading={saving} onClick={() => startSave(async () => { const r = await saveRoleAction(role.id, { name, permissions: [...perms] }); if (r.ok) toast.success("Role saved"); else toast.error(r.error); })}>Save permissions</Button>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="People with this role" description="Leave the scope empty to apply it across the whole company."
          action={canEdit ? <AddMember roleId={role.id} people={people.filter((p) => !members.some((m) => m.employee_id === p.id))} options={options} /> : undefined} />
        {members.length === 0 ? (
          <EmptyState compact title="No one has this role yet" />
        ) : (
          <ul className="divide-y divide-border border-t border-border">
            {members.map((m) => (
              <li key={m.assignment_id} className="flex items-center gap-3 px-5 py-3">
                <Avatar name={m.name} size="sm" />
                <span className="min-w-0 flex-1">
                  <Link href={`/people/${m.employee_id}`} className="block truncate text-base font-medium hover:underline">{m.name}</Link>
                  <span className="block text-sm text-text-muted">
                    {m.scopes.length === 0 ? "Whole company" : m.scopes.map((s) => `${SCOPE_LABELS[s.type]}: ${names(s.type, s.ids)}`).join(" · ")}
                  </span>
                </span>
                {canEdit && (
                  <ConfirmDialog title={`Remove ${m.name} from ${role.name}?`} description="They lose these permissions straight away." confirmLabel="Remove"
                    onConfirm={async () => { const r = await unassignRoleAction(m.assignment_id); if (r.ok) toast.success(`${m.name} removed`); else toast.error(r.error); }}
                    trigger={<IconButton label={`Remove ${m.name}`} size="icon-sm"><X /></IconButton>} />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {!canEdit && <p className="flex items-center gap-1.5 text-sm text-text-muted"><Lock className="size-3.5" aria-hidden />Only people who can manage roles can change this.</p>}
    </div>
  );
}

function AddMember({ roleId, people, options }: { roleId: string; people: Person[]; options: Record<ScopeType, Option[]> }) {
  const [open, setOpen] = React.useState(false);
  const [who, setWho] = React.useState<string[]>([]);
  const [scope, setScope] = React.useState<Record<ScopeType, Set<string>>>({ department: new Set(), location: new Set(), legal_entity: new Set(), business_unit: new Set() });
  const [pending, start] = React.useTransition();
  const toggle = (t: ScopeType, id: string, on: boolean) => setScope((s) => { const n = new Set(s[t]); if (on) n.add(id); else n.delete(id); return { ...s, [t]: n }; });
  const reset = () => { setWho([]); setScope({ department: new Set(), location: new Set(), legal_entity: new Set(), business_unit: new Set() }); };
  const scopes: Scope[] = (Object.keys(scope) as ScopeType[]).filter((t) => scope[t].size).map((t) => ({ type: t, ids: [...scope[t]] }));
  return (
    <Modal open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }} title="Give this role to someone" trigger={<Button size="sm"><UserPlus />Add person</Button>}
      footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!who.length} loading={pending} onClick={() => start(async () => {
        for (const id of who) { const r = await assignRoleAction(roleId, id, scopes); if (!r.ok) { toast.error(r.error); return; } }
        toast.success(who.length === 1 ? "Role given" : `Role given to ${who.length} people`); setOpen(false); reset();
      })}>Give role</Button></>}>
      <div className="flex flex-col gap-5">
        <Field label="People"><EmployeePicker multiple people={people} value={who} onChange={setWho} /></Field>
        <div>
          <p className="text-sm font-semibold">Limit to (optional)</p>
          <p className="mb-3 text-sm text-text-muted">{scopes.length ? "They can act only on people in all of the selected groups." : "No limit: they can act on everyone."}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            {(["department", "location"] as ScopeType[]).map((t) => (
              <fieldset key={t} className="flex max-h-48 flex-col gap-2 overflow-y-auto rounded-md border border-border p-3">
                <legend className="px-1 text-sm font-medium">{SCOPE_LABELS[t]}</legend>
                {options[t].length === 0 ? <p className="text-sm text-text-muted">None set up</p> : options[t].map((o) => (
                  <Checkbox key={o.id} label={o.name} checked={scope[t].has(o.id)} onCheckedChange={(c) => toggle(t, o.id, !!c)} />
                ))}
              </fieldset>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
