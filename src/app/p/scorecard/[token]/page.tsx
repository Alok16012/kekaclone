import type { Metadata } from "next";
import { Suspense } from "react";
import { withTenant } from "@/server/db";
import { scorecardByToken } from "@/server/modules/hire/interviews";
import { Card } from "@/ui/card";
import { EmptyState, Skeleton } from "@/ui/feedback";
import { LinkScorecard } from "@/features/hire/public/link-scorecard";
import { publicTenant } from "@/app/careers/tenant";

export const metadata: Metadata = { title: "Interview feedback" };

async function Body({ params }: { params: PageProps<"/p/scorecard/[token]">["params"] }) {
  const { token } = await params;
  const t = await publicTenant();
  const f = t ? await withTenant(t.id, (tx) => scorecardByToken(tx, token)) : null;
  if (!f) return <Card><EmptyState title="This feedback link doesn't work any more" description="It may have expired or been used. Open Hiring → My interviews in erp instead." /></Card>;
  if (f.submitted) return <Card><EmptyState title="Feedback already sent" description="Thanks! You can see it on the candidate's profile in erp." /></Card>;
  return <LinkScorecard token={token} candidate={f.candidate} job={f.job} interviewer={f.interviewer} card={f.scorecard} />;
}

export default function ScorecardLinkPage(props: PageProps<"/p/scorecard/[token]">) {
  return <Suspense fallback={<Skeleton className="h-96" />}><Body params={props.params} /></Suspense>;
}
