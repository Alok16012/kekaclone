import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { canEditQuickLinks, quickLinks } from "@/server/modules/home/service";
import { QuickLinksAdmin } from "@/features/home/quick-links-admin";

export const metadata: Metadata = { title: "Quick links" };

export default async function QuickLinksPage() {
  const d = await load(async (tx, actor) => ({ links: await quickLinks(tx), canEdit: canEditQuickLinks(actor) }));
  return <QuickLinksAdmin links={d.links} canEdit={d.canEdit} />;
}
