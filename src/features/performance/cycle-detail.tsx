"use client";
import * as React from "react";
import Link from "next/link";
import { BellRing, CheckCheck, Download, Pencil, Scale, Upload, Users } from "lucide-react";
import { CYCLE_STATUS_LABEL, NINE_BOX_LABEL, REVIEWER_LABEL, STAGE_LABEL, type Band, type CycleStatus, type ReviewerType, type ScalePoint, type Timelines } from "@/server/modules/performance/rules";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { Card, CardBody, CardHeader, StatTile } from "@/ui/card";
import { Button } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Modal, ConfirmDialog } from "@/ui/overlay";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Checkbox } from "@/ui/choice";
import { DataTable, type Column } from "@/ui/table";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { advanceCycleAction, importCalibrationAction, launchCycleAction, nudgeAction, publishResultsAction, setFinalRatingAction, updateCycleAction, deleteCycleAction } from "@/app/(app)/performance/actions";
import { CycleWizard, type CycleDraft } from "./cycle-wizard";
import { fmtDate, ReviewStatusBadge } from "./bits";
import { useRouter } from "next/navigation";

type Stage = { type: ReviewerType; total: number; submitted: number; draft: number; declined: number; overdue: number; due: string | null };
type PersonProgress = { id: string; name: string; reviews: { id: string; type: ReviewerType; status: string; reviewer: string; proposed: boolean }[] };
type Cycle = { id: string; name: string; kind: string; status: CycleStatus; period_start: string; period_end: string; timelines: Timelines; reviewers: CycleDraft["reviewers"]; form_id: string | null; employee_filter: CycleDraft["employeeFilter"]; auto_rule: CycleDraft["autoRule"]; source_cycle_ids: string[]; launched_at: string | null; published_at: string | null };
type CalPerson = { outcomeId: string; id: string; name: string; number: string; department: string | null; designation: string | null; computed: number | null; final: number | null; effective: number | null; potential: number | null; note: string | null; released: boolean; band: string | null; box: { perf: number; potential: number } | null; self: boolean };
type Dist = { total: number; unbanded: number; bands: { label: string; count: number; pct: number }[] };
type Cal = { cycle: { id: string; name: string; status: string; kind: string }; points: ScalePoint[]; bands: Band[]; ideal: { label: string; pct: number }[]; people: CalPerson[]; pre: Dist; post: Dist; canPublish: boolean };
type WizardProps = React.ComponentProps<typeof CycleWizard>;

export function CycleDetail({ admin, progress, cal, wizard, today, initialTab }: {
  admin: boolean; progress: { cycle: Cycle; stages: Stage[]; people: PersonProgress[] }; cal: Cal | null; wizard: Omit<WizardProps, "today"> | null; today: string; initialTab?: string;
}) {
  const c = progress.cycle;
  const [tab, setTab] = React.useState(initialTab ?? (c.status === "calibration" ? "calibration" : c.status === "draft" ? "setup" : "progress"));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={c.status === "live" ? "accent" : c.status === "calibration" ? "warning" : c.status === "published" ? "success" : "neutral"} size="md">{CYCLE_STATUS_LABEL[c.status]}</Badge>
        <span className="text-sm text-text-muted">{fmtDate(c.period_start)} – {fmtDate(c.period_end)}{c.launched_at ? ` · launched ${fmtDate(c.launched_at)}` : ""}</span>
        {admin && <div className="ml-auto flex flex-wrap gap-2"><Advance c={c} /></div>}
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList items={[
          ...(c.status === "draft" ? [{ value: "setup", label: "Set up" }] : []),
          ...(c.kind !== "aggregate" && c.status !== "draft" ? [{ value: "progress", label: "Progress" }] : []),
          ...(cal ? [{ value: "calibration", label: "Calibration" }, { value: "publish", label: "Publish" }] : []),
          ...(admin && c.status !== "draft" && c.status !== "closed" && c.kind !== "aggregate" ? [{ value: "dates", label: "Dates" }] : []),
        ]} />
        {c.status === "draft" && <TabsContent value="setup">{wizard ? <CycleWizard {...wizard} today={today} /> : <p className="text-base text-text-muted">This cycle hasn&apos;t been launched yet.</p>}</TabsContent>}
        <TabsContent value="progress"><Progress c={c} stages={progress.stages} people={progress.people} admin={admin} /></TabsContent>
        {cal && <TabsContent value="calibration"><Calibration cal={cal} /></TabsContent>}
        {cal && <TabsContent value="publish"><Publish cal={cal} /></TabsContent>}
        {admin && <TabsContent value="dates"><Dates c={c} /></TabsContent>}
      </Tabs>
    </div>
  );
}

