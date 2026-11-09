"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Globe, Trash2, UserPlus, Users, Megaphone } from "lucide-react";
import { Card } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { Switch } from "@/ui/choice";
import { Banner } from "@/ui/feedback";
import { Stepper } from "@/ui/flow";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { toast } from "@/ui/toast";
import { JOB_TYPES, TEAM_ROLES } from "@/server/modules/hire/rules";
import { saveJobAction } from "@/app/(app)/hire/actions";
import { RichText } from "./shared";
import { JdDraftButton, type AssistantInfo } from "./assist";

export type WizardData = {
  departments: { id: string; name: string }[]; locations: { id: string; name: string }[];
  flows: { id: string; name: string; is_default: boolean; stages: string[] | null }[]; jds: { id: string; name: string; description_html: string }[];
  people: (Person & { title: string | null })[];
};
export type WizardJob = {
  id: string | null; title: string; department_id: string | null; location_id: string | null; description_html: string; openings: number; target_date: string | null; job_type: string;
  experience_min: number | null; experience_max: number | null; salary_min_paise: number | null; salary_max_paise: number | null; show_salary: boolean; hiring_flow_id: string;
  allow_reapply_after_days: number | null; publish: { career_site?: boolean; internal?: boolean; referrals?: boolean }; requisition_id: string | null;
  team: { employee_id: string; role: string }[]; status: string; applications: number;
};

const STEPS = ["Posting", "Details", "Hiring team", "Publish"];
const rupeesText = (p: number | null) => (p == null ? "" : String(Math.round(p / 100)));
const toPaise = (s: string) => { const t = s.replace(/[₹,\s]/g, ""); return t === "" ? null : Number.isFinite(Number(t)) ? Math.round(Number(t) * 100) : NaN; };
const toInt = (s: string) => (s.trim() === "" ? null : Number(s));

