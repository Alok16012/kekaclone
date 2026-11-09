"use client";
import * as React from "react";
import { CheckCircle2, FileSpreadsheet, Search, Upload, Users, XCircle } from "lucide-react";
import { Button } from "@/ui/button";
import { RadioGroup } from "@/ui/choice";
import { Field, Input } from "@/ui/field";
import { Banner, EmptyState, Skeleton } from "@/ui/feedback";
import { Modal } from "@/ui/overlay";
import { DataTable, type Column } from "@/ui/table";
import { toast } from "@/ui/toast";
import { assignAction, commitAssignmentImportAction, previewAssignmentImportAction } from "@/app/(app)/settings/time/actions";
import type { AssignmentRow } from "@/server/modules/attendance/policies";
import type { AssignmentImportPreview } from "@/server/modules/attendance/assignments-import";

type Kind = "shift" | "weekly_off" | "capture" | "penalty" | "overtime";
type Opt = { id: string; name: string; hint?: string };
const TITLE: Record<Kind, string> = { shift: "Change shift", weekly_off: "Change weekly off", capture: "Change clock-in rules", penalty: "Change penalty policy", overtime: "Change overtime policy" };
const fmt = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

export function AssignmentsSettings({ rows, options, today }: { rows: AssignmentRow[]; options: Record<Kind, Opt[]>; today: string }) {
  const [q, setQ] = React.useState("");
  const [dialog, setDialog] = React.useState<{ kind: Kind; ids: string[]; clear: () => void } | null>(null);
  const [importing, setImporting] = React.useState(false);
  const term = q.trim().toLowerCase();
  const shown = term ? rows.filter((r) => [r.name, r.number, r.department ?? "", r.shift ?? "", r.weekly_off ?? ""].some((x) => x.toLowerCase().includes(term))) : rows;
  const cols: Column<AssignmentRow>[] = [
    { key: "name", header: "Person", sortValue: (r) => r.name, cell: (r) => <span className="block min-w-0"><span className="block truncate font-medium">{r.name}</span><span className="block truncate text-sm text-text-muted">{[r.number, r.department].filter(Boolean).join(" · ")}</span></span> },
    { key: "shift", header: "Shift", sortValue: (r) => r.shift ?? "", cell: (r) => <span>{r.shift ?? "Default"}{r.next_shift && <span className="block text-sm text-text-muted">{r.next_shift} from {fmt(r.next_shift_from!)}</span>}</span> },
    { key: "wo", header: "Weekly off", hideBelow: "md", cell: (r) => <span>{r.weekly_off ?? "Default"}{r.next_weekly_off && <span className="block text-sm text-text-muted">{r.next_weekly_off} from {fmt(r.next_weekly_off_from!)}</span>}</span> },
    { key: "cap", header: "Clock-in rules", hideBelow: "lg", cell: (r) => r.capture ?? "Default" },
    { key: "pen", header: "Penalties", hideBelow: "lg", cell: (r) => r.penalty ?? <span className="text-text-muted">None</span> },
    { key: "ot", header: "Overtime", hideBelow: "lg", cell: (r) => r.overtime ?? <span className="text-text-muted">None</span> },
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Assignments</h2>
          <p className="text-base text-text-muted">Pick people, then change their shift, weekly off, clock-in rules or penalty policy. Shift and weekly-off changes take an effective date.</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setImporting(true)}><Upload />Import from Excel</Button>
      </div>
      <Input leading={<Search />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, number, department or shift" aria-label="Search people" className="max-w-md" />
      <DataTable caption="Time assignments by person" rows={shown} columns={cols} rowKey={(r) => r.id} selectable
        empty={<EmptyState compact icon={<Users />} title={term ? "Nobody matches that search" : "Nobody to assign yet"} description={term ? "Try a different name or clear the search." : "People you can manage show up here."} />}
        bulkActions={(ids, clear) => (
          <div className="flex flex-wrap justify-end gap-2">
            {(["shift", "weekly_off", "capture", "penalty", "overtime"] as Kind[]).map((k) => (
              <Button key={k} size="sm" variant="secondary" onClick={() => setDialog({ kind: k, ids, clear })}>{TITLE[k].replace("Change ", "")}</Button>
            ))}
          </div>
        )} />
      {dialog && <AssignDialog kind={dialog.kind} ids={dialog.ids} options={options[dialog.kind]} today={today} onClose={(done) => { if (done) dialog.clear(); setDialog(null); }} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </div>
  );
}

/** Excel import: template pre-filled with today's assignments → upload → per-row report → apply. */
function ImportDialog({ onClose }: { onClose: () => void }) {
  const [file, setFile] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState<AssignmentImportPreview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [checking, startCheck] = React.useTransition();
  const [saving, startSave] = React.useTransition();
  const choose = (f: File | undefined) => {
    setError(null); setPreview(null); setFile(null);
    if (!f) return;
    if (!/\.xlsx$/i.test(f.name)) { setError("Choose an Excel .xlsx file."); return; }
    if (f.size > 5 * 1024 * 1024) { setError("The file is larger than 5 MB."); return; }
    setFile(f);
    const fd = new FormData(); fd.set("file", f);
    startCheck(async () => { const r = await previewAssignmentImportAction(fd); if (r.ok) setPreview(r.data!); else setError(r.error); });
  };
  const commit = () => startSave(async () => {
    const fd = new FormData(); fd.set("file", file!);
    const r = await commitAssignmentImportAction(fd);
    if (!r.ok) { setError(r.error); return; }
    toast.success(r.data!.changes ? `Updated ${r.data!.people} ${r.data!.people === 1 ? "person" : "people"}` : "Nothing to change", { description: r.data!.changes ? "Past days in the range were recalculated." : "Every row already matched." });
    onClose();
  });
  const bad = preview?.results.filter((r) => r.errors.length) ?? [];
  const good = preview?.results.filter((r) => !r.errors.length && r.changes.length) ?? [];
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="lg" title="Import assignments from Excel" description="Shift, weekly off, clock-in rules, penalty and overtime policies, with an effective date."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={commit} loading={saving} disabled={!preview?.valid || checking || !preview?.changes}>{preview?.valid ? `Apply ${preview.changes} ${preview.changes === 1 ? "change" : "changes"}` : "Apply"}</Button></>}>
      <div className="flex flex-col gap-4">
        <ol className="list-decimal space-y-1 pl-5 text-base text-text-muted">
          <li><a href="/settings/time/assignments/template" download className="text-accent-text underline-offset-4 hover:underline">Download the template</a>. It lists everyone with what applies today, and the Options sheet has every code and policy name.</li>
          <li>Change only the cells you want to change; a blank cell means no change. Set the effective date per row.</li>
          <li>Upload it here. erp checks every row and shows what will change before anything is saved.</li>
        </ol>
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-border-strong px-6 py-8 text-center hover:border-accent hover:bg-accent-soft/40 focus-within:outline-2 focus-within:outline-focus">
          {file ? <FileSpreadsheet className="size-6 text-accent-text" aria-hidden /> : <Upload className="size-6 text-accent-text" aria-hidden />}
          <span className="text-base font-medium">{file ? file.name : "Choose the filled file"}</span>
          <span className="text-sm text-text-muted">.xlsx, up to 5 MB</span>
          <input type="file" accept=".xlsx" className="sr-only" onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        {error && <Banner tone="danger">{error}</Banner>}
        {checking && <div className="flex flex-col gap-2" aria-busy aria-label="Checking the file"><Skeleton className="h-6 w-1/2" /><Skeleton className="h-24" /></div>}
        {preview && !checking && (
          preview.valid ? (
            <Banner tone="success" title={preview.changes ? `${preview.changes} ${preview.changes === 1 ? "change" : "changes"} for ${preview.people} ${preview.people === 1 ? "person" : "people"}` : "Everything already matches"}>
              {preview.changes ? "Rows that match today's assignments are skipped." : "There's nothing to apply."}
            </Banner>
          ) : (
            <Banner tone="danger" title={`${bad.length} of ${preview.total} rows need fixing`}>Nothing is saved until every row is valid.</Banner>
          )
        )}
        {preview && (bad.length > 0 || good.length > 0) && (
          <div className="max-h-72 overflow-auto rounded-md border border-border">
            <table className="w-full text-base">
              <caption className="sr-only">Rows in the file</caption>
              <thead className="sticky top-0 bg-surface-sunken text-left text-sm text-text-muted"><tr><th className="px-3 py-2 font-medium">Row</th><th className="px-3 py-2 font-medium">Person</th><th className="px-3 py-2 font-medium">From</th><th className="px-3 py-2 font-medium">Result</th></tr></thead>
              <tbody>
                {[...bad, ...good].map((r) => (
                  <tr key={r.rowNumber} className="border-t border-border align-top">
                    <td className="px-3 py-2 tabular text-text-muted">{r.rowNumber}</td>
                    <td className="px-3 py-2">{r.name ?? r.employee ?? "—"}</td>
                    <td className="px-3 py-2 tabular">{r.from ?? "—"}</td>
                    <td className="px-3 py-2">{r.errors.length ? (
                      <ul className="flex flex-col gap-0.5 text-sm text-danger-text">{r.errors.map((e) => <li key={e} className="flex gap-1"><XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />{e}</li>)}</ul>
                    ) : (
                      <ul className="flex flex-col gap-0.5 text-sm">{r.changes.map((c) => <li key={c.kind} className="flex gap-1"><CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success-text" aria-hidden />{c.label}</li>)}</ul>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}

function AssignDialog({ kind, ids, options, today, onClose }: { kind: Kind; ids: string[]; options: Opt[]; today: string; onClose: (done: boolean) => void }) {
  const dated = kind === "shift" || kind === "weekly_off";
  const opts = kind === "penalty" ? [{ id: "none", name: "No penalties" }, ...options] : kind === "overtime" ? [{ id: "none", name: "No overtime" }, ...options] : options;
  const [choice, setChoice] = React.useState(opts[0]?.id ?? "");
  const [from, setFrom] = React.useState(today);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    setError(null);
    const r = await assignAction({ employeeIds: ids, kind, policyId: choice === "none" ? null : choice, from });
    if (!r.ok) { setError(r.error); return; }
    toast.success(`Updated ${ids.length} ${ids.length === 1 ? "person" : "people"}`);
    onClose(true);
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose(false)} title={TITLE[kind]} description={`For ${ids.length} ${ids.length === 1 ? "person" : "people"}.`}
      footer={<><Button variant="secondary" onClick={() => onClose(false)}>Cancel</Button><Button loading={pending} onClick={save} disabled={!choice}>Apply</Button></>}>
      <div className="flex flex-col gap-4">
        {error && <Banner tone="danger">{error}</Banner>}
        {opts.length === 0 ? <Banner tone="warning">Nothing to choose from yet. Add one first.</Banner> : (
          <RadioGroup value={choice} onValueChange={setChoice} options={opts.map((o) => ({ value: o.id, label: o.name, hint: o.hint }))} aria-label={TITLE[kind]} />
        )}
        {dated ? (
          <Field label="Effective from" required help="Their current one ends the day before. Plans after this date are replaced. Past days are recalculated.">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
        ) : <p className="text-sm text-text-muted">This applies straight away.</p>}
      </div>
    </Modal>
  );
}
