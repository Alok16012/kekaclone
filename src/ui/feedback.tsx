import * as React from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/cn";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("relative overflow-hidden rounded-sm bg-surface-hover", className)}>
      <div className="absolute inset-0 -translate-x-full bg-linear-to-r from-transparent via-surface/60 to-transparent [animation:erp-shimmer_1.4s_infinite]" />
    </div>
  );
}

/** Every list has one: what is empty, why, and the next step. */
export function EmptyState({ icon, title, description, action, compact }: { icon?: React.ReactNode; title: string; description?: React.ReactNode; action?: React.ReactNode; compact?: boolean }) {
  return (
    <div className={cn("flex flex-col items-center justify-center text-center", compact ? "gap-2 py-8" : "gap-3 py-14")}>
      {icon && <div aria-hidden className="flex size-12 items-center justify-center rounded-pill bg-accent-soft text-accent-text [&_svg]:size-6">{icon}</div>}
      <div>
        <p className="text-md font-semibold text-text">{title}</p>
        {description && <p className="mx-auto mt-1 max-w-sm text-base text-text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

const BANNER = {
  info: { cls: "bg-accent-soft text-accent-text", Icon: Info },
  success: { cls: "bg-success-soft text-success-text", Icon: CheckCircle2 },
  warning: { cls: "bg-warning-soft text-warning-text", Icon: AlertTriangle },
  danger: { cls: "bg-danger-soft text-danger-text", Icon: XCircle },
};

export function Banner({ tone = "info", title, children, action, className }: { tone?: keyof typeof BANNER; title?: React.ReactNode; children?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  const { cls, Icon } = BANNER[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn("flex items-start gap-3 rounded-md px-4 py-3", cls, className)}>
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 text-base">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cn(title && "mt-0.5")}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function Progress({ value, max = 100, label, tone = "accent" }: { value: number; max?: number; label: string; tone?: "accent" | "success" | "warning" | "danger" }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div role="progressbar" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} className="h-1.5 w-full overflow-hidden rounded-pill bg-surface-hover">
      <div className={cn("h-full rounded-pill transition-[width] duration-slow", { accent: "bg-accent", success: "bg-success", warning: "bg-warning", danger: "bg-danger" }[tone])} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Leave balance ring: remaining of total, number in the middle. */
export function BalanceRing({ available, total, label, color = "var(--chart-1)", size = 88 }: { available: number; total: number; label: string; color?: string; size?: number }) {
  const r = (size - 10) / 2, c = 2 * Math.PI * r;
  const pct = total > 0 ? Math.max(0, Math.min(1, available / total)) : 0;
  return (
    <figure className="flex flex-col items-center gap-2">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-hover)" strokeWidth={8} />
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={8} strokeLinecap="round"
            strokeDasharray={c} strokeDashoffset={c * (1 - pct)} className="transition-[stroke-dashoffset] duration-slow" />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xl font-semibold tabular leading-none">{available}</span>
          <span className="mt-0.5 text-xs text-text-muted">of {total}</span>
        </div>
      </div>
      <figcaption className="text-sm font-medium text-text">{label}<span className="sr-only">: {available} of {total} days available</span></figcaption>
    </figure>
  );
}
