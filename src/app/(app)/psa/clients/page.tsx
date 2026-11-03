import type { Metadata } from "next";
import { Lock } from "lucide-react";
import { load } from "@/server/page-data";
import { listClients, listProjects } from "@/server/modules/psa/service";
import { canAdminPsa, canBill, canSeePsa } from "@/server/modules/psa/access";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { PsaDesk } from "@/features/psa/desk";
import { Clients } from "@/features/psa/clients";

export const metadata: Metadata = { title: "Clients" };

export default async function ClientsPage() {
  const d = await load(async (tx, actor) => {
    const access = { admin: canAdminPsa(actor), billing: canBill(actor), approver: (await listProjects(tx, actor)).some((p) => p.approver) };
    return { access, clients: canSeePsa(actor) ? await listClients(tx, actor) : null };
  });
  return (
    <>
      <PsaDesk access={d.access} title="Clients" description="The companies you do project work for." />
      {d.clients ? <Clients clients={d.clients} canEdit={d.access.admin} /> : <Card><EmptyState icon={<Lock />} title="Clients are for project admins and billing" description="Ask an admin for the project or billing role if you need this." /></Card>}
    </>
  );
}
