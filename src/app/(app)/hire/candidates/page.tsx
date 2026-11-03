import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { canRecruit } from "@/server/modules/hire/access";
import { listCandidates } from "@/server/modules/hire/candidates";
import { candidateFields } from "@/server/modules/hire/setup";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { CandidatesDb } from "@/features/hire/candidates-db";
import { HireHeader, hireTabs } from "../header";

export const metadata: Metadata = { title: "Candidates" };

export default async function CandidatesPage(props: PageProps<"/hire/candidates">) {
  const sp = await props.searchParams;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 100) : "";
  const tag = typeof sp.tag === "string" ? sp.tag.slice(0, 40) : "";
  const source = typeof sp.source === "string" ? sp.source.slice(0, 30) : "";
  const d = await load(async (tx, actor) => {
    const tabs = await hireTabs(tx, actor);
    if (!tabs.candidates) return { tabs, list: null, fields: [], canAdd: false };
    const [list, fields] = await Promise.all([listCandidates(tx, actor, { q, tag: tag || undefined, source: source || undefined }), candidateFields(tx)]);
    return { tabs, list, fields, canAdd: canRecruit(actor) };
  });
  return (
    <>
      <HireHeader tabs={d.tabs} title="Candidates" description="Everyone who has applied or been added, across jobs." />
      {!d.list ? <Card><EmptyState title="You're not on any hiring team" description="Candidates show up here for the jobs you help hire for." /></Card>
        : <CandidatesDb rows={d.list.rows} tags={d.list.tags} q={q} tag={tag} source={source} canAdd={d.canAdd} fields={d.fields} />}
    </>
  );
}
