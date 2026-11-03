"use client";
import * as React from "react";
import { BadgeCheck, Eye, GraduationCap, HeartHandshake, IdCard, Pencil, Plus, ShieldAlert, Trash2, Briefcase } from "lucide-react";
import { Button, IconButton } from "@/ui/button";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Checkbox } from "@/ui/choice";
import { ConfirmDialog, Modal } from "@/ui/overlay";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import {
  deleteIdentityAction, deleteSectionRowAction, revealIdentityAction, saveCustomFieldsAction, saveIdentityAction, saveSectionRowAction, verifyIdentityAction,
} from "@/app/(app)/corehr/actions";
import { ID_KINDS, ID_LABELS, displayFieldValue, type FieldValue } from "@/server/modules/corehr/rules";
import type { ProfileSections } from "@/server/modules/corehr/profile-sections";
import type { PersonField } from "@/server/modules/corehr/custom-fields";
import { CustomFieldInput, normaliseFieldValues } from "./custom-field-input";

const fmt = (d: string | null) => (d ? new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : null);
const REL: Record<string, string> = { father: "Father", mother: "Mother", spouse: "Spouse", child: "Child", sibling: "Sibling", other: "Other" };

type Run = (fn: () => Promise<{ ok: boolean; error?: string; field?: string }>, ok: string) => void;
function useRun(close: () => void) {
  const [pending, start] = React.useTransition();
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const run: Run = (fn, ok) => start(async () => { setError(null); const r = await fn(); if (!r.ok) { setError({ message: r.error ?? "Couldn't save.", field: r.field }); return; } toast.success(ok); close(); });
  return { pending, error, setError, run };
}

/** Family, education, experience, identity documents and the company's own fields, under the Profile tab. */
export function ProfileExtras({ employeeId, s, fields, self }: { employeeId: string; s: ProfileSections; fields: PersonField[]; self: boolean }) {
  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <CustomFieldCards employeeId={employeeId} fields={fields} />
      <RowsCard employeeId={employeeId} kind="relation" title="Family" icon={<HeartHandshake />} canEdit={s.canEdit} empty={self ? "Add your family members and who your nominee is." : "No family members added."}
        rows={s.relations.map((r) => ({ id: r.id, title: r.name, sub: [REL[r.relation], r.dob ? `born ${fmt(r.dob)}` : null, r.mobile].filter(Boolean).join(" · "), badge: r.is_nominee ? "Nominee" : null, raw: r }))} />
      <RowsCard employeeId={employeeId} kind="education" title="Education" icon={<GraduationCap />} canEdit={s.canEdit} empty="No education added."
        rows={s.educations.map((r) => ({ id: r.id, title: [r.degree, r.branch].filter(Boolean).join(", "), sub: [r.institution, r.start_year || r.end_year ? `${r.start_year ?? "?"}–${r.end_year ?? "now"}` : null, r.score].filter(Boolean).join(" · "), badge: null, raw: r }))} />
      <RowsCard employeeId={employeeId} kind="experience" title="Previous experience" icon={<Briefcase />} canEdit={s.canEdit} empty="No previous jobs added."
        rows={s.experiences.map((r) => ({ id: r.id, title: [r.title, r.company].filter(Boolean).join(" at "), sub: [r.location, r.start_date ? `${fmt(r.start_date)} – ${fmt(r.end_date) ?? "?"}` : null].filter(Boolean).join(" · "), badge: null, raw: r }))} />
      {s.identities && <IdentityCard employeeId={employeeId} ids={s.identities} canEdit={s.canEdit} isAdmin={s.isAdmin} self={self} />}
    </div>
  );
}

function CustomFieldCards({ employeeId, fields }: { employeeId: string; fields: PersonField[] }) {
  const sections = [...new Set(fields.map((f) => f.section))];
  return <>{sections.map((sec) => <CustomSection key={sec} employeeId={employeeId} title={sec} fields={fields.filter((f) => f.section === sec)} />)}</>;
}

