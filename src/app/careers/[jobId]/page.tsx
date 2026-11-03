import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { withTenant } from "@/server/db";
import { careersJob } from "@/server/modules/hire/public";
import { Card } from "@/ui/card";
import { EmptyState, Skeleton } from "@/ui/feedback";
import { Html, inr0 } from "@/features/hire/shared";
import { ApplyForm } from "@/features/hire/public/apply-form";
import { publicTenant } from "../tenant";

export const metadata: Metadata = { title: "Job" };

async function Body({ params }: { params: PageProps<"/careers/[jobId]">["params"] }) {
  const { jobId } = await params;
  const t = await publicTenant();
  const d = t ? await withTenant(t.id, (tx) => careersJob(tx, jobId)) : null;
  if (!d) return <Card><EmptyState title="This job isn't open any more" description="It may have been filled or closed." action={<Link href="/careers" className="text-accent-text hover:underline">See all open roles</Link>} /></Card>;
  const j = d.job;
  return (
    <>
      <Link href="/careers" className="text-sm text-text-muted hover:underline">← All roles at {d.company}</Link>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">{j.title}</h1>
      <p className="mt-2 text-base text-text-muted">{[j.department, j.location, d.typeLabel, j.experience_min != null ? `${j.experience_min}${j.experience_max != null ? `–${j.experience_max}` : "+"} years` : null].filter(Boolean).join(" · ")}</p>
      {j.salary_min_paise != null && <p className="mt-1 text-base">{inr0(j.salary_min_paise)}{j.salary_max_paise != null ? ` – ${inr0(j.salary_max_paise)}` : "+"} a year</p>}
      <Card className="mt-6 p-5"><Html html={j.description_html} /></Card>
      <Card className="mt-6 p-5">
        <h2 className="mb-4 text-lg font-semibold">Apply</h2>
        <ApplyForm jobId={j.id} company={d.company} />
      </Card>
    </>
  );
}

export default function CareersJobPage(props: PageProps<"/careers/[jobId]">) {
  return <Suspense fallback={<div className="flex flex-col gap-4"><Skeleton className="h-10 w-2/3" /><Skeleton className="h-64" /></div>}><Body params={props.params} /></Suspense>;
}
