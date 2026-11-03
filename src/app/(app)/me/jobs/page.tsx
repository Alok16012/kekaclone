import type { Metadata } from "next";
import Link from "next/link";
import { load } from "@/server/page-data";
import { internalJobs } from "@/server/modules/hire/internal";
import { hasHireAccess } from "@/server/modules/hire/access";
import { PageHeader } from "@/ui/app-shell";
import { Button } from "@/ui/button";
import { MeJobs } from "@/features/hire/me-jobs";

export const metadata: Metadata = { title: "Jobs & referrals" };

export default async function MeJobsPage(props: PageProps<"/me/jobs">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => ({ ...(await internalJobs(tx, actor)), hiring: await hasHireAccess(tx, actor) }));
  return (
    <>
      <PageHeader title="Jobs & referrals" description="Open roles you can apply for, or refer someone you know."
        actions={d.hiring ? <Button asChild variant="secondary"><Link href="/hire/jobs">Hiring workspace</Link></Button> : undefined} />
      <MeJobs jobs={d.jobs} referrals={d.referrals} mine={d.mine} initialTab={sp.tab === "referrals" ? "referrals" : "jobs"} />
    </>
  );
}
