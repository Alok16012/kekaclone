"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Rocket, Save, Users } from "lucide-react";
import { SECTION_LABEL, STAGE_LABEL, type Section, type Timelines } from "@/server/modules/performance/rules";
import { Card } from "@/ui/card";
import { Button } from "@/ui/button";
import { Stepper } from "@/ui/flow";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { Checkbox, Switch } from "@/ui/choice";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { Banner } from "@/ui/feedback";
import { ConfirmDialog } from "@/ui/overlay";
import { toast } from "@/ui/toast";
import { createCycleAction, launchCycleAction, previewParticipantsAction, updateCycleAction } from "@/app/(app)/performance/actions";

type Kind = "standard" | "aggregate" | "probation" | "new_joiner";
type Form = { id: string; name: string; sections: Section[] };
export type CycleDraft = {
  id?: string; name: string; kind: Kind; periodStart: string; periodEnd: string; timelines: Timelines;
  reviewers: { self: boolean; manager: boolean; skip_level: boolean; peer: { enabled: boolean; min: number; max: number; nominated_by: "employee" | "manager"; needs_approval: boolean } };
  formId: string | null; employeeFilter: { department_ids?: string[]; location_ids?: string[]; joined_before?: string | null; include_ids?: string[]; exclude_ids?: string[] };
  autoRule: { trigger: "joining" | "probation_end"; days: number } | null; sourceCycleIds: string[];
};
const STEPS = ["Cycle", "Reviewers", "Form", "People"];
const KINDS: { value: Kind; label: string }[] = [
  { value: "standard", label: "Standard: a set group of people" }, { value: "new_joiner", label: "New joiners: starts N days after joining" },
  { value: "probation", label: "Probation: starts N days before probation ends" }, { value: "aggregate", label: "Aggregate: combine earlier cycles' ratings" },
];

