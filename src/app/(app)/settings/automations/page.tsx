import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { canManageAutomations, editorOptions, listAutomations, runLog } from "@/server/modules/automations/service";
import { AutomationsPage } from "@/features/plat2/automations-ui";
import { EmptyState } from "@/ui/feedback";

export const metadata: Metadata = { title: "Automations" };

export default async function Automations() {
  const d = await load(async (tx, actor) => (canManageAutomations(actor)
    ? { items: await listAutomations(tx, actor), options: await editorOptions(tx, actor), runs: await runLog(tx, actor, undefined, 30) }
    : null));
  if (!d) return <EmptyState title="Automations are for company-wide admins" description="Ask a Global admin if you need a workflow automated (joiner welcomes, birthday posts, SLA alerts …)." />;
  return <AutomationsPage items={d.items} options={d.options} runs={d.runs} />;
}