function CustomSection({ employeeId, title, fields }: { employeeId: string; title: string; fields: PersonField[] }) {
  const [open, setOpen] = React.useState(false);
  const [v, setV] = React.useState<Record<string, FieldValue>>({});
  const { pending, error, run } = useRun(() => setOpen(false));
  const editable = fields.filter((f) => f.canEdit);
  return (
    <Card>
      <CardHeader title={title} action={editable.length ? <Button variant="ghost" size="sm" onClick={() => { setV(Object.fromEntries(editable.map((f) => [f.key, f.value]))); setOpen(true); }} aria-label={`Edit ${title}`}><Pencil />Edit</Button> : undefined} />
      <CardBody>
        <dl className="divide-y divide-border">
          {fields.map((f) => (
            <div key={f.key} className="grid grid-cols-[minmax(0,10rem)_1fr] gap-3 py-2">
              <dt className="text-sm text-text-muted">{f.label}</dt>
              <dd className="min-w-0 break-words text-base">{displayFieldValue(f.value) || <span className="text-text-muted">Not added</span>}</dd>
            </div>
          ))}
        </dl>
      </CardBody>
      <Modal open={open} onOpenChange={setOpen} title={`Edit ${title}`}
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={pending} onClick={() => run(() => saveCustomFieldsAction(employeeId, normaliseFieldValues(v)), "Saved")}>Save</Button></>}>
        <div className="flex flex-col gap-4">
          {error && <Banner tone="danger">{error.message}</Banner>}
          {editable.map((f) => <CustomFieldInput key={f.key} f={f} value={v[f.key]} onChange={(x) => setV((s) => ({ ...s, [f.key]: x }))} error={error?.field === f.key ? error.message : undefined} />)}
        </div>
      </Modal>
    </Card>
  );
}

type RowItem = { id: string; title: string; sub: string; badge: string | null; raw: Record<string, unknown> };

