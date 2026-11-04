import type { Metadata } from "next";
import { load, timeAgo } from "@/server/page-data";
import { inbox } from "@/server/modules/approvals/service";
import { PageHeader } from "@/ui/app-shell";
import { InboxList } from "@/features/inbox-list";
import { DelegationDialog } from "@/features/corehr/approval-settings";
import { workflowOptions } from "@/server/modules/corehr/approvals-admin";
import { todayIn } from "@/lib/dates";
import { Button } from "@/ui/button";
import { getT } from "@/i18n/server";

export const metadata: Metadata = { title: "Inbox" };

export default async function InboxPage() {
  const { items, people, meId } = await load(async (tx, actor) => ({ items: await inbox(tx, actor), people: (await workflowOptions(tx)).people, meId: actor.employeeId }));
  const { t } = await getT();
  return (
    <>
      <PageHeader title={t("inbox.title")} description={items.length ? t("inbox.waiting", { count: items.length }) : t("inbox.empty")}
        actions={<DelegationDialog people={people} meId={meId} canAll={false} today={todayIn()} trigger={<Button variant="secondary" size="sm">{t("inbox.handover")}</Button>} />} />
      <InboxList items={items.map((i) => ({ stepId: i.step_id, entityType: i.entity_type, entityId: i.entity_id, summary: i.summary, requester: i.requester_name, requesterTitle: i.requester_title, createdAt: i.created_at.toISOString(), ago: timeAgo(i.created_at) }))} />
    </>
  );
}
