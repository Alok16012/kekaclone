"use client";
import * as React from "react";
import Link from "next/link";
import {
  CalendarClock, CalendarPlus, CheckCircle2, ChevronDown, Download, ExternalLink, FileText, Mail, MessageSquare, Phone, Plus, RotateCcw, Send, Trash2, UserCheck, UserX, XCircle,
} from "lucide-react";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Checkbox, Switch } from "@/ui/choice";
import { ConfirmDialog, Menu, Modal } from "@/ui/overlay";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { cn } from "@/lib/cn";
import { average, criterionAverages, experienceLabel, groupLabel, RECOMMENDATIONS, sourceLabel } from "@/server/modules/hire/rules";
import type { candidateProfile } from "@/server/modules/hire/candidates";
import {
  addDocRequestAction, addNoteAction, addTaskAction, addToJobAction, deleteNoteAction, interviewStatusAction, moveAction, offerAction, previewOfferAction, replaceResumeAction,
  resendPortalAction, restoreAction, reviewDocumentAction, scorecardFormAction, setTagsAction, submitScorecardAction,
} from "@/app/(app)/hire/actions";
import { ConvertDialog, EmailDialog, OfferDialog, PreviewDialog, ScheduleDialog } from "./dialogs";
import { RejectDialog } from "./pipeline";
import { ScorecardForm, type CardSpec } from "./scorecard-form";
import { day, inr0, OfferBadge, Rating, StageBadge, when } from "./shared";

type Data = Awaited<ReturnType<typeof candidateProfile>>;
const EVENT: Record<string, string> = {
  applied: "Applied", reapplied: "Applied again", reopened: "Added back to the job", stage_change: "Moved", rejected: "Rejected", restored: "Brought back", email: "Email sent",
  interview_scheduled: "Interview scheduled", interview_cancelled: "Interview cancelled", interview_completed: "Interview done", interview_no_show: "Didn't attend", slot_picked: "Picked an interview slot",
  feedback: "Feedback sent", offer: "Offer", document: "Document uploaded", hired: "Hired",
};
const OFFER_ACTION: Record<string, string> = { drafted: "drafted", sent_for_approval: "sent for approval", approved: "approved", approval_declined: "declined by an approver", released: "sent to the candidate", accepted: "accepted", declined: "declined by the candidate", revised: "revised", withdrawn: "withdrawn", expired: "expired" };