function Advance({ c }: { c: Cycle }) {
  const router = useRouter();
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) => { const r = await fn(); if (r.ok) toast.success(ok); else toast.error(r.error ?? "Couldn't do that."); };
  if (c.status === "draft") return (
    <>
      <ConfirmDialog trigger={<Button variant="ghost">Delete draft</Button>} title="Delete this draft?" description="Nothing has been sent yet." confirmLabel="Delete"
        onConfirm={async () => { const r = await deleteCycleAction(c.id); if (r.ok) { toast.success("Deleted"); router.push("/performance"); } else toast.error(r.error); }} />
      <ConfirmDialog trigger={<Button>Launch</Button>} tone="primary" title="Launch this cycle?" description="Everyone involved is told about the reviews they need to write." confirmLabel="Launch"
        onConfirm={() => run(() => launchCycleAction(c.id), "Launched")} />
    </>
  );
  if (c.status === "live") return <ConfirmDialog trigger={<Button><Scale />Move to calibration</Button>} tone="primary" title="Close reviews and start calibration?" confirmLabel="Start calibration"
    description="Reviewers can't submit after this. Overall ratings are worked out from the reviews that are in." onConfirm={() => run(() => advanceCycleAction(c.id, "calibration"), "Calibration started")} />;
  if (c.status === "published") return <ConfirmDialog trigger={<Button variant="secondary">Close cycle</Button>} tone="primary" title="Close this cycle?" confirmLabel="Close"
    description="Results stay visible to employees. Nothing more can change." onConfirm={() => run(() => advanceCycleAction(c.id, "closed"), "Closed")} />;
  return null;
}

function Progress({ c, stages, people, admin }: { c: Cycle; stages: Stage[]; people: PersonProgress[]; admin: boolean }) {
  const [busy, setBusy] = React.useState<string | null>(null);
  if (!people.length) return <Card><EmptyState icon={<Users />} title="Nobody in this cycle yet" description={c.auto_rule ? "People join automatically when they reach the trigger date." : "Launch the cycle to send reviews out."} /></Card>;
  const nudge = async (t: ReviewerType | null) => { setBusy(t ?? "all"); const r = await nudgeAction(c.id, t); setBusy(null); if (r.ok) toast.success(r.data!.sent ? `Reminded ${r.data!.sent} ${r.data!.sent === 1 ? "person" : "people"}` : "Everyone has already been reminded today"); else toast.error(r.error); };
  const cols: Column<PersonProgress>[] = [
    { key: "name", header: "Person", cell: (p) => <span className="font-medium">{p.name}</span>, sortValue: (p) => p.name },
    ...(["self", "peer", "manager", "skip_level"] as ReviewerType[]).filter((t) => stages.some((s) => s.type === t)).map((t) => ({
      key: t, header: REVIEWER_LABEL[t], hideBelow: t === "peer" || t === "skip_level" ? ("md" as const) : undefined,
      cell: (p: PersonProgress) => {
        const rs = p.reviews.filter((r) => r.type === t);
        if (!rs.length) return <span className="text-text-muted">—</span>;
        const done = rs.filter((r) => r.status === "submitted").length;
        return rs.length === 1 ? <ReviewStatusBadge status={(rs[0].proposed ? "proposed" : rs[0].status) as "draft"} /> : <span className="tabular text-sm">{done} / {rs.length} done</span>;
      },
    })),
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stages.map((s) => (
          <StatTile key={s.type} label={`${REVIEWER_LABEL[s.type]} reviews`} value={`${s.submitted} / ${s.total}`} hint={`${s.overdue ? `${s.overdue} overdue · ` : ""}${s.due ? `due ${fmtDate(s.due)}` : "no due date"}`} />
        ))}
      </div>
      {admin && c.status === "live" && (
        <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
          <p className="flex-1 text-base"><BellRing className="mr-2 inline size-4 text-text-muted" aria-hidden />Remind people who haven&apos;t finished. Each person gets at most one reminder a day.</p>
          <div className="flex flex-wrap gap-2">
            {stages.filter((s) => s.submitted < s.total).map((s) => <Button key={s.type} size="sm" variant="secondary" loading={busy === s.type} onClick={() => nudge(s.type)}>{REVIEWER_LABEL[s.type]}</Button>)}
            <Button size="sm" loading={busy === "all"} onClick={() => nudge(null)}>Remind everyone</Button>
          </div>
        </Card>
      )}
      <DataTable caption="Review progress by person" rows={people} columns={cols} rowKey={(p) => p.id} />
    </div>
  );
}

