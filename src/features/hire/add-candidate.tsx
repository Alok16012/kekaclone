"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Download, FileUp, Sparkles, Upload } from "lucide-react";
import { Modal } from "@/ui/overlay";
import { Button } from "@/ui/button";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { Banner } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { SOURCES } from "@/server/modules/hire/rules";
import type { FieldDef } from "@/server/modules/hire/setup";
import { addCandidateAction, importCandidatesAction, parseResumeAction } from "@/app/(app)/hire/actions";

const EMPTY = { firstName: "", lastName: "", email: "", mobile: "", currentCompany: "", currentTitle: "", experienceYears: "", source: "manual", tags: "", gender: "" };

/** S138: add one candidate (to a job, or to the talent pool). Reading the resume fills in what it can find. */
export function AddCandidateDialog({ open, onClose, jobId, jobTitle, fields }: { open: boolean; onClose: () => void; jobId: string | null; jobTitle?: string; fields: FieldDef[] }) {
  const router = useRouter();
  const [f, setF] = React.useState(EMPTY);
  const [custom, setCustom] = React.useState<Record<string, string>>({});
  const [file, setFile] = React.useState<File | null>(null);
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [dupe, setDupe] = React.useState(false);
  const [skills, setSkills] = React.useState<string[]>([]);
  const [busy, start] = React.useTransition();
  const [reading, startRead] = React.useTransition();
  const set = (k: keyof typeof EMPTY, v: string) => setF((x) => ({ ...x, [k]: v }));
  const reset = () => { setF(EMPTY); setCustom({}); setFile(null); setError(null); setDupe(false); setSkills([]); };

  const read = () => startRead(async () => {
    if (!file) return;
    const fd = new FormData(); fd.set("resume", file);
    const r = await parseResumeAction(fd);
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    const p = r.data!;
    const [first, ...rest] = (p.name ?? "").split(" ");
    setF((x) => ({ ...x, firstName: x.firstName || first || "", lastName: x.lastName || rest.join(" "), email: x.email || p.email || "", mobile: x.mobile || p.phone || "",
      experienceYears: x.experienceYears || (p.experienceYears != null ? String(p.experienceYears) : ""), tags: x.tags || p.skills.join(", ") }));
    setSkills(p.skills);
    toast.success(p.email || p.name ? "Filled in what we found. Please check it." : "We couldn't read much from this file. Please fill in the details.");
  });

  const submit = (useExisting: boolean) => start(async () => {
    setError(null);
    const fd = new FormData();
    for (const [k, v] of Object.entries(f)) fd.set(k, v);
    for (const [k, v] of Object.entries(custom)) fd.set(`custom.${k}`, v);
    if (jobId) fd.set("jobId", jobId);
    if (file) fd.set("resume", file);
    if (useExisting) fd.set("useExisting", "1");
    const r = await addCandidateAction(fd);
    if (!r.ok) {
      setError({ message: r.error, field: r.field });
      setDupe(!!jobId && r.field === "email" && /already in your candidates/.test(r.error));
      return;
    }
    toast.success(r.data!.existing ? "Existing candidate added to the job" : "Candidate added");
    reset(); onClose();
    if (!jobId) router.push(`/hire/candidates/${r.data!.candidateId}`);
  });
  const err = (k: string) => (error?.field === k ? error.message : undefined);

  return (
    <Modal open={open} onOpenChange={(o) => { if (!o) { reset(); onClose(); } }} size="lg" title="Add a candidate" description={jobTitle ? `To ${jobTitle}` : "To your talent pool"}
      footer={<><Button variant="secondary" onClick={() => { reset(); onClose(); }}>Cancel</Button><Button type="submit" form="add-cand" loading={busy}>Add candidate</Button></>}>
      <form id="add-cand" className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); submit(false); }}>
        {error && !["firstName", "email", "mobile", "experience", "source"].includes(error.field ?? "") && <Banner tone="danger">{error.message}</Banner>}
        {dupe && (
          <Banner tone="warning" title="Already in your candidates" action={<Button size="sm" variant="secondary" loading={busy} onClick={() => submit(true)}>Add them to this job</Button>}>
            {error?.message} You can add the existing record to this job instead of creating a duplicate.
          </Banner>
        )}
        <div className="flex flex-col gap-2 rounded-md border border-dashed border-border-strong p-3 sm:flex-row sm:items-center">
          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-base">
            <FileUp aria-hidden className="size-4 shrink-0 text-text-muted" />
            <span className="truncate">{file ? file.name : "Resume (PDF, Word or text, up to 5 MB)"}</span>
            <input type="file" accept=".pdf,.docx,.txt" className="sr-only" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setSkills([]); }} />
          </label>
          <Button type="button" size="sm" variant="soft" disabled={!file} loading={reading} onClick={read}><Sparkles />Fill in from resume</Button>
        </div>
        {err("resume") && <p role="alert" className="text-sm text-danger-text">{err("resume")}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" required error={err("firstName")}><Input value={f.firstName} onChange={(e) => set("firstName", e.target.value)} maxLength={80} autoComplete="off" /></Field>
          <Field label="Last name"><Input value={f.lastName} onChange={(e) => set("lastName", e.target.value)} maxLength={80} autoComplete="off" /></Field>
          <Field label="Email" required error={err("email")}><Input type="email" value={f.email} onChange={(e) => set("email", e.target.value)} maxLength={254} autoComplete="off" /></Field>
          <Field label="Mobile" error={err("mobile")}><Input inputMode="tel" value={f.mobile} onChange={(e) => set("mobile", e.target.value)} maxLength={20} /></Field>
          <Field label="Current company"><Input value={f.currentCompany} onChange={(e) => set("currentCompany", e.target.value)} maxLength={120} /></Field>
          <Field label="Current title"><Input value={f.currentTitle} onChange={(e) => set("currentTitle", e.target.value)} maxLength={120} /></Field>
          <Field label="Experience (years)" error={err("experience")}><Input type="number" min={0} max={50} step="0.5" value={f.experienceYears} onChange={(e) => set("experienceYears", e.target.value)} /></Field>
          <Field label="Source" error={err("source")}><Select value={f.source} onValueChange={(v) => set("source", v)} options={SOURCES.filter((s) => s.value !== "internal" && s.value !== "career_site").map((s) => ({ value: s.value, label: s.label }))} /></Field>
          <Field className="sm:col-span-2" label="Tags" help={skills.length ? `Skills found in the resume: ${skills.join(", ")}` : "Comma separated, e.g. java, backend"}><Input value={f.tags} onChange={(e) => set("tags", e.target.value)} maxLength={500} /></Field>
          {fields.map((d) => (
            <Field key={d.key} label={d.label} required={d.required} error={err(`custom.${d.key}`)}>
              {d.type === "select" ? <Select value={custom[d.key] ?? ""} onValueChange={(v) => setCustom((c) => ({ ...c, [d.key]: v }))} options={(d.options ?? []).map((o) => ({ value: o, label: o }))} />
                : <Input type={d.type === "number" ? "number" : d.type === "date" ? "date" : "text"} value={custom[d.key] ?? ""} onChange={(e) => setCustom((c) => ({ ...c, [d.key]: e.target.value }))} />}
            </Field>
          ))}
        </div>
      </form>
    </Modal>
  );
}

