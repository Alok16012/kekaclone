"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileCheck2, Send } from "lucide-react";
import { StatTile } from "@/ui/card";
import { Segmented } from "@/ui/choice";
import { DataTable } from "@/ui/table";
import { EmptyState } from "@/ui/feedback";
import { Progress } from "@/ui/feedback";
import type { preboardingBoard } from "@/server/modules/hire/offers";
import { day, inr0, OfferBadge } from "./shared";

type Row = Awaited<ReturnType<typeof preboardingBoard>>[number];

/** S146–S147: every current offer with its approval / answer, and joining documents and tasks for accepted ones. */
export function Preboarding({ offers }: { offers: Row[] }) {
  const router = useRouter();
  const [filter, setFilter] = React.useState<"open" | "accepted" | "closed" | "all">("open");
  const isOpen = (o: Row) => ["draft", "pending_approval", "released"].includes(o.status);
  const joining = (o: Row) => o.status === "accepted" && o.app_status !== "hired";
  const shown = offers.filter((o) => filter === "all" || (filter === "open" ? isOpen(o) : filter === "accepted" ? o.status === "accepted" : !isOpen(o) && o.status !== "accepted"));
  const toReview = offers.reduce((n, o) => n + o.docs_uploaded, 0);
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Waiting for approval" value={offers.filter((o) => o.status === "pending_approval").length} />
        <StatTile label="Waiting for the candidate" value={offers.filter((o) => o.status === "released").length} icon={<Send />} />
        <StatTile label="Accepted, not yet joined" value={offers.filter(joining).length} />
        <StatTile label="Documents to review" value={toReview} icon={<FileCheck2 />} />
      </div>
      <div className="overflow-x-auto">
        <Segmented label="Show offers" value={filter} onChange={setFilter} options={[{ value: "open", label: "In progress" }, { value: "accepted", label: "Accepted" }, { value: "closed", label: "Declined or withdrawn" }, { value: "all", label: "All" }]} />
      </div>
      <DataTable caption="Offers" rows={shown} rowKey={(r) => r.id} onRowClick={(r) => router.push(`/hire/candidates/${r.candidate_id}?app=${r.application_id}&tab=${r.status === "accepted" ? "documents" : "offers"}`)}
        empty={<EmptyState icon={<Send />} title="No offers here" description="Offers are made from a candidate's profile." />}
        columns={[
          { key: "who", header: "Candidate", sortValue: (r) => r.candidate, cell: (r) => <div><Link href={`/hire/candidates/${r.candidate_id}?app=${r.application_id}&tab=offers`} onClick={(e) => e.stopPropagation()} className="font-medium hover:underline">{r.candidate}</Link><p className="text-sm text-text-muted">{r.job}</p></div> },
          { key: "ctc", header: "CTC", align: "right", hideBelow: "md", sortValue: (r) => r.ctc_paise, cell: (r) => inr0(r.ctc_paise) },
          { key: "join", header: "Joining", hideBelow: "md", sortValue: (r) => r.joining_date, cell: (r) => <span className="text-sm">{day(r.joining_date)}{r.status === "released" && r.expires_on ? <span className="block text-text-muted">answer by {day(r.expires_on)}</span> : null}</span> },
          { key: "status", header: "Status", cell: (r) => r.app_status === "hired" ? <span className="text-sm font-medium text-success-text">Joined as an employee</span> : <OfferBadge status={r.status} approval={r.approval} /> },
          { key: "docs", header: "Documents", hideBelow: "lg", cell: (r) => r.docs_total ? <div className="w-36"><Progress value={r.docs_approved} max={r.docs_total} label={`${r.docs_approved} of ${r.docs_total} documents approved`} /><span className="text-xs text-text-muted">{r.docs_approved}/{r.docs_total} approved{r.docs_uploaded ? `, ${r.docs_uploaded} to review` : ""}</span></div> : <span className="text-sm text-text-muted">—</span> },
          { key: "tasks", header: "Tasks", hideBelow: "lg", cell: (r) => r.tasks_total ? <span className="text-sm tabular">{r.tasks_done}/{r.tasks_total}</span> : <span className="text-sm text-text-muted">—</span> },
        ]} />
    </div>
  );
}
