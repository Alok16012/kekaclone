"use client";
import * as React from "react";
import { Tabs as T } from "radix-ui";
import { cn } from "@/lib/cn";

export const Tabs = T.Root;
export const TabsContent = ({ className, ...p }: React.ComponentProps<typeof T.Content>) => (
  <T.Content className={cn("pt-4 focus-visible:outline-none", className)} {...p} />
);

/** Underline tabs (pages, profile) or pill tabs (in-card filters). Arrow keys move between tabs. */
export function TabsList({ items, variant = "underline", className }: { items: { value: string; label: React.ReactNode; count?: number }[]; variant?: "underline" | "pill"; className?: string }) {
  return (
    <T.List className={cn(variant === "underline" ? "flex gap-1 overflow-x-auto border-b border-border" : "inline-flex gap-1 rounded-md bg-surface-hover p-0.5", className)}>
      {items.map((i) => (
        <T.Trigger key={i.value} value={i.value}
          className={cn("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-base font-medium text-text-muted transition-colors duration-fast hover:text-text",
            variant === "underline"
              ? "-mb-px h-10 border-b-2 border-transparent px-3 data-[state=active]:border-accent data-[state=active]:text-text"
              : "h-7 rounded-sm px-3 text-sm data-[state=active]:bg-surface data-[state=active]:text-text data-[state=active]:shadow-card")}>
          {i.label}
          {i.count != null && <span className="rounded-pill bg-neutral-soft px-1.5 text-xs tabular text-neutral-text">{i.count}</span>}
        </T.Trigger>
      ))}
    </T.List>
  );
}
