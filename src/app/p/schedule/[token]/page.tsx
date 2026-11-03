import type { Metadata } from "next";
import { Suspense } from "react";
import { withTenant } from "@/server/db";
import { selfScheduleView } from "@/server/modules/hire/interviews";
import { Card } from "@/ui/card";
import { EmptyState, Skeleton } from "@/ui/feedback";
import { SelfSchedule } from "@/features/hire/public/self-schedule";
import { publicTenant } from "@/app/careers/tenant";

export const metadata: Metadata = { title: "Pick an interview time" };

async function Body({ params }: { params: PageProps<"/p/schedule/[token]">["params"] }) {
  const { token } = await params;
  const t = await publicTenant();
  const v = t ? await withTenant(t.id, (tx) => selfScheduleView(tx, token)) : null;
  if (!v) return <Card><EmptyState title="This link doesn't work any more" description="It may have expired or the interview was changed. Reply to the email you got and the team will help." /></Card>;
  return <SelfSchedule token={token} view={{ firstName: v.first_name, job: v.job, company: v.company, mode: v.modeLabel, title: v.title, picked: v.picked, status: v.status, slots: v.slots.map((s) => ({ index: s.index, label: s.label, past: s.past })) }} />;
}

export default function SchedulePage(props: PageProps<"/p/schedule/[token]">) {
  return <Suspense fallback={<Skeleton className="h-64" />}><Body params={props.params} /></Suspense>;
}
