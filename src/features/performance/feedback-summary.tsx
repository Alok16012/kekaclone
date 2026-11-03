"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { MessageSquareText } from "lucide-react";
import { StatTile } from "@/ui/card";
import { DataTable, type Column } from "@/ui/table";
import { Field, Input } from "@/ui/field";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/feedback";

type Row = { id: string; name: string; department: string | null; given: number; received: number; requested: number; praise: number };

export function FeedbackSummary({ people, total, silent, from, to }: { people: Row[]; total: { given: number; received: number; requested: number; praise: number }; silent: number; from: string; to: string }) {
  const router = useRouter();
  const [f, setF] = React.useState(from), [t, setT] = React.useState(to);
  const cols: Column<Row>[] = [
    { key: "name", header: "Person", cell: (r) => <div><p className="font-medium">{r.name}</p>{r.department && <p className="text-xs text-text-muted">{r.department}</p>}</div>, sortValue: (r) => r.name },
    { key: "received", header: "Received", align: "right", cell: (r) => r.received, sortValue: (r) => r.received },
    { key: "given", header: "Given", align: "right", cell: (r) => r.given, sortValue: (r) => r.given },
    { key: "requested", header: "Asked for", align: "right", cell: (r) => r.requested, sortValue: (r) => r.requested, hideBelow: "md" },
    { key: "praise", header: "Praise", align: "right", cell: (r) => r.praise, sortValue: (r) => r.praise, hideBelow: "md" },
  ];
  return (
    <div className="flex flex-col gap-4">
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); router.push(`/performance/feedback?from=${f}&to=${t}`); }}>
        <Field label="From"><Input type="date" value={f} onChange={(e) => setF(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={t} onChange={(e) => setT(e.target.value)} /></Field>
        <Button type="submit" variant="secondary">Show</Button>
      </form>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Feedback shared" value={total.given} />
        <StatTile label="Requests" value={total.requested} />
        <StatTile label="Praise" value={total.praise} />
        <StatTile label="Received nothing" value={silent} hint="No feedback or praise in the range" />
      </div>
      <DataTable caption="Feedback per person" rows={people} columns={cols} rowKey={(r) => r.id} empty={<EmptyState icon={<MessageSquareText />} title="Nobody in your scope" />} />
    </div>
  );
}
