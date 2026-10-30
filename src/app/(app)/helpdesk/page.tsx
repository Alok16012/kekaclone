import type { Metadata } from "next";
import { z } from "zod";
import { load, timeAgo } from "@/server/page-data";
import { canAdminHelpdesk, isAgent, listCategories, queue, queueCounts, type QueueFilters } from "@/server/modules/helpdesk/service";
import { TicketQueue, type QueueFilterState } from "@/features/helpdesk/queue";
import { toRowDTO } from "@/features/helpdesk/dto";

export const metadata: Metadata = { title: "Helpdesk queue" };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const STATUSES = ["active", "open", "in_progress", "closed", "all"] as const;

export default async function HelpdeskQueuePage(props: PageProps<"/helpdesk">) {
  const sp = await props.searchParams;
  const uuid = z.uuid();
  const f: QueueFilterState = {
    status: (STATUSES as readonly string[]).includes(one(sp.status)) ? one(sp.status) : "active",
    category: uuid.safeParse(one(sp.category)).success ? one(sp.category) : "",
    assignee: ["me", "unassigned"].includes(one(sp.assignee)) || uuid.safeParse(one(sp.assignee)).success ? one(sp.assignee) : "any",
    breached: one(sp.breached) === "1",
    q: one(sp.q).slice(0, 80),
  };
  const ticket = uuid.safeParse(one(sp.ticket)).success ? one(sp.ticket) : null;
  const d = await load(async (tx, actor) => {
    if (!(await isAgent(tx, actor))) return null;
    const now = new Date();
    const admin = canAdminHelpdesk(actor);
    const filters: QueueFilters = { status: f.status as QueueFilters["status"], categoryId: f.category || null, assignee: f.assignee, breached: f.breached, q: f.q };
    const [rows, live, cats] = await Promise.all([queue(tx, actor, filters, now), queue(tx, actor, { status: "active" }, now), listCategories(tx)]);
    const mine = cats.filter((c) => admin || c.assignee_employee_ids.includes(actor.employeeId) || c.escalate_to_employee_id === actor.employeeId);
    const agentIds = [...new Set(mine.flatMap((c) => c.assignee_employee_ids))];
    const agents = agentIds.length ? await tx<{ id: string; name: string }[]>`select id, display_name as name from employees where id = any(${agentIds}::uuid[]) order by display_name` : [];
    return { rows: rows.map((r) => toRowDTO(r, timeAgo(r.created_at, now))), counts: queueCounts(live, actor), categories: mine.map((c) => ({ id: c.id, name: c.name })), agents, admin };
  });
  if (!d) return <TicketQueue allowed={false} rows={[]} counts={{ open: 0, unassigned: 0, mine: 0, breached: 0 }} filters={f} categories={[]} agents={[]} initialTicket={null} isAdmin={false} />;
  return <TicketQueue allowed rows={d.rows} counts={d.counts} filters={f} categories={d.categories} agents={d.agents} initialTicket={ticket} isAdmin={d.admin} />;
}
