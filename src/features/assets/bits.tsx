import { Archive, CheckCircle2, Clock3, PackageCheck, User, Wrench, XCircle, MinusCircle, Truck } from "lucide-react";
import { Badge } from "@/ui/badge";
import { CONDITION_LABEL, REQUEST_LABEL, STATUS_LABEL, type AssetStatus, type Condition, type RequestStatus } from "@/server/modules/assets/rules";

const STATUS_STYLE: Record<AssetStatus, { tone: "success" | "accent" | "warning" | "neutral"; icon: typeof User }> = {
  available: { tone: "success", icon: PackageCheck }, assigned: { tone: "accent", icon: User }, in_repair: { tone: "warning", icon: Wrench }, retired: { tone: "neutral", icon: Archive },
};
export function AssetStatusBadge({ status }: { status: AssetStatus }) {
  const s = STATUS_STYLE[status];
  const Icon = s.icon;
  return <Badge tone={s.tone}><Icon aria-hidden />{STATUS_LABEL[status]}</Badge>;
}

export function ConditionText({ condition }: { condition: Condition | null }) {
  if (!condition) return <span className="text-text-muted">—</span>;
  return <span className={condition === "damaged" || condition === "lost" ? "font-medium text-danger-text" : undefined}>{CONDITION_LABEL[condition]}</span>;
}

const REQ_STYLE: Record<RequestStatus, { tone: "warning" | "accent" | "success" | "danger" | "neutral"; icon: typeof User }> = {
  pending: { tone: "warning", icon: Clock3 }, approved: { tone: "accent", icon: Truck }, fulfilled: { tone: "success", icon: CheckCircle2 },
  rejected: { tone: "danger", icon: XCircle }, cancelled: { tone: "neutral", icon: MinusCircle },
};
export function RequestStatusBadge({ status }: { status: RequestStatus }) {
  const s = REQ_STYLE[status];
  const Icon = s.icon;
  return <Badge tone={s.tone}><Icon aria-hidden />{REQUEST_LABEL[status]}</Badge>;
}

export const fmtDay = (iso: string | null) => (iso ? new Date(iso.length === 10 ? iso + "T00:00:00Z" : iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: iso.length === 10 ? "UTC" : "Asia/Kolkata" }) : "—");
