"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Save, Send } from "lucide-react";
import { REVIEWER_LABEL, SECTION_LABEL, formScore, missingAnswers, type Answers, type ReviewerType, type ScalePoint, type Section } from "@/server/modules/performance/rules";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Button } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { ConfirmDialog } from "@/ui/overlay";
import { Textarea } from "@/ui/field";
import { Banner } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { cn } from "@/lib/cn";
import { declineReviewAction, saveReviewDraftAction, submitReviewAction } from "@/app/(app)/me/performance/actions";
import { fmtDate, ReviewStatusBadge } from "./bits";

type D = {
  id: string; cycle: { id: string; name: string; status: string; periodStart: string; periodEnd: string }; reviewee: { id: string; name: string }; reviewer: string;
  type: ReviewerType; status: "not_started" | "draft" | "submitted" | "declined"; rating: number | null; answers: Answers; selfAnswers: Answers | null; sections: Section[]; points: ScalePoint[]; canEdit: boolean;
};

/** Fill (or read) one review: every section with ratings on the cycle's scale and comments. Saves drafts; submit checks everything is answered. */
export function ReviewForm({ d }: { d: D }) {
  const router = useRouter();
  const [answers, setAnswers] = React.useState<Answers>(d.answers ?? {});
  const [busy, setBusy] = React.useState<"draft" | "submit" | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const missing = missingAnswers(d.sections, answers);
  const score = formScore(d.sections, answers);
  const set = (k: string, v: Partial<{ rating: number | null; comment: string | null }>) => setAnswers((a) => ({ ...a, [k]: { ...a[k], ...v } }));
  const title = d.type === "self" ? "Self review" : `${REVIEWER_LABEL[d.type]} review of ${d.reviewee.name}`;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" asChild><Link href="/me/performance/reviews"><ArrowLeft />All reviews</Link></Button>
        <h2 className="text-lg font-semibold">{title}</h2>
        <ReviewStatusBadge status={d.status} />
        <span className="text-sm text-text-muted">{d.cycle.name} · {fmtDate(d.cycle.periodStart)} – {fmtDate(d.cycle.periodEnd)}</span>
      </div>
      {!d.canEdit && d.status !== "submitted" && <Banner tone="info" title="Read only">This cycle is no longer taking reviews.</Banner>}
      {!d.canEdit && d.status === "submitted" && <Banner tone="success" title={`Submitted by ${d.reviewer}`}>{d.rating != null ? `Overall score ${d.rating}.` : null}</Banner>}
      {d.canEdit && d.type === "peer" && <Banner tone="info">Your name isn&apos;t shown to {d.reviewee.name} with this review. Their manager and HR can see who wrote it.</Banner>}
      <Scale points={d.points} />
      {d.sections.map((s) => (
        <Card key={s.id}>
          <CardHeader title={s.title} description={`${SECTION_LABEL[s.type]}${s.weight ? ` · ${s.weight}% of the score` : ""}`} />
          <CardBody className="flex flex-col gap-5">
            {!s.items.length && <p className="text-sm text-text-muted">{s.type === "goals" ? "No goals in this review period." : "Nothing to rate here."}</p>}
            {s.items.map((i) => {
              const k = `${s.id}:${i.id}`;
              const a = answers[k] ?? {};
              const self = d.selfAnswers?.[k];
              return (
                <fieldset key={k} className="flex flex-col gap-2 border-t border-border pt-4 first:border-0 first:pt-0">
                  <legend className="mb-2 text-base font-medium">{i.text}{(i.rated || i.required) && d.canEdit && <span aria-hidden className="ml-0.5 text-danger">*</span>}</legend>
                  {i.rated && (
                    <div role="radiogroup" aria-label={`Rating for ${i.text}`} className="flex flex-wrap gap-1.5">
                      {d.points.map((p) => {
                        const on = a.rating === p.value;
                        return (
                          <button key={p.value} type="button" role="radio" aria-checked={on} disabled={!d.canEdit} onClick={() => set(k, { rating: on ? null : p.value })}
                            className={cn("min-h-9 rounded-md border px-3 text-sm transition-colors", on ? "border-accent bg-accent text-on-accent" : "border-border-strong bg-surface hover:bg-surface-hover", !d.canEdit && "cursor-default")}>
                            <span className="font-semibold tabular">{p.value}</span> <span className={cn("hidden sm:inline", !on && "text-text-muted")}>{p.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {d.canEdit ? <Textarea aria-label={`Comment on ${i.text}`} placeholder={i.rated ? "Comment (optional): examples help" : "Your answer"} rows={i.rated ? 2 : 4} maxLength={4000}
                      value={a.comment ?? ""} onChange={(e) => set(k, { comment: e.target.value })} />
                    : a.comment ? <p className="whitespace-pre-line rounded-md bg-surface-sunken px-3 py-2 text-base">{a.comment}</p> : null}
                  {self && (self.rating != null || self.comment) && (
                    <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-text-muted"><span className="font-medium">Their self review:</span> {self.rating != null ? `rated ${self.rating}` : ""}{self.rating != null && self.comment ? " · " : ""}{self.comment}</p>
                  )}
                </fieldset>
              );
            })}
          </CardBody>
        </Card>
      ))}
      {d.canEdit && (
        <div className="sticky bottom-16 z-10 flex flex-col gap-2 rounded-lg border border-border bg-surface p-3 shadow-pop sm:flex-row sm:items-center lg:bottom-4">
          <p className="flex-1 text-sm text-text-muted" role="status">{missing.length ? `${missing.length} item${missing.length === 1 ? "" : "s"} still to answer` : "Everything is answered"}{score != null ? ` · score so far ${score}` : ""}</p>
          {err && <p role="alert" className="text-sm text-danger-text">{err}</p>}
          <div className="flex flex-wrap gap-2">
            {d.type === "peer" && <ConfirmDialog trigger={<Button variant="ghost">Decline</Button>} title="Decline this review?" description="Do this if you haven't worked with them enough to say. Their manager will see you declined." confirmLabel="Decline"
              onConfirm={async () => { const r = await declineReviewAction(d.id); if (r.ok) { toast.success("Declined"); router.push("/me/performance/reviews"); } else toast.error(r.error); }} />}
            <Button variant="secondary" loading={busy === "draft"} onClick={async () => { setBusy("draft"); setErr(null); const r = await saveReviewDraftAction(d.id, answers); setBusy(null); if (r.ok) toast.success("Draft saved"); else setErr(r.error); }}><Save />Save draft</Button>
            <ConfirmDialog trigger={<Button disabled={missing.length > 0}><Send />Submit</Button>} tone="primary" title="Submit this review?" description="You can't change it after submitting." confirmLabel="Submit"
              onConfirm={async () => { setBusy("submit"); setErr(null); const r = await submitReviewAction(d.id, answers); setBusy(null); if (r.ok) { toast.success("Review submitted"); router.push("/me/performance/reviews"); } else setErr(r.error); }} />
          </div>
        </div>
      )}
    </div>
  );
}

function Scale({ points }: { points: ScalePoint[] }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
      <span>Rating scale:</span>
      {points.map((p) => <Badge key={p.value} tone="neutral"><span className="tabular font-semibold">{p.value}</span> {p.label}</Badge>)}
    </div>
  );
}