/** S136: create or edit a job in four steps. Drafts save any time; publishing opens it to the chosen audiences. */
export function JobWizard({ data, job, assistant }: { data: WizardData; job: WizardJob; assistant?: AssistantInfo }) {
  const router = useRouter();
  const [step, setStep] = React.useState(0);
  const [f, setF] = React.useState({
    title: job.title, departmentId: job.department_id ?? "", locationId: job.location_id ?? "", html: job.description_html, openings: String(job.openings),
    targetDate: job.target_date ?? "", jobType: job.job_type, expMin: job.experience_min?.toString() ?? "", expMax: job.experience_max?.toString() ?? "",
    salMin: rupeesText(job.salary_min_paise), salMax: rupeesText(job.salary_max_paise), showSalary: job.show_salary, flowId: job.hiring_flow_id,
    reapply: job.allow_reapply_after_days?.toString() ?? "", careerSite: !!job.publish.career_site, internal: !!job.publish.internal, referrals: !!job.publish.referrals,
  });
  const [team, setTeam] = React.useState(job.team.map((t) => ({ employeeId: t.employee_id, role: t.role })));
  const [jdKey, setJdKey] = React.useState(0);
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [busy, start] = React.useTransition();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const [pick, setPick] = React.useState<{ ids: string[]; role: string }>({ ids: [], role: "panelist" });

  const stepOf: Record<string, number> = { title: 0, departmentId: 0, locationId: 0, experienceMin: 0, experienceMax: 0, openings: 1, targetDate: 1, jobType: 1, salaryMinPaise: 1, salaryMaxPaise: 1, hiringFlowId: 1, reapplyAfterDays: 1, team: 2 };
  const check = (s: number): string | null => {
    if (s === 0 && !f.title.trim()) return "Give the job a title.";
    if (s === 1 && (!Number.isInteger(Number(f.openings)) || Number(f.openings) < 1)) return "Openings must be at least 1.";
    return null;
  };
  const next = () => { const p = check(step); if (p) { setError({ message: p }); return; } setError(null); setStep((s) => Math.min(3, s + 1)); };

  const save = (publish: boolean) => start(async () => {
    setError(null);
    const salMin = toPaise(f.salMin), salMax = toPaise(f.salMax);
    if (Number.isNaN(salMin) || Number.isNaN(salMax)) { setError({ message: "Enter the salary in rupees.", field: "salaryMinPaise" }); setStep(1); return; }
    const r = await saveJobAction(job.id, {
      title: f.title, departmentId: f.departmentId || null, locationId: f.locationId || null, descriptionHtml: f.html, openings: Number(f.openings), targetDate: f.targetDate || null,
      jobType: f.jobType, experienceMin: toInt(f.expMin), experienceMax: toInt(f.expMax), salaryMinPaise: salMin, salaryMaxPaise: salMax, showSalary: f.showSalary,
      hiringFlowId: f.flowId, reapplyAfterDays: toInt(f.reapply), team, publish: { careerSite: f.careerSite, internal: f.internal, referrals: f.referrals }, requisitionId: job.requisition_id,
    }, publish);
    if (!r.ok) { setError({ message: r.error, field: r.field }); if (r.field && r.field in stepOf) setStep(stepOf[r.field]); return; }
    toast.success(publish ? "Job published" : job.id ? "Job saved" : "Draft saved");
    router.push(`/hire/jobs/${r.data!.id}`);
  });

  const people = data.people.map((p) => ({ id: p.id, name: p.name, title: p.title, department: p.department }));
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? "Someone who left";
  const flow = data.flows.find((x) => x.id === f.flowId);
  const errFor = (k: string) => (error?.field === k ? error.message : undefined);
  const published = job.status !== "draft";

  return (
    <Card className="p-4 sm:p-6">
      <Stepper steps={STEPS} current={step} onStepClick={(i) => setStep(i)} />
      <p className="mt-2 text-sm text-text-muted sm:hidden">Step {step + 1} of 4: {STEPS[step]}</p>
      {error && !error.field && <Banner tone="danger" className="mt-4">{error.message}</Banner>}
      <div className="mt-6 flex flex-col gap-4">
        {step === 0 && (
          <>
            <Field label="Job title" required error={errFor("title")}><Input value={f.title} onChange={(e) => set("title", e.target.value)} maxLength={120} placeholder="e.g. Backend Engineer" /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Department"><Select value={f.departmentId} onValueChange={(v) => set("departmentId", v)} placeholder="Pick a department" options={data.departments.map((d) => ({ value: d.id, label: d.name }))} /></Field>
              <Field label="Location"><Select value={f.locationId} onValueChange={(v) => set("locationId", v)} placeholder="Pick a location" options={data.locations.map((d) => ({ value: d.id, label: d.name }))} /></Field>
              <Field label="Least experience (years)" error={errFor("experienceMin")}><Input type="number" min={0} max={50} value={f.expMin} onChange={(e) => set("expMin", e.target.value)} /></Field>
              <Field label="Most experience (years)" error={errFor("experienceMax")}><Input type="number" min={0} max={50} value={f.expMax} onChange={(e) => set("expMax", e.target.value)} /></Field>
            </div>
            {data.jds.length > 0 && (
              <Field label="Start from a template" help="Replaces the description below.">
                <Select placeholder="Pick a job description template" onValueChange={(v) => { const t = data.jds.find((j) => j.id === v); if (t) { set("html", t.description_html); setJdKey((k) => k + 1); } }}
                  options={data.jds.map((j) => ({ value: j.id, label: j.name }))} />
              </Field>
            )}
            {assistant && (
              <div className="flex justify-end">
                <JdDraftButton assistant={assistant} hasText={!!f.html.replace(/<[^>]+>/g, "").trim()} onDraft={(h) => { set("html", h); setJdKey((k) => k + 1); }}
                  brief={{ title: f.title, departmentId: f.departmentId, locationId: f.locationId, expMin: f.expMin, expMax: f.expMax, jobType: f.jobType }} />
              </div>
            )}
            <RichText key={jdKey} label="Job description" initial={f.html} onChange={(h) => set("html", h)} minHeight="min-h-64" />
          </>
        )}
        {step === 1 && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Openings" required error={errFor("openings")}><Input type="number" min={1} max={500} value={f.openings} onChange={(e) => set("openings", e.target.value)} /></Field>
            <Field label="Fill by" error={errFor("targetDate")}><Input type="date" value={f.targetDate} onChange={(e) => set("targetDate", e.target.value)} /></Field>
            <Field label="Type of job" error={errFor("jobType")}><Select value={f.jobType} onValueChange={(v) => set("jobType", v)} options={JOB_TYPES.map((t) => ({ value: t.value, label: t.label }))} /></Field>
            <Field label="Hiring flow" error={errFor("hiringFlowId")} help={job.applications ? "Locked: this job already has candidates." : flow?.stages?.join(" → ")}>
              <Select value={f.flowId} disabled={job.applications > 0} onValueChange={(v) => set("flowId", v)} options={data.flows.map((x) => ({ value: x.id, label: x.is_default ? `${x.name} (default)` : x.name }))} />
            </Field>
            <Field label="Salary from (₹ a year)" error={errFor("salaryMinPaise")}><Input inputMode="numeric" value={f.salMin} onChange={(e) => set("salMin", e.target.value)} placeholder="e.g. 1800000" /></Field>
            <Field label="Salary up to (₹ a year)" error={errFor("salaryMaxPaise")}><Input inputMode="numeric" value={f.salMax} onChange={(e) => set("salMax", e.target.value)} placeholder="e.g. 2800000" /></Field>
            <div className="sm:col-span-2"><Switch checked={f.showSalary} onCheckedChange={(c) => set("showSalary", !!c)} label="Show the salary range on the careers page" /></div>
            <Field className="sm:col-span-2" label="Let people apply again after (days)" error={errFor("reapplyAfterDays")} help="Someone who was turned down can apply to this job again after this many days. Leave empty to never allow it.">
              <Input type="number" min={0} max={730} value={f.reapply} onChange={(e) => set("reapply", e.target.value)} className="sm:max-w-40" />
            </Field>
          </div>
        )}
        {step === 2 && (
          <>
            <p className="text-base text-text-muted">Only people on the hiring team (and hiring admins) can see this job&apos;s candidates. Recruiters, hiring managers and coordinators can move candidates and make offers; the interview panel can see candidates, add notes and send feedback.</p>
            <div className="flex flex-col gap-3 rounded-md bg-surface-sunken p-3 sm:flex-row sm:items-end">
              <Field label="Add people" className="flex-1"><EmployeePicker people={people.filter((p) => !team.some((t) => t.employeeId === p.id && t.role === pick.role))} value={pick.ids} onChange={(ids) => setPick((x) => ({ ...x, ids }))} multiple /></Field>
              <Field label="As"><Select value={pick.role} onValueChange={(v) => setPick((x) => ({ ...x, role: v }))} options={TEAM_ROLES.map((r) => ({ value: r.value, label: r.label }))} className="sm:w-44" /></Field>
              <Button variant="secondary" disabled={!pick.ids.length} onClick={() => { setTeam((t) => [...t, ...pick.ids.map((id) => ({ employeeId: id, role: pick.role }))]); setPick((x) => ({ ...x, ids: [] })); }}><UserPlus />Add</Button>
            </div>
            {errFor("team") && <p role="alert" className="text-sm text-danger-text">{errFor("team")}</p>}
            {team.length === 0 ? <p className="text-base text-text-muted">No one yet. You&apos;ll be added as the recruiter when you save.</p> : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {team.map((m, i) => (
                  <li key={`${m.employeeId}:${m.role}`} className="flex items-center gap-3 px-3 py-2">
                    <Users aria-hidden className="size-4 text-text-muted" />
                    <span className="flex-1 text-base">{nameOf(m.employeeId)}</span>
                    <Select size="sm" value={m.role} onValueChange={(v) => setTeam((t) => t.map((x, j) => (j === i ? { ...x, role: v } : x)))} options={TEAM_ROLES.map((r) => ({ value: r.value, label: r.label }))} className="w-40" />
                    <IconButton size="icon-sm" label={`Remove ${nameOf(m.employeeId)}`} onClick={() => setTeam((t) => t.filter((_, j) => j !== i))}><Trash2 /></IconButton>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {step === 3 && (
          <div className="flex flex-col gap-4">
            <Switch checked={f.careerSite} onCheckedChange={(c) => set("careerSite", !!c)} label={<span className="inline-flex items-center gap-1.5"><Globe className="size-4" aria-hidden />Careers page: anyone can see it and apply</span>} />
            <Switch checked={f.internal} onCheckedChange={(c) => set("internal", !!c)} label="Internal jobs: employees can see it and apply" />
            <Switch checked={f.referrals} onCheckedChange={(c) => set("referrals", !!c)} label="Referrals: employees can refer people for it" />
            <Banner tone="info" title="Job boards">Posting to LinkedIn or Naukri isn&apos;t available. Share the careers page link instead.</Banner>
            {!f.html.replace(/<[^>]+>/g, "").trim() && <Banner tone="warning"><Megaphone className="mr-1 inline size-4" aria-hidden />Add a job description (step 1) before publishing.</Banner>}
          </div>
        )}
      </div>
      <div className="mt-6 flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:items-center">
        {step > 0 && <Button variant="ghost" onClick={() => { setError(null); setStep((s) => s - 1); }}>Back</Button>}
        <div className="flex flex-col-reverse gap-2 sm:ml-auto sm:flex-row">
          <Button variant="secondary" loading={busy} onClick={() => save(false)}>{published ? "Save changes" : "Save draft"}</Button>
          {step < 3 ? <Button onClick={next}>Next</Button> : !published && <Button loading={busy} onClick={() => save(true)}>Publish job</Button>}
        </div>
      </div>
      {error?.field && !(error.field in stepOf) && <Banner tone="danger" className="mt-4">{error.message}</Banner>}
    </Card>
  );
}
