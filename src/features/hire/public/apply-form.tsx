"use client";
import * as React from "react";
import { CheckCircle2, FileUp } from "lucide-react";
import { Button } from "@/ui/button";
import { Field, Input } from "@/ui/field";
import { Checkbox } from "@/ui/choice";
import { Banner } from "@/ui/feedback";
import { applyAction } from "@/app/careers/actions";

/** S144: the public apply form, with the consent checkbox required by DPDP and a hidden honeypot field for bots. */
export function ApplyForm({ jobId, company }: { jobId: string; company: string }) {
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [done, setDone] = React.useState(false);
  const [consent, setConsent] = React.useState(false);
  const [file, setFile] = React.useState<File | null>(null);
  const [busy, start] = React.useTransition();
  if (done) return (
    <div role="status" className="flex flex-col items-center gap-2 py-6 text-center">
      <CheckCircle2 aria-hidden className="size-10 text-success-text" />
      <p className="text-lg font-semibold">Thanks, we&apos;ve got your application</p>
      <p className="text-base text-text-muted">We&apos;ve sent a confirmation to your email. {company}&apos;s team will be in touch.</p>
    </div>
  );
  const err = (k: string) => (error?.field === k ? error.message : undefined);
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      fd.set("jobId", jobId); fd.set("consent", consent ? "1" : "");
      if (file) fd.set("resume", file);
      start(async () => { setError(null); const r = await applyAction(fd); if (r.ok) setDone(true); else setError({ message: r.error, field: r.field }); });
    }}>
      {error && !["firstName", "email", "mobile", "experienceYears", "resume", "consent"].includes(error.field ?? "") && <Banner tone="danger">{error.message}</Banner>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name" required error={err("firstName")}><Input name="firstName" autoComplete="given-name" maxLength={80} required /></Field>
        <Field label="Last name"><Input name="lastName" autoComplete="family-name" maxLength={80} /></Field>
        <Field label="Email" required error={err("email")}><Input name="email" type="email" autoComplete="email" required /></Field>
        <Field label="Mobile" error={err("mobile")}><Input name="mobile" inputMode="tel" autoComplete="tel" maxLength={20} /></Field>
        <Field label="Current company"><Input name="currentCompany" autoComplete="organization" maxLength={120} /></Field>
        <Field label="Current title"><Input name="currentTitle" autoComplete="organization-title" maxLength={120} /></Field>
        <Field label="Experience (years)" error={err("experienceYears")}><Input name="experienceYears" type="number" min={0} max={50} step="0.5" /></Field>
      </div>
      <div aria-hidden className="absolute left-[-9999px] h-0 w-0 overflow-hidden"><label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Resume <span aria-hidden className="text-danger">*</span></span>
        <label className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-border-strong p-3 text-base focus-within:ring-3 focus-within:ring-focus/25">
          <FileUp aria-hidden className="size-4 text-text-muted" /><span className="truncate">{file ? file.name : "PDF, Word or text, up to 5 MB"}</span>
          <input type="file" accept=".pdf,.docx,.txt" className="sr-only" aria-label="Resume" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        {err("resume") && <p role="alert" className="text-sm text-danger-text">{err("resume")}</p>}
      </div>
      <div className="flex flex-col gap-1">
        <Checkbox checked={consent} onCheckedChange={(c) => setConsent(!!c)} label={`I agree that ${company} may store and use my details to consider me for this and similar roles.`} />
        {err("consent") && <p role="alert" className="text-sm text-danger-text">{err("consent")}</p>}
      </div>
      <Button type="submit" size="lg" loading={busy} className="self-start">Send application</Button>
    </form>
  );
}
