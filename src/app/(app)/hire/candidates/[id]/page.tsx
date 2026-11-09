import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { load } from "@/server/page-data";
import { AppError } from "@/server/db";
import { candidateProfile } from "@/server/modules/hire/candidates";
import { visibleJobIds } from "@/server/modules/hire/access";
import { CandidateProfile } from "@/features/hire/candidate-profile";
import { applicationScore, assistantState } from "@/server/modules/hire/assist";
import { erasureBlockerFor } from "@/server/modules/hire/privacy";
import { CandidateScores, EraseCandidateButton, type AppScore } from "@/features/hire/assist";
import { HireHeader, hireTabs } from "../../header";

export const metadata: Metadata = { title: "Candidate" };

export default async function CandidatePage(props: PageProps<"/hire/candidates/[id]">) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const d = await load(async (tx, actor) => {
    try {
      const [p, tabs, ids] = await Promise.all([candidateProfile(tx, actor, id), hireTabs(tx, actor), visibleJobIds(tx, actor)]);
      const [people, designations, templates, openJobs] = await Promise.all([
        tx<{ id: string; name: string; title: string | null }[]>`select e.id, e.display_name as name, d.title from employees e left join designations d on d.id = e.designation_id where e.status <> 'relieved' and e.id is distinct from ${p.candidate.employee_id} order by e.display_name`,
        tx<{ id: string; name: string }[]>`select id, title as name from designations order by title`,
        tx<{ id: string; name: string }[]>`select id, name from letter_templates where kind = 'offer' order by name`,
        tx<{ id: string; title: string }[]>`select id, title from jobs where status in ('open','on_hold','draft') and (${ids === null} or id = any(${ids ?? []}::uuid[])) order by title`,
      ]);
      const [assistant, [flags]] = await Promise.all([assistantState(tx), tx<{ anonymised: boolean }[]>`select anonymised_at is not null as anonymised from candidates where id = ${id}`]);
      const scores: AppScore[] = [];
      for (const a of p.apps) {
        const s = await applicationScore(tx, actor, a.id);
        scores.push({ applicationId: a.id, job: a.job, canAct: p.actable.includes(a.id) && a.status === "active", score: s && { ...s, created_at: s.created_at.toISOString() } });
      }
      const erase = p.canAdmin && !flags.anonymised && p.candidate.employee_id !== actor.employeeId ? { blocker: await erasureBlockerFor(tx, id) } : null;
      return { p, tabs, people, designations, templates, openJobs, me: actor.employeeId, assistant, scores, erase, anonymised: flags.anonymised };
    } catch (e) { if (e instanceof AppError && e.code === "not_found") return null; throw e; }
  });
  if (!d) notFound();
  const c = d.p.candidate;
  return (
    <>
      <HireHeader tabs={d.tabs} title={[c.first_name, c.last_name].filter(Boolean).join(" ")} description={[c.current_title, c.current_company].filter(Boolean).join(" at ") || c.email}
        breadcrumb={<Link href="/hire/candidates" className="hover:underline">← Candidates</Link>}
        actions={d.erase && <EraseCandidateButton candidateId={c.id} name={[c.first_name, c.last_name].filter(Boolean).join(" ")} blocker={d.erase.blocker} />} />
      <CandidateProfile data={d.p} people={d.people} designations={d.designations} templates={d.templates} openJobs={d.openJobs} me={d.me}
        initialApp={typeof sp.app === "string" ? sp.app : null} initialTab={typeof sp.tab === "string" ? sp.tab : "overview"} />
      <CandidateScores items={d.scores} assistant={d.assistant} anonymised={d.anonymised} />
    </>
  );
}
