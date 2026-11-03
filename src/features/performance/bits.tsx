import { AlertTriangle, CheckCircle2, Circle, Clock3, Lock, MinusCircle, TrendingDown, XCircle } from "lucide-react";
import { Badge } from "@/ui/badge";
import { GOAL_STATUS_LABEL, type GoalStatus } from "@/server/modules/performance/rules";

const GOAL_STYLE: Record<GoalStatus, { tone: "neutral" | "success" | "warning" | "danger" | "accent"; icon: typeof Circle }> = {
  not_started: { tone: "neutral", icon: Circle }, on_track: { tone: "success", icon: CheckCircle2 }, at_risk: { tone: "warning", icon: AlertTriangle },
  behind: { tone: "danger", icon: TrendingDown }, completed: { tone: "accent", icon: CheckCircle2 }, closed: { tone: "neutral", icon: Lock },
};
/** Status is never colour alone: icon + words. */
export function GoalStatusBadge({ status }: { status: GoalStatus }) {
  const s = GOAL_STYLE[status];
  const Icon = s.icon;
  return <Badge tone={s.tone}><Icon aria-hidden />{GOAL_STATUS_LABEL[status]}</Badge>;
}

const REVIEW_STYLE = {
  not_started: { tone: "neutral", icon: Circle, label: "Not started" }, draft: { tone: "warning", icon: Clock3, label: "In progress" },
  submitted: { tone: "success", icon: CheckCircle2, label: "Submitted" }, declined: { tone: "neutral", icon: MinusCircle, label: "Declined" },
  proposed: { tone: "warning", icon: Clock3, label: "Waiting for approval" }, rejected: { tone: "danger", icon: XCircle, label: "Not approved" },
} as const;
export function ReviewStatusBadge({ status }: { status: keyof typeof REVIEW_STYLE }) {
  const s = REVIEW_STYLE[status];
  const Icon = s.icon;
  return <Badge tone={s.tone}><Icon aria-hidden />{s.label}</Badge>;
}

export const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso.length === 10 ? iso + "T00:00:00Z" : iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: iso.length === 10 ? "UTC" : "Asia/Kolkata" }) : "—");
export const fmtDateTime = (iso: string) => new Date(iso).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
export const inr = (paise: number) => `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
export const pct = (n: number) => `${Math.round(n)}%`;

/** A thin labelled progress bar with the number next to it. */
export function ProgressLine({ value, label }: { value: number; label: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="flex items-center gap-2">
      <div role="progressbar" aria-label={label} aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100} className="h-1.5 flex-1 overflow-hidden rounded-pill bg-surface-hover">
        <div className="h-full rounded-pill bg-accent transition-[width] duration-slow" style={{ width: `${v}%` }} />
      </div>
      <span className="w-10 text-right text-sm tabular text-text-muted">{Math.round(v)}%</span>
    </div>
  );
}