function BellCurve({ cal }: { cal: Cal }) {
  const series = [
    { key: "ideal", label: "Ideal", color: "var(--chart-3)", values: cal.bands.map((b) => cal.ideal.find((i) => i.label === b.label)?.pct ?? 0) },
    { key: "pre", label: "Before calibration", color: "var(--chart-2)", values: cal.bands.map((b) => cal.pre.bands.find((x) => x.label === b.label)?.pct ?? 0) },
    { key: "post", label: "After calibration", color: "var(--chart-1)", values: cal.bands.map((b) => cal.post.bands.find((x) => x.label === b.label)?.pct ?? 0) },
  ];
  const max = Math.max(10, ...series.flatMap((s) => s.values));
  const W = 640, H = 220, pad = 28, groupW = (W - pad) / Math.max(1, cal.bands.length), barW = Math.min(22, (groupW - 16) / 3);
  return (
    <figure className="flex flex-col gap-3">
      <figcaption className="flex flex-wrap gap-4 text-sm" aria-hidden>
        {series.map((s) => <span key={s.key} className="inline-flex items-center gap-1.5"><span className="size-3 rounded-sm" style={{ background: s.color }} />{s.label}</span>)}
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H + 40}`} className="h-auto w-full" role="img" aria-label="Share of people per rating band: ideal, before and after calibration. The table below has the same numbers.">
        {[0, 0.5, 1].map((f) => <g key={f}><line x1={pad} x2={W} y1={H - f * H + 4} y2={H - f * H + 4} stroke="var(--border)" /><text x={0} y={H - f * H + 8} fontSize="11" fill="var(--text-muted)">{Math.round(f * max)}%</text></g>)}
        {cal.bands.map((b, i) => (
          <g key={b.label}>
            {series.map((s, j) => {
              const h = (s.values[i] / max) * H;
              return <rect key={s.key} x={pad + i * groupW + 8 + j * (barW + 2)} y={H - h + 4} width={barW} height={Math.max(0, h)} rx={2} fill={s.color} />;
            })}
            <text x={pad + i * groupW + groupW / 2} y={H + 24} fontSize="11" textAnchor="middle" fill="var(--text-muted)">{b.label.length > 16 ? b.label.slice(0, 15) + "…" : b.label}</text>
          </g>
        ))}
      </svg>
      <table className="w-full text-sm">
        <caption className="sr-only">Rating distribution by band</caption>
        <thead><tr className="border-b border-border text-left text-text-muted"><th scope="col" className="py-1.5 font-medium">Band</th>{series.map((s) => <th key={s.key} scope="col" className="py-1.5 text-right font-medium">{s.label}</th>)}</tr></thead>
        <tbody>{cal.bands.map((b, i) => (
          <tr key={b.label} className="border-b border-border last:border-0"><th scope="row" className="py-1.5 text-left font-normal">{b.label} <span className="text-text-muted">({b.min}–{b.max})</span></th>
            {series.map((s) => <td key={s.key} className="py-1.5 text-right tabular">{Math.round(s.values[i])}%</td>)}</tr>
        ))}</tbody>
      </table>
      {cal.post.unbanded > 0 && <p className="text-sm text-text-muted">{cal.post.unbanded} rating{cal.post.unbanded === 1 ? " falls" : "s fall"} outside every band. Check the bands in Settings.</p>}
    </figure>
  );
}

function NineBox({ cal }: { cal: Cal }) {
  const cell = (perf: number, pot: number) => cal.people.filter((p) => p.box?.perf === perf && p.box?.potential === pot);
  const unplaced = cal.people.filter((p) => !p.box).length;
  return (
    <div>
      <div className="grid grid-cols-[auto_1fr] gap-2">
        <div className="flex items-center"><span className="text-xs font-medium text-text-muted [writing-mode:vertical-rl] rotate-180">Potential →</span></div>
        <div className="grid grid-cols-3 gap-1.5" role="table" aria-label="9-box grid: performance across, potential up">
          {[3, 2, 1].map((pot) => [1, 2, 3].map((perf) => {
            const ps = cell(perf, pot);
            return (
              <div key={`${perf}-${pot}`} role="cell" className="min-h-24 rounded-md border border-border bg-surface-sunken p-2">
                <p className="text-xs font-semibold">{NINE_BOX_LABEL[`${perf}-${pot}`]} <span className="font-normal text-text-muted tabular">· {ps.length}</span></p>
                <ul className="mt-1 flex flex-col gap-0.5 text-xs">{ps.slice(0, 6).map((p) => <li key={p.id} className="truncate">{p.name}</li>)}{ps.length > 6 && <li className="text-text-muted">+{ps.length - 6} more</li>}</ul>
              </div>
            );
          }))}
        </div>
        <div />
        <p className="text-center text-xs font-medium text-text-muted">Performance →</p>
      </div>
      {unplaced > 0 && <p className="mt-2 text-sm text-text-muted">{unplaced} {unplaced === 1 ? "person needs" : "people need"} a potential rating to appear in the grid.</p>}
    </div>
  );
}

function Calibration({ cal }: { cal: Cal }) {
  const [editing, setEditing] = React.useState<CalPerson | null>(null);
  const [filter, setFilter] = React.useState("all");
  const editable = cal.cycle.status === "calibration";
  const depts = [...new Set(cal.people.map((p) => p.department).filter(Boolean))] as string[];
  const rows = cal.people.filter((p) => filter === "all" || p.department === filter);
  const cols: Column<CalPerson>[] = [
    { key: "name", header: "Person", cell: (p) => <div><p className="font-medium">{p.name}</p><p className="text-xs text-text-muted">{p.designation ?? ""}{p.department ? ` · ${p.department}` : ""}</p></div>, sortValue: (p) => p.name },
    { key: "computed", header: "From reviews", align: "right", cell: (p) => p.computed ?? "—", sortValue: (p) => p.computed ?? -1 },
    { key: "final", header: "Final", align: "right", cell: (p) => (p.final != null ? <span className="font-semibold">{p.final}</span> : <span className="text-text-muted">same</span>), sortValue: (p) => p.effective ?? -1 },
    { key: "band", header: "Band", cell: (p) => (p.band ? <Badge>{p.band}</Badge> : "—"), hideBelow: "md" },
    { key: "potential", header: "Potential", cell: (p) => (p.potential ? ["", "Low", "Medium", "High"][p.potential] : "—"), hideBelow: "md" },
    { key: "edit", header: <span className="sr-only">Edit</span>, cell: (p) => editable && !p.self ? <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setEditing(p); }} aria-label={`Edit ${p.name}'s rating`}><Pencil /></Button> : null },
  ];
  return (
    <div className="flex flex-col gap-4">
      {!editable && <Banner tone="info">Ratings are locked: this cycle is {cal.cycle.status}.</Banner>}
      <div className="grid gap-4 xl:grid-cols-2">
        <Card><CardHeader title="Bell curve" description={`${cal.post.total} people rated`} /><CardBody><BellCurve cal={cal} /></CardBody></Card>
        <Card><CardHeader title="9-box" description="Final rating against potential" /><CardBody><NineBox cal={cal} /></CardBody></Card>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        {depts.length > 1 && <Field label="Department" className="w-56"><Select size="sm" value={filter} onValueChange={setFilter} options={[{ value: "all", label: "All departments" }, ...depts.map((d) => ({ value: d, label: d }))]} /></Field>}
        {editable && <div className="ml-auto flex flex-wrap gap-2"><Button size="sm" variant="secondary" asChild><a href={`/performance/cycles/${cal.cycle.id}/template`}><Download />Download sheet</a></Button><ImportSheet cycleId={cal.cycle.id} /></div>}
      </div>
      <DataTable caption="Ratings to calibrate" rows={rows} columns={cols} rowKey={(p) => p.outcomeId} />
      {editing && <EditRating p={editing} points={cal.points} onClose={() => setEditing(null)} />}
    </div>
  );
}

