import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { can } from "@/server/auth/permissions";
import { emailTemplates } from "@/server/modules/notifications/service";
import { EmailTemplatesPage } from "@/features/plat2/email-templates-ui";

export const metadata: Metadata = { title: "Email templates" };

export default async function EmailTemplates() {
  const d = await load(async (tx, actor) => ({ groups: await emailTemplates(tx), canEdit: can(actor, "settings.notifications") }));
  return <EmailTemplatesPage groups={d.groups} canEdit={d.canEdit} />;
}
