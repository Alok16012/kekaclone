"use client";
import * as React from "react";
import { CheckCircle2, Download, FileText, FilePlus2, FilePen, ShieldCheck, Trash2, Upload } from "lucide-react";
import { Card, CardHeader } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Modal, ConfirmDialog } from "@/ui/overlay";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Segmented } from "@/ui/choice";
import { Banner, EmptyState, Skeleton } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import type { Person } from "@/ui/employee-picker";
import { deletePersonDocumentAction, generateLetterAction, previewLetterAction, reviewPersonDocumentAction, uploadPersonDocumentAction } from "@/app/(app)/org/documents/actions";
import { ACCEPT, ACCEPT_LABEL, MAX_UPLOAD_BYTES } from "@/server/modules/documents/rules";
import { RequestSignatures, SignerList } from "./esign-ui";

export type PersonDocRow = {
  id: string; category: string; doc_type: string; number: string | null; status: string; file_id: string; file_name: string; size_bytes: number; created_at: string;
  expiry_date?: string | null; review_comment?: string | null; verified_by_name?: string | null;
  sign?: { letterId: string; status: string; total: number; signed: number; pendingName: string | null } | null;
};
type Template = { id: string; name: string; kind: string };

const CATEGORY: Record<string, string> = { letter: "Letters", identity: "Identity", education: "Education", experience: "Previous employment", other: "Other" };
export const fmtSize = (b: number) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
const fmtDate = (d: string) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const fmtDay = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** The Documents tab on a profile: issued letters (with erp Sign status) and personal documents with HR review and expiry. */
export function PersonDocuments({ employeeId, name, docs, canManage, isSelf, templates, people = [], today }: { employeeId: string; name: string; docs: PersonDocRow[]; canManage: boolean; isSelf: boolean; templates: Template[]; people?: Person[]; today?: string }) {
  const groups = Object.keys(CATEGORY).map((c) => ({ c, rows: docs.filter((d) => d.category === c) })).filter((g) => g.rows.length);
  const canUpload = canManage || isSelf;
  const [deleting, setDeleting] = React.useState<PersonDocRow | null>(null);
  const [reviewing, setReviewing] = React.useState<PersonDocRow | null>(null);
  const [signersFor, setSignersFor] = React.useState<string | null>(null);
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
            {g.rows.map((d) => {
              const expired = !!d.expiry_date && !!today && d.expiry_date < today;
              const soon = !!d.expiry_date && !!today && !expired && d.expiry_date <= addDays(today, 30);
              return (
                <li key={d.id} className="px-5 py-3">
                  <div className="flex items-center gap-3">
                    <FileText className="size-5 shrink-0 text-text-muted" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <a href={`/files/${d.file_id}`} target="_blank" rel="noreferrer" className="block truncate text-base font-medium hover:underline">{d.doc_type}</a>
                      <p className="truncate text-sm text-text-muted">{[d.number, d.file_name, fmtSize(d.size_bytes), fmtDate(d.created_at), d.expiry_date ? `expires ${fmtDay(d.expiry_date)}` : null].filter(Boolean).join(" · ")}</p>
                    </div>
                    {d.category !== "letter" && (d.status === "pending" ? <Badge tone="warning">Not verified</Badge> : d.status === "rejected" ? <Badge tone="danger">Sent back</Badge> : <Badge tone="success"><CheckCircle2 />Verified</Badge>)}
                    {expired ? <Badge tone="danger">Expired</Badge> : soon ? <Badge tone="warning">Expiring soon</Badge> : null}
                    {d.category === "letter" && d.sign && d.sign.total > 0 && (
                      <button type="button" className="text-left" onClick={() => setSignersFor(signersFor === d.id ? null : d.id)}>
                        <Badge tone={d.sign.status === "signed" ? "success" : d.sign.status === "pending_signature" ? "accent" : "neutral"}><FilePen />{d.sign.status === "signed" ? "Signed" : d.sign.status === "pending_signature" ? `Signing ${d.sign.signed}/${d.sign.total}` : "Not signed"}</Badge>
                      </button>
                    )}
                    {d.category === "letter" && canManage && (!d.sign || (d.sign.status !== "pending_signature" && d.sign.status !== "signed")) && d.sign?.letterId && (
                      <RequestSignatures letterId={d.sign.letterId} docType={d.doc_type} personName={name} people={people} trigger={<IconButton size="icon-sm" label={`Request signatures on ${d.doc_type}`}><FilePen /></IconButton>} />
                    )}
                    {d.category !== "letter" && canManage && !isSelf && <Button size="sm" variant={d.status === "pending" ? "secondary" : "ghost"} onClick={() => setReviewing(d)}><ShieldCheck />{d.status === "pending" ? "Check" : "Review"}</Button>}
                    <IconButton asChild size="icon-sm" label={`Download ${d.doc_type}`}><a href={`/files/${d.file_id}?download=1`}><Download /></a></IconButton>
                    {d.category !== "letter" && (canManage || (isSelf && d.status !== "verified")) && (
                      <IconButton size="icon-sm" label={`Delete ${d.doc_type}`} onClick={() => setDeleting(d)}><Trash2 /></IconButton>
                    )}
                  </div>
                  {d.review_comment && d.status === "rejected" && <p className="mt-1.5 ml-8 text-sm text-danger-text">{isSelf ? "HR says: " : "Sent back: "}{d.review_comment}</p>}
                  {d.status === "verified" && d.verified_by_name && d.category !== "letter" && <p className="mt-1 ml-8 text-xs text-text-muted">Verified by {d.verified_by_name}</p>}
                  {signersFor === d.id && d.sign && <div className="mt-2 ml-8 rounded-md bg-surface-sunken p-3"><SignerList letterId={d.sign.letterId} canManage={canManage} /></div>}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {deleting && (
        <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting.doc_type}?`} description="The file is removed for good." confirmLabel="Delete"
          onConfirm={async () => { const r = await deletePersonDocumentAction(deleting.id); if (r.ok) toast.success("Document deleted"); else toast.error(r.error); setDeleting(null); }} />
      )}
      {reviewing && <ReviewDialog doc={reviewing} onClose={() => setReviewing(null)} />}
    </Card>
  );
}

function addDays(d: string, n: number) { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }

/** HR checks an upload: verify (with an expiry date for documents that have one) or send it back with a note. */
function ReviewDialog({ doc, onClose }: { doc: PersonDocRow; onClose: () => void }) {
  const [status, setStatus] = React.useState<"verified" | "rejected">(doc.status === "rejected" ? "rejected" : "verified");
  const [comment, setComment] = React.useState(doc.review_comment ?? "");
  const [expiry, setExpiry] = React.useState(doc.expiry_date ?? "");
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    const r = await reviewPersonDocumentAction(doc.id, { status, comment: comment || null, expiryDate: expiry || null });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success(status === "verified" ? "Document verified" : "Sent back to the person"); onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="sm" title={`Check ${doc.doc_type}`} description="The person sees the outcome and any note you add."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save} variant={status === "rejected" ? "danger" : "primary"}>{status === "verified" ? "Mark verified" : "Send back"}</Button></>}>
      <div className="flex flex-col gap-4">
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <Button asChild variant="secondary"><a href={`/files/${doc.file_id}`} target="_blank" rel="noreferrer"><FileText />Open the file</a></Button>
        <Segmented label="Outcome" value={status} onChange={setStatus} options={[{ value: "verified", label: "Verified" }, { value: "rejected", label: "Send back" }]} />
        <Field label="Expiry date" help="For passports, licences and similar: reminders go out 30 and 7 days before." error={error?.field === "expiryDate" ? error.message : undefined}>
          <Input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        </Field>
        <Field label={status === "rejected" ? "What's wrong?" : "Note"} required={status === "rejected"} error={error?.field === "comment" ? error.message : undefined}>
          <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} maxLength={500} placeholder={status === "rejected" ? "e.g. The scan is cut off; please upload both sides." : "Optional"} />
        </Field>
      </div>
    </Modal>
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
    toast.success(isSelf ? "Uploaded. HR will check it." : "Document added");
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
        <Field label="Expiry date" help="Optional. Reminders go out 30 and 7 days before." error={error?.field === "expiryDate" ? error.message : undefined}><Input name="expiryDate" type="date" /></Field>
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
      description="The letter is filled in with their details, saved as a PDF and added to their documents. You can request signatures on it afterwards."
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
