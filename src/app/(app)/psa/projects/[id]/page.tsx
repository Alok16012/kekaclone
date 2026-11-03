import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { load } from "@/server/page-data";
import { listClients, people, projectDetail } from "@/server/modules/psa/service";
import { canBill } from "@/server/modules/psa/access";
import { PsaDesk } from "@/features/psa/desk";
import { ProjectDetail, type Detail } from "@/features/psa/project-detail";

export const metadata: Metadata = { title: "Project" };

export default async function ProjectPage(props: PageProps<"/psa/projects/[id]">) {
  const { id } = await props.params;
  if (!z.uuid().safeParse(id).success) notFound();
  const d = await load(async (tx, actor) => {
    const det = await projectDetail(tx, actor, id);
    if (!det) return null;
    const [clients, ppl] = await Promise.all([det.canEdit ? listClients(tx, actor) : Promise.resolve([]), det.canEdit ? people(tx) : Promise.resolve([])]);
    const n = (v: bigint | number | null) => (v == null ? null : Number(v));
    const detail: Detail = {
      project: { ...det.project, retainer_paise: n(det.project.retainer_paise), invoiced_paise: Number(det.project.invoiced_paise) },
      members: det.members.map((m) => ({ ...m, bill_rate_paise: n(m.bill_rate_paise) })),
      tasks: det.tasks,
      milestones: det.milestones.map((m) => ({ ...m, amount_paise: Number(m.amount_paise) })),
      canEdit: det.canEdit, canBill: det.canBill,
    };
    return { detail, clients: clients.map((c) => ({ id: c.id, name: c.name })), people: ppl, access: { admin: det.canEdit, billing: canBill(actor), approver: det.project.approver } };
  });
  if (!d) notFound();
  return (
    <>
      <PsaDesk access={d.access} title={d.detail.project.name} description={d.detail.project.client ? `For ${d.detail.project.client}` : "Internal project"} />
      <ProjectDetail d={d.detail} clients={d.clients} people={d.people} />
    </>
  );
}
