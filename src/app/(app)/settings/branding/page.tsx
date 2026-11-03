import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { brandingSettings } from "@/server/modules/saas/branding";
import { canWorkspace, hasFeature } from "@/server/modules/saas/gate";
import { BrandingPage } from "@/features/saas/branding-ui";

export const metadata: Metadata = { title: "Branding" };

export default async function Branding() {
  const d = await load(async (tx, actor) => ({ branding: await brandingSettings(tx), canEdit: canWorkspace(actor, "settings.org"), allowed: hasFeature(actor, "branding"), company: actor.tenant.name }));
  return <BrandingPage {...d} />;
}
