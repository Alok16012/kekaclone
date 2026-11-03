"use client";
import * as React from "react";
import { CalendarRange, FileText, Pencil, Plus, Trash2 } from "lucide-react";
import { SECTION_LABEL, type Band, type ReviewerType, type ScalePoint, type Section, type SectionType } from "@/server/modules/performance/rules";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Modal } from "@/ui/overlay";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { Switch, Checkbox } from "@/ui/choice";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { saveFormAction, savePeriodAction, saveSettingsAction } from "@/app/(app)/performance/actions";
import { fmtDate } from "./bits";

type Settings = {
  goalMode: "okr" | "kra"; ratingScaleId: string | null; points: ScalePoint[]; bands: Band[]; idealDistribution: { label: string; pct: number }[];
  rounding: "none" | "one_decimal" | "half" | "whole"; reviewerWeights: Record<ReviewerType, number>; checkinReminder: "off" | "weekly" | "biweekly" | "monthly"; krWeightsMustTotal: boolean;
};
type Form = { id: string; name: string; rating_scale_id: string | null; sections: Section[]; in_use: boolean };
type LibItem = { id: string; kind: "competency" | "core_value" | "skill"; name: string };

export function PerfSettingsView({ settings, scales, periods, forms, library }: {
  settings: Settings; scales: { id: string; name: string; points: ScalePoint[] }[]; periods: { id: string; name: string; starts_on: string; ends_on: string }[]; forms: Form[]; library: LibItem[];
}) {
  return (
    <div className="flex flex-col gap-5">
      <General s={settings} scales={scales} />
      <Periods periods={periods} />
      <Forms forms={forms} library={library} scales={scales} />
    </div>
  );
}

const num = (s: string) => (s.trim() === "" ? NaN : Number(s));

