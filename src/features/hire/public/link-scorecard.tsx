"use client";
import * as React from "react";
import { CheckCircle2 } from "lucide-react";
import { Card } from "@/ui/card";
import { submitScorecardLinkAction } from "@/app/p/actions";
import { ScorecardForm, type CardSpec } from "../scorecard-form";

/** S142 by emailed link: the interviewer rates the candidate without signing in. */
export function LinkScorecard({ token, candidate, job, interviewer, card }: { token: string; candidate: string; job: string; interviewer: string; card: CardSpec }) {
  const [sent, setSent] = React.useState(false);
  if (sent) return <Card className="flex flex-col items-center gap-2 p-8 text-center" role="status"><CheckCircle2 aria-hidden className="size-10 text-success-text" /><p className="text-lg font-semibold">Thanks, your feedback was sent</p></Card>;
  return (
    <Card className="p-6">
      <p className="text-sm text-text-muted">Feedback from {interviewer}</p>
      <h1 className="mt-1 text-2xl font-semibold">{candidate}</h1>
      <p className="mb-6 text-base text-text-muted">{job} · {card.name}</p>
      <ScorecardForm card={card} onSubmit={async (v) => { const r = await submitScorecardLinkAction(token, v); if (r.ok) setSent(true); return r; }} />
    </Card>
  );
}