/** Bulk add from the Excel template. Emails already in the database are skipped (or put on the job). */
export function ImportDialog({ open, onClose, jobId }: { open: boolean; onClose: () => void; jobId: string | null }) {
  const [file, setFile] = React.useState<File | null>(null);
  const [result, setResult] = React.useState<{ added: number; skipped: { row: number; error: string }[] } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, start] = React.useTransition();
  const close = () => { setFile(null); setResult(null); setError(null); onClose(); };
  return (
    <Modal open={open} onOpenChange={(o) => !o && close()} title="Import candidates" description="From an Excel sheet, up to 1,000 at a time."
      footer={result ? <Button onClick={close}>Done</Button> : <><Button variant="secondary" onClick={close}>Cancel</Button><Button disabled={!file} loading={busy} onClick={() => start(async () => {
        setError(null);
        const fd = new FormData(); fd.set("file", file!); if (jobId) fd.set("jobId", jobId);
        const r = await importCandidatesAction(fd);
        if (!r.ok) setError(r.error); else { setResult(r.data!); toast.success(`${r.data!.added} added`); }
      })}><Upload />Import</Button></>}>
      {result ? (
        <div className="flex flex-col gap-3">
          <p className="text-base"><strong className="tabular">{result.added}</strong> {result.added === 1 ? "candidate" : "candidates"} added.</p>
          {result.skipped.length > 0 && (
            <div>
              <p className="text-sm font-medium">{result.skipped.length} rows skipped</p>
              <ul className="mt-1 max-h-60 overflow-y-auto text-sm text-text-muted">{result.skipped.map((s, i) => <li key={i}>Row {s.row}: {s.error}</li>)}</ul>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Button asChild variant="secondary" className="self-start"><a href="/hire/candidates/template" download><Download />Download the template</a></Button>
          <label className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-border-strong p-3 text-base">
            <FileUp aria-hidden className="size-4 text-text-muted" /><span className="truncate">{file ? file.name : "Choose the filled-in .xlsx file"}</span>
            <input type="file" accept=".xlsx" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          {error && <Banner tone="danger">{error}</Banner>}
        </div>
      )}
    </Modal>
  );
}
