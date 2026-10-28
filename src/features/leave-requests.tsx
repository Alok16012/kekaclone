"use client";
import * as React from "react";
import { CalendarX2 } from "lucide-react";
import { Card, CardHeader } from "@/ui/card";
import { Button } from "@/ui/button";
import { StatusChip } from "@/ui/badge";
import { ConfirmDialog } from "@/ui/overlay";
import { EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { cancelLeaveAction } from "@/app/(app)/actions";

export type RequestRow = { id: string; type: string; color: string; range: string; days: number; part: string | null; status: "pending" | "approved" | "rejected" | "cancelled"; note: string | null; cancellable: boolean };

export function LeaveRequests({ rows }: { rows: RequestRow[] }) {
  const upcoming = rows.filter((r) => r.status === "pending" || r.cancellable).reverse();   // rows arrive newest first; upcoming reads soonest first
  const past = rows.filter((r) => !upcoming.includes(r));
  const list = (items: RequestRow[]) => (
    <ul className="divide-y divide-border">
      {items.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
          <span aria-hidden className="h-9 w-1 shrink-0 rounded-pill" style={{ background: r.color }} />
          <div className="min-w-0 flex-1">
            <p className="text-base font-medium">{r.type} <span className="font-normal text-text-muted">· {r.range}</span></p>
            <p className="text-sm text-text-muted tabular">{r.days} {r.days === 1 ? "day" : "days"}{r.part ? ` · ${r.part}` : ""}{r.note ? ` · “${r.note}”` : ""}</p>
          </div>
          <StatusChip status={r.status} />
          {r.cancellable && (
            <ConfirmDialog title="Cancel this leave?" description={`${r.type}, ${r.range}. ${r.status === "approved" ? "The days go back to your balance." : "Your manager won't need to review it anymore."}`}
              confirmLabel="Cancel leave" onConfirm={async () => { const res = await cancelLeaveAction(r.id); if (res.ok) toast.success("Leave cancelled"); else toast.error(res.error); }}
              trigger={<Button variant="ghost" size="sm">Cancel</Button>} />
          )}
        </li>
      ))}
    </ul>
  );
  return (
    <Card>
      <CardHeader title="Your requests" description="Pending and upcoming first" />
      {rows.length === 0 ? (
        <EmptyState compact icon={<CalendarX2 />} title="No leave requests yet" description="When you apply for leave, you can follow its approval here." />
      ) : (
        <>
          {list(upcoming)}
          {past.length > 0 && <><p className="border-t border-border bg-surface-sunken px-5 py-2 text-xs font-medium uppercase tracking-wide text-text-muted">History</p>{list(past)}</>}
        </>
      )}
    </Card>
  );
}