function RowsCard({ employeeId, kind, title, icon, rows, canEdit, empty }: { employeeId: string; kind: "relation" | "education" | "experience"; title: string; icon: React.ReactNode; rows: RowItem[]; canEdit: boolean; empty: string }) {
  const [editing, setEditing] = React.useState<RowItem | "new" | null>(null);
  return (
    <Card>
      <CardHeader title={title} action={canEdit ? <Button variant="ghost" size="sm" onClick={() => setEditing("new")}><Plus />Add</Button> : undefined} />
      {rows.length === 0 ? <EmptyState compact icon={icon} title={empty} /> : (
        <ul className="divide-y divide-border border-t border-border">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-base font-medium"><span className="break-words">{r.title}</span>{r.badge && <Badge tone="accent">{r.badge}</Badge>}</p>
                {r.sub && <p className="text-sm text-text-muted">{r.sub}</p>}
              </div>
              {canEdit && <>
                <IconButton label={`Edit ${r.title}`} size="icon-sm" onClick={() => setEditing(r)}><Pencil /></IconButton>
                <ConfirmDialog title={`Remove ${r.title}?`} description="This can't be undone." confirmLabel="Remove"
                  onConfirm={async () => { const x = await deleteSectionRowAction(employeeId, kind, r.id); if (x.ok) toast.success("Removed"); else toast.error(x.error); }}
                  trigger={<IconButton label={`Remove ${r.title}`} size="icon-sm"><Trash2 /></IconButton>} />
              </>}
            </li>
          ))}
        </ul>
      )}
      {editing && <RowDialog employeeId={employeeId} kind={kind} row={editing === "new" ? null : editing.raw} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function RowDialog({ employeeId, kind, row, onClose }: { employeeId: string; kind: "relation" | "education" | "experience"; row: Record<string, unknown> | null; onClose: () => void }) {
  const str = (k: string) => (row?.[k] == null ? "" : String(row[k]));
  const [v, setV] = React.useState<Record<string, string>>((): Record<string, string> => kind === "relation"
    ? { relation: str("relation") || "spouse", name: str("name"), gender: str("gender"), dob: str("dob"), email: str("email"), mobile: str("mobile"), profession: str("profession") }
    : kind === "education" ? { degree: str("degree"), branch: str("branch"), institution: str("institution"), score: str("score"), startYear: str("start_year"), endYear: str("end_year") }
    : { company: str("company"), title: str("title"), location: str("location"), description: str("description"), startDate: str("start_date"), endDate: str("end_date") });
  const [nominee, setNominee] = React.useState(row?.is_nominee === true);
  const { pending, error, run } = useRun(onClose);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV((s) => ({ ...s, [k]: e.target.value }));
  const err = (k: string) => (error?.field === k ? error.message : undefined);
  const nn = (x: string) => (x.trim() ? x.trim() : null);
  const payload = () => kind === "relation" ? { relation: v.relation, name: v.name, gender: nn(v.gender), dob: nn(v.dob), email: nn(v.email), mobile: nn(v.mobile), profession: nn(v.profession), isNominee: nominee }
    : kind === "education" ? { degree: v.degree, branch: nn(v.branch), institution: nn(v.institution), score: nn(v.score), startYear: v.startYear ? Number(v.startYear) : null, endYear: v.endYear ? Number(v.endYear) : null }
    : { company: v.company, title: nn(v.title), location: nn(v.location), description: nn(v.description), startDate: nn(v.startDate), endDate: nn(v.endDate) };
  const titles = { relation: "family member", education: "education", experience: "previous job" };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`${row ? "Edit" : "Add"} ${titles[kind]}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={() => run(() => saveSectionRowAction(employeeId, kind, (row?.id as string) ?? null, payload()), "Saved")}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {error && !["name", "degree", "company", "endYear", "endDate", "startDate"].includes(error.field ?? "") && <Banner tone="danger" className="sm:col-span-2">{error.message}</Banner>}
        {kind === "relation" && <>
          <Field label="Relation" required><Select value={v.relation} onValueChange={(x) => setV((s) => ({ ...s, relation: x }))} options={Object.entries(REL).map(([value, label]) => ({ value, label }))} /></Field>
          <Field label="Name" required error={err("name")}><Input value={v.name} onChange={set("name")} /></Field>
          <Field label="Date of birth"><Input type="date" value={v.dob} onChange={set("dob")} /></Field>
          <Field label="Gender"><Select value={v.gender || undefined} onValueChange={(x) => setV((s) => ({ ...s, gender: x }))} options={[{ value: "female", label: "Female" }, { value: "male", label: "Male" }, { value: "non_binary", label: "Non-binary" }, { value: "undisclosed", label: "Prefer not to say" }]} placeholder="Choose" /></Field>
          <Field label="Mobile"><Input type="tel" value={v.mobile} onChange={set("mobile")} /></Field>
          <Field label="Email"><Input type="email" value={v.email} onChange={set("email")} /></Field>
          <Field label="Profession"><Input value={v.profession} onChange={set("profession")} /></Field>
          <div className="flex items-end pb-2"><Checkbox label="Nominee (for PF, gratuity and insurance)" checked={nominee} onCheckedChange={(c) => setNominee(!!c)} /></div>
        </>}
        {kind === "education" && <>
          <Field label="Degree or course" required error={err("degree")}><Input value={v.degree} onChange={set("degree")} placeholder="B.Tech" /></Field>
          <Field label="Specialisation"><Input value={v.branch} onChange={set("branch")} /></Field>
          <Field label="Institution" className="sm:col-span-2"><Input value={v.institution} onChange={set("institution")} /></Field>
          <Field label="Start year"><Input type="number" inputMode="numeric" value={v.startYear} onChange={set("startYear")} /></Field>
          <Field label="End year" error={err("endYear")}><Input type="number" inputMode="numeric" value={v.endYear} onChange={set("endYear")} /></Field>
          <Field label="Score or grade"><Input value={v.score} onChange={set("score")} placeholder="8.2 CGPA" /></Field>
        </>}
        {kind === "experience" && <>
          <Field label="Company" required error={err("company")}><Input value={v.company} onChange={set("company")} /></Field>
          <Field label="Job title"><Input value={v.title} onChange={set("title")} /></Field>
          <Field label="Location"><Input value={v.location} onChange={set("location")} /></Field>
          <span className="hidden sm:block" />
          <Field label="From" error={err("startDate")}><Input type="date" value={v.startDate} onChange={set("startDate")} /></Field>
          <Field label="To" error={err("endDate")}><Input type="date" value={v.endDate} onChange={set("endDate")} /></Field>
          <Field label="What you did" className="sm:col-span-2"><Textarea value={v.description} onChange={set("description")} maxLength={1000} /></Field>
        </>}
      </div>
    </Modal>
  );
}

function IdentityCard({ employeeId, ids, canEdit, isAdmin, self }: { employeeId: string; ids: NonNullable<ProfileSections["identities"]>; canEdit: boolean; isAdmin: boolean; self: boolean }) {
  const [adding, setAdding] = React.useState<null | { kind: string }>(null);
  const [shown, setShown] = React.useState<Record<string, string>>({});
  return (
    <Card>
      <CardHeader title="Identity documents" description={isAdmin ? "Numbers are stored encrypted. Showing a full number is recorded in the audit log." : "Stored encrypted; only the last four characters are shown."}
        action={canEdit ? <Button variant="ghost" size="sm" onClick={() => setAdding({ kind: ID_KINDS.find((k) => !ids.some((i) => i.kind === k)) ?? "other" })}><Plus />Add</Button> : undefined} />
      {ids.length === 0 ? <EmptyState compact icon={<IdCard />} title={self ? "Add your PAN and Aadhaar" : "No IDs added"} description={self ? "HR needs them for payroll and statutory filings." : undefined} /> : (
        <ul className="divide-y divide-border border-t border-border">
          {ids.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-base font-medium">{i.label}
                  {i.verified ? <Badge tone="success"><BadgeCheck />Verified</Badge> : <Badge tone="warning">Not verified</Badge>}
                  {i.expired && <Badge tone="danger"><ShieldAlert />Expired</Badge>}
                </p>
                <p className="font-mono text-sm tabular text-text-muted">{shown[i.id] ?? i.masked}{i.name_on_doc ? <span className="font-sans"> · {i.name_on_doc}</span> : null}{i.expiry_date ? <span className="font-sans"> · valid till {fmt(i.expiry_date)}</span> : null}</p>
                {i.verified && i.verified_by && <p className="text-xs text-text-muted">Checked by {i.verified_by}</p>}
              </div>
              {isAdmin && !shown[i.id] && <IconButton label={`Show full ${i.label} number`} size="icon-sm" onClick={async () => { const r = await revealIdentityAction(i.id); if (r.ok) setShown((s) => ({ ...s, [i.id]: r.data!.number })); else toast.error(r.error); }}><Eye /></IconButton>}
              {isAdmin && !self && (
                <Button variant="secondary" size="sm" onClick={async () => { const r = await verifyIdentityAction(i.id, !i.verified); if (r.ok) toast.success(i.verified ? "Marked as not verified" : "Verified"); else toast.error(r.error); }}>{i.verified ? "Unverify" : "Verify"}</Button>
              )}
              {canEdit && (!i.verified || isAdmin) && <>
                <IconButton label={`Update ${i.label}`} size="icon-sm" onClick={() => setAdding({ kind: i.kind })}><Pencil /></IconButton>
                <ConfirmDialog title={`Remove ${i.label}?`} description="The stored number is deleted." confirmLabel="Remove"
                  onConfirm={async () => { const r = await deleteIdentityAction(i.id); if (r.ok) toast.success("Removed"); else toast.error(r.error); }}
                  trigger={<IconButton label={`Remove ${i.label}`} size="icon-sm"><Trash2 /></IconButton>} />
              </>}
            </li>
          ))}
        </ul>
      )}
      {adding && <IdentityDialog employeeId={employeeId} kind={adding.kind} replacing={ids.some((x) => x.kind === adding.kind)} onClose={() => setAdding(null)} />}
    </Card>
  );
}

function IdentityDialog({ employeeId, kind: k0, replacing, onClose }: { employeeId: string; kind: string; replacing: boolean; onClose: () => void }) {
  const [kind, setKind] = React.useState(k0);
  const [v, setV] = React.useState({ number: "", nameOnDoc: "", expiryDate: "" });
  const { pending, error, run } = useRun(onClose);
  const set = (x: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV((s) => ({ ...s, [x]: e.target.value }));
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={replacing ? `Update ${ID_LABELS[kind as keyof typeof ID_LABELS]}` : "Add an ID"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={() => run(() => saveIdentityAction(employeeId, { kind, number: v.number, nameOnDoc: v.nameOnDoc || null, expiryDate: v.expiryDate || null }), "Saved")}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {error && error.field !== "number" && <Banner tone="danger" className="sm:col-span-2">{error.message}</Banner>}
        <Field label="Document"><Select value={kind} onValueChange={setKind} options={ID_KINDS.map((x) => ({ value: x, label: ID_LABELS[x] }))} /></Field>
        <Field label="Number" required error={error?.field === "number" ? error.message : undefined}><Input value={v.number} onChange={set("number")} autoComplete="off" spellCheck={false} className="font-mono" /></Field>
        <Field label="Name as on the document"><Input value={v.nameOnDoc} onChange={set("nameOnDoc")} /></Field>
        {(kind === "passport" || kind === "driving_licence" || kind === "other") && <Field label="Valid till"><Input type="date" value={v.expiryDate} onChange={set("expiryDate")} /></Field>}
        {replacing && <p className="text-sm text-text-muted sm:col-span-2">Saving replaces the number on file and it will need to be verified again.</p>}
      </div>
    </Modal>
  );
}
