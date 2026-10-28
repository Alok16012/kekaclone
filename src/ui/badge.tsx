import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { CheckCircle2, Clock3, XCircle, MinusCircle, AlertTriangle, Info } from "lucide-react";
import { cn } from "@/lib/cn";

export const badgeStyles = cva("inline-flex items-center gap-1 whitespace-nowrap rounded-pill font-medium [&_svg]:size-3.5", {
  variants: {
    tone: {
      neutral: "bg-neutral-soft text-neutral-text",
      accent: "bg-accent-soft text-accent-text",
      success: "bg-success-soft text-success-text",
      warning: "bg-warning-soft text-warning-text",
      danger: "bg-danger-soft text-danger-text",
    },
    size: { sm: "h-5 px-2 text-xs", md: "h-6 px-2.5 text-sm" },
  },
  defaultVariants: { tone: "neutral", size: "sm" },
});

export function Badge({ className, tone, size, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeStyles>) {
  return <span className={cn(badgeStyles({ tone, size }), className)} {...props} />;
}

const STATUS = {
  pending: { tone: "warning", icon: Clock3, label: "Pending" },
  approved: { tone: "success", icon: CheckCircle2, label: "Approved" },
  rejected: { tone: "danger", icon: XCircle, label: "Rejected" },
  cancelled: { tone: "neutral", icon: MinusCircle, label: "Cancelled" },
  draft: { tone: "neutral", icon: MinusCircle, label: "Draft" },
  live: { tone: "accent", icon: Info, label: "Live" },
  overdue: { tone: "danger", icon: AlertTriangle, label: "Overdue" },
  completed: { tone: "success", icon: CheckCircle2, label: "Completed" },
} as const;
export type Status = keyof typeof STATUS;

/** Status is never colour alone: always icon + text. */
export function StatusChip({ status, label, size }: { status: Status; label?: string; size?: "sm" | "md" }) {
  const s = STATUS[status];
  const Icon = s.icon;
  return (
    <Badge tone={s.tone} size={size}><Icon aria-hidden />{label ?? s.label}</Badge>
  );
}