/** S139: everything about one candidate: overview, feedback, interviews, emails, documents, offers, notes and activity. */
export function CandidateProfile({ data, people, designations, templates, openJobs, me, initialApp, initialTab }: {
  data: Data; people: { id: string; name: string; title: string | null }[]; designations: { id: string; name: string }[]; templates: { id: string; name: string }[];
  openJobs: { id: string; title: string }[]; me: string; initialApp: string | null; initialTab: string;
}) {
  const { candidate: c, apps, stages } = data;
  const [appId, setAppId] = React.useState(apps.find((a) => a.id === initialApp)?.id ?? apps[0]?.id ?? null);
  const [tab, setTab] = React.useState(initialTab);
  const [dialog, setDialog] = React.useState<null | "schedule" | "offer" | "email" | "reject" | "convert" | "addJob">(null);
  const [revise, setRevise] = React.useState<Data["offers"][number] | null>(null);
  const [preview, setPreview] = React.useState<{ html: string; missing: string[] } | null>(null);
  const [scoring, setScoring] = React.useState<{ interviewId: string; card: CardSpec } | null>(null);
  const [, start] = React.useTransition();
  const app = apps.find((a) => a.id === appId) ?? null;
  const canAct = !!app && data.actable.includes(app.id);
  const flow = app ? stages.filter((s) => s.flow_id === app.flow_id) : [];
  const appOffers = data.offers.filter((o) => o.application_id === appId);
  const live = appOffers.find((o) => ["draft", "pending_approval", "released", "accepted"].includes(o.status));
  const name = [c.first_name, c.last_name].filter(Boolean).join(" ");
  const feedback = data.feedback.filter((f) => !appId || f.application_id === appId);
  const avg = average(feedback.map((f) => f.overall));
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, msg: string) => start(async () => { const r = await fn(); if (r.ok) toast.success(msg); else toast.error(r.error ?? "Something went wrong."); });

  const openScorecard = (interviewId: string) => start(async () => {
    const r = await scorecardFormAction(interviewId);
    if (!r.ok) { toast.error(r.error); return; }
    if (r.data!.submitted) { toast.info("You've already sent feedback for this interview."); return; }
    setScoring({ interviewId, card: { ...r.data!.scorecard } });
  });

  return (
    <div className="flex flex-col gap-5">
      {/* header: application picker + stage + actions */}
      <Card className="p-4 sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-text-muted">
              <a href={`mailto:${c.email}`} className="inline-flex items-center gap-1 hover:text-text"><Mail aria-hidden className="size-4" />{c.email}</a>
              {c.mobile && <a href={`tel:${c.mobile}`} className="inline-flex items-center gap-1 hover:text-text"><Phone aria-hidden className="size-4" />{c.mobile}</a>}
              <span>{sourceLabel(c.source)}</span>
              {experienceLabel(c.experience_months) && <span>{experienceLabel(c.experience_months)} experience</span>}
            </div>
            {apps.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                {apps.length > 1 ? (
                  <Select size="sm" value={appId ?? ""} onValueChange={setAppId} options={apps.map((a) => ({ value: a.id, label: a.job }))} className="w-60" />
                ) : <Link href={`/hire/jobs/${app!.job_id}`} className="text-base font-medium hover:underline">{app!.job}</Link>}
                {app && <StageBadge group={app.group} label={app.status === "rejected" ? `Rejected: ${app.reject_reason ?? ""}` : app.status === "hired" ? "Hired" : app.stage} />}
                <Rating value={avg} count={feedback.length} />
              </div>
            ) : <p className="text-base text-text-muted">In the talent pool, not on any job yet.</p>}
          </div>
          {canAct && app && (
            <div className="flex flex-wrap gap-2">
              {app.status === "active" && (
                <Menu trigger={<Button size="sm" variant="secondary">Move<ChevronDown /></Button>} items={flow.filter((s) => s.stage_group !== "rejected" && s.stage_group !== "hired" && s.id !== app.stage_id).map((s) => ({
                  label: s.name, onSelect: () => act(() => moveAction(app.id, s.id), `Moved to ${s.name}`),
                }))} />
              )}
              {app.status === "active" && <Button size="sm" variant="secondary" onClick={() => setDialog("schedule")}><CalendarPlus />Interview</Button>}
              <Button size="sm" variant="secondary" onClick={() => setDialog("email")}><Mail />Email</Button>
              {app.status === "active" && !live && <Button size="sm" onClick={() => setDialog("offer")}><Send />Make offer</Button>}
              {app.status === "active" && live?.status === "accepted" && <Button size="sm" onClick={() => setDialog("convert")}><UserCheck />Make employee</Button>}
              {app.status === "active" && <Button size="sm" variant="ghost" onClick={() => setDialog("reject")}><UserX />Reject</Button>}
              {app.status === "rejected" && <Button size="sm" variant="secondary" onClick={() => act(() => restoreAction(app.id), "Brought back")}><RotateCcw />Bring back</Button>}
            </div>
          )}
          {data.access.act && openJobs.length > 0 && <Button size="sm" variant="ghost" onClick={() => setDialog("addJob")}><Plus />Add to a job</Button>}
        </div>
      </Card>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList items={[
          { value: "overview", label: "Overview" }, { value: "feedback", label: "Feedback", count: feedback.length },
          { value: "interviews", label: "Interviews", count: data.interviews.filter((i) => !appId || i.application_id === appId).length },
          { value: "emails", label: "Emails", count: data.events.filter((e) => e.kind === "email" && (!appId || e.application_id === appId)).length },
          { value: "documents", label: "Documents" }, { value: "offers", label: "Offer", count: appOffers.length },
          { value: "notes", label: "Notes", count: data.notes.length }, { value: "activity", label: "Activity" },
        ]} />

        <TabsContent value="overview"><Overview data={data} /></TabsContent>

        <TabsContent value="feedback">
          {feedback.length === 0 ? <Card><EmptyState icon={<MessageSquare />} title="No feedback yet" description="Interviewers' scorecards show up here once they send them." /></Card> : (
            <div className="flex flex-col gap-4">
              <FeedbackSummary feedback={feedback} />
              {feedback.map((f) => (
                <Card key={f.id}>
                  <CardHeader title={f.interviewer} description={`${day(f.submitted_at)} · ${data.interviews.find((i) => i.id === f.interview_id)?.title ?? "Interview"}`}
                    action={<div className="flex items-center gap-2"><Rating value={f.overall} /><RecBadge rec={f.recommendation} /></div>} />
                  <CardBody>
                    <dl className="grid gap-2 sm:grid-cols-2">
                      {f.sections.flatMap((s) => s.criteria).map((cr) => (
                        <div key={cr.id} className="flex items-center justify-between gap-3 rounded-md bg-surface-sunken px-3 py-1.5 text-sm">
                          <dt>{cr.label}</dt><dd className="font-medium tabular">{f.ratings[cr.id] ?? "—"} <span className="font-normal text-text-muted">{f.points.find((p) => p.value === f.ratings[cr.id])?.label}</span></dd>
                        </div>
                      ))}
                    </dl>
                    {f.comments && <p className="mt-3 whitespace-pre-line text-base">{f.comments}</p>}
                  </CardBody>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="interviews">
          <Interviews data={data} appId={appId} canAct={canAct} me={me} onSchedule={() => setDialog("schedule")} onScore={openScorecard} />
        </TabsContent>

        <TabsContent value="emails">
          <Card>
            <CardHeader title="Emails to the candidate" action={canAct && app ? <Button size="sm" variant="secondary" onClick={() => setDialog("email")}><Mail />New email</Button> : undefined} />
            {(() => {
              const emails = data.events.filter((e) => e.kind === "email" && (!appId || e.application_id === appId));
              return emails.length === 0 ? <EmptyState compact title="No emails yet" description="Emails sent from erp (confirmations, interview details, offers) are listed here." /> : (
                <ul className="divide-y divide-border border-t border-border">
                  {emails.map((e) => (
                    <li key={e.id} className="px-5 py-3">
                      <details>
                        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2"><span className="flex-1 font-medium">{String(e.data.subject ?? "")}</span><span className="text-sm text-text-muted">{e.actor ?? "Sent automatically"} · {when(e.created_at)}</span></summary>
                        <p className="mt-2 whitespace-pre-line rounded-md bg-surface-sunken p-3 text-sm">{String(e.data.body ?? "")}</p>
                      </details>
                    </li>
                  ))}
                </ul>
              );
            })()}
          </Card>
        </TabsContent>

        <TabsContent value="documents"><Documents data={data} canAct={data.access.act} /></TabsContent>

        <TabsContent value="offers">
          {!app ? <Card><EmptyState compact title="Add the candidate to a job first" /></Card> : appOffers.length === 0 ? (
            <Card><EmptyState icon={<Send />} title="No offer yet" description="Make an offer from a letter template. It goes for approval before it's sent."
              action={canAct && app.status === "active" ? <Button onClick={() => setDialog("offer")}><Send />Make offer</Button> : undefined} /></Card>
          ) : (
            <div className="flex flex-col gap-3">
              {appOffers.map((o) => (
                <Card key={o.id} className={cn(o !== live && "opacity-80")}>
                  <CardHeader title={`Version ${o.version} · ${inr0(o.ctc_paise)} a year`} description={`${o.designation ?? app.job} · joining ${day(o.joining_date)}${o.expires_on ? ` · accept by ${day(o.expires_on)}` : ""}`}
                    action={<OfferBadge status={o.status} approval={o.approval} />} />
                  <CardBody className="flex flex-col gap-3">
                    {o.status === "accepted" && <p className="text-base"><CheckCircle2 aria-hidden className="mr-1 inline size-4 text-success-text" />Signed by <strong>{o.signed_name}</strong> on {when(o.responded_at)}.</p>}
                    {o.status === "declined" && <p className="text-base"><XCircle aria-hidden className="mr-1 inline size-4 text-danger-text" />Declined{o.decline_reason ? `: “${o.decline_reason}”` : ""}.</p>}
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="ghost" onClick={() => start(async () => { const r = await previewOfferAction(o.id); if (r.ok) setPreview(r.data!); else toast.error(r.error); })}><FileText />Preview letter</Button>
                      {o.letter_file_id && <Button asChild size="sm" variant="ghost"><a href={`/hire/files/${o.letter_file_id}`} target="_blank" rel="noopener"><Download />Letter PDF<span className="sr-only"> (opens in a new tab)</span></a></Button>}
                      {canAct && o.status === "draft" && o.approval !== "approved" && o.approval !== "pending" && <Button size="sm" variant="secondary" onClick={() => act(() => offerAction(o.id, "submit"), "Sent for approval")}>Send for approval</Button>}
                      {canAct && o.status === "draft" && o.approval === "approved" && <Button size="sm" onClick={() => act(() => offerAction(o.id, "release"), "Offer sent to the candidate")}><Send />Send to candidate</Button>}
                      {canAct && o.status === "released" && <Button size="sm" variant="secondary" onClick={() => act(() => resendPortalAction(app.id), "A new link was emailed")}>Resend link</Button>}
                      {canAct && ["draft", "pending_approval", "released"].includes(o.status) && <Button size="sm" variant="secondary" onClick={() => setRevise(o)}>Revise</Button>}
                      {canAct && ["draft", "pending_approval", "released"].includes(o.status) && (
                        <ConfirmDialog title="Withdraw this offer?" description="The candidate can't accept it any more." confirmLabel="Withdraw" onConfirm={() => act(() => offerAction(o.id, "withdraw"), "Offer withdrawn")}
                          trigger={<Button size="sm" variant="ghost">Withdraw</Button>} />
                      )}
                      {canAct && o.status === "accepted" && app.status === "active" && <Button size="sm" onClick={() => setDialog("convert")}><UserCheck />Make employee</Button>}
                    </div>
                  </CardBody>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="notes"><Notes data={data} appId={appId} me={me} /></TabsContent>

        <TabsContent value="activity">
          <Card>
            {data.events.length === 0 ? <EmptyState compact title="Nothing yet" /> : (
              <ol className="divide-y divide-border">
                {data.events.filter((e) => !appId || e.application_id === appId).map((e) => (
                  <li key={e.id} className="flex flex-col gap-0.5 px-5 py-3 sm:flex-row sm:items-center sm:gap-3">
                    <span className="flex-1 text-base">
                      <strong className="font-medium">{EVENT[e.kind] ?? e.kind}</strong>
                      {e.kind === "stage_change" && <> to {String(e.data.to)}{e.data.from ? <span className="text-text-muted"> (from {String(e.data.from)})</span> : null}</>}
                      {e.kind === "rejected" && <>: {String(e.data.reason)}</>}
                      {e.kind === "offer" && <> {OFFER_ACTION[String(e.data.action)] ?? String(e.data.action)}</>}
                      {e.kind === "email" && <>: {String(e.data.subject)}</>}
                      {(e.kind === "applied" && e.data.source) ? <span className="text-text-muted"> via {sourceLabel(String(e.data.source))}</span> : null}
                      {e.kind === "feedback" && <> by {String(e.data.by)}</>}
                    </span>
                    <span className="text-sm text-text-muted">{e.actor ?? "System"} · {when(e.created_at)}</span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </TabsContent>
      </Tabs>

      {dialog === "schedule" && app && <ScheduleDialog applicationId={app.id} candidate={name} people={people} scorecards={data.scorecards} onClose={() => setDialog(null)} />}
      {dialog === "offer" && app && <OfferDialog applicationId={app.id} templates={templates} designations={designations} onClose={() => setDialog(null)} />}
      {revise && app && <OfferDialog applicationId={app.id} reviseOfferId={revise.id} templates={templates} designations={designations} onClose={() => setRevise(null)}
        initial={{ templateId: null, designationId: null, ctc: String(Math.round(revise.ctc_paise / 100)), joiningDate: revise.joining_date, expiresOn: revise.expires_on ?? "" }} />}
      {dialog === "email" && app && <EmailDialog applicationId={app.id} to={c.email} onClose={() => setDialog(null)} />}
      {dialog === "reject" && app && <RejectDialog ids={[app.id]} names={[name]} onClose={() => setDialog(null)} />}
      {dialog === "convert" && app && <ConvertDialog applicationId={app.id} candidate={name} onClose={() => setDialog(null)} />}
      {dialog === "addJob" && <AddToJob candidateId={c.id} jobs={openJobs.filter((j) => !apps.some((a) => a.job_id === j.id))} onClose={() => setDialog(null)} />}
      {preview && <PreviewDialog title="Offer letter" html={preview.html} missing={preview.missing} onClose={() => setPreview(null)} />}
      {scoring && (
        <Modal open onOpenChange={(o) => !o && setScoring(null)} size="lg" title={`Feedback on ${name}`} description={scoring.card.name}>
          <ScorecardForm card={scoring.card} onSubmit={async (v) => { const r = await submitScorecardAction(scoring.interviewId, v); if (r.ok) { toast.success("Feedback sent"); setScoring(null); } return r; }} />
        </Modal>
      )}
    </div>
  );
}

function RecBadge({ rec }: { rec: string | null }) {
  if (!rec) return null;
  const label = RECOMMENDATIONS.find((r) => r.value === rec)?.label ?? rec;
  return <Badge tone={rec.endsWith("no") ? "danger" : "success"}>{label}</Badge>;
}

function FeedbackSummary({ feedback }: { feedback: Data["feedback"][number][] }) {
  const crit = criterionAverages(feedback.map((f) => f.ratings));
  const labels = new Map(feedback.flatMap((f) => f.sections.flatMap((s) => s.criteria.map((c) => [c.id, c.label] as const))));
  const recs = RECOMMENDATIONS.map((r) => ({ ...r, n: feedback.filter((f) => f.recommendation === r.value).length })).filter((r) => r.n);
  return (
    <Card>
      <CardHeader title="Summary" description={`${feedback.length} ${feedback.length === 1 ? "scorecard" : "scorecards"}`} action={<Rating value={average(feedback.map((f) => f.overall))} />} />
      <CardBody className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">{recs.map((r) => <Badge key={r.value} tone={r.value.endsWith("no") ? "danger" : "success"}>{r.label}: {r.n}</Badge>)}</div>
        <dl className="grid gap-2 sm:grid-cols-2">
          {Object.entries(crit).map(([k, v]) => (
            <div key={k} className="flex items-center gap-3 text-sm">
              <dt className="w-40 shrink-0 truncate">{labels.get(k) ?? k}</dt>
              <dd className="flex flex-1 items-center gap-2"><span className="h-2 flex-1 overflow-hidden rounded-pill bg-surface-sunken"><span className="block h-full bg-accent" style={{ width: `${(v / 5) * 100}%` }} /></span><span className="w-8 tabular">{v}</span></dd>
            </div>
          ))}
        </dl>
      </CardBody>
    </Card>
  );
}

function Overview({ data }: { data: Data }) {
  const c = data.candidate;
  const [tags, setTags] = React.useState(c.tags.join(", "));
  const [busy, start] = React.useTransition();
  const fileRef = React.useRef<HTMLInputElement>(null);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader title="Resume" action={data.access.act ? (
          <>
            <Button size="sm" variant="secondary" loading={busy} onClick={() => fileRef.current?.click()}>{c.resume_file_id ? "Replace" : "Upload"}</Button>
            <input ref={fileRef} type="file" accept=".pdf,.docx,.txt" className="sr-only" aria-label="Choose a resume" onChange={(e) => {
              const f = e.target.files?.[0]; if (!f) return;
              const fd = new FormData(); fd.set("resume", f);
              start(async () => { const r = await replaceResumeAction(c.id, fd); if (r.ok) toast.success("Resume saved"); else toast.error(r.error); });
            }} />
          </>
        ) : undefined} />
        <CardBody className="flex flex-col gap-3">
          {c.resume_file_id ? (
            <a href={`/hire/files/${c.resume_file_id}`} target="_blank" rel="noopener" className="inline-flex items-center gap-2 self-start rounded-md bg-surface-sunken px-3 py-2 text-base text-accent-text hover:underline">
              <FileText aria-hidden className="size-4" />{c.resume_name}<ExternalLink aria-hidden className="size-3.5" /><span className="sr-only">(opens in a new tab)</span>
            </a>
          ) : <p className="text-base text-text-muted">No resume uploaded.</p>}
          {c.parsed?.skills?.length ? <div className="flex flex-wrap gap-1.5"><span className="text-sm text-text-muted">Skills found:</span>{c.parsed.skills.map((s) => <Badge key={s}>{s}</Badge>)}</div> : null}
          {c.parsed?.text ? <details><summary className="cursor-pointer text-sm text-text-muted">Text read from the resume</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-surface-sunken p-3 font-sans text-sm">{c.parsed.text}</pre></details> : null}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Details" />
        <CardBody>
          <dl className="flex flex-col gap-2.5 text-base">
            {[["Current company", c.current_company], ["Current title", c.current_title], ["Experience", experienceLabel(c.experience_months)], ["Gender", c.gender], ["Added", day(c.created_at)],
              ["Consent to store details", c.consent_at ? day(c.consent_at) : null], ...data.fields.map((f) => [f.label, c.custom?.[f.key] != null ? String(c.custom[f.key]) : null])].map(([k, v]) => (
              <div key={k as string} className="flex justify-between gap-3"><dt className="text-text-muted">{k}</dt><dd className="text-right">{v || "—"}</dd></div>
            ))}
          </dl>
          <form className="mt-4 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); start(async () => { const r = await setTagsAction(c.id, tags.split(",")); if (r.ok) toast.success("Tags saved"); else toast.error(r.error); }); }}>
            <Field label="Tags" className="flex-1"><Input value={tags} onChange={(e) => setTags(e.target.value)} disabled={!data.access.act} /></Field>
            {data.access.act && <Button type="submit" size="sm" variant="secondary" loading={busy}>Save</Button>}
          </form>
        </CardBody>
      </Card>
      {data.apps.length > 0 && (
        <Card className="lg:col-span-3">
          <CardHeader title="Applications" />
          <ul className="divide-y divide-border border-t border-border">
            {data.apps.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <Link href={`/hire/jobs/${a.job_id}`} className="flex-1 font-medium hover:underline">{a.job}</Link>
                <StageBadge group={a.group} label={a.status === "active" ? a.stage : a.status === "hired" ? "Hired" : `${groupLabel(a.group)}${a.reject_reason ? `: ${a.reject_reason}` : ""}`} />
                <span className="text-sm text-text-muted">{a.referred_by ? `Referred by ${a.referred_by}` : sourceLabel(a.source)} · {day(a.created_at)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function Interviews({ data, appId, canAct, me, onSchedule, onScore }: { data: Data; appId: string | null; canAct: boolean; me: string; onSchedule: () => void; onScore: (id: string) => void }) {
  const list = data.interviews.filter((i) => !appId || i.application_id === appId);
  const [, start] = React.useTransition();
  const set = (id: string, s: string, msg: string) => start(async () => { const r = await interviewStatusAction(id, s); if (r.ok) toast.success(msg); else toast.error(r.error); });
  if (!list.length) return <Card><EmptyState icon={<CalendarClock />} title="No interviews yet" action={canAct ? <Button onClick={onSchedule}><CalendarPlus />Schedule an interview</Button> : undefined} /></Card>;
  return (
    <div className="flex flex-col gap-3">
      {canAct && <Button className="self-start" variant="secondary" onClick={onSchedule}><CalendarPlus />Schedule another</Button>}
      {list.map((i) => {
        const mine = i.panel.find((p) => p.id === me);
        return (
          <Card key={i.id} className="p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{i.title ?? "Interview"} <span className="font-normal text-text-muted">· {i.mode === "online" ? "Video call" : i.mode === "in_person" ? "In person" : "Phone call"}</span></p>
                <p className="text-sm text-text-muted">{i.status === "awaiting_candidate" ? `Waiting for the candidate to pick one of ${i.slots} slots` : when(i.starts_at)}{i.location ? ` · ${i.location}` : ""}</p>
                {i.meeting_url && <a href={i.meeting_url} target="_blank" rel="noopener noreferrer" className="text-sm text-accent-text hover:underline">Join link<span className="sr-only"> (opens in a new tab)</span></a>}
                <p className="mt-1 text-sm">Panel: {i.panel.map((p) => <span key={p.id} className="mr-2 inline-flex items-center gap-1">{p.name}{p.submitted ? <CheckCircle2 aria-label="feedback sent" className="size-3.5 text-success-text" /> : null}</span>)}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={i.status === "scheduled" ? "accent" : i.status === "completed" ? "success" : i.status === "awaiting_candidate" ? "warning" : "neutral"}>
                  {{ scheduled: "Scheduled", completed: "Done", awaiting_candidate: "Waiting for a slot", cancelled: "Cancelled", no_show: "Didn't attend" }[i.status] ?? i.status}
                </Badge>
                {i.starts_at && i.status === "scheduled" && <Button asChild size="sm" variant="ghost"><a href={`/hire/interviews/${i.id}/ics`}><CalendarPlus />Add to calendar</a></Button>}
                {mine && !mine.submitted && ["scheduled", "completed"].includes(i.status) && <Button size="sm" onClick={() => onScore(i.id)}>Give feedback</Button>}
                {canAct && ["scheduled", "awaiting_candidate"].includes(i.status) && (
                  <Menu trigger={<Button size="sm" variant="ghost">More<ChevronDown /></Button>} items={[
                    ...(i.status === "scheduled" ? [{ label: "Mark as done", onSelect: () => set(i.id, "completed", "Marked as done") }, { label: "Didn't attend", onSelect: () => set(i.id, "no_show", "Marked as didn't attend") }] : []),
                    { label: "Cancel interview", danger: true, onSelect: () => set(i.id, "cancelled", "Interview cancelled") },
                  ]} />
                )}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function Documents({ data, canAct }: { data: Data; canAct: boolean }) {
  const [busy, start] = React.useTransition();
  const [rejecting, setRejecting] = React.useState<string | null>(null);
  const [comment, setComment] = React.useState("");
  const [doc, setDoc] = React.useState({ type: "", required: true });
  const [task, setTask] = React.useState("");
  const review = (id: string, d: "approved" | "rejected", note: string) => start(async () => { const r = await reviewDocumentAction(id, d, note); if (r.ok) { toast.success(d === "approved" ? "Approved" : "Sent back to the candidate"); setRejecting(null); setComment(""); } else toast.error(r.error); });
  const STATUS: Record<string, { tone: "neutral" | "warning" | "success" | "danger"; label: string }> = { requested: { tone: "neutral", label: "Waiting for upload" }, uploaded: { tone: "warning", label: "To review" }, approved: { tone: "success", label: "Approved" }, rejected: { tone: "danger", label: "Needs a new upload" } };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Joining documents" description="The candidate uploads these in their portal once an offer is sent." />
        {data.docs.length === 0 ? <EmptyState compact title="None requested yet" /> : (
          <ul className="divide-y divide-border border-t border-border">
            {data.docs.map((d) => (
              <li key={d.id} className="flex flex-col gap-2 px-5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex-1 font-medium">{d.doc_type}{d.required ? "" : <span className="font-normal text-text-muted"> (optional)</span>}</span>
                  <Badge tone={STATUS[d.status]?.tone}>{STATUS[d.status]?.label ?? d.status}</Badge>
                </div>
                {d.file_id && <a href={`/hire/files/${d.file_id}`} target="_blank" rel="noopener" className="text-sm text-accent-text hover:underline">{d.file_name}<span className="sr-only"> (opens in a new tab)</span></a>}
                {d.reviewer_comment && <p className="text-sm text-text-muted">“{d.reviewer_comment}”</p>}
                {canAct && d.status === "uploaded" && (rejecting === d.id ? (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                    <Field label="What should they fix?" className="flex-1"><Input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={300} /></Field>
                    <Button size="sm" variant="danger" loading={busy} onClick={() => review(d.id, "rejected", comment)}>Send back</Button>
                    <Button size="sm" variant="ghost" onClick={() => setRejecting(null)}>Cancel</Button>
                  </div>
                ) : (
                  <div className="flex gap-2"><Button size="sm" loading={busy} onClick={() => review(d.id, "approved", "")}>Approve</Button><Button size="sm" variant="secondary" onClick={() => setRejecting(d.id)}>Ask for a new one</Button></div>
                ))}
              </li>
            ))}
          </ul>
        )}
        {canAct && (
          <form className="flex flex-col gap-2 border-t border-border px-5 py-3 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); start(async () => { const r = await addDocRequestAction(data.candidate.id, doc.type, doc.required); if (r.ok) { toast.success("Document requested"); setDoc({ type: "", required: true }); } else toast.error(r.error); }); }}>
            <Field label="Ask for another document" className="flex-1"><Input value={doc.type} onChange={(e) => setDoc((d) => ({ ...d, type: e.target.value }))} maxLength={80} placeholder="e.g. Relieving letter" /></Field>
            <Checkbox label="Required" checked={doc.required} onCheckedChange={(c) => setDoc((d) => ({ ...d, required: !!c }))} />
            <Button type="submit" size="sm" variant="secondary" disabled={!doc.type.trim()} loading={busy}>Add</Button>
          </form>
        )}
      </Card>
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader title="Joining tasks" />
          {data.tasks.length === 0 ? <EmptyState compact title="No tasks yet" /> : (
            <ul className="divide-y divide-border border-t border-border">
              {data.tasks.map((t) => <li key={t.id} className="flex items-center gap-2 px-5 py-2.5">{t.done_at ? <CheckCircle2 aria-label="done" className="size-4 text-success-text" /> : <span aria-label="to do" className="size-4 rounded-pill border border-border-strong" />}<span className={cn("flex-1", t.done_at && "text-text-muted line-through")}>{t.title}</span></li>)}
            </ul>
          )}
          {canAct && (
            <form className="flex items-end gap-2 border-t border-border px-5 py-3" onSubmit={(e) => { e.preventDefault(); start(async () => { const r = await addTaskAction(data.candidate.id, task, ""); if (r.ok) { toast.success("Task added"); setTask(""); } else toast.error(r.error); }); }}>
              <Field label="Add a task" className="flex-1"><Input value={task} onChange={(e) => setTask(e.target.value)} maxLength={120} /></Field>
              <Button type="submit" size="sm" variant="secondary" disabled={!task.trim()} loading={busy}>Add</Button>
            </form>
          )}
        </Card>
        <Card>
          <CardHeader title="Letters" />
          {data.offers.filter((o) => o.letter_file_id).length === 0 ? <EmptyState compact title="No letters yet" /> : (
            <ul className="divide-y divide-border border-t border-border">
              {data.offers.filter((o) => o.letter_file_id).map((o) => (
                <li key={o.id} className="flex items-center gap-2 px-5 py-2.5"><FileText aria-hidden className="size-4 text-text-muted" />
                  <a href={`/hire/files/${o.letter_file_id}`} target="_blank" rel="noopener" className="flex-1 text-accent-text hover:underline">Offer letter v{o.version}<span className="sr-only"> (opens in a new tab)</span></a><OfferBadge status={o.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function Notes({ data, appId, me }: { data: Data; appId: string | null; me: string }) {
  const [body, setBody] = React.useState("");
  const [priv, setPriv] = React.useState(false);
  const [busy, start] = React.useTransition();
  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); start(async () => { const r = await addNoteAction(data.candidate.id, body, appId, priv); if (r.ok) { setBody(""); toast.success("Note added"); } else toast.error(r.error); }); }}>
          <Field label="Add a note" help="Mention a teammate on this job with @Name to notify them."><Textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} rows={3} /></Field>
          <div className="flex flex-wrap items-center gap-3">
            <Switch checked={priv} onCheckedChange={(c) => setPriv(!!c)} label="Only visible to me" />
            <Button type="submit" size="sm" className="ml-auto" disabled={!body.trim()} loading={busy}>Add note</Button>
          </div>
        </form>
      </Card>
      {data.notes.length === 0 ? <Card><EmptyState compact title="No notes yet" /></Card> : data.notes.map((n) => (
        <Card key={n.id} className="p-4">
          <div className="flex items-center gap-2 text-sm text-text-muted">
            <span className="font-medium text-text">{n.author}</span><span>{when(n.created_at)}</span>{n.is_private && <Badge>Private</Badge>}
            {n.author_id === me && <ConfirmDialog title="Delete this note?" description="This can't be undone." confirmLabel="Delete" onConfirm={async () => { const r = await deleteNoteAction(n.id); if (r.ok) toast.success("Note deleted"); else toast.error(r.error); }}
              trigger={<Button size="icon-sm" variant="ghost" className="ml-auto" aria-label="Delete note"><Trash2 /></Button>} />}
          </div>
          <p className="mt-1 whitespace-pre-line text-base">{n.body}</p>
        </Card>
      ))}
    </div>
  );
}

function AddToJob({ candidateId, jobs, onClose }: { candidateId: string; jobs: { id: string; title: string }[]; onClose: () => void }) {
  const [job, setJob] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, start] = React.useTransition();
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="sm" title="Add to a job"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!job} loading={busy} onClick={() => start(async () => { const r = await addToJobAction(candidateId, job); if (r.ok) { toast.success("Added to the job"); onClose(); } else setError(r.error); })}>Add</Button></>}>
      {jobs.length === 0 ? <p className="text-base text-text-muted">They&apos;re already on every job you can add to.</p> : <Field label="Job" error={error ?? undefined}><Select value={job} onValueChange={setJob} options={jobs.map((j) => ({ value: j.id, label: j.title }))} /></Field>}
    </Modal>
  );
}

export { Banner };
