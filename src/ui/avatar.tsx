import * as React from "react";
import { Avatar as A } from "radix-ui";
import { cn } from "@/lib/cn";

const SIZES = { xs: "size-6 text-[10px]", sm: "size-8 text-xs", md: "size-10 text-sm", lg: "size-14 text-lg", xl: "size-20 text-2xl" };
// initials background: deterministic from name, from the soft status/accent roles so text contrast holds
const TONES = ["bg-accent-soft text-accent-text", "bg-success-soft text-success-text", "bg-warning-soft text-warning-text", "bg-danger-soft text-danger-text", "bg-neutral-soft text-neutral-text"];

export function initials(name: string) {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
}

export function Avatar({ name, src, size = "md", status, className }: { name: string; src?: string | null; size?: keyof typeof SIZES; status?: "online" | "leave" | "remote"; className?: string }) {
  const tone = TONES[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % TONES.length];
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <A.Root className={cn("inline-flex items-center justify-center overflow-hidden rounded-pill font-semibold", SIZES[size], tone)}>
        {src && <A.Image src={src} alt="" className="size-full object-cover" />}
        <A.Fallback delayMs={src ? 300 : 0} aria-hidden>{initials(name)}</A.Fallback>
      </A.Root>
      {status && (
        <span aria-label={status === "leave" ? "On leave" : status === "remote" ? "Working remotely" : "In office"}
          className={cn("absolute -bottom-0.5 -right-0.5 size-3 rounded-pill ring-2 ring-surface",
            status === "online" ? "bg-success" : status === "leave" ? "bg-warning" : "bg-accent")} />
      )}
    </span>
  );
}

export function AvatarGroup({ names, max = 4, size = "sm" }: { names: string[]; max?: number; size?: keyof typeof SIZES }) {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  return (
    <div className="flex -space-x-2" aria-label={`${names.length} people: ${names.join(", ")}`}>
      {shown.map((n) => <Avatar key={n} name={n} size={size} className="ring-2 ring-surface rounded-pill" />)}
      {rest > 0 && <span className={cn("inline-flex items-center justify-center rounded-pill bg-surface-hover font-medium text-text-muted ring-2 ring-surface", SIZES[size])}>+{rest}</span>}
    </div>
  );
}
