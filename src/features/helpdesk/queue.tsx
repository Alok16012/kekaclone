"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AlertTriangle, Headset, Inbox, Search, Settings, UserCheck, UserX } from "lucide-react";
import { DataTable, type Column } from "@/ui/table";
import { Button } from "@/ui/button";
import { Card, StatTile } from "@/ui/card";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { Switch } from "@/ui/choice";
import { EmptyState } from "@/ui/feedback";
import { PageHeader } from "@/ui/app-shell";
import type { TicketRowDTO } from "./types";
import { TicketDrawer } from "./ticket-drawer";
import { PriorityBadge, SlaFlag, TicketStatusBadge } from "./bits";

const Labeled = ({ label, children }: { label: string; children: React.ReactNode }) => <Field label={<span className="sr-only">{label}</span>} className="gap-0">{children}</Field>;

export type QueueFilterState = { status: string; category: string; assignee: string; breached: boolean; q: string };

/** Agent queue: filters live in the URL (so a filtered view can be shared or refreshed); the drawer handles the ticket. */
export function TicketQueue({ rows, counts, filters, categories, agents, initialTicket, isAdmin, allowed }: {
  rows: TicketRowDTO[]; counts: { open: number; unassigned: number; mine: number; breached: number }; filters: QueueFilterState;
  categories: { id: string; name: string }[]; agents: { id: string; name: string }[]; initialTicket: string | null; isAdmin: boolean; allowed: boolean;
}) {
  const router = useRouter();
  const path = usePathname();
  const [pending, start] = React.useTransition();
  const [open, setOpen] = React.useState<string | null>(initialTicket);
  const [q, setQ] = React.useState(filters.q);
  const set = (patch: Partial<QueueFilterState>) => {
    const next = { ...filters, ...patch };
    const sp = new URLSearchParams();
    if (next.status !== "active") sp.set("status", next.status);
    if (next.category) sp.set("category", next.category);
    if (next.assignee !== "any") sp.set("assignee", next.assignee);
    if (next.breached) sp.set("breached", "1");
    if (next.q) sp.set("q", next.q);
    start(() => router.replace(`${path}${sp.size ? `?${sp}` : ""}`, { scroll: false }));
  };
  React.useEffect(() => {
    if (q === filters.q) return;
    const t = setTimeout(() => set({ q }), 350);
    return () => clearTimeout(t);
  });   // debounce search typing into the URL

  if (!allowed) {
    return (
      <>
        <PageHeader title="Helpdesk queue" />
        <Card><EmptyState icon={<Headset />} title="You're not a helpdesk agent" description="Tickets show up here for people who handle a helpdesk category. To raise a ticket of your own, go to your helpdesk."
          action={<Button asChild variant="secondary"><Link href="/me/helpdesk">Go to my helpdesk</Link></Button>} /></Card>
      </>
    );
  }

  const columns: Column<TicketRowDTO>[] = [
    { key: "ticket", header: "Ticket", sortValue: (r) => r.ref, cell: (r) => (
      <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(r.id); }} className="flex min-w-0 flex-col text-left">
        <span className="flex items-center gap-2"><span className="text-sm tabular text-text-muted">{r.ref}</span><span className="max-w-72 truncate font-medium hover:underline">{r.title}</span></span>
        <span className="text-sm text-text-muted">{r.requester} · {r.ago}</span>
      </button>
    ) },
    { key: "category", header: "Category", hideBelow: "md", sortValue: (r) => r.category, cell: (r) => r.category },
    { key: "priority", header: "Priority", hideBelow: "lg", sortValue: (r) => ({ high: 0, medium: 1, low: 2 })[r.priority], cell: (r) => <PriorityBadge priority={r.priority} /> },
    { key: "assignee", header: "Assignee", hideBelow: "md", sortValue: (r) => r.assignee ?? "~", cell: (r) => r.assignee ?? <span className="text-text-muted">Unassigned</span> },
    { key: "status", header: "Status", sortValue: (r) => r.status, cell: (r) => <span className="flex flex-wrap gap-1.5"><TicketStatusBadge status={r.status} /><SlaFlag sla={r.sla} closed={r.status === "closed"} /></span> },
  ];
  const filtered = filters.status !== "active" || filters.category || filters.assignee !== "any" || filters.breached || filters.q;

  return (
    <>
      <PageHeader title="Helpdesk queue" description={isAdmin ? "Every ticket in the company, except your own." : "Tickets in the categories you handle."}
        actions={isAdmin ? <Button asChild variant="secondary"><Link href="/settings/helpdesk"><Settings />Categories</Link></Button> : undefined} />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Open" value={counts.open} icon={<Inbox />} />
        <StatTile label="Unassigned" value={counts.unassigned} icon={<UserX />} />
        <StatTile label="Assigned to you" value={counts.mine} icon={<UserCheck />} />
        <StatTile label="Missed targets" value={counts.breached} icon={<AlertTriangle />} />
      </div>
      <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end" aria-busy={pending}>
        <div className="lg:w-64"><Input aria-label="Search tickets" leading={<Search />} placeholder="Search subject, person or HD-number" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:flex lg:gap-3">
          <div className="lg:w-40"><Labeled label="Status"><Select value={filters.status} onValueChange={(v) => set({ status: v })}
            options={[{ value: "active", label: "Open and in progress" }, { value: "open", label: "Open" }, { value: "in_progress", label: "In progress" }, { value: "closed", label: "Closed" }, { value: "all", label: "All statuses" }]} /></Labeled></div>
          <div className="lg:w-44"><Labeled label="Category"><Select value={filters.category || "all"} onValueChange={(v) => set({ category: v === "all" ? "" : v })}
            options={[{ value: "all", label: "All categories" }, ...categories.map((c) => ({ value: c.id, label: c.name }))]} /></Labeled></div>
          <div className="lg:w-44"><Labeled label="Assignee"><Select value={filters.assignee} onValueChange={(v) => set({ assignee: v })}
            options={[{ value: "any", label: "Anyone" }, { value: "me", label: "Assigned to me" }, { value: "unassigned", label: "Unassigned" }, ...agents.map((a) => ({ value: a.id, label: a.name }))]} /></Labeled></div>
        </div>
        <Switch label="Missed targets only" checked={filters.breached} onCheckedChange={(c) => set({ breached: !!c })} />
      </div>
      <DataTable caption="Helpdesk tickets" rows={rows} columns={columns} rowKey={(r) => r.id} onRowClick={(r) => setOpen(r.id)} loading={pending}
        empty={filtered ? <EmptyState compact icon={<Search />} title="No tickets match these filters" action={<Button variant="secondary" size="sm" onClick={() => { setQ(""); set({ status: "active", category: "", assignee: "any", breached: false, q: "" }); }}>Clear filters</Button>} />
          : <EmptyState icon={<Headset />} title="The queue is clear" description="New tickets in your categories will show up here." />} />
      <TicketDrawer ticketId={open} onClose={() => setOpen(null)} />
    </>
  );
}
