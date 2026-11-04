"use client";
import * as React from "react";
import { Archive, Download, FileStack, Play, RefreshCw, Users } from "lucide-react";
import { Button } from "@/ui/button";
import { Card, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Modal } from "@/ui/overlay";
import { Field } from "@/ui/field";
import { Select } from "@/ui/select";
import { Segmented } from "@/ui/choice";
import { Banner, EmptyState, Progress, Skeleton } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { batchDetailAction, bulkRecipientsAction, continueBatchAction, createBatchAction } from "@/app/(app)/org/documents/actions";
import { MAX_BATCH } from "@/server/modules/documents/rules";

export type BatchListRow = { id: string; template_name: string; status: "queued" | "running" | "done" | "failed"; total: number; done: number; failed: number; zip_file_id: string | null; created_by_name: string | null; created_at: string; finished_at: string | null; error: string | null };
type Option = { value: string; label: string };
type Props = { batches: BatchListRow[]; templates: Option[]; departments: Option[]; locations: Option[]; designations: Option[]; openId?: string | null };

const fmt = (d: string) => new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
const TONE: Record<BatchListRow["status"], "neutral" | "accent" | "success" | "danger"> = { queued: "neutral", running: "accent", done: "success", failed: "danger" };
const LABEL: Record<BatchListRow["status"], string> = { queued: "Queued", running: "Running", done: "Done", failed: "Failed" };

