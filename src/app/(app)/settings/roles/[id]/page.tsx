import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { load } from "@/server/page-data";
import { can } from "@/server/auth/permissions";
import { listRoles, roleMembers } from "@/server/modules/settings/roles";
import { RoleDetail } from "@/features/settings/roles-ui";

export const metadata: Metadata = { title: "Role" };

export default async function RolePage(props: PageProps<"/settings/roles/[id]">) {
  const { id } = await props.params;
  if (!z.uuid().safeParse(id).success) notFound();
  const d = await load(async (tx, actor) => {
    const role = (await listRoles(tx)).find((r) => r.id === id);
    if (!role) return null;
    const [members, people, department, location, legal_entity, business_unit] = await Promise.all([
      roleMembers(tx, id),
      tx<{ id: string; name: string; title: string | null }[]>`select e.id, e.display_name as name, d.title from employees e left join designations d on d.id = e.designation_id where e.status <> 'relieved' order by 2`,
      tx<{ id: string; name: string }[]>`select id, name from departments order by name`,
      tx<{ id: string; name: string }[]>`select id, name from locations order by name`,
      tx<{ id: string; name: string }[]>`select id, name from legal_entities order by name`,
      tx<{ id: string; name: string }[]>`select id, name from business_units order by name`,
    ]);
    return { role, members, people, options: { department, location, legal_entity, business_unit }, canEdit: can(actor, "settings.roles") };
  });
  if (!d) notFound();
  return <RoleDetail role={d.role} members={d.members} people={d.people} options={d.options} canEdit={d.canEdit} />;
}
