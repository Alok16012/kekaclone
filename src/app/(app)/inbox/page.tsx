import type { Metadata } from "next";
import { load, timeAgo } from "@/server/page-data";
import { inbox } from "@/server/modules/approvals/service";
import { PageHeader } from "@/ui/app-shell";
import { InboxList } from "@/features/inbox-list";

export const metadata: Metadata = { title: "Inbox" };

export default async function InboxPage() {
  const items = await load((tx, actor) => inbox(tx, actor));
  return (
    <>
      <PageHeader title="Inbox" description={items.length ? `${items.length} ${items.length === 1 ? "request is" : "requests are"} waiting for your decision.` : "Requests that need your decision."} />
      <InboxList items={items.map((i) => ({ stepId: i.step_id, entityType: i.entity_type, entityId: i.entity_id, summary: i.summary, requester: i.requester_name, requesterTitle: i.requester_title, createdAt: i.created_at.toISOString(), ago: timeAgo(i.created_at) }))} />
    </>
  );
}
