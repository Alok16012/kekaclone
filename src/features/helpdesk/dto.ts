import type { TicketListRow } from "@/server/modules/helpdesk/service";
import type { TicketRowDTO } from "./types";

/** Server list row → plain props for client components. */
export function toRowDTO(t: TicketListRow, ago: string): TicketRowDTO {
  return {
    id: t.id, ref: t.ref, title: t.title, category: t.category, category_id: t.category_id, status: t.status, priority: t.priority,
    requester: t.requester, requester_id: t.requester_id, assignee: t.assignee, assignee_id: t.assignee_id,
    created_at: t.created_at.toISOString(), last_activity_at: t.last_activity_at.toISOString(), ago, messages: t.messages, sla: t.sla,
  };
}
