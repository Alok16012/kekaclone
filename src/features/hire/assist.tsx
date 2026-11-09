"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronUp, ShieldCheck, Sparkles, Trash2, Wand2 } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Checkbox, Switch } from "@/ui/choice";
import { Modal } from "@/ui/overlay";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { RETENTION_OPTIONS, scoreBand } from "@/server/modules/assist/rules";
import { declinePrivacyRequestAction, draftJdAction, eraseCandidateAction, saveHirePrivacyAction, scoreApplicationAction, scoreJobAction } from "@/app/(app)/hire/assist-actions";

/** What the screens say about the assistant. `active` = an AI provider is configured and the company has it switched on. */
export type AssistantInfo = { provider: string | null; model: string | null; enabled: boolean; active: boolean };

export function assistantLabel(a: AssistantInfo) {
  if (a.active) return `Uses ${a.provider}`;
  if (a.provider && !a.enabled) return "AI switched off: rule-based";
  return "AI not configured: rule-based";
}

const methodBadge = (m: "ai" | "keywords" | "outline", model?: string | null) =>
  m === "ai" ? <Badge tone="accent"><Sparkles aria-hidden />AI{model ? ` · ${model}` : ""}</Badge> : <Badge tone="neutral">{m === "keywords" ? "Keyword match" : "Built-in outline"}</Badge>;

/** Shown next to every score: what it is, what it isn't, and what leaves the app. */
export function ScorePrivacyNote({ a }: { a: AssistantInfo }) {
  return (
    <p className="flex items-start gap-1.5 text-sm text-text-muted">
      <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>
        Scores are advice for the hiring team, not decisions: nobody is moved or turned down because of a score.{" "}
        {a.active ? `Resume text is sent to ${a.provider} with names, contact details and ID numbers removed; it isn't used to train models.` : "Nothing leaves the app: scores come from keyword overlap with the job description."}
      </span>
    </p>
  );
}

// ---------------------------------------------------------------- JD drafting (job wizard)
export function JdDraftButton({ brief, hasText, assistant, onDraft }: {
  brief: { title: string; departmentId: string; locationId: string; expMin: string; expMax: string; jobType: string };
  hasText: boolean; assistant: AssistantInfo; onDraft: (html: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [skills, setSkills] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [busy, start] = React.useTransition();
  const go = () => start(async () => {
    setError(null);
    const r = await draftJdAction({ ...brief, experienceMin: brief.expMin, experienceMax: brief.expMax, skills, notes });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    onDraft(r.data!.html);
    setOpen(false);
    if (r.data!.notice) toast.info(r.data!.notice);
    else toast.success(r.data!.method === "ai" ? "Draft ready. Read it through and edit before publishing." : "Outline added. Fill in the details.");
  });
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}><Wand2 />{assistant.active ? "Draft with AI" : "Draft an outline"}</Button>
      <Modal open={open} onOpenChange={setOpen} title="Draft the job description" description={assistantLabel(assistant)}
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={busy} onClick={go}>{hasText ? "Replace with draft" : "Draft it"}</Button></>}>
        <div className="flex flex-col gap-4">
          {error && error.field !== "title" && <Banner tone="danger">{error.message}</Banner>}
          {error?.field === "title" && <Banner tone="warning">{error.message} Close this and fill in the job title.</Banner>}
          <p className="text-base text-text-muted">For <strong className="text-text">{brief.title.trim() || "an untitled job"}</strong>. The department, location and experience you picked are used too.</p>
          <Field label="Key skills" help="Separate with commas, e.g. Java, Spring, PostgreSQL."><Input value={skills} onChange={(e) => setSkills(e.target.value)} maxLength={600} /></Field>
          <Field label="Anything else to mention" help="Optional. A line about the team or the work."><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} rows={3} /></Field>
          {hasText && <Banner tone="warning">This replaces the description you have now.</Banner>}
          <p className="text-sm text-text-muted">
            {assistant.active ? `${assistant.provider} writes a first draft from the brief above. It doesn't know your salary or benefits; check every line before you publish.`
              : "With AI not set up, you get a structured outline with your title and skills filled in, ready to edit."}
          </p>
        </div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- scores on a job
