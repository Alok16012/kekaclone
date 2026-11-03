import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { canSeeIntegrations, integrationsOverview } from "@/server/modules/integrations/service";
import { exportableRuns } from "@/server/modules/integrations/accounting";
import { IntegrationsPage } from "@/features/saas/integrations-ui";
import { EmptyState } from "@/ui/feedback";

export const metadata: Metadata = { title: "Integrations" };

export default async function Integrations() {
  const d = await load(async (tx, actor) => (canSeeIntegrations(actor) ? { overview: await integrationsOverview(tx, actor), runs: await exportableRuns(tx, actor) } : null));
  if (!d) return <EmptyState title="Integrations are for workspace admins" description="Ask a Global admin if you need Slack, Teams, calendar or accounting connections." />;
  return <IntegrationsPage overview={d.overview} runs={d.runs} />;
}
