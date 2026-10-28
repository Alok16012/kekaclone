import * as React from "react";
import { TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/cn";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-border bg-surface shadow-card", className)} {...props} />;
}

export function CardHeader({ title, description, action, className }: { title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start justify-between gap-4 px-5 pt-4 pb-3", className)}>
      <div className="min-w-0">
        <h3 className="text-md font-semibold text-text">{title}</h3>
        {description && <p className="mt-0.5 text-sm text-text-muted">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 pb-5", className)} {...props} />;
}

/** One number with a label: no chart needed. */
export function StatTile({ label, value, delta, hint, icon }: { label: string; value: React.ReactNode; delta?: { value: string; good: boolean; up: boolean }; hint?: string; icon?: React.ReactNode }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between text-sm text-text-muted">
        <span>{label}</span>
        {icon && <span className="text-text-muted [&_svg]:size-4" aria-hidden>{icon}</span>}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular text-text">{value}</div>
      {(delta || hint) && (
        <div className="mt-1 flex items-center gap-1.5 text-sm">
          {delta && (
            <span className={cn("inline-flex items-center gap-0.5 font-medium", delta.good ? "text-success-text" : "text-danger-text")}>
              {delta.up ? <TrendingUp className="size-3.5" aria-hidden /> : <TrendingDown className="size-3.5" aria-hidden />}
              {delta.value}
            </span>
          )}
          {hint && <span className="text-text-muted">{hint}</span>}
        </div>
      )}
    </Card>
  );
}
