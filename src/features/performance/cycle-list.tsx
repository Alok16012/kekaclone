"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ClipboardList, Plus } from "lucide-react";
import { CYCLE_STATUS_LABEL, type CycleStatus } from "@/server/modules/performance/rules";
import { DataTable, type Column } from "@/ui/table";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/feedback";
import { fmtDate } from "./bits";

type Row = { id: string; name: string; kind: string; status: CycleStatus; period_start: string; period_end: string; participants: number; submitted: number; total: number };
const KIND: Record<string, string> = { standard: "Standard", aggregate: "Aggregate", probation: "Probation (automatic)", new_joiner: "New joiners (automatic)" };
const TONE: Record<CycleStatus, "neutral" | "accent" | "warning" | "success"> = { draft: "neutral", live: "accent", calibration: "warning", published: "success", closed: "neutral" };

export function CycleList({ cycles, canCreate }: { cycles: Row[]; canCreate: boolean }) {
  const router = useRouter();
  const cols: Column<Row>[] = [
    { key: "name", header: "Cycle", cell: (r) => <Link href={`/performance/cycles/${r.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>{r.name}</Link>, sortValue: (r) => r.name },
    { key: "kind", header: "Type", cell: (r) => KIND[r.kind] ?? r.kind, hideBelow: "md" },
    { key: "period", header: "Period", cell: (r) => `${fmtDate(r.period_start)} – ${fmtDate(r.period_end)}`, hideBelow: "lg", sortValue: (r) => r.period_start },
    { key: "people", header: "People", align: "right", cell: (r) => r.participants, sortValue: (r) => r.participants },
    { key: "done", header: "Reviews done", align: "right", cell: (r) => (r.total ? `${r.submitted} / ${r.total}` : "—"), hideBelow: "md" },
    { key: "status", header: "Status", cell: (r) => <Badge tone={TONE[r.status]}>{CYCLE_STATUS_LABEL[r.status]}</Badge>, sortValue: (r) => r.status },
  ];
  return (
    <DataTable caption="Review cycles" rows={cycles} columns={cols} rowKey={(r) => r.id} onRowClick={(r) => router.push(`/performance/cycles/${r.id}`)}
      empty={<EmptyState icon={<ClipboardList />} title="No review cycles yet" description="A cycle asks people for self, manager and peer reviews over a period, then you calibrate and publish."
        action={canCreate ? <Button size="sm" asChild><Link href="/performance/cycles/new"><Plus />New cycle</Link></Button> : undefined} />} />
  );
}
