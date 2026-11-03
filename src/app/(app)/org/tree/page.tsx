import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { departmentsTree, orgChain, orgChildren } from "@/server/modules/corehr/people";
import { PageHeader } from "@/ui/app-shell";
import { OrgChart } from "@/features/corehr/org-chart";

export const metadata: Metadata = { title: "Org chart" };

export default async function OrgTreePage(props: PageProps<"/org/tree">) {
  const { from } = await props.searchParams;
  const d = await load(async (tx, actor) => {
    const [roots, chain, departments] = await Promise.all([orgChildren(tx, null), orgChain(tx, actor.employeeId), departmentsTree(tx)]);
    // the teams along "my" chain are loaded up front so "From me" opens instantly
    const preloaded: Record<string, Awaited<ReturnType<typeof orgChildren>>> = {};
    for (const c of chain) if (c.id !== actor.employeeId) preloaded[c.id] = await orgChildren(tx, c.id);
    return { roots, chain, departments, preloaded, meId: actor.employeeId };
  });
  const mode = from === "me" ? "me" : from === "departments" ? "departments" : "top";
  return (
    <>
      <PageHeader title="Org chart" breadcrumb="People" description="Who reports to whom. Open a branch to see the team under someone." />
      <OrgChart roots={d.roots} chain={d.chain} preloaded={d.preloaded} departments={d.departments} meId={d.meId} initialMode={mode} />
    </>
  );
}
