/** Plain data shapes the helpdesk screens receive (dates as ISO strings). Shared by server pages, actions and client components. */
import type { Priority, SlaClock, TicketAction, TicketStatus } from "@/server/modules/helpdesk/rules";

export type Sla = { first: SlaClock; resolution: SlaClock; breached: boolean };

export type TicketRowDTO = {
  id: string; ref: string; title: string; category: string; category_id: string; status: TicketStatus; priority: Priority;
  requester: string; requester_id: string; assignee: string | null; assignee_id: string | null;
  created_at: string; last_activity_at: string; ago: string; messages: number; sla: Sla;
};

export type TicketDetailDTO = {
  ticket: {
    id: string; ref: string; title: string; category: string; status: TicketStatus; priority: Priority; requester: string; requester_id: string;
    assignee: string | null; assignee_id: string | null; created_at: string; reopened_count: number; sla: Sla;
    first_response_due_at: string | null; first_responded_at: string | null; resolution_due_at: string | null; closed_at: string | null;
  };
  messages: { id: string; author: string | null; author_id: string | null; body: string; internal: boolean; created_at: string; mine: boolean; from_agent: boolean; files: { id: string; name: string; mime: string; size: number }[] }[];
  role: "requester" | "agent";
  can: { reply: boolean; internal: boolean; assign: boolean; actions: TicketAction[] };
  agents: { id: string; name: string; title: string | null }[];
};

export type CategoryOption = { id: string; name: string; priority: Priority; first_response_sla_mins: number | null; resolution_sla_mins: number | null };
