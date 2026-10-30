import { AlertTriangle, CheckCircle2, CircleDot, Clock3, Loader, Timer } from "lucide-react";
import { Badge } from "@/ui/badge";
import type { Priority, SlaClock, TicketStatus } from "@/server/modules/helpdesk/rules";
import type { Sla } from "./types";

const STATUS: Record<TicketStatus, { label: string; tone: "accent" | "warning" | "neutral"; icon: typeof CircleDot }> = {
  open: { label: "Open", tone: "accent", icon: CircleDot },
  in_progress: { label: "In progress", tone: "warning", icon: Loader },
  closed: { label: "Closed", tone: "neutral", icon: CheckCircle2 },
};

/** Status is never colour alone: icon + text. */
export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  const s = STATUS[status];
  const Icon = s.icon;
  return <Badge tone={s.tone}><Icon aria-hidden />{s.label}</Badge>;
}

const PRIORITY: Record<Priority, { label: string; tone: "danger" | "warning" | "neutral" }> = {
  high: { label: "High", tone: "danger" }, medium: { label: "Medium", tone: "warning" }, low: { label: "Low", tone: "neutral" },
};
export function PriorityBadge({ priority }: { priority: Priority }) {
  return <Badge tone={PRIORITY[priority].tone}>{PRIORITY[priority].label}</Badge>;
}

const CLOCK: Record<Exclude<SlaClock, "none">, { label: string; tone: "success" | "neutral" | "warning" | "danger"; icon: typeof Clock3 }> = {
  met: { label: "met", tone: "success", icon: CheckCircle2 },
  on_track: { label: "on track", tone: "neutral", icon: Clock3 },
  due_soon: { label: "due soon", tone: "warning", icon: Timer },
  breached: { label: "missed", tone: "danger", icon: AlertTriangle },
};

/** One SLA target: "First response · missed". Nothing when the category has no target. */
export function SlaBadge({ clock, label }: { clock: SlaClock; label: string }) {
  if (clock === "none") return null;
  const c = CLOCK[clock];
  const Icon = c.icon;
  return <Badge tone={c.tone}><Icon aria-hidden />{label} {c.label}</Badge>;
}

/** Compact flag for lists: shows only when something needs attention. */
export function SlaFlag({ sla, closed }: { sla: Sla; closed: boolean }) {
  if (sla.breached) return <Badge tone="danger"><AlertTriangle aria-hidden />SLA missed</Badge>;
  if (!closed && (sla.first === "due_soon" || sla.resolution === "due_soon")) return <Badge tone="warning"><Timer aria-hidden />Due soon</Badge>;
  return null;
}

export const fmtWhen = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "—");
export const fmtSize = (b: number) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
