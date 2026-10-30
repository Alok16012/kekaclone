"use client";
import * as React from "react";
import { DoorOpen, ListChecks, Search, UserMinus } from "lucide-react";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { DataTable, type Column } from "@/ui/table";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card, CardHeader } from "@/ui/card";
import { Input } from "@/ui/field";
import { EmptyState, Progress } from "@/ui/feedback";
import { PageHeader } from "@/ui/app-shell";
import type { BoardRow } from "@/server/modules/exits/service";
import type { Person } from "@/ui/employee-picker";
import { ExitDrawer, fmtDate, STATUS_LABEL } from "./exit-drawer";
import { InitiateExit, type Reason } from "./initiate-exit";

type Stage = "review" | "progress" | "exited";
export type BoardData = Record<Stage, BoardRow[]>;
type MyTask = { id: string; title: string; due_date: string | null; subject: string; exit_id: string };

const EMPTY: Record<Stage, { title: string; description: string }> = {
  review: { title: "No resignations waiting", description: "When someone resigns, it shows up here until it's accepted or declined." },
  progress: { title: "Nobody is serving notice", description: "Accepted resignations and exits started by HR appear here until the last working day." },
  exited: { title: "No one has left yet", description: "People who have completed their exit are listed here." },
};

export function ExitsBoard({ board, people, reasons, letterTemplates, myTasks, today, canManage }: {
  board: BoardData | null; people: Person[]; reasons: Reason[]; letterTemplates: { id: string; name: string; kind: string }[]; myTasks: MyTask[]; today: string; canManage: boolean;
}) {
  const [open, setOpen] = React.useState<string | null>(null);
  const [q, setQ] = React.useState("");
  const [tab, setTab] = React.useState<Stage>(board && board.review.length ? "review" : "progress");
  const filter = (rows: BoardRow[]) => (q ? rows.filter((r) => `${r.name} ${r.number} ${r.department ?? ""} ${r.designation ?? ""}`.toLowerCase().includes(q.toLowerCase())) : rows);

  const columns = (stage: Stage): Column<BoardRow>[] => [
    { key: "name", header: "Person", sortValue: (r) => r.name, cell: (r) => (
      <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(r.id); }} className="flex min-w-0 items-center gap-3 rounded-md text-left">
        <Avatar name={r.name} size="sm" />
        <span className="min-w-0"><span className="block truncate font-medium hover:underline">{r.name}</span><span className="block truncate text-sm text-text-muted">{[r.designation, r.department].filter(Boolean).join(" · ") || r.number}</span></span>
      </button>
    ) },
    { key: "lwd", header: stage === "exited" ? "Left on" : "Last working day", sortValue: (r) => r.last_working_date, cell: (r) => (
      <span className="flex flex-col"><span className="tabular">{fmtDate(r.last_working_date)}</span>
        {stage === "progress" && r.last_working_date < today && <Badge tone="warning" className="mt-0.5 w-fit">Past due</Badge>}</span>
    ) },
    { key: "type", header: "Type", hideBelow: "md", cell: (r) => (r.kind === "resignation" ? "Resignation" : "Company action") },
    { key: "reason", header: "Reason", hideBelow: "lg", cell: (r) => r.reason ?? <span className="text-text-muted">—</span> },
    ...(stage === "review" ? [{ key: "since", header: "Resigned on", hideBelow: "md" as const, sortValue: (r: BoardRow) => r.resignation_date, cell: (r: BoardRow) => fmtDate(r.resignation_date) }] : [{
      key: "tasks", header: "Checklist", hideBelow: "md" as const, cell: (r: BoardRow) => r.tasks_total ? (
        <span className="flex min-w-28 flex-col gap-1"><span className="text-sm tabular text-text-muted">{r.tasks_done} of {r.tasks_total}</span><Progress value={r.tasks_done} max={r.tasks_total} label={`${r.name}'s checklist`} tone={r.tasks_done === r.tasks_total ? "success" : "accent"} /></span>
      ) : <span className="text-text-muted">—</span>,
    }]),
    { key: "status", header: "Status", hideBelow: "lg", cell: (r) => <Badge tone={STATUS_LABEL[r.status].tone}>{STATUS_LABEL[r.status].label}</Badge> },
  ];

  return (
    <>
      <PageHeader title="Exits" description="Resignations, notice periods and leaving checklists."
        actions={canManage ? <InitiateExit people={people} reasons={reasons} today={today} trigger={<Button><UserMinus />Initiate exit</Button>} /> : undefined} />

      {myTasks.length > 0 && (
        <Card className="mb-6">
          <CardHeader title="Your exit tasks" description="Things you've been asked to do for colleagues who are leaving." />
          <ul className="divide-y divide-border border-t border-border">
            {myTasks.map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => setOpen(t.exit_id)} className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-surface-sunken">
                  <ListChecks className="size-4 shrink-0 text-text-muted" aria-hidden />
                  <span className="min-w-0 flex-1"><span className="block truncate text-base font-medium">{t.title}</span><span className="block text-sm text-text-muted">{t.subject} · due {fmtDate(t.due_date)}</span></span>
                  {t.due_date && t.due_date < today && <Badge tone="danger">Overdue</Badge>}
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {!board ? (
        myTasks.length === 0 && <Card><EmptyState icon={<DoorOpen />} title="Exits are handled by HR" description="If you want to resign, you can do it from your profile. Tasks for colleagues who are leaving will show up here." /></Card>
      ) : (
        <Tabs value={tab} onValueChange={(v) => setTab(v as Stage)}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <TabsList items={[{ value: "review", label: "Under review", count: board.review.length }, { value: "progress", label: "In progress", count: board.progress.length }, { value: "exited", label: "Exited", count: board.exited.length }]} />
            <div className="sm:w-72"><Input aria-label="Search exits" leading={<Search />} placeholder="Search by name or team" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          </div>
          {(["review", "progress", "exited"] as const).map((s) => (
            <TabsContent key={s} value={s}>
              <DataTable caption={EMPTY[s].title} rows={filter(board[s])} columns={columns(s)} rowKey={(r) => r.id} onRowClick={(r) => setOpen(r.id)}
                empty={q ? <EmptyState compact icon={<Search />} title={`No one matches “${q}”`} /> : <EmptyState icon={<DoorOpen />} title={EMPTY[s].title} description={EMPTY[s].description} />} />
            </TabsContent>
          ))}
        </Tabs>
      )}
      <ExitDrawer exitId={open} onClose={() => setOpen(null)} letterTemplates={letterTemplates} today={today} />
    </>
  );
}
