import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { load } from "@/server/page-data";
import { canRecruit } from "@/server/modules/hire/access";
import { jobStats, listJobs } from "@/server/modules/hire/jobs";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { JobsList } from "@/features/hire/jobs-list";
import { HireHeader, hireTabs } from "../header";

export const metadata: Metadata = { title: "Hiring" };

export default async function JobsPage() {
  const d = await load(async (tx, actor) => {
    const tabs = await hireTabs(tx, actor);
    if (!tabs.jobs) return { tabs, jobs: [], canCreate: false, stats: null };
    const [jobs, stats] = await Promise.all([listJobs(tx, actor), jobStats(tx, actor)]);
    return { tabs, jobs, canCreate: canRecruit(actor), stats };
  });
  if (!d.tabs.jobs) {
    return (
      <>
        <HireHeader tabs={d.tabs} title="Hiring" description="Jobs, candidates, interviews and offers." />
        <Card>
          <EmptyState title="You're not on any hiring team yet" description="When a recruiter adds you to a job's hiring team or interview panel, it shows up here. You can see open roles and refer people under Jobs & referrals."
            action={<Button asChild variant="secondary"><Link href="/me/jobs">See open roles</Link></Button>} />
        </Card>
      </>
    );
  }
  return (
    <>
      <HireHeader tabs={d.tabs} title="Hiring" description="Jobs, candidates, interviews and offers."
        actions={d.canCreate ? <Button asChild><Link href="/hire/jobs/new"><Plus />Create job</Link></Button> : undefined} />
      <JobsList jobs={d.jobs} stats={d.stats!} canCreate={d.canCreate} />
    </>
  );
}
