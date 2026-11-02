"use client";
import * as React from "react";
import Link from "next/link";
import { BadgeCheck, CalendarPlus } from "lucide-react";
import { DataTable, type Column } from "@/ui/table";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Field, Input, Textarea } from "@/ui/field";
import { Segmented } from "@/ui/choice";
import { Modal } from "@/ui/overlay";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { bulkProbationAction } from "@/app/(app)/corehr/actions";

export type ProbationItem = { id: string; name: string; title: string | null; department: string | null; manager: string | null; joining_date: string; probation_end_date: string | null; probation_status: string; policy: string | null; auto_confirm: boolean; bucket: "overdue" | "due_soon" | "upcoming" };
const fmt = (d: string | null) => (d ? new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");
const BUCKET = { overdue: { label: "Ended, decide now", tone: "danger" as const }, due_soon: { label: "Ends within 15 days", tone: "warning" as const }, upcoming: { label: "Later", tone: "neutral" as const } };

/** Everyone on probation the viewer can act on; select some and confirm or extend them together. */
export function ProbationBoard({ rows, today }: { rows: ProbationItem[]; today: string }) {
  const [filter, setFilter] = React.useState<"all" | "overdue" | "due_soon">("all");
  const [dialog, setDialog] = React.useState<{ ids: string[]; action: "confirm" | "extend"; clear: () => void } | null>(null);
  const shown = filter === "all" ? rows : rows.filter((r) => r.bucket === filter);
  const cols: Column<ProbationItem>[] = [
    { key: "name", header: "Name", sortValue: (r) => r.name, cell: (r) => <span className="min-w-0"><Link href={`/people/${r.id}?tab=job`} onClick={(e) => e.stopPropagation()} className="block truncate font-medium hover:underline">{r.name}</Link><span className="block truncate text-sm text-text-muted">{r.title ?? "—"}</span></span> },
    { key: "dept", header: "Department", sortValue: (r) => r.department ?? "", cell: (r) => r.department ?? "—", hideBelow: "md" },
    { key: "mgr", header: "Manager", cell: (r) => r.manager ?? "—", hideBelow: "lg" },
    { key: "joined", header: "Joined", sortValue: (r) => r.joining_date, cell: (r) => fmt(r.joining_date), hideBelow: "lg" },
    { key: "end", header: "Probation ends", sortValue: (r) => r.probation_end_date ?? "", cell: (r) => <span className="flex flex-col"><span className="tabular">{fmt(r.probation_end_date)}</span>{r.probation_status === "extended" && <span className="text-xs text-text-muted">extended</span>}</span> },
    { key: "state", header: "Status", sortValue: (r) => r.bucket, cell: (r) => <span className="flex flex-wrap gap-1"><Badge tone={BUCKET[r.bucket].tone}>{BUCKET[r.bucket].label}</Badge>{r.auto_confirm && <Badge tone="accent">Auto-confirms</Badge>}</span>, hideBelow: "md" },
  ];
  return (
    <div className="flex flex-col gap-4">
      <Segmented label="Show" value={filter} onChange={setFilter} options={[{ value: "all" as const, label: `All · ${rows.length}` }, { value: "overdue" as const, label: `Ended · ${rows.filter((r) => r.bucket === "overdue").length}` }, { value: "due_soon" as const, label: `Due soon · ${rows.filter((r) => r.bucket === "due_soon").length}` }]} />
      <DataTable caption="People on probation" rows={shown} columns={cols} rowKey={(r) => r.id} selectable
        bulkActions={(ids, clear) => <>
          <Button size="sm" variant="secondary" onClick={() => setDialog({ ids, action: "extend", clear })}><CalendarPlus />Extend</Button>
          <Button size="sm" onClick={() => setDialog({ ids, action: "confirm", clear })}><BadgeCheck />Confirm</Button>
        </>}
        empty={<EmptyState icon={<BadgeCheck />} title="No one is on probation" description="People added with a probation policy show up here until they're confirmed." />} />
      {dialog && <ProbationDialog {...dialog} today={today} names={rows.filter((r) => dialog.ids.includes(r.id)).map((r) => r.name)} onClose={() => setDialog(null)} />}
    </div>
  );
}

function ProbationDialog({ ids, action, clear, today, names, onClose }: { ids: string[]; action: "confirm" | "extend"; clear: () => void; today: string; names: string[]; onClose: () => void }) {
  const [date, setDate] = React.useState(action === "confirm" ? today : "");
  const [days, setDays] = React.useState("30");
  const [note, setNote] = React.useState("");
  const [pending, start] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const submit = () => start(async () => {
    const r = await bulkProbationAction({ employeeIds: ids, action, date: date || undefined, extendDays: action === "extend" && !date ? Number(days) : undefined, note: note || undefined });
    if (!r.ok) { setError(r.error); return; }
    toast.success(`${r.data!.updated} ${r.data!.updated === 1 ? "person" : "people"} ${action === "confirm" ? "confirmed" : "extended"}`);
    clear(); onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={action === "confirm" ? `Confirm ${ids.length} ${ids.length === 1 ? "person" : "people"}` : `Extend probation for ${ids.length}`}
      description={names.slice(0, 4).join(", ") + (names.length > 4 ? ` and ${names.length - 4} more` : "")}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={submit}>{action === "confirm" ? "Confirm" : "Extend"}</Button></>}>
      <div className="flex flex-col gap-4">
        {error && <Banner tone="danger">{error}</Banner>}
        {action === "confirm" ? (
          <Field label="Confirmed from"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Extend by (days)" help="From their current end date"><Input type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} disabled={!!date} /></Field>
            <Field label="Or a new end date"><Input type="date" value={date} min={today} onChange={(e) => setDate(e.target.value)} /></Field>
          </div>
        )}
        <Field label="Note" help="Kept on each person's timeline"><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
        <p className="text-sm text-text-muted">Each person gets a notification.</p>
      </div>
    </Modal>
  );
}
