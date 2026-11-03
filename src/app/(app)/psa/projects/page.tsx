import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { listClients, listProjects, people } from "@/server/modules/psa/service";
import { canAdminPsa, canBill } from "@/server/modules/psa/access";
import { PsaDesk } from "@/features/psa/desk";
import { Projects, type ProjectCard } from "@/features/psa/projects";

export const metadata: Metadata = { title: "Projects" };

export default async function ProjectsPage(props: PageProps<"/psa/projects">) {
  const sp = await props.searchParams;
  const showArchived = sp.archived === "1";
  const d = await load(async (tx, actor) => {
    const admin = canAdminPsa(actor);
    const [projects, clients, ppl] = await Promise.all([listProjects(tx, actor, showArchived), admin ? listClients(tx, actor) : Promise.resolve([]), admin ? people(tx) : Promise.resolve([])]);
    return {
      access: { admin, billing: canBill(actor), approver: projects.some((p) => p.approver) },
      projects: projects.map((p): ProjectCard => ({ ...p, retainer_paise: p.retainer_paise == null ? null : Number(p.retainer_paise) })),
      clients: clients.map((c) => ({ id: c.id, name: c.name })), people: ppl,
    };
  });
  return (
    <>
      <PsaDesk access={d.access} title="Projects" description="Client and internal projects, the people on them, and what's been logged." />
      <Projects projects={d.projects} clients={d.clients} people={d.people} canEdit={d.access.admin} showArchived={showArchived} />
    </>
  );
}
