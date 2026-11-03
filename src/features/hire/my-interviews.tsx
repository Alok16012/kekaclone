"use client";
import * as React from "react";
import Link from "next/link";
import { CalendarClock, CalendarPlus, CheckCircle2, MessageSquarePlus } from "lucide-react";
import { Card } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Modal } from "@/ui/overlay";
import { EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import type { myInterviews } from "@/server/modules/hire/interviews";
import { scorecardFormAction, submitScorecardAction } from "@/app/(app)/hire/actions";
import { ScorecardForm, type CardSpec } from "./scorecard-form";
import { when } from "./shared";

type Row = Awaited<ReturnType<typeof myInterviews>>[number];
const MODE: Record<string, string> = { online: "Video call", in_person: "In person", phone: "Phone call" };

/** Panelist's view: what's coming up, what's waiting for the candidate to pick a time, and feedback still owed. */
export function MyInterviews({ rows }: { rows: Row[] }) {
  const [scoring, setScoring] = React.useState<{ row: Row; card: CardSpec } | null>(null);
  const [, start] = React.useTransition();
  const [now] = React.useState(() => Date.now());
  const owed = rows.filter((r) => !r.submitted && r.status !== "awaiting_candidate" && r.starts_at && new Date(r.starts_at).getTime() < now);
  const upcoming = rows.filter((r) => !owed.includes(r) && (r.status === "awaiting_candidate" || (r.starts_at && new Date(r.starts_at).getTime() >= now)));
  const open = (row: Row) => start(async () => {
    const r = await scorecardFormAction(row.id);
    if (!r.ok) { toast.error(r.error); return; }
    setScoring({ row, card: r.data!.scorecard });
  });
  const item = (r: Row, feedback: boolean) => (
    <li key={r.id} className="flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <Link href={`/hire/candidates/${r.candidate_id}?tab=interviews`} className="font-medium hover:underline">{r.candidate}</Link>
        <p className="text-sm text-text-muted">{r.title ?? "Interview"} · {r.job} · {MODE[r.mode]}</p>
        <p className="text-sm">{r.status === "awaiting_candidate" ? "Waiting for the candidate to pick a time" : when(r.starts_at)}{r.location ? ` · ${r.location}` : ""}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {r.meeting_url && r.status === "scheduled" && <Button asChild size="sm" variant="secondary"><a href={r.meeting_url} target="_blank" rel="noopener noreferrer">Join<span className="sr-only"> (opens in a new tab)</span></a></Button>}
        {r.starts_at && r.status === "scheduled" && <Button asChild size="sm" variant="ghost"><a href={`/hire/interviews/${r.id}/ics`}><CalendarPlus />Calendar</a></Button>}
        {r.submitted ? <Badge tone="success"><CheckCircle2 aria-hidden />Feedback sent</Badge> : feedback || r.status === "scheduled" ? <Button size="sm" variant={feedback ? "primary" : "secondary"} onClick={() => open(r)}><MessageSquarePlus />Give feedback</Button> : null}
      </div>
    </li>
  );
  if (!rows.length) return <Card><EmptyState icon={<CalendarClock />} title="No interviews" description="When a recruiter puts you on an interview panel, it shows up here." /></Card>;
  return (
    <div className="flex flex-col gap-5">
      {owed.length > 0 && <Card><h2 className="px-5 pt-4 text-md font-semibold">Feedback to send ({owed.length})</h2><ul className="mt-2 divide-y divide-border border-t border-border">{owed.map((r) => item(r, true))}</ul></Card>}
      <Card><h2 className="px-5 pt-4 text-md font-semibold">Coming up</h2>{upcoming.length ? <ul className="mt-2 divide-y divide-border border-t border-border">{upcoming.map((r) => item(r, false))}</ul> : <EmptyState compact title="Nothing scheduled" />}</Card>
      {scoring && (
        <Modal open onOpenChange={(o) => !o && setScoring(null)} size="lg" title={`Feedback on ${scoring.row.candidate}`} description={`${scoring.row.job} · ${scoring.card.name}`}>
          <ScorecardForm card={scoring.card} onSubmit={async (v) => { const r = await submitScorecardAction(scoring.row.id, v); if (r.ok) { toast.success("Feedback sent"); setScoring(null); } return r; }} />
        </Modal>
      )}
    </div>
  );
}
