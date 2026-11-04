import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { load } from "@/server/page-data";
import { AppError } from "@/server/db";
import { pipeline } from "@/server/modules/hire/jobs";
import { candidateFields } from "@/server/modules/hire/setup";
import { Pipeline } from "@/features/hire/pipeline";
import { assistantState, jobScores } from "@/server/modules/hire/assist";
import { JobScores } from "@/features/hire/assist";
import { HireHeader, hireTabs } from "../../header";

export const metadata: Metadata = { title: "Job pipeline" };

export default async function JobPipelinePage(props: PageProps<"/hire/jobs/[id]">) {
  const { id } = await props.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const d = await load(async (tx, actor) => {
    try {
      const [p, tabs, fields] = await Promise.all([pipeline(tx, actor, id), hireTabs(tx, actor), candidateFields(tx)]);
      const [scores, assistant] = await Promise.all([jobScores(tx, actor, id), assistantState(tx)]);
      return { p, tabs, fields, scores, assistant };
    } catch (e) { if (e instanceof AppError && e.code === "not_found") return null; throw e; }
  });
  if (!d) notFound();
  const { job, stages, cards, access } = d.p;
  return (
    <>
      <HireHeader tabs={d.tabs} title={job.title} breadcrumb={<Link href="/hire/jobs" className="hover:underline">← All jobs</Link>} />
      <Pipeline key={job.id} job={job} stages={stages} cards={cards} canAct={access.act && job.status !== "closed"} fields={d.fields} />
      <JobScores jobId={job.id} rows={d.scores.rows} unscored={d.scores.unscored} canAct={access.act && job.status !== "closed"} assistant={d.assistant} />
    </>
  );
}
