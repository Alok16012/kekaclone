import * as React from "react";
import { Check, CircleDot, X, Clock3 } from "lucide-react";
import { cn } from "@/lib/cn";
import { Avatar } from "./avatar";

/** Wizard steps. The current step is aria-current="step"; completed steps are reachable, future ones are not. */
export function Stepper({ steps, current, onStepClick }: { steps: string[]; current: number; onStepClick?: (i: number) => void }) {
  return (
    <ol className="flex w-full items-center gap-2">
      {steps.map((s, i) => {
        const done = i < current, active = i === current;
        return (
          <li key={s} className="flex flex-1 items-center gap-2" aria-current={active ? "step" : undefined}>
            <button type="button" disabled={!done || !onStepClick} onClick={() => onStepClick?.(i)} className="flex items-center gap-2 disabled:cursor-default">
              <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-pill border text-sm font-semibold tabular",
                done ? "border-accent bg-accent text-on-accent" : active ? "border-accent text-accent-text" : "border-border-strong text-text-muted")}>
                {done ? <Check className="size-4" aria-label="done" /> : i + 1}
              </span>
              <span className={cn("hidden text-base sm:inline", active ? "font-semibold text-text" : "text-text-muted")}>{s}</span>
            </button>
            {i < steps.length - 1 && <span aria-hidden className={cn("h-px flex-1", done ? "bg-accent" : "bg-border")} />}
          </li>
        );
      })}
    </ol>
  );
}

export type ApprovalLevel = { level: number; approver: string; role?: string; status: "approved" | "rejected" | "pending" | "waiting"; at?: string; comment?: string };

/** Who has to approve, in order, and where the request is now. */
export function ApprovalTimeline({ levels }: { levels: ApprovalLevel[] }) {
  const icon = { approved: <Check className="size-3.5" />, rejected: <X className="size-3.5" />, pending: <Clock3 className="size-3.5" />, waiting: <CircleDot className="size-3.5" /> };
  const tone = { approved: "bg-success text-on-accent", rejected: "bg-danger text-on-accent", pending: "bg-warning-soft text-warning-text ring-2 ring-warning", waiting: "bg-surface-hover text-text-muted" };
  const word = { approved: "Approved", rejected: "Rejected", pending: "Waiting for approval", waiting: "Not yet reached" };
  return (
    <ol className="relative flex flex-col gap-5">
      {levels.map((l, i) => (
        <li key={l.level} className="relative flex gap-3">
          {i < levels.length - 1 && <span aria-hidden className="absolute left-3 top-7 h-[calc(100%-4px)] w-px bg-border" />}
          <span className={cn("z-10 flex size-6 shrink-0 items-center justify-center rounded-pill", tone[l.status])} aria-hidden>{icon[l.status]}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2">
              <Avatar name={l.approver} size="xs" />
              <span className="text-base font-medium">{l.approver}</span>
              {l.role && <span className="text-sm text-text-muted">· {l.role}</span>}
            </div>
            <p className="mt-0.5 text-sm text-text-muted">Level {l.level} · {word[l.status]}{l.at && ` · ${l.at}`}</p>
            {l.comment && <p className="mt-1.5 rounded-md bg-surface-sunken px-3 py-2 text-base">{l.comment}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
