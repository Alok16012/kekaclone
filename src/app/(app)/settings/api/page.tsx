import { tenantHost } from "@/lib/tenancy";
import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { canSeeIntegrations, listApiKeys, listEndpoints } from "@/server/modules/integrations/service";
import { hasFeature } from "@/server/modules/saas/gate";
import { listOAuthClients } from "@/server/modules/integrations/oauth";
import { ApiSettingsPage } from "@/features/saas/api-ui";
import { EmptyState } from "@/ui/feedback";

export const metadata: Metadata = { title: "API & webhooks" };

export default async function ApiSettings() {
  const d = await load(async (tx, actor) => (canSeeIntegrations(actor)
    ? { keys: await listApiKeys(tx, actor), clients: await listOAuthClients(tx, actor), endpoints: await listEndpoints(tx, actor), apiAllowed: hasFeature(actor, "api"), webhooksAllowed: hasFeature(actor, "webhooks"), host: tenantHost(actor.tenant.subdomain) }
    : null));
  if (!d) return <EmptyState title="API keys are for workspace admins" description="Ask a Global admin if your team needs API access." />;
  return <ApiSettingsPage {...d} />;
}
