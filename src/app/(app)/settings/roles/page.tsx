import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { can } from "@/server/auth/permissions";
import { listRoles } from "@/server/modules/settings/roles";
import { RoleList } from "@/features/settings/roles-ui";

export const metadata: Metadata = { title: "Roles & permissions" };

export default async function RolesPage() {
  const d = await load(async (tx, actor) => ({ roles: await listRoles(tx), canEdit: can(actor, "settings.roles") }));
  return <RoleList roles={d.roles} canEdit={d.canEdit} />;
}
