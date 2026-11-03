"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, CalendarClock, Download, FileSpreadsheet, Play, Plus, Save, Trash2 } from "lucide-react";
import { Card, CardHeader } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Modal } from "@/ui/overlay";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { Checkbox, Segmented } from "@/ui/choice";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { previewReportAction, saveReportAction, setScheduleAction } from "@/app/(app)/reports/actions";
import { AGGS, OP_LABEL, OPS_FOR, describeSchedule, type Agg, type ColType, type Definition, type Op, type Schedule } from "@/server/modules/reports/rules";
import { ReportTable, type Header } from "./report-view";

export type DatasetInfo = { key: string; label: string; description: string; columns: { key: string; label: string; type: ColType }[] };
export type SavedInfo = { id: string; name: string; dataset: string; definition: Definition; mine: boolean; owner: string | null; shared_roles: string[]; schedule: Schedule | null; next_run_at: string | null };
type FilterRow = { id: number; col: string; op: Op; value: string; value2: string };
type Mode = "columns" | "group";

const AGG_LABEL: Record<Agg, string> = { count: "Count rows", sum: "Sum", avg: "Average", min: "Lowest", max: "Highest" };
let seq = 1;

/** S183: pick a dataset, columns or a grouping, filters and sort; preview; save, share with roles and schedule by email. */
export function ReportBuilder({ datasets, roles, people, saved, canBuild }: { datasets: DatasetInfo[]; roles: { key: string; name: string }[]; people: Person[]; saved: SavedInfo | null; canBuild: boolean }) {
  const router = useRouter();
  const editable = canBuild && (!saved || saved.mine);
  const [datasetKey, setDatasetKey] = React.useState(saved?.dataset ?? datasets[0]?.key ?? "");
  const ds = datasets.find((d) => d.key === datasetKey) ?? datasets[0];
  const def = saved?.definition;
  const [mode, setMode] = React.useState<Mode>(def?.groupBy ? "group" : "columns");
  const [columns, setColumns] = React.useState<string[]>(def?.columns ?? ds.columns.slice(0, 5).map((c) => c.key));
  const [groupBy, setGroupBy] = React.useState<string>(def?.groupBy ?? ds.columns[0]?.key ?? "");
  const [aggs, setAggs] = React.useState<{ fn: Agg; col: string | null }[]>(def?.aggregates?.length ? def.aggregates : [{ fn: "count", col: null }]);
  const [filters, setFilters] = React.useState<FilterRow[]>(() => (def?.filters ?? []).map((f) => ({ id: seq++, col: f.col, op: f.op, value: Array.isArray(f.value) ? (f.op === "in" ? f.value.join(", ") : String(f.value[0])) : f.value == null ? "" : String(f.value), value2: Array.isArray(f.value) && f.op === "between" ? String(f.value[1]) : "" })));
  const [sort, setSort] = React.useState<{ col: string; dir: "asc" | "desc" } | null>(def?.sort ?? null);
  const [name, setName] = React.useState(saved?.name ?? "");
  const [shared, setShared] = React.useState<string[]>(saved?.shared_roles ?? []);
  const [result, setResult] = React.useState<{ headers: Header[]; rows: Record<string, unknown>[]; total: number } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, start] = React.useTransition();
  const [saving, setSaving] = React.useState(false);
  const [scheduling, setScheduling] = React.useState(false);
  const col = (k: string) => ds.columns.find((c) => c.key === k);
  const numeric = ds.columns.filter((c) => c.type === "number" || c.type === "money");

  const definition = () => ({
    columns: mode === "columns" ? columns : [], groupBy: mode === "group" ? groupBy : null, aggregates: mode === "group" ? aggs : [],
    filters: filters.map((f) => ({ col: f.col, op: f.op, value: f.op === "between" ? [f.value, f.value2] : f.op === "in" ? f.value : f.value })),
    sort, limit: 5000,
  });
  const changeDataset = (k: string) => {
    const nd = datasets.find((d) => d.key === k)!;
    setDatasetKey(k); setColumns(nd.columns.slice(0, 5).map((c) => c.key)); setGroupBy(nd.columns[0]?.key ?? ""); setAggs([{ fn: "count", col: null }]); setFilters([]); setSort(null); setResult(null);
  };
  const run = () => start(async () => {
    const r = await previewReportAction(datasetKey, definition());
    if (!r.ok || !r.data) { setError(r.ok ? "Something went wrong." : r.error); setResult(null); return; }
    setError(null); setResult({ headers: r.data.headers, rows: r.data.rows, total: r.data.total });
  });
  const save = () => start(async () => {
    const r = await saveReportAction(saved?.id ?? null, { name, dataset: datasetKey, definition: definition(), sharedRoles: shared });
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(saved ? "Report saved" : "Report created"); setSaving(false);
    if (!saved && r.data) router.push(`/reports/builder/${r.data.id}`);
  });
  const savedId = saved?.id ?? null, savedDataset = saved?.dataset ?? null, savedDef = saved?.definition ?? null;
  React.useEffect(() => {   // a saved report runs itself once on open
    if (!savedId || !savedDataset || !savedDef) return;
    let live = true;
    previewReportAction(savedDataset, savedDef).then((r) => {
      if (!live) return;
      if (r.ok && r.data) { setError(null); setResult({ headers: r.data.headers, rows: r.data.rows, total: r.data.total }); } else if (!r.ok) setError(r.error);
    });
    return () => { live = false; };
  }, [savedId, savedDataset, savedDef]);
  const sortOptions = mode === "group" ? [{ value: groupBy, label: col(groupBy)?.label ?? groupBy }, ...aggs.map((a) => ({ value: `${a.fn}_${a.col ?? "rows"}`, label: a.fn === "count" ? "Rows" : `${AGG_LABEL[a.fn]} ${col(a.col ?? "")?.label ?? ""}` }))] : columns.map((k) => ({ value: k, label: col(k)?.label ?? k }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm"><Link href="/reports"><ArrowLeft />All reports</Link></Button>
        {saved && !saved.mine && <Badge tone="accent">Shared by {saved.owner ?? "a colleague"} · read only</Badge>}
        {saved?.schedule && <Badge tone="neutral"><CalendarClock />{describeSchedule(saved.schedule)}</Badge>}
        <div className="ml-auto flex flex-wrap gap-2">
          {saved && <Button asChild variant="secondary" size="sm"><a href={`/reports/export?saved=${saved.id}&format=csv`} download><Download />CSV</a></Button>}
          {saved && <Button asChild variant="secondary" size="sm"><a href={`/reports/export?saved=${saved.id}&format=xlsx`} download><FileSpreadsheet />XLSX</a></Button>}
          {editable && saved && <Button variant="secondary" size="sm" onClick={() => setScheduling(true)}><CalendarClock />Schedule</Button>}
          {editable && <Button size="sm" onClick={() => setSaving(true)}><Save />{saved ? "Save changes" : "Save report"}</Button>}
        </div>
      </div>
      {!canBuild && <Banner tone="info" title="View only">You can run reports shared with you. Building or changing them needs the report-builder permission.</Banner>}
      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        <fieldset disabled={!editable} className="flex flex-col gap-4">
          <Card>
            <CardHeader title="Data" />
            <div className="flex flex-col gap-4 px-5 pb-5">
              <Field label="Dataset" help={ds.description}><Select value={datasetKey} onValueChange={changeDataset} options={datasets.map((d) => ({ value: d.key, label: d.label }))} /></Field>
              <Segmented label="Shape" value={mode} onChange={setMode} options={[{ value: "columns", label: "Rows" }, { value: "group", label: "Summary" }]} />
              {mode === "columns" ? (
                <Field label="Columns">
                  <div className="grid gap-1.5 sm:grid-cols-2">{ds.columns.map((c) => <Checkbox key={c.key} label={c.label} checked={columns.includes(c.key)} onCheckedChange={(v) => setColumns((cs) => (v ? [...cs, c.key] : cs.filter((x) => x !== c.key)))} />)}</div>
                </Field>
              ) : (
                <>
                  <Field label="Group by"><Select value={groupBy} onValueChange={setGroupBy} options={ds.columns.map((c) => ({ value: c.key, label: c.label }))} /></Field>
                  <Field label="Show">
                    <div className="flex flex-col gap-2">
                      {aggs.map((a, i) => (
                        <div key={i} className="flex gap-2">
                          <Select size="sm" value={a.fn} onValueChange={(v) => setAggs((as) => as.map((x, j) => (j === i ? { fn: v as Agg, col: v === "count" ? null : (x.col ?? numeric[0]?.key ?? null) } : x)))} options={AGGS.map((g) => ({ value: g, label: AGG_LABEL[g] }))} className="w-36" />
                          {a.fn !== "count" && <Select size="sm" value={a.col ?? ""} onValueChange={(v) => setAggs((as) => as.map((x, j) => (j === i ? { ...x, col: v } : x)))} options={numeric.map((c) => ({ value: c.key, label: c.label }))} className="flex-1" />}
                          <IconButton size="icon-sm" label="Remove" disabled={aggs.length === 1} onClick={() => setAggs((as) => as.filter((_, j) => j !== i))}><Trash2 /></IconButton>
                        </div>
                      ))}
                      <Button variant="ghost" size="sm" className="self-start" onClick={() => setAggs((as) => [...as, { fn: "sum", col: numeric[0]?.key ?? null }])} disabled={!numeric.length}><Plus />Add value</Button>
                    </div>
                  </Field>
                </>
              )}
            </div>
          </Card>
          <Card>
            <CardHeader title="Filters" action={<Button variant="ghost" size="sm" onClick={() => setFilters((fs) => [...fs, { id: seq++, col: ds.columns[0].key, op: OPS_FOR[ds.columns[0].type][0], value: "", value2: "" }])}><Plus />Add</Button>} />
            <div className="flex flex-col gap-3 px-5 pb-5">
              {filters.length === 0 && <p className="text-sm text-text-muted">No filters: every row you may see.</p>}
              {filters.map((f) => {
                const c = col(f.col) ?? ds.columns[0];
                const ops = OPS_FOR[c.type];
                const inputType = c.type === "date" ? "date" : c.type === "number" || c.type === "money" ? "number" : "text";
                return (
                  <div key={f.id} className="flex flex-col gap-1.5 rounded-md border border-border p-2">
                    <div className="flex gap-1.5">
                      <Select size="sm" value={f.col} onValueChange={(v) => { const nc = col(v)!; setFilters((fs) => fs.map((x) => (x.id === f.id ? { ...x, col: v, op: OPS_FOR[nc.type].includes(x.op) ? x.op : OPS_FOR[nc.type][0], value: "", value2: "" } : x))); }} options={ds.columns.map((x) => ({ value: x.key, label: x.label }))} className="flex-1" />
                      <IconButton size="icon-sm" label="Remove filter" onClick={() => setFilters((fs) => fs.filter((x) => x.id !== f.id))}><Trash2 /></IconButton>
                    </div>
                    <Select size="sm" value={f.op} onValueChange={(v) => setFilters((fs) => fs.map((x) => (x.id === f.id ? { ...x, op: v as Op } : x)))} options={ops.map((o) => ({ value: o, label: OP_LABEL[o] }))} />
                    {f.op !== "is_null" && f.op !== "not_null" && (c.type === "bool" ? (
                      <Select size="sm" value={f.value || "true"} onValueChange={(v) => setFilters((fs) => fs.map((x) => (x.id === f.id ? { ...x, value: v } : x)))} options={[{ value: "true", label: "Yes" }, { value: "false", label: "No" }]} />
                    ) : (
                      <div className="flex gap-1.5">
                        <Input inputSize="sm" type={f.op === "in" ? "text" : inputType} value={f.value} placeholder={f.op === "in" ? "a, b, c" : c.type === "money" ? "Rupees" : ""} aria-label="Value" onChange={(e) => setFilters((fs) => fs.map((x) => (x.id === f.id ? { ...x, value: e.target.value } : x)))} />
                        {f.op === "between" && <Input inputSize="sm" type={inputType} value={f.value2} aria-label="And" onChange={(e) => setFilters((fs) => fs.map((x) => (x.id === f.id ? { ...x, value2: e.target.value } : x)))} />}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </Card>
          <Card>
            <CardHeader title="Sort" />
            <div className="flex gap-2 px-5 pb-5">
              <Select size="sm" value={sort?.col ?? "__default"} onValueChange={(v) => setSort(v === "__default" ? null : { col: v, dir: sort?.dir ?? "asc" })} options={[{ value: "__default", label: "Default" }, ...sortOptions]} className="flex-1" />
              <Select size="sm" value={sort?.dir ?? "asc"} onValueChange={(v) => sort && setSort({ ...sort, dir: v as "asc" | "desc" })} options={[{ value: "asc", label: "A → Z / low → high" }, { value: "desc", label: "Z → A / high → low" }]} className="w-44" disabled={!sort} />
            </div>
          </Card>
          <Button onClick={run} loading={busy} disabled={!canBuild}><Play />Run</Button>
        </fieldset>
        <div className="min-w-0">
          {error && <Banner tone="danger" className="mb-3">{error}</Banner>}
          {!result ? <Card><EmptyState icon={<Play />} title="Run the report to see rows" description="Pick columns and filters on the left, then press Run." /></Card>
            : <ReportTable headers={result.headers} rows={result.rows} limitNote />}
          {result && result.total > result.rows.length && <p className="mt-2 text-xs text-text-muted">Preview shows {result.rows.length} of {result.total} rows. Save the report to export everything.</p>}
        </div>
      </div>
      {saving && (
        <Modal open onOpenChange={(o) => !o && setSaving(false)} title={saved ? "Save changes" : "Save this report"} footer={<><Button variant="secondary" onClick={() => setSaving(false)}>Cancel</Button><Button onClick={save} loading={busy} disabled={!name.trim()}>Save</Button></>}>
          <div className="flex flex-col gap-4">
            <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
            <Field label="Share with roles" help="People holding these roles can run it (within what they may see) but not change it.">
              <div className="grid gap-1.5 sm:grid-cols-2">{roles.map((r) => <Checkbox key={r.key} label={r.name} checked={shared.includes(r.key)} onCheckedChange={(v) => setShared((s) => (v ? [...s, r.key] : s.filter((x) => x !== r.key)))} />)}</div>
            </Field>
          </div>
        </Modal>
      )}
      {scheduling && saved && <ScheduleDialog reportId={saved.id} current={saved.schedule} people={people} onClose={() => setScheduling(false)} />}
    </div>
  );
}

function ScheduleDialog({ reportId, current, people, onClose }: { reportId: string; current: Schedule | null; people: Person[]; onClose: () => void }) {
  const [f, setF] = React.useState({ frequency: current?.frequency ?? "weekly", weekday: String(current?.weekday ?? 1), day: String(current?.day ?? 1), hour: String(current?.hour ?? 9), format: current?.format ?? "xlsx", recipients: current?.recipients ?? [] });
  const [busy, start] = React.useTransition();
  const apply = (clear: boolean) => start(async () => {
    const r = await setScheduleAction(reportId, clear ? null : { frequency: f.frequency, weekday: Number(f.weekday), day: Number(f.day), hour: Number(f.hour), format: f.format, recipients: f.recipients });
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(clear ? "Schedule removed" : "Schedule saved", !clear && r.data ? { description: `Next run ${new Date(r.data.next_run_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}` } : undefined);
    onClose();
  });
  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Email this report on a schedule" description="Recipients get a notification and an email with a sign-in link to the file; it's only visible to them."
      footer={<>{current && <Button variant="danger" onClick={() => apply(true)} loading={busy}>Remove schedule</Button>}<Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => apply(false)} loading={busy} disabled={!f.recipients.length}>Save schedule</Button></>}>
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="How often"><Select value={f.frequency} onValueChange={(v) => setF({ ...f, frequency: v as Schedule["frequency"] })} options={[{ value: "daily", label: "Every day" }, { value: "weekly", label: "Every week" }, { value: "monthly", label: "Every month" }]} /></Field>
          {f.frequency === "weekly" && <Field label="On"><Select value={f.weekday} onValueChange={(v) => setF({ ...f, weekday: v })} options={DAYS.map((d, i) => ({ value: String(i + 1), label: d }))} /></Field>}
          {f.frequency === "monthly" && <Field label="On day"><Select value={f.day} onValueChange={(v) => setF({ ...f, day: v })} options={Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))} /></Field>}
          <Field label="At (IST)"><Select value={f.hour} onValueChange={(v) => setF({ ...f, hour: v })} options={Array.from({ length: 24 }, (_, i) => ({ value: String(i), label: `${String(i).padStart(2, "0")}:00` }))} /></Field>
        </div>
        <Field label="Format"><Segmented label="Format" value={f.format} onChange={(v) => setF({ ...f, format: v })} options={[{ value: "xlsx", label: "Excel" }, { value: "csv", label: "CSV" }]} /></Field>
        <Field label="Send to" required help="People with an erp account, up to 20."><EmployeePicker people={people} value={f.recipients} onChange={(ids) => setF({ ...f, recipients: ids.slice(0, 20) })} multiple /></Field>
        <p className="text-sm text-text-muted">Runs with your access: recipients see what you would see. Needs <code className="rounded bg-surface-sunken px-1">pnpm jobs:reports</code> on an hourly schedule.</p>
      </div>
    </Modal>
  );
}
