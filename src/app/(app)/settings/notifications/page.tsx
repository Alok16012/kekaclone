import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { can } from "@/server/auth/permissions";
import { notificationSettings } from "@/server/modules/notifications/service";
import { NotificationSettings } from "@/features/settings/notifications-ui";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const d = await load(async (tx, actor) => ({ groups: await notificationSettings(tx), canEdit: can(actor, "settings.notifications"), emailConfigured: !!process.env.RESEND_API_KEY }));
  return <NotificationSettings groups={d.groups} canEdit={d.canEdit} emailConfigured={d.emailConfigured} />;
}
