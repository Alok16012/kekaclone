import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { can } from "@/server/auth/permissions";
import { securitySettings } from "@/server/modules/settings/security";
import { SecuritySettings } from "@/features/settings/security-ui";

export const metadata: Metadata = { title: "Sign-in security" };

export default async function SecurityPage() {
  const d = await load(async (tx, actor) => ({ ...(await securitySettings(tx, actor)), canEdit: can(actor, "settings.security") }));
  return <SecuritySettings mode={d.mode} mine={d.mine} canEdit={d.canEdit} />;
}
