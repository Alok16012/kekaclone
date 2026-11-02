"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowRight, Wallet } from "lucide-react";
import { Badge } from "@/ui/badge";
import { Skeleton } from "@/ui/feedback";
import { settlementSummaryAction } from "@/app/(app)/payroll/actions";
import { money } from "./format";

type Summary = { status: string | null; net: number | null; canOpen: boolean };
const LABEL: Record<string, string> = { draft: "Draft", approved: "Approved", finalized: "Finalised" };

/** The exit drawer's "Final settlement" section: where the settlement stands, with a link for people who run payroll. */
export function ExitSettlement({ exitId, status }: { exitId: string; status: string }) {
  const [s, setS] = React.useState<{ id: string; data: Summary | null } | null>(null);
  React.useEffect(() => {
    let live = true;
    settlementSummaryAction(exitId).then((r) => { if (live) setS({ id: exitId, data: r.ok ? (r.data as Summary) : null }); });
    return () => { live = false; };
  }, [exitId]);
  const data = s?.id === exitId ? s.data : undefined;
  const relevant = status === "in_progress" || status === "exited";
  return (
    <div className="flex items-start gap-3 rounded-md bg-surface-sunken px-3 py-3 text-base">
      <Wallet className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden />
      <div className="min-w-0 flex-1">
        {data === undefined ? <Skeleton className="h-5 w-48" /> : !relevant ? (
          <p className="text-text-muted">The final settlement is worked out in payroll once the exit is approved.</p>
        ) : (
          <>
            <p className="flex flex-wrap items-center gap-2">
              {data?.status ? <Badge tone={data.status === "finalized" ? "success" : "accent"}>{LABEL[data.status] ?? data.status}</Badge> : <Badge tone="warning">Not started</Badge>}
              {data?.net != null && <span className="tabular">{money(data.net)} net</span>}
            </p>
            {data?.canOpen ? (
              <Link href={`/payroll/settlements/${exitId}`} className="mt-1 inline-flex items-center gap-1 text-accent-text hover:underline">Open in payroll<ArrowRight className="size-4" aria-hidden /></Link>
            ) : <p className="mt-1 text-sm text-text-muted">Payroll works this out and the person can download the statement from My finances.</p>}
          </>
        )}
      </div>
    </div>
  );
}
