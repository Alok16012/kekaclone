import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { load } from "@/server/page-data";
import { AppError } from "@/server/db";
import { jobAccess } from "@/server/modules/hire/access";
import { getJob, jobFormData } from "@/server/modules/hire/jobs";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { JobWizard } from "@/features/hire/job-wizard";
import { HireHeader, hireTabs } from "../../../header";

export const metadata: Metadata = { title: "Edit job" };

export default async function EditJobPage(props: PageProps<"/hire/jobs/[id]/edit">) {
  const { id } = await props.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const d = await load(async (tx, actor) => {
    const tabs = await hireTabs(tx, actor);
    try {
      const a = await jobAccess(tx, actor, id);
      if (!a.see) return null;
      const [job, data] = await Promise.all([getJob(tx, actor, id), jobFormData(tx)]);
      return { tabs, job, data, act: a.act };
    } catch (e) { if (e instanceof AppError && e.code === "not_found") return null; throw e; }
  });
  if (!d) notFound();
  return (
    <>
      <HireHeader tabs={d.tabs} title={`Edit ${d.job.title}`} breadcrumb={<Link href={`/hire/jobs/${id}`} className="hover:underline">← Back to the pipeline</Link>} />
      {!d.act ? <Card><EmptyState title="You can view this job but not edit it" description="Only the job's recruiters, hiring managers and coordinators can change it." /></Card>
        : d.job.status === "closed" ? <Card><EmptyState title="This job is closed" description="Reopen it from the pipeline to make changes." /></Card>
        : <JobWizard data={d.data} job={{ ...d.job, team: d.job.team.map((t) => ({ employee_id: t.employee_id, role: t.role })) }} />}
    </>
  );
}
