import type { Metadata } from "next";
import { z } from "zod";
import { load, timeAgo } from "@/server/page-data";
import { isAgent, listCategories, myTickets } from "@/server/modules/helpdesk/service";
import { MyTickets } from "@/features/helpdesk/my-tickets";
import { toRowDTO } from "@/features/helpdesk/dto";
import { helpdeskSettings } from "@/server/modules/helpdesk/assist";
import { llm } from "@/server/modules/assist/provider";

export const metadata: Metadata = { title: "Helpdesk" };

export default async function MyHelpdeskPage(props: PageProps<"/me/helpdesk">) {
  const sp = await props.searchParams;
  const ticket = typeof sp.ticket === "string" && z.uuid().safeParse(sp.ticket).success ? sp.ticket : null;
  const d = await load(async (tx, actor) => {
    const now = new Date();
    const [tickets, categories, agent, hs] = await Promise.all([myTickets(tx, actor, now), listCategories(tx), isAgent(tx, actor), helpdeskSettings(tx)]);
    const p = hs.ai_enabled ? llm() : null;
    return { tickets: tickets.map((t) => toRowDTO(t, timeAgo(t.last_activity_at, now))), categories: categories.map((c) => ({ id: c.id, name: c.name, priority: c.priority, first_response_sla_mins: c.first_response_sla_mins, resolution_sla_mins: c.resolution_sla_mins })), agent,
      assist: { suggest: hs.suggest_before_raise, active: !!p, provider: p?.name ?? null } };
  });
  return <MyTickets tickets={d.tickets} categories={d.categories} isAgent={d.agent} initialTicket={ticket} startNew={sp.new === "1"} assist={d.assist} />;
}
