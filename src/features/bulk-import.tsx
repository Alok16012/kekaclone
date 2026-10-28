"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Download, FileSpreadsheet, Upload, XCircle } from "lucide-react";
import { Button } from "@/ui/button";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Banner, Skeleton } from "@/ui/feedback";
import { Stepper } from "@/ui/flow";
import { toast } from "@/ui/toast";
import { cn } from "@/lib/cn";
import { commitImportAction, previewImportAction } from "@/app/(app)/actions";
import type { ImportPreview } from "@/server/modules/employees/import";

/** Template → upload → review → import. Nothing is written until the last step, and only if every row is valid. */
export function BulkImport() {
  const router = useRouter();
  const [file, setFile] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState<ImportPreview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [drag, setDrag] = React.useState(false);
  const [checking, startCheck] = React.useTransition();
  const [importing, startImport] = React.useTransition();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const step = !file ? 0 : 1;   // 0 fill template · 1 upload & check · 2 import (when every row is valid)

  const choose = (f: File | undefined) => {
    setError(null); setPreview(null);
    if (!f) return;
    if (!/\.xlsx$/i.test(f.name)) { setError("Choose an Excel .xlsx file. If yours is .xls or .csv, open it in Excel or Google Sheets and save as .xlsx."); return; }
    if (f.size > 5 * 1024 * 1024) { setError("The file is larger than 5 MB."); return; }
    setFile(f);
    const fd = new FormData(); fd.set("file", f);
    startCheck(async () => {
      const r = await previewImportAction(fd);
      if (!r.ok) { setError(r.error); return; }
      setPreview(r.data!);
    });
  };
  const doImport = () => {
    if (!file) return;
    const fd = new FormData(); fd.set("file", file);
    startImport(async () => {
      const r = await commitImportAction(fd);
      if (!r.ok) { setError(r.error); return; }
      toast.success(`${r.data!.created} ${r.data!.created === 1 ? "person" : "people"} added`, { description: "They have leave balances and the default shift already." });
      router.push("/org/employees");
    });
  };
  const bad = preview?.results.filter((r) => r.errors.length) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <Stepper steps={["Fill the template", "Upload and check", "Import"]} current={preview?.valid ? 2 : step} />

      <Card>
        <CardHeader title="1. Download the template" description="It already has your departments, designations and locations as dropdowns." />
        <CardBody>
          <Button asChild variant="secondary"><a href="/org/employees/import/template" download><Download />Download template (.xlsx)</a></Button>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="2. Upload the filled file" description="erp checks every row before anything is saved." />
        <CardBody className="flex flex-col gap-4">
          <label
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); choose(e.dataTransfer.files[0]); }}
            className={cn("flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border-strong px-6 py-10 text-center transition-colors hover:border-accent hover:bg-accent-soft/40",
              drag && "border-accent bg-accent-soft/60")}>
            <span className="flex size-12 items-center justify-center rounded-pill bg-accent-soft text-accent-text">{file ? <FileSpreadsheet className="size-6" /> : <Upload className="size-6" />}</span>
            <span className="text-base font-medium">{file ? file.name : "Drop the file here, or click to choose"}</span>
            <span className="text-sm text-text-muted">{file ? `${(file.size / 1024).toFixed(0)} KB · click to choose another` : ".xlsx, up to 5 MB and 1,000 people"}</span>
            <input ref={inputRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only"
              onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
          {error && <Banner tone="danger">{error}</Banner>}
          {checking && <div className="flex flex-col gap-2" aria-busy aria-label="Checking the file"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>}
        </CardBody>
      </Card>

      {preview && !checking && (
        <Card>
          <CardHeader title="3. Review"
            description={preview.total === 0 ? "No people found in the file." : preview.valid ? `All ${preview.total} rows look good.` : `${bad.length} of ${preview.total} rows need fixing. Correct them in the file and upload it again.`}
            action={preview.valid && preview.total > 0 ? <Button onClick={doImport} loading={importing}>Import {preview.total} {preview.total === 1 ? "person" : "people"}</Button> : undefined} />
          {preview.total > 0 && (
            <div className="overflow-x-auto border-t border-border">
              <table className="w-full text-base">
                <caption className="sr-only">Rows in the uploaded file</caption>
                <thead className="bg-surface-sunken text-left text-sm text-text-muted">
                  <tr><th className="px-5 py-2 font-medium">Row</th><th className="px-3 py-2 font-medium">Person</th><th className="px-3 py-2 font-medium">Status</th></tr>
                </thead>
                <tbody>
                  {[...bad, ...preview.results.filter((r) => !r.errors.length)].map((r) => (
                    <tr key={r.rowNumber} className="border-t border-border align-top">
                      <td className="px-5 py-3 tabular text-text-muted">{r.rowNumber}</td>
                      <td className="px-3 py-3"><span className="block font-medium">{r.name}</span><span className="block text-sm text-text-muted">{r.email || "—"}</span></td>
                      <td className="px-3 py-3">
                        {r.errors.length === 0 ? <Badge tone="success"><CheckCircle2 />Ready</Badge> : (
                          <ul className="flex flex-col gap-1">
                            {r.errors.map((e, i) => <li key={i} className="flex gap-1.5 text-sm text-danger-text"><XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />{e}</li>)}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      <p className="text-sm text-text-muted">Adding just one person? <Link href="/org/employees/new" className="font-medium text-accent-text hover:underline">Use the form instead</Link>.</p>
    </div>
  );
}
