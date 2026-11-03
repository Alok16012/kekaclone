"use client";
import * as React from "react";
import { BriefcaseBusiness, FileUp, Gift, Send, UserPlus } from "lucide-react";
import { Card } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Field, Input, Textarea } from "@/ui/field";
import { Modal } from "@/ui/overlay";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { jobTypeLabel } from "@/server/modules/hire/rules";
import type { InternalJob } from "@/server/modules/hire/internal";
import { applyInternalAction, referAction } from "@/app/(app)/hire/actions";
import { day, Html } from "./shared";

type Ref = { id: string; job: string; candidate: string; created_at: Date; progress: string; bonus_status: string };
type Mine = { id: string; job: string; created_at: Date; progress: string };

/** S145: internal job postings and referrals for every employee. Referrers and applicants see progress, never feedback. */
export function MeJobs({ jobs, referrals, mine, initialTab }: { jobs: InternalJob[]; referrals: Ref[]; mine: Mine[]; initialTab: string }) {
  const [tab, setTab] = React.useState(initialTab);
  const [view, setView] = React.useState<InternalJob | null>(null);
  const [applying, setApplying] = React.useState<InternalJob | null>(null);
  const [referring, setReferring] = React.useState<InternalJob | null>(null);
  return (
    <>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList items={[{ value: "jobs", label: "Open roles", count: jobs.length }, { value: "referrals", label: "My referrals", count: referrals.length }, { value: "applications", label: "My applications", count: mine.length }]} />
        <TabsContent value="jobs">
          {jobs.length === 0 ? <Card><EmptyState icon={<BriefcaseBusiness />} title="No open roles right now" description="Roles open to employees and referrals show up here." /></Card> : (
            <ul className="grid gap-3 md:grid-cols-2">
              {jobs.map((j) => (
                <li key={j.id}>
                  <Card className="flex h-full flex-col p-4">
                    <button type="button" onClick={() => setView(j)} className="text-left text-md font-semibold hover:underline">{j.title}</button>
                    <p className="mt-1 text-sm text-text-muted">{[j.department, j.location, jobTypeLabel(j.job_type), j.experience_min != null ? `${j.experience_min}+ years` : null].filter(Boolean).join(" · ")}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">{j.internal && <Badge tone="accent">Open to employees</Badge>}{j.referrals && <Badge tone="success"><Gift aria-hidden />Referrals welcome</Badge>}</div>
                    <div className="mt-auto flex flex-wrap gap-2 pt-4">
                      {j.referrals && <Button size="sm" variant="secondary" onClick={() => setReferring(j)}><UserPlus />Refer someone</Button>}
                      {j.internal && !j.on_team && (j.applied ? <Badge>Applied</Badge> : <Button size="sm" onClick={() => setApplying(j)}><Send />Apply</Button>)}
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
        <TabsContent value="referrals">
          <Card>
            {referrals.length === 0 ? <EmptyState icon={<UserPlus />} title="No referrals yet" description="Know someone great? Refer them for an open role." /> : (
              <ul className="divide-y divide-border">{referrals.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 px-5 py-3"><span className="flex-1"><span className="font-medium">{r.candidate}</span><span className="block text-sm text-text-muted">{r.job} · referred {day(r.created_at)}</span></span>
                  <Badge tone={r.progress === "Hired" ? "success" : r.progress === "Not selected" ? "neutral" : "accent"}>{r.progress}</Badge>
                  {r.bonus_status !== "none" && <Badge tone="success"><Gift aria-hidden />{r.bonus_status === "paid" ? "Bonus paid" : "Bonus due"}</Badge>}</li>
              ))}</ul>
            )}
          </Card>
        </TabsContent>
        <TabsContent value="applications">
          <Card>
            {mine.length === 0 ? <EmptyState compact title="You haven't applied for any roles" /> : (
              <ul className="divide-y divide-border">{mine.map((m) => <li key={m.id} className="flex items-center gap-2 px-5 py-3"><span className="flex-1"><span className="font-medium">{m.job}</span><span className="block text-sm text-text-muted">Applied {day(m.created_at)}</span></span><Badge tone="accent">{m.progress}</Badge></li>)}</ul>
            )}
          </Card>
        </TabsContent>
      </Tabs>
      {view && (
        <Modal open onOpenChange={(o) => !o && setView(null)} size="lg" title={view.title} description={[view.department, view.location].filter(Boolean).join(" · ")}
          footer={<>{view.referrals && <Button variant="secondary" onClick={() => { setReferring(view); setView(null); }}>Refer someone</Button>}{view.internal && !view.on_team && !view.applied && <Button onClick={() => { setApplying(view); setView(null); }}>Apply</Button>}</>}>
          <Html html={view.description_html} />
        </Modal>
      )}
      {applying && <ApplyDialog job={applying} onClose={() => setApplying(null)} />}
      {referring && <ReferDialog job={referring} onClose={() => setReferring(null)} />}
    </>
  );
}

function ApplyDialog({ job, onClose }: { job: InternalJob; onClose: () => void }) {
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, start] = React.useTransition();
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Apply for ${job.title}`} description="The hiring team sees your profile and this note. Your manager isn't told automatically."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={() => start(async () => { const r = await applyInternalAction(job.id, note); if (!r.ok) setError(r.error); else { toast.success("Application sent"); onClose(); } })}>Apply</Button></>}>
      <div className="flex flex-col gap-3">
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Why you'd like this role" help="Optional"><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={5} /></Field>
      </div>
    </Modal>
  );
}

function ReferDialog({ job, onClose }: { job: InternalJob; onClose: () => void }) {
  const [f, setF] = React.useState({ firstName: "", lastName: "", email: "", mobile: "", note: "" });
  const [file, setFile] = React.useState<File | null>(null);
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [busy, start] = React.useTransition();
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const err = (k: string) => (error?.field === k ? error.message : undefined);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Refer someone for ${job.title}`} description="You'll see how far they get. Feedback and ratings stay with the hiring team."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="refer" loading={busy}>Refer</Button></>}>
      <form id="refer" className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); start(async () => {
        setError(null);
        const fd = new FormData(); for (const [k, v] of Object.entries(f)) fd.set(k, v); fd.set("jobId", job.id); if (file) fd.set("resume", file);
        const r = await referAction(fd);
        if (!r.ok) setError({ message: r.error, field: r.field }); else { toast.success("Thanks! Your referral was sent."); onClose(); }
      }); }}>
        {error && !["firstName", "email", "mobile", "resume"].includes(error.field ?? "") && <Banner tone="danger">{error.message}</Banner>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" required error={err("firstName")}><Input value={f.firstName} onChange={(e) => set("firstName", e.target.value)} maxLength={80} /></Field>
          <Field label="Last name"><Input value={f.lastName} onChange={(e) => set("lastName", e.target.value)} maxLength={80} /></Field>
          <Field label="Email" required error={err("email")}><Input type="email" value={f.email} onChange={(e) => set("email", e.target.value)} /></Field>
          <Field label="Mobile" error={err("mobile")}><Input inputMode="tel" value={f.mobile} onChange={(e) => set("mobile", e.target.value)} maxLength={20} /></Field>
        </div>
        <label className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-border-strong p-3 text-base">
          <FileUp aria-hidden className="size-4 text-text-muted" /><span className="truncate">{file ? file.name : "Their resume (PDF, Word or text, up to 5 MB)"}</span>
          <input type="file" accept=".pdf,.docx,.txt" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        {err("resume") && <p role="alert" className="text-sm text-danger-text">{err("resume")}</p>}
        <Field label="How do you know them?"><Textarea value={f.note} onChange={(e) => set("note", e.target.value)} maxLength={1000} /></Field>
      </form>
    </Modal>
  );
}