/** Quick set-up in four steps. Saves as a draft; launching sends the reviews out. */
export function CycleWizard({ forms, people, departments, locations, sources, today, initial }: {
  forms: Form[]; people: Person[]; departments: { id: string; name: string }[]; locations: { id: string; name: string }[]; sources: { id: string; name: string }[]; today: string; initial?: CycleDraft;
}) {
  const router = useRouter();
  const [step, setStep] = React.useState(0);
  const [c, setC] = React.useState<CycleDraft>(initial ?? {
    name: "", kind: "standard", periodStart: today.slice(0, 4) + "-01-01", periodEnd: today.slice(0, 4) + "-06-30", timelines: {},
    reviewers: { self: true, manager: true, skip_level: false, peer: { enabled: false, min: 1, max: 3, nominated_by: "employee", needs_approval: true } },
    formId: forms[0]?.id ?? null, employeeFilter: {}, autoRule: null, sourceCycleIds: [],
  });
  const [busy, setBusy] = React.useState<"save" | "launch" | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<{ key: string; people?: { id: string; name: string }[]; error?: string } | null>(null);
  const up = (patch: Partial<CycleDraft>) => setC((x) => ({ ...x, ...patch }));
  const tl = (k: keyof Timelines, v: string) => up({ timelines: { ...c.timelines, [k]: v || null } });
  const filterKey = JSON.stringify(c.employeeFilter);
  React.useEffect(() => {
    if (step !== 3 || c.kind === "aggregate") return;
    let live = true;
    const key = filterKey;
    previewParticipantsAction(JSON.parse(key)).then((r) => { if (live) setPreview(r.ok ? { key, people: r.data } : { key, error: r.error }); });
    return () => { live = false; };
  }, [step, filterKey, c.kind]);
  const pv = preview?.key === filterKey ? preview : null;
  const payload = () => ({ ...c, autoRule: c.kind === "probation" || c.kind === "new_joiner" ? c.autoRule ?? { trigger: c.kind === "probation" ? "probation_end" : "joining", days: c.kind === "probation" ? 15 : 90 } : null });
  const save = async (launch: boolean) => {
    setBusy(launch ? "launch" : "save"); setErr(null);
    let id = c.id;
    const r = id ? await updateCycleAction(id, payload()) : await createCycleAction(payload());
    if (!r.ok) { setBusy(null); setErr(r.error); return; }
    if (!id) id = (r as { data?: { id: string } }).data!.id;
    if (launch) {
      const l = await launchCycleAction(id);
      if (!l.ok) { setBusy(null); setErr(l.error); up({ id }); return; }
      toast.success(c.kind === "standard" ? `Launched for ${l.data!.added} people` : "Launched");
    } else toast.success("Draft saved");
    setBusy(null);
    router.push(`/performance/cycles/${id}`);
  };
  const form = forms.find((f) => f.id === c.formId);
  const auto = c.kind === "probation" || c.kind === "new_joiner";
  return (
    <div className="flex flex-col gap-5">
      <Stepper steps={STEPS} current={step} onStepClick={(i) => setStep(i)} />
      {err && <Banner tone="danger" title="Couldn't save">{err}</Banner>}
      <Card className="p-5">
        {step === 0 && (
          <div className="flex flex-col gap-4">
            <Field label="Name" required help="People see this, e.g. “H2 2026 review”"><Input value={c.name} onChange={(e) => up({ name: e.target.value })} maxLength={80} /></Field>
            <Field label="Type"><Select value={c.kind} onValueChange={(v) => up({ kind: v as Kind })} options={KINDS} /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Review period starts" required><Input type="date" value={c.periodStart} onChange={(e) => up({ periodStart: e.target.value })} /></Field>
              <Field label="Review period ends" required><Input type="date" value={c.periodEnd} onChange={(e) => up({ periodEnd: e.target.value })} /></Field>
            </div>
            {auto && (
              <Field label={c.kind === "probation" ? "Days before probation ends" : "Days after joining"} help="The daily job adds each person on that day">
                <Input type="number" min={0} max={730} value={c.autoRule?.days ?? (c.kind === "probation" ? 15 : 90)} onChange={(e) => up({ autoRule: { trigger: c.kind === "probation" ? "probation_end" : "joining", days: Number(e.target.value) } })} />
              </Field>
            )}
            {c.kind === "aggregate" ? (
              <fieldset className="flex flex-col gap-2"><legend className="mb-1 text-sm font-medium">Cycles to combine</legend>
                {sources.length ? sources.map((s) => (
                  <Checkbox key={s.id} label={s.name} checked={c.sourceCycleIds.includes(s.id)} onCheckedChange={(v) => up({ sourceCycleIds: v ? [...c.sourceCycleIds, s.id] : c.sourceCycleIds.filter((x) => x !== s.id) })} />
                )) : <p className="text-sm text-text-muted">There are no launched cycles to combine yet.</p>}
              </fieldset>
            ) : (
              <fieldset><legend className="mb-2 text-sm font-medium">Timeline</legend>
                <div className="grid gap-4 sm:grid-cols-3">
                  {(["nominate_due", "self_due", "peer_due", "manager_due", "calibration_due", "publish_on"] as (keyof Timelines)[]).filter((k) => c.reviewers.peer.enabled || (k !== "nominate_due" && k !== "peer_due")).map((k) => (
                    <Field key={k} label={STAGE_LABEL[k]}><Input type="date" value={c.timelines[k] ?? ""} onChange={(e) => tl(k, e.target.value)} /></Field>
                  ))}
                </div>
              </fieldset>
            )}
          </div>
        )}
        {step === 1 && (c.kind === "aggregate" ? <p className="text-base text-text-muted">Aggregate cycles don&apos;t ask anyone for reviews: they combine the calibrated ratings of the cycles you picked.</p> : (
          <div className="flex flex-col gap-4">
            <Switch label="Self review" checked={c.reviewers.self} onCheckedChange={(v) => up({ reviewers: { ...c.reviewers, self: v } })} />
            <Switch label="Manager review" checked={c.reviewers.manager} onCheckedChange={(v) => up({ reviewers: { ...c.reviewers, manager: v } })} />
            <Switch label="Skip-level manager review" checked={c.reviewers.skip_level} onCheckedChange={(v) => up({ reviewers: { ...c.reviewers, skip_level: v } })} />
            <Switch label="Peer reviews" checked={c.reviewers.peer.enabled} onCheckedChange={(v) => up({ reviewers: { ...c.reviewers, peer: { ...c.reviewers.peer, enabled: v } } })} />
            {c.reviewers.peer.enabled && (
              <div className="grid gap-4 rounded-md border border-border p-4 sm:grid-cols-2">
                <Field label="Fewest peers"><Input type="number" min={0} max={10} value={c.reviewers.peer.min} onChange={(e) => up({ reviewers: { ...c.reviewers, peer: { ...c.reviewers.peer, min: Number(e.target.value) } } })} /></Field>
                <Field label="Most peers"><Input type="number" min={1} max={10} value={c.reviewers.peer.max} onChange={(e) => up({ reviewers: { ...c.reviewers, peer: { ...c.reviewers.peer, max: Number(e.target.value) } } })} /></Field>
                <Field label="Who picks peers"><Select value={c.reviewers.peer.nominated_by} onValueChange={(v) => up({ reviewers: { ...c.reviewers, peer: { ...c.reviewers.peer, nominated_by: v as "employee" | "manager" } } })}
                  options={[{ value: "employee", label: "The person being reviewed" }, { value: "manager", label: "Their manager" }]} /></Field>
                {c.reviewers.peer.nominated_by === "employee" && <Switch label="Manager approves the picks" checked={c.reviewers.peer.needs_approval} onCheckedChange={(v) => up({ reviewers: { ...c.reviewers, peer: { ...c.reviewers.peer, needs_approval: v } } })} />}
              </div>
            )}
          </div>
        ))}
        {step === 2 && (c.kind === "aggregate" ? <p className="text-base text-text-muted">No form needed for an aggregate cycle.</p> : (
          <div className="flex flex-col gap-4">
            {forms.length ? <Field label="Review form"><Select value={c.formId ?? undefined} placeholder="Pick a form" onValueChange={(v) => up({ formId: v })} options={forms.map((f) => ({ value: f.id, label: f.name }))} /></Field>
              : <Banner tone="warning" title="No review forms yet">Create one in <Link href="/performance/settings#forms" className="underline">Settings</Link> first.</Banner>}
            {form && (
              <ol className="flex flex-col gap-2">{form.sections.map((s, i) => (
                <li key={s.id} className="rounded-md border border-border px-3 py-2"><p className="text-base font-medium">{i + 1}. {s.title} <span className="font-normal text-text-muted">· {SECTION_LABEL[s.type]}{s.weight ? ` · ${s.weight}%` : ""}</span></p>
                  <p className="text-sm text-text-muted">{s.type === "goals" ? "Each person's goals in the review period" : s.items.map((x) => x.text).join(" · ")}</p></li>
              ))}</ol>
            )}
            <p className="text-sm text-text-muted">Forms are managed in <Link href="/performance/settings#forms" className="text-accent-text hover:underline">Settings</Link>.</p>
          </div>
        ))}
        {step === 3 && (c.kind === "aggregate" ? <p className="text-base text-text-muted">Everyone rated in the cycles you picked is included.</p> : (
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Departments" help="Leave empty for all"><EmployeePicker multiple placeholder="All departments" people={departments.map((d) => ({ id: d.id, name: d.name }))} value={c.employeeFilter.department_ids ?? []} onChange={(v) => up({ employeeFilter: { ...c.employeeFilter, department_ids: v } })} /></Field>
              <Field label="Locations" help="Leave empty for all"><EmployeePicker multiple placeholder="All locations" people={locations.map((d) => ({ id: d.id, name: d.name }))} value={c.employeeFilter.location_ids ?? []} onChange={(v) => up({ employeeFilter: { ...c.employeeFilter, location_ids: v } })} /></Field>
              <Field label="Joined on or before" help="Leaves out recent joiners"><Input type="date" value={c.employeeFilter.joined_before ?? ""} onChange={(e) => up({ employeeFilter: { ...c.employeeFilter, joined_before: e.target.value || null } })} /></Field>
              <Field label="Always include"><EmployeePicker multiple people={people} value={c.employeeFilter.include_ids ?? []} onChange={(v) => up({ employeeFilter: { ...c.employeeFilter, include_ids: v } })} /></Field>
              <Field label="Leave out"><EmployeePicker multiple people={people} value={c.employeeFilter.exclude_ids ?? []} onChange={(v) => up({ employeeFilter: { ...c.employeeFilter, exclude_ids: v } })} /></Field>
            </div>
            <div className="rounded-md bg-surface-sunken p-3" aria-live="polite">
              {!pv ? <p className="text-sm text-text-muted">Counting…</p> : pv.error ? <p className="text-sm text-danger-text">{pv.error}</p> : (
                <><p className="flex items-center gap-2 text-base font-medium"><Users className="size-4" aria-hidden />{auto ? `${pv.people!.length} people match; they join as they reach the trigger` : `${pv.people!.length} people will be reviewed`}</p>
                  <p className="mt-1 line-clamp-3 text-sm text-text-muted">{pv.people!.map((p) => p.name).join(", ")}</p></>
              )}
            </div>
          </div>
        ))}
      </Card>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" asChild><Link href="/performance">Cancel</Link></Button>
        <div className="ml-auto flex flex-wrap gap-2">
          {step > 0 && <Button variant="secondary" onClick={() => setStep(step - 1)}><ArrowLeft />Back</Button>}
          <Button variant="secondary" loading={busy === "save"} onClick={() => save(false)}><Save />Save draft</Button>
          {step < 3 ? <Button onClick={() => setStep(step + 1)}>Next<ArrowRight /></Button>
            : <ConfirmDialog trigger={<Button loading={busy === "launch"}><Rocket />Launch</Button>} tone="primary" confirmLabel="Launch" title="Launch this cycle?"
                description={c.kind === "aggregate" ? "Ratings are combined now and the cycle goes straight to calibration." : "Everyone involved is told about the reviews they need to write. You can still move dates later."}
                onConfirm={() => save(true)} />}
        </div>
      </div>
    </div>
  );
}
