import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { canManageApprovals, listDelegations, listWorkflows, workflowOptions } from "@/server/modules/corehr/approvals-admin";
import { todayIn } from "@/lib/dates";
import { ApprovalSettings, Delegations } from "@/features/corehr/approval-settings";
import { Banner } from "@/ui/feedback";

export const metadata: Metadata = { title: "Approvals" };

export default async function ApprovalsSettingsPage() {
  const d = await load(async (tx, actor) => {
    const manage = canManageApprovals(actor);
    const [wf, delegations, options] = await Promise.all([manage ? listWorkflows(tx, actor) : null, listDelegations(tx, actor), workflowOptions(tx)]);
    return { wf, delegations, options, meId: actor.employeeId, manage };
  });
  return (
    <div className="flex flex-col gap-6">
      {d.wf ? <ApprovalSettings rows={d.wf.rows} options={d.wf.options} entities={d.wf.entities} defaults={d.wf.defaults} />
        : <Banner tone="info">Only people with the approval-settings permission (for the whole company) can change workflows. You can still hand over your own approvals below.</Banner>}
      <Delegations rows={d.delegations} people={d.options.people} meId={d.meId} canAll={d.manage} today={todayIn()} />
    </div>
  );
}