function EditRating({ p, points, onClose }: { p: CalPerson; points: ScalePoint[]; onClose: () => void }) {
  const [final, setFinal] = React.useState(p.final != null ? String(p.final) : "");
  const [potential, setPotential] = React.useState(p.potential ? String(p.potential) : "none");
  const [note, setNote] = React.useState(p.note ?? "");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const min = Math.min(...points.map((x) => x.value)), max = Math.max(...points.map((x) => x.value));
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="sm" title={`Calibrate ${p.name}`} description={`From reviews: ${p.computed ?? "no rating yet"}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={async () => {
        setBusy(true); setErr(null);
        const r = await setFinalRatingAction(p.outcomeId, { finalRating: final === "" ? null : Number(final), potential: potential === "none" ? null : Number(potential), note: note || null });
        setBusy(false);
        if (r.ok) { toast.success("Saved"); onClose(); } else setErr(r.error);
      }}>Save</Button></>}>
      <div className="flex flex-col gap-4">
        {err && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{err}</p>}
        <Field label="Final rating" help={`Between ${min} and ${max}. Leave empty to keep the rating from reviews.`}><Input type="number" inputMode="decimal" step="0.1" min={min} max={max} value={final} onChange={(e) => setFinal(e.target.value)} /></Field>
        <Field label="Potential"><Select value={potential} onValueChange={setPotential} options={[{ value: "none", label: "Not set" }, { value: "1", label: "Low" }, { value: "2", label: "Medium" }, { value: "3", label: "High" }]} /></Field>
        <Field label="Note" help="Needed when the final rating differs from the reviews"><Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={1000} /></Field>
      </div>
    </Modal>
  );
}

function ImportSheet({ cycleId }: { cycleId: string }) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<string[]>([]);
  const ref = React.useRef<HTMLFormElement>(null);
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => { setErrors([]); setOpen(true); }}><Upload />Import sheet</Button>
      <Modal open={open} onOpenChange={setOpen} title="Import calibrated ratings" description="Upload the downloaded sheet with final ratings, potential and notes filled in. Nothing changes unless every row is right."
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={busy} onClick={async () => {
          setBusy(true); setErrors([]);
          const r = await importCalibrationAction(cycleId, new FormData(ref.current!));
          setBusy(false);
          if (!r.ok) { setErrors([r.error]); return; }
          if (r.data!.errors.length) { setErrors(r.data!.errors); return; }
          toast.success(`Updated ${r.data!.applied} ${r.data!.applied === 1 ? "rating" : "ratings"}`); setOpen(false);
        }}>Import</Button></>}>
        <form ref={ref} onSubmit={(e) => e.preventDefault()} className="flex flex-col gap-3">
          <Field label="Sheet (.xlsx)"><input name="file" type="file" accept=".xlsx" className="text-sm file:mr-3 file:rounded-md file:border file:border-border-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm" /></Field>
          {errors.length > 0 && <ul role="alert" className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
        </form>
      </Modal>
    </>
  );
}

function Publish({ cal }: { cal: Cal }) {
  const pending = cal.people.filter((p) => !p.released);
  const [picked, setPicked] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  if (!cal.canPublish) return <Banner tone="info">Only performance admins for the whole company can publish results.</Banner>;
  const publish = async (ids: string[] | null) => {
    setBusy(true);
    const r = await publishResultsAction(cal.cycle.id, ids);
    setBusy(false);
    if (r.ok) { toast.success(`Released to ${r.data!.released} ${r.data!.released === 1 ? "person" : "people"}`); setPicked([]); } else toast.error(r.error);
  };
  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <p className="flex-1 text-base">{pending.length ? `${pending.length} of ${cal.people.length} people haven't received their results.` : "Everyone has their results."} Each person sees their final rating, band and written comments. Peer names are never shown.</p>
        {pending.length > 0 && <ConfirmDialog trigger={<Button loading={busy}><CheckCheck />Publish to everyone</Button>} tone="primary" title="Publish results to everyone?" confirmLabel="Publish"
          description="People are told straight away. Ratings can't be changed afterwards." onConfirm={() => publish(null)} />}
      </Card>
      {pending.length > 0 && (
        <Card>
          <CardHeader title="Or publish to some people first" action={<Button size="sm" variant="secondary" disabled={!picked.length} loading={busy} onClick={() => publish(picked)}>Publish to {picked.length || "selected"}</Button>} />
          <ul className="grid gap-1 border-t border-border px-5 py-3 sm:grid-cols-2 lg:grid-cols-3">
            {pending.map((p) => <li key={p.id}><Checkbox label={`${p.name} · ${p.effective ?? "no rating"}`} checked={picked.includes(p.id)} onCheckedChange={(v) => setPicked(v ? [...picked, p.id] : picked.filter((x) => x !== p.id))} /></li>)}
          </ul>
        </Card>
      )}
      {cal.people.some((p) => p.released) && <p className="text-sm text-text-muted">Released: {cal.people.filter((p) => p.released).map((p) => p.name).join(", ")}</p>}
    </div>
  );
}

