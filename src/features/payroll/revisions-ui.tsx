"use client";
import * as React from "react";
import Link from "next/link";
import { CheckCircle2, Download, FileSpreadsheet, History, Upload, XCircle } from "lucide-react";
import { Button } from "@/ui/button";
import { Card, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Modal } from "@/ui/overlay";
import { Banner, EmptyState, Skeleton } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { commitRevisionsAction, previewRevisionsAction } from "@/app/(app)/settings/payroll/actions";
import { fmtDate, fmtMonth, money, REASON_LABEL } from "./labels";

export type RecentRevision = { id: string; employee_id: string; name: string; number: string; ctc_paise: number; effective_from: string; reason: string; arrears_from_month: string | null; structure: string; created_at: string; by: string | null };

export function RevisionsAdmin({ recent }: { recent: RecentRevision[] }) {
  const [importing, setImporting] = React.useState(false);
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="Bulk salary revisions" description="Give many people a new CTC at once from an Excel file. To change one person, open their profile's Finances tab."
          action={<div className="flex flex-wrap gap-2">
            <Button asChild variant="secondary" size="sm"><a href="/settings/payroll/revisions/template" download><Download />Template</a></Button>
            <Button size="sm" onClick={() => setImporting(true)}><Upload />Import revisions</Button>
          </div>} />
      </Card>
      <Card>
        <CardHeader title="Recent salary changes" description="Newest first, for the people you manage payroll for." />
        {recent.length === 0 ? <EmptyState compact icon={<History />} title="No salary changes yet" description="Salaries you assign or revise show up here." /> : (
          <ul className="divide-y divide-border border-t border-border">
            {recent.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <Link href={`/people/${r.employee_id}?tab=finances`} className="text-base font-medium hover:underline">{r.name}</Link>
                  <p className="text-sm text-text-muted">{r.number} · {REASON_LABEL[r.reason] ?? r.reason} from {fmtDate(r.effective_from)} · {r.structure}{r.by ? ` · by ${r.by}` : ""}</p>
                </div>
                {r.arrears_from_month && <Badge tone="warning">Arrears from {fmtMonth(r.arrears_from_month)}</Badge>}
                <span className="font-medium tabular">{money(r.ctc_paise)}<span className="text-sm font-normal text-text-muted"> /yr</span></span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </div>
  );
}

type Preview = { valid: boolean; total: number; changes: number; results: { rowNumber: number; employee: string; name: string | null; currentPaise: number | null; newPaise: number | null; effectiveFrom: string | null; reason: string; structure: string | null; arrearsFromMonth: string | null; unchanged: boolean; errors: string[] }[] };

function ImportDialog({ onClose }: { onClose: () => void }) {
  const [file, setFile] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState<Preview | null>(null);
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
    startCheck(async () => { const r = await previewRevisionsAction(fd); if (r.ok) setPreview(r.data!); else setError(r.error); });
  };
  const commit = () => startSave(async () => {
    const fd = new FormData(); fd.set("file", file!);
    const r = await commitRevisionsAction(fd);
    if (!r.ok) { setError(r.error); return; }
    toast.success(r.data!.changed ? `${r.data!.changed} ${r.data!.changed === 1 ? "salary" : "salaries"} revised` : "Nothing to change", { description: r.data!.changed ? "Each person has been notified." : "Every row was already recorded." });
    onClose();
  });
  const bad = preview?.results.filter((r) => r.errors.length) ?? [];
  const good = preview?.results.filter((r) => !r.errors.length) ?? [];
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="lg" title="Import salary revisions" description="New CTCs for many people from one Excel file."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={commit} loading={saving} disabled={!preview?.valid || checking}>{preview?.valid ? `Save ${preview.changes} ${preview.changes === 1 ? "revision" : "revisions"}` : "Save"}</Button></>}>
      <div className="flex flex-col gap-4">
        <ol className="list-decimal space-y-1 pl-5 text-base text-text-muted">
          <li><a href="/settings/payroll/revisions/template" download className="text-accent-text underline-offset-4 hover:underline">Download the template</a>. It lists your people with today&apos;s CTC.</li>
          <li>Fill in the new annual CTC and the date it starts for each person getting a revision.</li>
          <li>Upload it here. erp checks every row before saving anything.</li>
        </ol>
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-border-strong px-6 py-8 text-center hover:border-accent hover:bg-accent-soft/40 focus-within:outline-2 focus-within:outline-focus">
          {file ? <FileSpreadsheet className="size-6 text-accent-text" aria-hidden /> : <Upload className="size-6 text-accent-text" aria-hidden />}
          <span className="text-base font-medium">{file ? file.name : "Choose the filled file"}</span>
          <span className="text-sm text-text-muted">.xlsx, up to 5 MB</span>
          <input type="file" accept=".xlsx" className="sr-only" onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        {error && <Banner tone="danger">{error}</Banner>}
        {checking && <div className="flex flex-col gap-2" aria-busy aria-label="Checking the file"><Skeleton className="h-6 w-1/2" /><Skeleton className="h-24" /></div>}
        {preview && !checking && (preview.valid
          ? <Banner tone="success" title={preview.changes ? `${preview.changes} of ${preview.total} rows are new revisions` : "Every row is already recorded"}>{preview.changes ? "Rows already saved are skipped." : "There's nothing to import."}</Banner>
          : <Banner tone="danger" title={`${bad.length} of ${preview.total} rows need fixing`}>Nothing is saved until every row is valid.</Banner>)}
        {preview && preview.results.length > 0 && (
          <div className="max-h-72 overflow-auto rounded-md border border-border">
            <table className="w-full text-base">
              <caption className="sr-only">Rows in the file</caption>
              <thead className="sticky top-0 bg-surface-sunken text-left text-sm text-text-muted"><tr><th className="px-3 py-2 font-medium">Row</th><th className="px-3 py-2 font-medium">Person</th><th className="px-3 py-2 font-medium">Result</th></tr></thead>
              <tbody>
                {[...bad, ...good].map((r) => (
                  <tr key={r.rowNumber} className="border-t border-border align-top">
                    <td className="px-3 py-2 tabular text-text-muted">{r.rowNumber}</td>
                    <td className="px-3 py-2">{r.name ?? (r.employee || "—")}</td>
                    <td className="px-3 py-2">{r.errors.length ? (
                      <ul className="flex flex-col gap-0.5 text-sm text-danger-text">{r.errors.map((e) => <li key={e} className="flex gap-1"><XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />{e}</li>)}</ul>
                    ) : (
                      <span className="flex flex-wrap items-center gap-1 text-sm">
                        <CheckCircle2 className="size-3.5 text-success-text" aria-hidden />
                        {r.currentPaise != null ? `${money(r.currentPaise)} → ` : ""}<span className="font-medium">{money(r.newPaise!)}</span> from {fmtDate(r.effectiveFrom)}
                        {r.unchanged && <Badge>Already saved</Badge>}
                        {r.arrearsFromMonth && <Badge tone="warning">Arrears from {fmtMonth(r.arrearsFromMonth)}</Badge>}
                      </span>
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
