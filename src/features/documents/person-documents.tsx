"use client";
import * as React from "react";
import { Download, FileText, FilePlus2, Trash2, Upload } from "lucide-react";
import { Card, CardHeader } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Modal, ConfirmDialog } from "@/ui/overlay";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { Banner, EmptyState, Skeleton } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { deletePersonDocumentAction, generateLetterAction, previewLetterAction, uploadPersonDocumentAction } from "@/app/(app)/org/documents/actions";
import { ACCEPT, ACCEPT_LABEL, MAX_UPLOAD_BYTES } from "@/server/modules/documents/rules";

export type PersonDocRow = { id: string; category: string; doc_type: string; number: string | null; status: string; file_id: string; file_name: string; size_bytes: number; created_at: string };
type Template = { id: string; name: string; kind: string };

const CATEGORY: Record<string, string> = { letter: "Letters", identity: "Identity", education: "Education", experience: "Previous employment", other: "Other" };
export const fmtSize = (b: number) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
const fmtDate = (d: string) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

/** The Documents tab on a profile: issued letters and personal documents, upload, and (HR) issue a letter. */
export function PersonDocuments({ employeeId, name, docs, canManage, isSelf, templates }: { employeeId: string; name: string; docs: PersonDocRow[]; canManage: boolean; isSelf: boolean; templates: Template[] }) {
  const groups = Object.keys(CATEGORY).map((c) => ({ c, rows: docs.filter((d) => d.category === c) })).filter((g) => g.rows.length);
  const canUpload = canManage || isSelf;
  const [deleting, setDeleting] = React.useState<PersonDocRow | null>(null);
  return (
    <Card>
      <CardHeader title="Documents" description={isSelf ? "Your letters and the documents you've shared with HR." : `Letters issued to ${name} and documents on file.`}
        action={<div className="flex flex-wrap gap-2">
          {canManage && templates.length > 0 && <IssueLetter employeeId={employeeId} name={name} templates={templates} />}
          {canUpload && <UploadPersonDoc employeeId={employeeId} isSelf={isSelf && !canManage} />}
        </div>} />
      {groups.length === 0 ? (
        <EmptyState compact icon={<FileText />} title="No documents yet" description={isSelf ? "Letters from HR appear here. You can also upload documents such as your ID or degree certificates." : "Issued letters and uploaded documents will show here."} />
      ) : groups.map((g) => (
        <section key={g.c} className="border-t border-border">
          <h4 className="px-5 pt-3 text-xs font-medium uppercase tracking-wide text-text-muted">{CATEGORY[g.c]}</h4>
          <ul className="divide-y divide-border">
            {g.rows.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-5 py-3">
                <FileText className="size-5 shrink-0 text-text-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <a href={`/files/${d.file_id}`} target="_blank" rel="noreferrer" className="block truncate text-base font-medium hover:underline">{d.doc_type}</a>
                  <p className="truncate text-sm text-text-muted">{[d.number, d.file_name, fmtSize(d.size_bytes), fmtDate(d.created_at)].filter(Boolean).join(" · ")}</p>
                </div>
                {d.category !== "letter" && (d.status === "pending" ? <Badge tone="warning">Not verified</Badge> : d.status === "rejected" ? <Badge tone="danger">Rejected</Badge> : <Badge tone="success">Verified</Badge>)}
                <IconButton asChild size="icon-sm" label={`Download ${d.doc_type}`}><a href={`/files/${d.file_id}?download=1`}><Download /></a></IconButton>
                {d.category !== "letter" && (canManage || (isSelf && d.status === "pending")) && (
                  <IconButton size="icon-sm" label={`Delete ${d.doc_type}`} onClick={() => setDeleting(d)}><Trash2 /></IconButton>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {deleting && (
        <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting.doc_type}?`} description="The file is removed for good." confirmLabel="Delete"
          onConfirm={async () => { const r = await deletePersonDocumentAction(deleting.id); if (r.ok) toast.success("Document deleted"); else toast.error(r.error); setDeleting(null); }} />
      )}
    </Card>
  );
}

function UploadPersonDoc({ employeeId, isSelf }: { employeeId: string; isSelf: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [category, setCategory] = React.useState("identity");
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const form = React.useRef<HTMLFormElement>(null);
  const submit = () => start(async () => {
    setError(null);
    const fd = new FormData(form.current!);
    const f = fd.get("file");
    if (!(f instanceof File) || !f.size) { setError({ message: "Choose a file to upload.", field: "file" }); return; }
    if (f.size > MAX_UPLOAD_BYTES) { setError({ message: "This file is larger than 5 MB.", field: "file" }); return; }
    fd.set("employeeId", employeeId); fd.set("category", category);
    const r = await uploadPersonDocumentAction(fd);
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success(isSelf ? "Uploaded. HR will verify it." : "Document added");
    setOpen(false);
  });
  return (
    <Modal open={open} onOpenChange={(o) => { setOpen(o); setError(null); }} size="sm" title="Upload a document" trigger={<Button variant="secondary" size="sm"><Upload />Upload</Button>}
      footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={pending} onClick={submit}>Upload</Button></>}>
      <form ref={form} className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <Field label="Category" required error={error?.field === "category" ? error.message : undefined}>
          <Select value={category} onValueChange={setCategory} options={[{ value: "identity", label: "Identity" }, { value: "education", label: "Education" }, { value: "experience", label: "Previous employment" }, { value: "other", label: "Other" }]} />
        </Field>
        <Field label="What is it?" required help="For example: PAN card, Passport, B.Tech degree" error={error?.field === "docType" ? error.message : undefined}><Input name="docType" maxLength={80} /></Field>
        <Field label="Document number" help="Optional"><Input name="number" maxLength={60} /></Field>
        <Field label="File" required help={ACCEPT_LABEL} error={error?.field === "file" ? error.message : undefined}><Input name="file" type="file" accept={ACCEPT} className="py-1.5" /></Field>
      </form>
    </Modal>
  );
}

/** S51: pick a template, preview it merged for this person, then issue it as a PDF. */
export function IssueLetter({ employeeId, name, templates, trigger }: { employeeId: string; name: string; templates: Template[]; trigger?: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const [templateId, setTemplateId] = React.useState<string | undefined>();
  const [preview, setPreview] = React.useState<{ html: string; missing: string[] } | { error: string } | null>(null);
  const [pending, start] = React.useTransition();
  const pick = (id: string) => {
    setTemplateId(id); setPreview(null);
    previewLetterAction(id, employeeId).then((r) => setPreview(r.ok ? r.data! : { error: r.error }));
  };
  const issue = () => start(async () => {
    if (!templateId) return;
    const r = await generateLetterAction(templateId, employeeId);
    if (!r.ok) { toast.error(r.error); return; }
    toast.success("Letter issued", { description: `Saved to ${name}'s documents as a PDF.` });
    setOpen(false);
  });
  return (
    <Modal open={open} onOpenChange={(o) => { setOpen(o); if (o) { setTemplateId(undefined); setPreview(null); } }} size="lg" title={`Issue a letter to ${name}`}
      description="The letter is filled in with their details, saved as a PDF and added to their documents."
      trigger={trigger ?? <Button size="sm"><FilePlus2 />Issue letter</Button>}
      footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={pending} disabled={!templateId || !preview || "error" in preview} onClick={issue}>Issue PDF</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="Template"><Select value={templateId} onValueChange={pick} placeholder="Pick a letter template" options={templates.map((t) => ({ value: t.id, label: t.name }))} /></Field>
        {templateId && !preview && <div className="flex flex-col gap-2" aria-busy aria-label="Loading preview"><Skeleton className="h-4 w-1/3" /><Skeleton className="h-40" /></div>}
        {preview && "error" in preview && <Banner tone="danger">{preview.error}</Banner>}
        {preview && "html" in preview && (
          <>
            {preview.missing.length > 0 && <Banner tone="warning" title="Some details are missing">These show in [brackets] in the letter: {preview.missing.join(", ")}. Fill them in on the profile first, or issue it as it is.</Banner>}
            {/* sanitised on the server: only p/br/strong/em/u/h2/h3/lists, no attributes; values are escaped */}
            <div className="letter-preview max-h-96 overflow-y-auto rounded-md border border-border bg-surface-sunken px-5 py-4 text-base [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-5 [&_ol]:list-decimal [&_p]:mb-2 [&_ul]:list-disc"
              dangerouslySetInnerHTML={{ __html: preview.html }} />
          </>
        )}
      </div>
    </Modal>
  );
}