export type ScoreRowDTO = {
  application_id: string; candidate_id: string; name: string; stage: string; status: string; score: number; method: "ai" | "keywords"; model: string | null;
  summary: string; strengths: string[]; gaps: string[]; matched: string[]; missing: string[]; stale: boolean;
};

function ScoreValue({ score }: { score: number }) {
  const b = scoreBand(score);
  return <span className="inline-flex items-center gap-2"><span className="text-lg font-semibold tabular">{score}</span><Badge tone={b.tone}>{b.label}</Badge></span>;
}

function Explanation({ r }: { r: Pick<ScoreRowDTO, "summary" | "strengths" | "gaps" | "matched" | "missing"> }) {
  return (
    <div className="flex flex-col gap-2 text-base">
      {r.summary && <p>{r.summary}</p>}
      {r.strengths.length > 0 && <div><p className="text-sm font-medium">Strengths</p><ul className="ml-5 list-disc text-text-muted">{r.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul></div>}
      {r.gaps.length > 0 && <div><p className="text-sm font-medium">Gaps</p><ul className="ml-5 list-disc text-text-muted">{r.gaps.map((s, i) => <li key={i}>{s}</li>)}</ul></div>}
      {(r.matched.length > 0 || r.missing.length > 0) && (
        <div className="flex flex-wrap gap-1">
          {r.matched.slice(0, 12).map((m) => <Badge key={`m${m}`} tone="success">{m}</Badge>)}
          {r.missing.slice(0, 12).map((m) => <Badge key={`x${m}`} tone="neutral"><span className="sr-only">missing: </span>{m}</Badge>)}
        </div>
      )}
    </div>
  );
}

export function JobScores({ jobId, rows, unscored, canAct, assistant }: { jobId: string; rows: ScoreRowDTO[]; unscored: number; canAct: boolean; assistant: AssistantInfo }) {
  const router = useRouter();
  const [open, setOpen] = React.useState<string | null>(null);
  const [busy, start] = React.useTransition();
  const run = () => start(async () => {
    const r = await scoreJobAction(jobId);
    if (!r.ok) { toast.error(r.error); return; }
    const d = r.data!;
    if (d.notice) toast.info(d.notice);
    toast.success(d.scored ? `Scored ${d.scored} ${d.scored === 1 ? "candidate" : "candidates"}${d.remaining ? `; ${d.remaining} left, run it again` : ""}.` : "Everyone with a resume already has a current score.");
    router.refresh();
  });
  return (
    <Card className="mt-4">
      <CardHeader title="Resume match" description={`${assistantLabel(assistant)} · compares each resume with this job's description`}
        action={canAct && <Button size="sm" variant="secondary" loading={busy} onClick={run} disabled={!unscored}><Sparkles />{unscored ? `Score ${unscored} ${unscored === 1 ? "candidate" : "candidates"}` : "All scored"}</Button>} />
      <CardBody className="flex flex-col gap-3">
        <ScorePrivacyNote a={assistant} />
        {rows.length === 0 ? <EmptyState compact title="No scores yet" description={canAct ? "Score candidates to see how their resumes match the job description." : "The hiring team hasn't scored anyone yet."} /> : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {rows.map((r) => (
              <li key={r.application_id} className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-3">
                  <Link href={`/hire/candidates/${r.candidate_id}?app=${r.application_id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">{r.name}</Link>
                  <span className="text-sm text-text-muted">{r.status === "active" ? r.stage : r.status}</span>
                  <ScoreValue score={r.score} />
                  {methodBadge(r.method)}
                  {r.stale && <Badge tone="warning">Job changed</Badge>}
                  <Button size="icon-sm" variant="ghost" aria-label={open === r.application_id ? `Hide why for ${r.name}` : `Why this score for ${r.name}`} aria-expanded={open === r.application_id}
                    onClick={() => setOpen((o) => (o === r.application_id ? null : r.application_id))}>{open === r.application_id ? <ChevronUp /> : <ChevronDown />}</Button>
                </div>
                {open === r.application_id && <div className="mt-2 rounded-md bg-surface-sunken p-3"><Explanation r={r} /></div>}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------- scores on the candidate profile
export type AppScore = { applicationId: string; job: string; canAct: boolean; score: (Omit<ScoreRowDTO, "candidate_id" | "name" | "stage" | "status" | "stale"> & { created_at: string; scored_by: string | null }) | null };

export function CandidateScores({ items, assistant, anonymised }: { items: AppScore[]; assistant: AssistantInfo; anonymised: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  if (!items.length || anonymised) return null;
  const score = async (id: string) => {
    setBusy(id);
    const r = await scoreApplicationAction(id);
    setBusy(null);
    if (!r.ok) { toast.error(r.error); return; }
    if (r.data!.notice) toast.info(r.data!.notice); else toast.success("Score updated");
    router.refresh();
  };
  return (
    <Card className="mt-4">
      <CardHeader title="Resume match" description={assistantLabel(assistant)} />
      <CardBody className="flex flex-col gap-4">
        <ScorePrivacyNote a={assistant} />
        {items.map((it) => (
          <div key={it.applicationId} className="flex flex-col gap-2 rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="min-w-0 flex-1 font-medium">{it.job}</span>
              {it.score ? <><ScoreValue score={it.score.score} />{methodBadge(it.score.method, it.score.model)}</> : <span className="text-sm text-text-muted">Not scored</span>}
              {it.canAct && <Button size="sm" variant="secondary" loading={busy === it.applicationId} onClick={() => score(it.applicationId)}><Sparkles />{it.score ? "Score again" : "Score"}</Button>}
            </div>
            {it.score && <Explanation r={it.score} />}
            {it.score && <p className="text-xs text-text-muted">Scored {new Date(it.score.created_at).toLocaleDateString("en-IN", { dateStyle: "medium" })}{it.score.scored_by ? ` by ${it.score.scored_by}` : ""}</p>}
          </div>
        ))}
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------- privacy: remove a candidate's data
export function EraseCandidateButton({ candidateId, name, blocker }: { candidateId: string; name: string; blocker: string | null }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [sure, setSure] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [busy, start] = React.useTransition();
  const go = () => start(async () => {
    const r = await eraseCandidateAction(candidateId, note);
    if (!r.ok) { toast.error(r.error); return; }
    toast.success("Candidate details removed");
    setOpen(false);
    router.refresh();
  });
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}><Trash2 />Remove personal data</Button>
      <Modal open={open} onOpenChange={setOpen} title={`Remove ${name}'s personal data?`} description="Use this when a candidate asks you to delete their data."
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button variant="danger" disabled={!sure || !!blocker} loading={busy} onClick={go}>Remove data</Button></>}>
        <div className="flex flex-col gap-4">
          {blocker ? <Banner tone="warning">{blocker}</Banner> : (
            <p className="text-base">Their name, email, phone, resume, notes, documents and letters are deleted. Hiring counts and stage history stay, without anything that identifies them. This can&apos;t be undone. They&apos;re emailed a confirmation.</p>
          )}
          <Field label="Note for the record" help="Optional, e.g. how they asked."><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
          <Checkbox checked={sure} onCheckedChange={(c) => setSure(c === true)} label="I understand this can't be undone" />
        </div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- settings: privacy & AI
export type PrivacyRequestDTO = { id: string; candidate_id: string | null; candidate: string; source: string; status: string; reason: string | null; decision_note: string | null; created_at: string; decided_by: string | null; blocker: string | null };

const SOURCE = { portal: "Candidate portal", hr: "Hiring team", retention: "Retention period" } as Record<string, string>;
const STATUS_TONE = { pending: "warning", completed: "success", declined: "neutral" } as const;

export function HirePrivacy({ canEdit, aiEnabled, retentionMonths, assistant, requests }: { canEdit: boolean; aiEnabled: boolean; retentionMonths: number | null; assistant: AssistantInfo; requests: PrivacyRequestDTO[] }) {
  const router = useRouter();
  const [ai, setAi] = React.useState(aiEnabled);
  const [ret, setRet] = React.useState(retentionMonths == null ? "" : String(retentionMonths));
  const [busy, start] = React.useTransition();
  const [declining, setDeclining] = React.useState<PrivacyRequestDTO | null>(null);
  const [note, setNote] = React.useState("");
  const save = () => start(async () => {
    const r = await saveHirePrivacyAction({ aiEnabled: ai, retentionMonths: ret });
    if (r.ok) toast.success("Saved"); else toast.error(r.error);
  });
  const decline = () => start(async () => {
    if (!declining) return;
    const r = await declinePrivacyRequestAction(declining.id, note);
    if (!r.ok) { toast.error(r.error); return; }
    toast.success("Request declined; the candidate was emailed");
    setDeclining(null); setNote("");
    router.refresh();
  });
  const pending = requests.filter((r) => r.status === "pending");
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="AI assistant" description={assistant.provider ? `${assistant.provider} (${assistant.model}) is set up for this workspace.` : "No AI service is set up for this workspace (ANTHROPIC_API_KEY isn't set), so drafting and scoring use built-in rules."} />
        <CardBody className="flex flex-col gap-3">
          <Switch checked={ai} disabled={!canEdit} onCheckedChange={(c) => setAi(!!c)} label="Use AI to draft job descriptions and score resumes" />
          <p className="text-sm text-text-muted">When on, job briefs and resume text (with names, contact details and ID numbers removed) are sent to the AI service. When off, or when AI isn&apos;t set up, everything runs on built-in rules inside the app. Scores are always advice only.</p>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Keep candidate data for" description="Candidates with no hiring activity for this long are anonymised automatically each night. Employees and candidates with a live application or offer are never touched." />
        <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field label="Retention period" className="sm:w-64">
            <Select value={ret || "keep"} disabled={!canEdit} onValueChange={(v) => setRet(v === "keep" ? "" : v)}
              options={[{ value: "keep", label: "Until someone asks" }, ...RETENTION_OPTIONS.map((m) => ({ value: String(m), label: m % 12 === 0 ? `${m / 12} ${m === 12 ? "year" : "years"}` : `${m} months` }))]} />
          </Field>
          {canEdit && <Button loading={busy} onClick={save} className="sm:ml-auto">Save</Button>}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Data removal requests" description={pending.length ? `${pending.length} waiting for a decision` : "Candidates can ask from their portal; you can also remove someone's data from their profile."} />
        <CardBody>
          {requests.length === 0 ? <EmptyState compact title="No requests yet" /> : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {requests.map((r) => (
                <li key={r.id} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{r.candidate_id && r.status === "pending" ? <Link className="hover:underline" href={`/hire/candidates/${r.candidate_id}`}>{r.candidate}</Link> : r.candidate}</p>
                    <p className="text-sm text-text-muted">{SOURCE[r.source] ?? r.source} · {new Date(r.created_at).toLocaleDateString("en-IN", { dateStyle: "medium" })}{r.reason ? ` · “${r.reason}”` : ""}{r.decision_note ? ` · ${r.decision_note}` : ""}</p>
                    {r.blocker && <p className="text-sm text-warning-text">{r.blocker}</p>}
                  </div>
                  <Badge tone={STATUS_TONE[r.status as keyof typeof STATUS_TONE] ?? "neutral"}>{r.status === "pending" ? "Waiting" : r.status === "completed" ? "Removed" : "Declined"}</Badge>
                  {canEdit && r.status === "pending" && <Button size="sm" variant="ghost" onClick={() => setDeclining(r)}>Decline</Button>}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
      <Modal open={!!declining} onOpenChange={(o) => !o && setDeclining(null)} title="Decline this request?" description={declining?.candidate}
        footer={<><Button variant="secondary" onClick={() => setDeclining(null)}>Cancel</Button><Button loading={busy} onClick={decline}>Decline and email them</Button></>}>
        <Field label="Why" required help="The candidate sees this, e.g. that you must keep records while an offer is open."><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={3} /></Field>
      </Modal>
    </div>
  );
}