/** Bulk letters: pick people by filters, one template, a ZIP of PDFs; each person also gets the letter in their Documents tab. */
export function BulkLetters({ batches, templates, departments, locations, designations, openId }: Props) {
  const [open, setOpen] = React.useState<string | null>(openId ?? null);
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="Letter batches" description="Every batch issues one template to many people at once. Big batches continue in the background and finish on their own."
          action={<NewBatch templates={templates} departments={departments} locations={locations} designations={designations} onCreated={setOpen} />} />
        {batches.length === 0 ? <EmptyState compact icon={<FileStack />} title="No batches yet" description="Start one to issue, say, a revised appointment letter to a whole department." /> : (
          <ul className="divide-y divide-border border-t border-border">
            {batches.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <button type="button" onClick={() => setOpen(b.id)} className="block truncate text-left text-base font-medium hover:underline">{b.template_name}</button>
                  <p className="text-sm text-text-muted">{b.total} {b.total === 1 ? "person" : "people"} · {fmt(b.created_at)}{b.created_by_name ? ` · ${b.created_by_name}` : ""}</p>
                </div>
                <Badge tone={TONE[b.status]}>{LABEL[b.status]}{b.status === "running" || b.status === "queued" ? ` · ${b.done + b.failed}/${b.total}` : b.failed ? ` · ${b.failed} failed` : ""}</Badge>
                {b.zip_file_id && <Button asChild size="sm" variant="secondary"><a href={`/files/${b.zip_file_id}?download=1`}><Download />ZIP</a></Button>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {open && <BatchDialog id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function NewBatch({ templates, departments, locations, designations, onCreated }: Omit<Props, "batches" | "openId"> & { onCreated: (id: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const [templateId, setTemplateId] = React.useState<string | undefined>();
  const [status, setStatus] = React.useState<"working" | "active" | "notice">("working");
  const [departmentIds, setDepartmentIds] = React.useState<string[]>([]);
  const [locationIds, setLocationIds] = React.useState<string[]>([]);
  const [designationIds, setDesignationIds] = React.useState<string[]>([]);
  const [preview, setPreview] = React.useState<{ count: number; sample: { id: string; name: string; department: string | null }[] } | null>(null);
  const [pending, start] = React.useTransition();
  const [loading, startLoad] = React.useTransition();
  const filters = React.useMemo(() => ({ status, departmentIds, locationIds, designationIds }), [status, departmentIds, locationIds, designationIds]);
  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    startLoad(async () => { const r = await bulkRecipientsAction(filters); if (alive) setPreview(r.ok ? r.data! : { count: 0, sample: [] }); });
    return () => { alive = false; };
  }, [filters, open]);
  const create = () => start(async () => {
    if (!templateId) return;
    const r = await createBatchAction(templateId, filters);
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(r.data!.finished ? `Issued ${r.data!.total} letters` : `Batch started for ${r.data!.total} people. It keeps going in the background.`);
    setOpen(false); onCreated(r.data!.id);
  });
  const tooMany = (preview?.count ?? 0) > MAX_BATCH;
  return (
    <Modal open={open} onOpenChange={(o) => { setOpen(o); if (o) { setTemplateId(undefined); setPreview(null); } }} size="lg" title="New letter batch"
      description="Pick who gets the letter, then the template. Each PDF is filled in with the person's details and added to their Documents tab."
      trigger={<Button size="sm"><FileStack />New batch</Button>}
      footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={pending} disabled={!templateId || !preview?.count || tooMany} onClick={create}>Issue {preview?.count ? `${preview.count} letters` : "letters"}</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="Template" required><Select value={templateId} onValueChange={setTemplateId} placeholder="Pick a letter template" options={templates} /></Field>
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Who</p>
          <Segmented label="Employment status" value={status} onChange={setStatus} options={[{ value: "working", label: "Everyone working" }, { value: "active", label: "Active only" }, { value: "notice", label: "On notice" }]} />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <MultiPick label="Departments" options={departments} value={departmentIds} onChange={setDepartmentIds} />
          <MultiPick label="Locations" options={locations} value={locationIds} onChange={setLocationIds} />
          <MultiPick label="Designations" options={designations} value={designationIds} onChange={setDesignationIds} />
        </div>
        <div className="rounded-md border border-border bg-surface-sunken p-3" aria-live="polite">
          {loading && !preview ? <Skeleton className="h-5 w-1/2" /> : (
            <>
              <p className="flex items-center gap-2 text-base font-medium"><Users className="size-4 text-text-muted" aria-hidden />{preview?.count ?? 0} {preview?.count === 1 ? "person" : "people"} match</p>
              {preview && preview.sample.length > 0 && <p className="mt-1 text-sm text-text-muted">{preview.sample.map((p) => p.name).join(", ")}{preview.count > preview.sample.length ? ` and ${preview.count - preview.sample.length} more` : ""}</p>}
              {tooMany && <Banner tone="warning" className="mt-2">A batch covers at most {MAX_BATCH} people. Narrow the filters and run it in parts.</Banner>}
              {preview && preview.count === 0 && <p className="mt-1 text-sm text-text-muted">Nobody matches, or you can&apos;t issue letters to the people who do.</p>}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** A small multi-select: checkboxes in a scrolling box (fine for a few dozen options). */
function MultiPick({ label, options, value, onChange }: { label: string; options: Option[]; value: string[]; onChange: (v: string[]) => void }) {
  const id = React.useId();
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1 text-sm font-medium">{label} <span className="font-normal text-text-muted">(any)</span></legend>
      <div className="max-h-36 overflow-y-auto rounded-md border border-border-input p-2">
        {options.length === 0 ? <p className="text-sm text-text-muted">None</p> : options.map((o) => (
          <label key={o.value} htmlFor={`${id}-${o.value}`} className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-0.5 text-base hover:bg-surface-hover">
            <input id={`${id}-${o.value}`} type="checkbox" className="size-4 accent-[var(--accent)]" checked={value.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...value, o.value] : value.filter((v) => v !== o.value))} />
            <span className="truncate">{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

type Detail = { id: string; template_name: string; status: BatchListRow["status"]; total: number; done: number; failed: number; zip_file_id: string | null; error: string | null; items: { id: string; employee_id: string; name: string; number: string; status: string; file_id: string | null; error: string | null }[] };

function BatchDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const [d, setD] = React.useState<Detail | null | undefined>(undefined);
  const [pending, start] = React.useTransition();
  const load = React.useCallback(() => batchDetailAction(id).then((r) => setD(r.ok ? (r.data as Detail | null) : null)), [id]);
  const live = !!d && (d.status === "running" || d.status === "queued");
  React.useEffect(() => {
    const t = setTimeout(load, 0);   // first read, then poll while the batch is still being worked on
    const poll = live ? setInterval(load, 4000) : null;
    return () => { clearTimeout(t); if (poll) clearInterval(poll); };
  }, [load, live]);
  const cont = () => start(async () => { const r = await continueBatchAction(id); if (!r.ok) toast.error(r.error); else { toast.success(r.data!.finished ? "Batch finished" : `Issued ${r.data!.processed} more`); load(); } });
  const handled = d ? d.done + d.failed : 0;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="lg" title={d ? d.template_name : "Letter batch"}
      footer={<>
        {d && (d.status === "running" || d.status === "queued") && <Button variant="secondary" loading={pending} onClick={cont}><Play />Continue now</Button>}
        {d?.zip_file_id && <Button asChild><a href={`/files/${d.zip_file_id}?download=1`}><Archive />Download ZIP</a></Button>}
        <Button variant="ghost" onClick={onClose}>Close</Button>
      </>}>
      {d === undefined ? <div className="flex flex-col gap-2" aria-busy><Skeleton className="h-5 w-1/3" /><Skeleton className="h-40" /></div>
        : d === null ? <Banner tone="danger">This batch doesn&apos;t exist or isn&apos;t yours to see.</Banner>
        : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone={TONE[d.status]}>{LABEL[d.status]}</Badge>
              <span className="text-base">{d.done} issued{d.failed ? `, ${d.failed} failed` : ""} of {d.total}</span>
              {(d.status === "running" || d.status === "queued") && <span className="flex items-center gap-1 text-sm text-text-muted"><RefreshCw className="size-3.5 animate-spin" aria-hidden />Working in the background</span>}
            </div>
            <Progress value={handled} max={Math.max(1, d.total)} label="Letters issued" tone={d.status === "done" ? "success" : "accent"} />
            {d.error && <Banner tone="danger">{d.error}</Banner>}
            <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border" aria-label="People in this batch">
              {d.items.map((it) => (
                <li key={it.id} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1"><p className="truncate text-base">{it.name}</p><p className="text-sm text-text-muted">{it.number}{it.error ? ` · ${it.error}` : ""}</p></div>
                  {it.status === "done" && it.file_id ? <Button asChild size="sm" variant="ghost"><a href={`/files/${it.file_id}`} target="_blank" rel="noreferrer">PDF</a></Button>
                    : it.status === "failed" ? <Badge tone="danger">Failed</Badge> : <Badge tone="neutral">Queued</Badge>}
                </li>
              ))}
            </ul>
          </div>
        )}
    </Modal>
  );
}
