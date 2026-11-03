"use client";
import * as React from "react";
import Link from "next/link";
import { FolderKanban, Plus } from "lucide-react";
import { Card } from "@/ui/card";
import { Button } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Modal } from "@/ui/overlay";
import { Field, Input, MoneyInput, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { EmptyState, Progress } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { saveProjectAction } from "@/app/(app)/psa/actions";
import { BILLING_LABEL, BILLING_MODELS, formatINR, formatMinutes, projectCodeFrom, PROJECT_STATUS_LABEL, type BillingModel, type ProjectStatus } from "@/server/modules/psa/rules";

export type ProjectCard = {
  id: string; name: string; code: string; client: string | null; client_id: string | null; billing_model: BillingModel; status: ProjectStatus; retainer_paise: number | null; currency: string;
  start_date: string | null; end_date: string | null; members: number; logged_minutes: number; approved_minutes: number; uninvoiced_minutes: number; budget_minutes: number | null; mine: boolean; approver: boolean;
};
export type ProjectForm = { id?: string; name: string; code: string; clientId: string | null; billingModel: BillingModel; retainerPaise: number | null; currency: string; startDate: string | null; endDate: string | null; description: string | null; approverIds: string[]; budgetMinutes: number | null };
const TONE: Record<ProjectStatus, "success" | "warning" | "neutral" | "accent"> = { active: "success", on_hold: "warning", completed: "accent", archived: "neutral" };

/** S130 list: every project you may see, with hours logged against budget and what's still to invoice. */
export function Projects({ projects, clients, people, canEdit, showArchived }: { projects: ProjectCard[]; clients: { id: string; name: string }[]; people: Person[]; canEdit: boolean; showArchived: boolean }) {
  const [creating, setCreating] = React.useState(false);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-text-muted">{projects.length} {projects.length === 1 ? "project" : "projects"}{canEdit ? "" : " you're on or approve"}</p>
        <div className="ml-auto flex gap-2">
          <Button asChild variant="ghost" size="sm"><Link href={showArchived ? "/psa/projects" : "/psa/projects?archived=1"}>{showArchived ? "Hide archived" : "Show archived"}</Link></Button>
          {canEdit && <Button size="sm" onClick={() => setCreating(true)}><Plus />New project</Button>}
        </div>
      </div>
      {projects.length === 0 ? (
        <Card><EmptyState icon={<FolderKanban />} title={canEdit ? "No projects yet" : "You're not on any project yet"} description={canEdit ? "Create one, add the team with their bill rates, and people can start logging hours." : "When a project admin adds you to a project it shows up here."}
          action={canEdit ? <Button onClick={() => setCreating(true)}><Plus />New project</Button> : undefined} /></Card>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => {
            const pct = p.budget_minutes ? Math.min(100, Math.round((p.logged_minutes / p.budget_minutes) * 100)) : null;
            return (
              <li key={p.id}>
                <Link href={`/psa/projects/${p.id}`} className="block h-full rounded-lg border border-border bg-surface p-4 transition-colors hover:bg-surface-hover focus-visible:outline-offset-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0"><p className="truncate text-base font-medium">{p.name}</p><p className="text-sm text-text-muted">{p.code}{p.client ? ` · ${p.client}` : ""}</p></div>
                    <Badge tone={TONE[p.status]}>{PROJECT_STATUS_LABEL[p.status]}</Badge>
                  </div>
                  <p className="mt-3 text-sm text-text-muted">{BILLING_LABEL[p.billing_model]}{p.billing_model === "retainer" && p.retainer_paise ? ` · ${formatINR(Number(p.retainer_paise))}/month` : ""}</p>
                  <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
                    <div><dt className="text-text-muted">Team</dt><dd className="font-medium tabular">{p.members}</dd></div>
                    <div><dt className="text-text-muted">Logged</dt><dd className="font-medium tabular">{formatMinutes(p.logged_minutes)}</dd></div>
                    <div><dt className="text-text-muted">To invoice</dt><dd className="font-medium tabular">{p.billing_model === "time_and_materials" ? formatMinutes(p.uninvoiced_minutes) : "–"}</dd></div>
                  </dl>
                  {pct != null && <div className="mt-3"><Progress value={pct} label={`${pct}% of budget used`} tone={pct >= 100 ? "danger" : pct >= 80 ? "warning" : "accent"} /><p className="mt-1 text-xs text-text-muted">{pct}% of {formatMinutes(p.budget_minutes!)} budget</p></div>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {creating && <ProjectDialog project={null} clients={clients} people={people} onClose={() => setCreating(false)} />}
    </div>
  );
}

export function ProjectDialog({ project, clients, people, onClose }: { project: ProjectForm | null; clients: { id: string; name: string }[]; people: Person[]; onClose: () => void }) {
  const [f, setF] = React.useState<ProjectForm>(project ?? { name: "", code: "", clientId: clients[0]?.id ?? null, billingModel: "time_and_materials", retainerPaise: null, currency: "INR", startDate: null, endDate: null, description: "", approverIds: [], budgetMinutes: null });
  const [codeTouched, setCodeTouched] = React.useState(!!project);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, start] = React.useTransition();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!f.name.trim()) errs.name = "Give the project a name.";
    if (f.billingModel !== "non_billable" && !f.clientId) errs.clientId = "Billable projects need a client.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    start(async () => {
      const r = await saveProjectAction(project?.id ?? null, { ...f, code: f.code || projectCodeFrom(f.name), clientId: f.billingModel === "non_billable" ? f.clientId : f.clientId, description: f.description || null });
      if (!r.ok) { setErrors({ [r.field ?? "form"]: r.error }); return; }
      toast.success(project ? "Project saved" : "Project created"); onClose();
    });
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={project ? `Edit ${project.name}` : "New project"} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="project-form" loading={busy}>Save</Button></>}>
      <form id="project-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {errors.form && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{errors.form}</p>}
        <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
          <Field label="Name" required error={errors.name}><Input value={f.name} maxLength={120} onChange={(e) => setF({ ...f, name: e.target.value, code: codeTouched ? f.code : projectCodeFrom(e.target.value) })} /></Field>
          <Field label="Code" help="Shown on timesheets" error={errors.code}><Input value={f.code} maxLength={12} className="uppercase" onChange={(e) => { setCodeTouched(true); setF({ ...f, code: e.target.value.toUpperCase() }); }} /></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Billing" error={errors.billingModel}><Select value={f.billingModel} onValueChange={(v) => setF({ ...f, billingModel: v as BillingModel })} options={BILLING_MODELS.map((m) => ({ value: m, label: BILLING_LABEL[m] }))} /></Field>
          <Field label="Client" error={errors.clientId} help={f.billingModel === "non_billable" ? "Optional for internal work" : undefined}>
            <Select value={f.clientId ?? "__none"} onValueChange={(v) => setF({ ...f, clientId: v === "__none" ? null : v })} options={[{ value: "__none", label: "No client" }, ...clients.map((c) => ({ value: c.id, label: c.name }))]} />
          </Field>
        </div>
        {f.billingModel === "retainer" && <Field label="Monthly retainer" required error={errors.retainerPaise}><MoneyInput valuePaise={f.retainerPaise} onChangePaise={(p) => setF({ ...f, retainerPaise: p })} /></Field>}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Start"><Input type="date" value={f.startDate ?? ""} onChange={(e) => setF({ ...f, startDate: e.target.value || null })} /></Field>
          <Field label="End" error={errors.endDate}><Input type="date" value={f.endDate ?? ""} onChange={(e) => setF({ ...f, endDate: e.target.value || null })} /></Field>
          <Field label="Budget (hours)" error={errors.budgetMinutes}><Input type="number" min={0} inputMode="numeric" value={f.budgetMinutes == null ? "" : String(f.budgetMinutes / 60)} onChange={(e) => setF({ ...f, budgetMinutes: e.target.value === "" ? null : Math.round(Number(e.target.value) * 60) })} /></Field>
        </div>
        <Field label="Approvers" help="They approve timesheets with hours on this project. Leave empty to use each person's manager." error={errors.approverIds}>
          <EmployeePicker people={people} value={f.approverIds} onChange={(ids) => setF({ ...f, approverIds: ids })} multiple placeholder="Pick approvers" />
        </Field>
        <Field label="Description"><Textarea value={f.description ?? ""} maxLength={2000} rows={3} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      </form>
    </Modal>
  );
}
