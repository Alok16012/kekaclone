"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, CheckCircle2, Download, FileSpreadsheet, Upload, XCircle } from "lucide-react";
import { Button } from "@/ui/button";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Banner, Skeleton } from "@/ui/feedback";
import { Stepper } from "@/ui/flow";
import { toast } from "@/ui/toast";
import { cn } from "@/lib/cn";
import { commitUpdateAction, previewUpdateAction } from "@/app/(app)/corehr/actions";

type Preview = { valid: boolean; changed: number; total: number; rows: { rowNumber: number; name: string; errors: string[]; changes: { field: string; label: string; from: string | null; to: string | null }[] }[] };

/** Download today's data → edit → upload → review the differences → apply. All or nothing. */
export function BulkUpdate() {
  const router = useRouter();
  const [file, setFile] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [drag, setDrag] = React.useState(false);
  const [checking, startCheck] = React.useTransition();
  const [saving, startSave] = React.useTransition();
  const choose = (f: File | undefined) => {
    setError(null); setPreview(null);
    if (!f) return;
    if (!/\.xlsx$/i.test(f.name)) { setError("Choose an Excel .xlsx file."); return; }
    if (f.size > 5 * 1024 * 1024) { setError("The file is larger than 5 MB."); return; }
    setFile(f);
    const fd = new FormData(); fd.set("file", f);
    startCheck(async () => { const r = await previewUpdateAction(fd); if (!r.ok) setError(r.error); else setPreview(r.data as Preview); });
  };
  const apply = () => {
    if (!file) return;
    const fd = new FormData(); fd.set("file", file);
    startSave(async () => {
      const r = await commitUpdateAction(fd);
      if (!r.ok) { setError(r.error); return; }
      toast.success(`${r.data!.updated} ${r.data!.updated === 1 ? "person" : "people"} updated`);
      router.push("/org/employees");
    });
  };
  const bad = preview?.rows.filter((r) => r.errors.length) ?? [];
  const changed = preview?.rows.filter((r) => !r.errors.length && r.changes.length) ?? [];
  return (
    <div className="flex flex-col gap-6">
      <Stepper steps={["Download", "Upload and review", "Apply"]} current={preview?.valid && preview.changed ? 2 : file ? 1 : 0} />
      <Card>
        <CardHeader title="1. Download today's data" description="One row per person you manage, with dropdowns for departments, designations and locations. Change only what needs changing." />
        <CardBody><Button asChild variant="secondary"><a href="/org/employees/update/template" download><Download />Download people (.xlsx)</a></Button></CardBody>
      </Card>
      <Card>
        <CardHeader title="2. Upload the edited file" description="Empty cells are left as they are. Nothing is saved until you apply." />
        <CardBody className="flex flex-col gap-4">
          <label onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); choose(e.dataTransfer.files[0]); }}
            className={cn("flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border-strong px-6 py-10 text-center transition-colors hover:border-accent", drag && "border-accent bg-accent-soft")}>
            <span className="flex size-12 items-center justify-center rounded-pill bg-accent-soft text-accent-text">{file ? <FileSpreadsheet className="size-6" /> : <Upload className="size-6" />}</span>
            <span className="text-base font-medium">{file ? file.name : "Drop the file here, or click to choose"}</span>
            <span className="text-sm text-text-muted">.xlsx, up to 5 MB and 2,000 people</span>
            <input type="file" accept=".xlsx" className="sr-only" onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
          {error && <Banner tone="danger">{error}</Banner>}
          {checking && <div className="flex flex-col gap-2" aria-busy aria-label="Checking the file"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>}
        </CardBody>
      </Card>
      {preview && !checking && (
        <Card>
          <CardHeader title="3. Review"
            description={!preview.valid ? `${bad.length} ${bad.length === 1 ? "row needs" : "rows need"} fixing. Correct the file and upload it again.` : preview.changed ? `${preview.changed} ${preview.changed === 1 ? "person" : "people"} will change. Job changes take effect today.` : "Nothing in the file differs from today's data."}
            action={preview.valid && preview.changed ? <Button onClick={apply} loading={saving}>Apply changes</Button> : undefined} />
          {(bad.length > 0 || changed.length > 0) && (
            <div className="overflow-x-auto border-t border-border">
              <table className="w-full text-base">
                <caption className="sr-only">Rows with changes or problems</caption>
                <thead className="bg-surface-sunken text-left text-sm text-text-muted"><tr><th className="px-5 py-2 font-medium">Row</th><th className="px-3 py-2 font-medium">Person</th><th className="px-3 py-2 font-medium">What changes</th></tr></thead>
                <tbody>
                  {[...bad, ...changed].map((r) => (
                    <tr key={r.rowNumber} className="border-t border-border align-top">
                      <td className="px-5 py-3 tabular text-text-muted">{r.rowNumber}</td>
                      <td className="px-3 py-3 font-medium">{r.name}</td>
                      <td className="px-3 py-3">
                        {r.errors.length ? (
                          <ul className="flex flex-col gap-1">{r.errors.map((e, i) => <li key={i} className="flex gap-1.5 text-sm text-danger-text"><XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />{e}</li>)}</ul>
                        ) : (
                          <ul className="flex flex-col gap-1">{r.changes.map((c) => <li key={c.field} className="flex flex-wrap items-center gap-1.5 text-sm"><span className="text-text-muted">{c.label}:</span><span className="line-through text-text-muted">{c.from ?? "—"}</span><ArrowRight className="size-3.5" aria-label="becomes" /><span className="font-medium">{c.to ?? "—"}</span></li>)}</ul>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {preview.valid && !preview.changed && <div className="px-5 pb-4"><Badge tone="success"><CheckCircle2 />Up to date</Badge></div>}
        </Card>
      )}
    </div>
  );
}
