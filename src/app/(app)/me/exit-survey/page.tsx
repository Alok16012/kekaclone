import type { Metadata } from "next";
import Link from "next/link";
import { ClipboardList } from "lucide-react";
import { load } from "@/server/page-data";
import { myExitSurvey } from "@/server/modules/exits/survey";
import { PageHeader } from "@/ui/app-shell";
import { Card } from "@/ui/card";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/feedback";
import { ExitSurveyTake } from "@/features/exits/exit-survey-take";

export const metadata: Metadata = { title: "Exit survey" };

export default async function MyExitSurveyPage() {
  const d = await load((tx, actor) => myExitSurvey(tx, actor));
  return (
    <div className="mx-auto w-full max-w-2xl">
      <PageHeader title="Exit survey" description="A few questions about your time here. HR reads every answer; nothing is anonymous, and nothing you say changes your settlement." />
      {!d ? (
        <Card><EmptyState icon={<ClipboardList />} title="No exit survey for you right now" description="It's sent when an exit starts." action={<Button asChild variant="secondary"><Link href="/me">Back to my profile</Link></Button>} /></Card>
      ) : <ExitSurveyTake survey={d} />}
    </div>
  );
}
