"use client";
import * as React from "react";
import { Button } from "@/ui/button";
import { Field, Textarea } from "@/ui/field";
import { Banner } from "@/ui/feedback";
import { cn } from "@/lib/cn";
import { RECOMMENDATIONS } from "@/server/modules/hire/rules";

export type CardSpec = { name: string; sections: { title: string; criteria: { id: string; label: string }[] }[]; points: { value: number; label: string }[]; overall_rating: boolean };
export type ScoreInput = { ratings: Record<string, number>; overall: number | null; recommendation: string | null; comments: string | null };

/** One row of rating buttons (a radio group): every point shows its number and label. */
function Scale({ name, points, value, onChange }: { name: string; points: CardSpec["points"]; value: number | undefined; onChange: (v: number) => void }) {
  return (
    <div role="radiogroup" aria-label={name} className="flex flex-wrap gap-1.5">
      {points.map((p) => (
        <button key={p.value} type="button" role="radio" aria-checked={value === p.value} onClick={() => onChange(p.value)}
          className={cn("flex min-w-16 flex-col items-center rounded-md border px-2 py-1.5 text-sm transition-colors",
            value === p.value ? "border-accent bg-accent-soft font-semibold text-accent-text" : "border-border bg-surface text-text-muted hover:border-border-strong hover:text-text")}>
          <span className="tabular">{p.value}</span><span className="text-xs">{p.label}</span>
        </button>
      ))}
    </div>
  );
}

/** S142: rate every criterion, give a recommendation and comments. Used in the app and on the emailed link. */
export function ScorecardForm({ card, onSubmit, submitLabel = "Send feedback" }: { card: CardSpec; onSubmit: (v: ScoreInput) => Promise<{ ok: boolean; error?: string }>; submitLabel?: string }) {
  const [ratings, setRatings] = React.useState<Record<string, number>>({});
  const [overall, setOverall] = React.useState<number | null>(null);
  const [rec, setRec] = React.useState<string | null>(null);
  const [comments, setComments] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, start] = React.useTransition();
  const total = card.sections.reduce((n, s) => n + s.criteria.length, 0);
  const done = Object.keys(ratings).length;
  return (
    <form className="flex flex-col gap-6" onSubmit={(e) => { e.preventDefault(); start(async () => {
      setError(null);
      const r = await onSubmit({ ratings, overall, recommendation: rec, comments: comments.trim() || null });
      if (!r.ok) setError(r.error ?? "Couldn't send your feedback.");
    }); }}>
      {card.sections.map((s) => (
        <fieldset key={s.title} className="flex flex-col gap-4">
          <legend className="mb-2 text-md font-semibold">{s.title}</legend>
          {s.criteria.map((c) => (
            <div key={c.id} className="flex flex-col gap-1.5">
              <span className="text-base font-medium">{c.label}</span>
              <Scale name={c.label} points={card.points} value={ratings[c.id]} onChange={(v) => setRatings((r) => ({ ...r, [c.id]: v }))} />
            </div>
          ))}
        </fieldset>
      ))}
      {card.overall_rating && (
        <div className="flex flex-col gap-1.5"><span className="text-base font-medium">Overall rating</span><Scale name="Overall rating" points={card.points} value={overall ?? undefined} onChange={setOverall} /></div>
      )}
      <div className="flex flex-col gap-1.5">
        <span className="text-base font-medium">Your recommendation</span>
        <div role="radiogroup" aria-label="Your recommendation" className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          {RECOMMENDATIONS.map((r) => (
            <button key={r.value} type="button" role="radio" aria-checked={rec === r.value} onClick={() => setRec(r.value)}
              className={cn("rounded-md border px-3 py-2 text-sm font-medium", rec === r.value ? (r.value.endsWith("no") ? "border-danger bg-danger-soft text-danger-text" : "border-success bg-success-soft text-success-text") : "border-border text-text-muted hover:text-text")}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <Field label="Comments" help="Shared with the hiring team, never with the candidate."><Textarea value={comments} onChange={(e) => setComments(e.target.value)} maxLength={4000} rows={4} /></Field>
      {error && <Banner tone="danger">{error}</Banner>}
      <div className="flex items-center gap-3">
        <Button type="submit" loading={busy}>{submitLabel}</Button>
        <span className="text-sm text-text-muted tabular">{done} of {total} rated</span>
      </div>
    </form>
  );
}