function Dates({ c }: { c: Cycle }) {
  const [t, setT] = React.useState<Timelines>(c.timelines);
  const [busy, setBusy] = React.useState(false);
  return (
    <Card className="p-5">
      <p className="mb-4 text-sm text-text-muted">A running cycle can move its dates. Who&apos;s reviewed and the form are fixed once launched.</p>
      <div className="grid gap-4 sm:grid-cols-3">
        {(Object.keys(STAGE_LABEL) as (keyof Timelines)[]).map((k) => <Field key={k} label={STAGE_LABEL[k]}><Input type="date" value={t[k] ?? ""} onChange={(e) => setT({ ...t, [k]: e.target.value || null })} /></Field>)}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" asChild><Link href="/performance">Back</Link></Button>
        <Button loading={busy} onClick={async () => {
          setBusy(true);
          const r = await updateCycleAction(c.id, { name: c.name, kind: c.kind, periodStart: c.period_start, periodEnd: c.period_end, timelines: t, reviewers: c.reviewers, formId: c.form_id, employeeFilter: c.employee_filter, autoRule: c.auto_rule, sourceCycleIds: c.source_cycle_ids });
          setBusy(false);
          if (r.ok) toast.success("Dates saved"); else toast.error(r.error);
        }}>Save dates</Button>
      </div>
    </Card>
  );
}