function General({ s, scales }: { s: Settings; scales: { id: string; name: string; points: ScalePoint[] }[] }) {
  const [v, setV] = React.useState(s);
  const [points, setPoints] = React.useState(s.points.map((p) => ({ value: String(p.value), label: p.label })));
  const [bands, setBands] = React.useState(s.bands.map((b) => ({ label: b.label, min: String(b.min), max: String(b.max) })));
  const [ideal, setIdeal] = React.useState<Record<string, string>>(Object.fromEntries(s.idealDistribution.map((d) => [d.label, String(d.pct)])));
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const up = (patch: Partial<Settings>) => setV((x) => ({ ...x, ...patch }));
  const weightSum = Object.values(v.reviewerWeights).reduce((a, b) => a + b, 0);
  const idealSum = bands.reduce((a, b) => a + (Number(ideal[b.label]) || 0), 0);
  const save = async () => {
    setBusy(true); setErr(null);
    const bs = bands.map((b) => ({ label: b.label, min: num(b.min), max: num(b.max) }));
    const r = await saveSettingsAction({
      ...v, points: points.map((p) => ({ value: num(p.value), label: p.label })), bands: bs,
      idealDistribution: idealSum ? bs.map((b) => ({ label: b.label, pct: Number(ideal[b.label]) || 0 })) : [],
    });
    setBusy(false);
    if (r.ok) toast.success("Settings saved"); else setErr(r.error);
  };
  return (
    <Card>
      <CardHeader title="Goals and ratings" />
      <CardBody className="flex flex-col gap-6">
        {err && <Banner tone="danger">{err}</Banner>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Goal style" help="OKRs: objectives with key results that roll up. KRAs: weighted responsibility areas adding up to 100%.">
            <Select value={v.goalMode} onValueChange={(x) => up({ goalMode: x as "okr" | "kra" })} options={[{ value: "okr", label: "OKRs (objectives and key results)" }, { value: "kra", label: "KRAs (key result areas)" }]} />
          </Field>
          <Field label="Check-in reminders" help="People with goals that haven't moved get a nudge">
            <Select value={v.checkinReminder} onValueChange={(x) => up({ checkinReminder: x as Settings["checkinReminder"] })} options={[{ value: "off", label: "Off" }, { value: "weekly", label: "Weekly" }, { value: "biweekly", label: "Every two weeks" }, { value: "monthly", label: "Monthly" }]} />
          </Field>
        </div>
        <Switch label="Key result weights must add up to 100%" checked={v.krWeightsMustTotal} onCheckedChange={(x) => up({ krWeightsMustTotal: x })} />

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-semibold">Rating scale</legend>
          {scales.length > 1 && <Field label="Scale"><Select value={v.ratingScaleId ?? undefined} onValueChange={(x) => { up({ ratingScaleId: x }); const sc = scales.find((y) => y.id === x); if (sc) setPoints(sc.points.map((p) => ({ value: String(p.value), label: p.label }))); }} options={scales.map((x) => ({ value: x.id, label: x.name }))} /></Field>}
          <p className="text-sm text-text-muted">Points can change until the first review is submitted on this scale.</p>
          {points.map((p, i) => (
            <div key={i} className="grid grid-cols-[5rem_1fr_auto] gap-2">
              <Input aria-label={`Point ${i + 1} value`} type="number" inputMode="decimal" value={p.value} onChange={(e) => setPoints(points.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
              <Input aria-label={`Point ${i + 1} label`} value={p.label} onChange={(e) => setPoints(points.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} maxLength={40} />
              <IconButton label={`Remove point ${i + 1}`} disabled={points.length <= 2} onClick={() => setPoints(points.filter((_, j) => j !== i))}><Trash2 /></IconButton>
            </div>
          ))}
          {points.length < 10 && <Button size="sm" variant="secondary" className="self-start" onClick={() => setPoints([...points, { value: String(points.length + 1), label: "" }])}><Plus />Add point</Button>}
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-semibold">Bands and ideal distribution</legend>
          <p className="text-sm text-text-muted">Bands group ratings for the bell curve and results. The ideal shares are what calibration aims for.</p>
          <div className="hidden grid-cols-[1fr_6rem_6rem_6rem_auto] gap-2 text-xs font-medium text-text-muted sm:grid"><span>Band</span><span>From</span><span>To</span><span>Ideal %</span><span className="w-9" /></div>
          {bands.map((b, i) => (
            <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_6rem_6rem_6rem_auto]">
              <Input className="col-span-2 sm:col-span-1" aria-label={`Band ${i + 1} name`} value={b.label} onChange={(e) => { const old = b.label; setBands(bands.map((x, j) => (j === i ? { ...x, label: e.target.value } : x))); setIdeal((d) => { const n = { ...d, [e.target.value]: d[old] ?? "" }; delete n[old]; return n; }); }} maxLength={40} />
              <Input aria-label={`Band ${i + 1} from`} type="number" step="0.01" value={b.min} onChange={(e) => setBands(bands.map((x, j) => (j === i ? { ...x, min: e.target.value } : x)))} />
              <Input aria-label={`Band ${i + 1} to`} type="number" step="0.01" value={b.max} onChange={(e) => setBands(bands.map((x, j) => (j === i ? { ...x, max: e.target.value } : x)))} />
              <Input aria-label={`Band ${i + 1} ideal share`} type="number" min={0} max={100} value={ideal[b.label] ?? ""} onChange={(e) => setIdeal({ ...ideal, [b.label]: e.target.value })} />
              <IconButton label={`Remove band ${b.label}`} onClick={() => setBands(bands.filter((_, j) => j !== i))}><Trash2 /></IconButton>
            </div>
          ))}
          <div className="flex items-center gap-3">
            {bands.length < 10 && <Button size="sm" variant="secondary" onClick={() => setBands([...bands, { label: "", min: "", max: "" }])}><Plus />Add band</Button>}
            <span className={idealSum && idealSum !== 100 ? "text-sm text-danger-text" : "text-sm text-text-muted"}>Ideal shares total {idealSum}%</span>
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-semibold">How reviews combine into one rating</legend>
            {(["self", "manager", "peer", "skip_level"] as ReviewerType[]).map((k) => (
              <div key={k} className="grid grid-cols-[1fr_6rem] items-center gap-2">
                <label htmlFor={`w-${k}`} className="text-base">{{ self: "Self review", manager: "Manager review", peer: "Peer reviews (average)", skip_level: "Skip-level review" }[k]}</label>
                <Input id={`w-${k}`} type="number" min={0} max={100} value={v.reviewerWeights[k]} onChange={(e) => up({ reviewerWeights: { ...v.reviewerWeights, [k]: Number(e.target.value) || 0 } })} />
              </div>
            ))}
            <p className={weightSum !== 100 ? "text-sm text-danger-text" : "text-sm text-text-muted"}>Total {weightSum}% (needs 100)</p>
          </fieldset>
          <Field label="Rounding of the overall rating"><Select value={v.rounding} onValueChange={(x) => up({ rounding: x as Settings["rounding"] })} options={[{ value: "none", label: "Two decimals (3.47)" }, { value: "one_decimal", label: "One decimal (3.5)" }, { value: "half", label: "Nearest half (3.5)" }, { value: "whole", label: "Whole number (3)" }]} /></Field>
        </div>
        <div className="flex justify-end"><Button loading={busy} onClick={save}>Save settings</Button></div>
      </CardBody>
    </Card>
  );
}

function Periods({ periods }: { periods: { id: string; name: string; starts_on: string; ends_on: string }[] }) {
  const [edit, setEdit] = React.useState<{ id: string | null; name: string; startsOn: string; endsOn: string } | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  return (
    <Card>
      <CardHeader title="Goal periods" description="Quarters, halves or years that goals belong to" action={<Button size="sm" variant="secondary" onClick={() => { setErr(null); setEdit({ id: null, name: "", startsOn: "", endsOn: "" }); }}><Plus />Add period</Button>} />
      {!periods.length ? <EmptyState compact icon={<CalendarRange />} title="No periods" description="Without periods every goal shows all the time." /> : (
        <ul className="divide-y divide-border border-t border-border">{periods.map((p) => (
          <li key={p.id} className="flex items-center gap-3 px-5 py-2.5"><span className="flex-1 text-base font-medium">{p.name}</span><span className="text-sm text-text-muted">{fmtDate(p.starts_on)} – {fmtDate(p.ends_on)}</span>
            <IconButton label={`Edit ${p.name}`} size="icon-sm" onClick={() => { setErr(null); setEdit({ id: p.id, name: p.name, startsOn: p.starts_on, endsOn: p.ends_on }); }}><Pencil /></IconButton></li>
        ))}</ul>
      )}
      {edit && (
        <Modal open onOpenChange={(o) => !o && setEdit(null)} size="sm" title={edit.id ? "Edit period" : "Add period"}
          footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={async () => { const r = await savePeriodAction(edit.id, { name: edit.name, startsOn: edit.startsOn, endsOn: edit.endsOn }); if (r.ok) { toast.success("Saved"); setEdit(null); } else setErr(r.error); }}>Save</Button></>}>
          <div className="flex flex-col gap-4">
            {err && <p role="alert" className="text-sm text-danger-text">{err}</p>}
            <Field label="Name" help="e.g. Q1 2027"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={60} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Starts"><Input type="date" value={edit.startsOn} onChange={(e) => setEdit({ ...edit, startsOn: e.target.value })} /></Field>
              <Field label="Ends"><Input type="date" value={edit.endsOn} onChange={(e) => setEdit({ ...edit, endsOn: e.target.value })} /></Field>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  );
}

const rid = () => Math.random().toString(36).slice(2, 10);
const LIB_KIND: Partial<Record<SectionType, LibItem["kind"]>> = { competencies: "competency", core_values: "core_value", skills: "skill" };

function Forms({ forms, library, scales }: { forms: Form[]; library: LibItem[]; scales: { id: string; name: string }[] }) {
  const [edit, setEdit] = React.useState<{ id: string | null; name: string; ratingScaleId: string | null; sections: Section[] } | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const setSec = (i: number, patch: Partial<Section>) => setEdit((e) => e && { ...e, sections: e.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  return (
    <Card id="forms">
      <CardHeader title="Review forms" description="Sections people answer in a review" action={<Button size="sm" variant="secondary" onClick={() => { setErr(null); setEdit({ id: null, name: "", ratingScaleId: null, sections: [{ id: rid(), type: "questions", title: "Looking back", weight: 0, items: [{ id: rid(), text: "", rated: true }] }] }); }}><Plus />New form</Button>} />
      {!forms.length ? <EmptyState compact icon={<FileText />} title="No forms yet" description="Create a form before setting up a review cycle." /> : (
        <ul className="divide-y divide-border border-t border-border">{forms.map((f) => (
          <li key={f.id} className="flex items-center gap-3 px-5 py-2.5">
            <div className="min-w-0 flex-1"><p className="text-base font-medium">{f.name}</p><p className="truncate text-sm text-text-muted">{f.sections.map((s) => s.title).join(" · ")}</p></div>
            {f.in_use && <Badge tone="accent">In use</Badge>}
            <Button size="sm" variant="ghost" onClick={() => { setErr(null); setEdit({ id: f.id, name: f.name, ratingScaleId: f.rating_scale_id, sections: f.sections }); }}>Edit</Button>
            <Button size="sm" variant="ghost" onClick={() => { setErr(null); setEdit({ id: null, name: `${f.name} (copy)`, ratingScaleId: f.rating_scale_id, sections: f.sections.map((s) => ({ ...s, id: rid() })) }); }}>Copy</Button>
          </li>
        ))}</ul>
      )}
      {edit && (
        <Modal open onOpenChange={(o) => !o && setEdit(null)} size="lg" title={edit.id ? "Edit form" : "New form"}
          footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button loading={busy} onClick={async () => { setBusy(true); setErr(null); const r = await saveFormAction(edit.id, edit); setBusy(false); if (r.ok) { toast.success("Form saved"); setEdit(null); } else setErr(r.error); }}>Save form</Button></>}>
          <div className="flex flex-col gap-4">
            {err && <Banner tone="danger">{err}</Banner>}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" required><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={80} /></Field>
              <Field label="Rating scale" help="Empty uses the company scale"><Select value={edit.ratingScaleId ?? "default"} onValueChange={(x) => setEdit({ ...edit, ratingScaleId: x === "default" ? null : x })} options={[{ value: "default", label: "Company scale" }, ...scales.map((s) => ({ value: s.id, label: s.name }))]} /></Field>
            </div>
            <p className="text-sm text-text-muted">Section weights must add up to 100, or all stay at 0 for equal weight.</p>
            {edit.sections.map((s, i) => (
              <fieldset key={s.id} className="flex flex-col gap-3 rounded-md border border-border p-3">
                <legend className="px-1 text-sm font-semibold">Section {i + 1}</legend>
                <div className="grid gap-2 sm:grid-cols-[1fr_12rem_6rem_auto] sm:items-end">
                  <Field label="Title"><Input value={s.title} onChange={(e) => setSec(i, { title: e.target.value })} maxLength={120} /></Field>
                  <Field label="Type"><Select value={s.type} onValueChange={(x) => setSec(i, { type: x as SectionType, items: [] })} options={(Object.keys(SECTION_LABEL) as SectionType[]).map((k) => ({ value: k, label: SECTION_LABEL[k] }))} /></Field>
                  <Field label="Weight %"><Input type="number" min={0} max={100} value={s.weight} onChange={(e) => setSec(i, { weight: Number(e.target.value) || 0 })} /></Field>
                  <IconButton label={`Remove section ${i + 1}`} onClick={() => setEdit({ ...edit, sections: edit.sections.filter((_, j) => j !== i) })}><Trash2 /></IconButton>
                </div>
                {s.type === "goals" && <p className="text-sm text-text-muted">Each person&apos;s goals in the review period are listed and rated.</p>}
                {s.type === "questions" && (
                  <div className="flex flex-col gap-2">
                    {s.items.map((it, k) => (
                      <div key={it.id} className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto] sm:items-center">
                        <Input aria-label={`Question ${k + 1}`} value={it.text} placeholder="Question" onChange={(e) => setSec(i, { items: s.items.map((x, m) => (m === k ? { ...x, text: e.target.value } : x)) })} maxLength={500} />
                        <Checkbox label="Rated" checked={it.rated} onCheckedChange={(v) => setSec(i, { items: s.items.map((x, m) => (m === k ? { ...x, rated: !!v } : x)) })} />
                        {!it.rated && <Checkbox label="Required" checked={!!it.required} onCheckedChange={(v) => setSec(i, { items: s.items.map((x, m) => (m === k ? { ...x, required: !!v } : x)) })} />}
                        <IconButton label={`Remove question ${k + 1}`} size="icon-sm" onClick={() => setSec(i, { items: s.items.filter((_, m) => m !== k) })}><Trash2 /></IconButton>
                      </div>
                    ))}
                    <Button size="sm" variant="ghost" className="self-start" onClick={() => setSec(i, { items: [...s.items, { id: rid(), text: "", rated: true }] })}><Plus />Add question</Button>
                  </div>
                )}
                {LIB_KIND[s.type] && (
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {library.filter((l) => l.kind === LIB_KIND[s.type]).map((l) => (
                      <Checkbox key={l.id} label={l.name} checked={s.items.some((x) => x.id === l.id)}
                        onCheckedChange={(v) => setSec(i, { items: v ? [...s.items, { id: l.id, text: l.name, rated: true }] : s.items.filter((x) => x.id !== l.id) })} />
                    ))}
                    {!library.some((l) => l.kind === LIB_KIND[s.type]) && <p className="text-sm text-text-muted">Add some in the skills library first.</p>}
                  </div>
                )}
              </fieldset>
            ))}
            {edit.sections.length < 10 && <Button size="sm" variant="secondary" className="self-start" onClick={() => setEdit({ ...edit, sections: [...edit.sections, { id: rid(), type: "questions", title: "", weight: 0, items: [] }] })}><Plus />Add section</Button>}
          </div>
        </Modal>
      )}
    </Card>
  );
}
