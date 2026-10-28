"use client";
import * as React from "react";
import { addDays, addMonths, endOfMonth, endOfWeek, format, isAfter, isBefore, isSameDay, isSameMonth, startOfMonth, startOfWeek } from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { useToday } from "@/lib/use-today";
import { IconButton } from "./button";

export type DayMark = "holiday" | "weekly_off" | "leave" | "half";
export type Range = { from: Date | null; to: Date | null };

/**
 * Month grid (Monday first). role=grid; arrow keys move focus by day/week, PageUp/PageDown by month, Enter selects.
 * marks decorate days (holiday, weekly off, existing leave) and are announced in each day's label.
 * The current time is read only after mount (never during render), so the component prerenders cleanly.
 */
export function Calendar({ range, onRangeChange, marks = {}, disabled, month: m0 }: {
  range: Range; onRangeChange: (r: Range) => void; marks?: Record<string, DayMark>; disabled?: (d: Date) => boolean; month?: Date;
}) {
  const today = useToday();
  const gridRef = React.useRef<HTMLDivElement>(null);
  const [monthState, setMonth] = React.useState<Date | null>(null);
  const [focusState, setFocus] = React.useState<Date | null>(null);
  const anchor = m0 ?? range.from ?? today;
  const month = monthState ?? (anchor && startOfMonth(anchor));
  const focus = focusState ?? range.from ?? anchor;
  if (!month || !focus) return <div className="h-80 w-full max-w-80" aria-busy />;
  const isToday = (d: Date) => !!today && isSameDay(d, today);
  const days: Date[] = [];
  for (let d = startOfWeek(startOfMonth(month), { weekStartsOn: 1 }); d <= endOfWeek(endOfMonth(month), { weekStartsOn: 1 }); d = addDays(d, 1)) days.push(d);

  const pick = (d: Date) => {
    if (disabled?.(d)) return;
    setMonth((m) => m ?? month);   // pin the visible month so picking a spill-over day doesn't jump the grid
    if (!range.from || range.to || isBefore(d, range.from)) onRangeChange({ from: d, to: null });
    else onRangeChange({ from: range.from, to: d });
  };
  const move = (d: Date) => {
    setFocus(d);
    if (!isSameMonth(d, month)) setMonth(startOfMonth(d));
    requestAnimationFrame(() => gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${format(d, "yyyy-MM-dd")}"]`)?.focus());
  };
  const onKey = (e: React.KeyboardEvent) => {
    const k: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (k[e.key]) { e.preventDefault(); move(addDays(focus, k[e.key])); }
    if (e.key === "PageUp" || e.key === "PageDown") { e.preventDefault(); move(addMonths(focus, e.key === "PageUp" ? -1 : 1)); }
  };
  const inRange = (d: Date) => range.from && range.to && isAfter(d, range.from) && isBefore(d, range.to);
  const markLabel: Record<DayMark, string> = { holiday: "holiday", weekly_off: "weekly off", leave: "on leave", half: "half day leave" };

  return (
    <div className="w-full max-w-80 select-none">
      <div className="mb-2 flex items-center justify-between">
        <IconButton label="Previous month" size="icon-sm" onClick={() => setMonth(addMonths(month, -1))}><ChevronLeft /></IconButton>
        <p className="text-base font-semibold" aria-live="polite">{format(month, "MMMM yyyy")}</p>
        <IconButton label="Next month" size="icon-sm" onClick={() => setMonth(addMonths(month, 1))}><ChevronRight /></IconButton>
      </div>
      <div ref={gridRef} role="grid" aria-label={format(month, "MMMM yyyy")} onKeyDown={onKey} className="grid grid-cols-7 gap-y-1 text-center">
        {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => <div key={d} role="columnheader" className="pb-1 text-xs font-medium text-text-muted">{d}</div>)}
        {days.map((d) => {
          const key = format(d, "yyyy-MM-dd");
          const mark = marks[key];
          const start = range.from && isSameDay(d, range.from), end = range.to && isSameDay(d, range.to);
          const off = !isSameMonth(d, month), dis = disabled?.(d);
          return (
            <div key={key} role="gridcell" className={cn("relative py-0.5", inRange(d) && "bg-accent-soft", start && range.to && "rounded-l-pill bg-accent-soft", end && "rounded-r-pill bg-accent-soft")}>
              <button type="button" data-day={key} tabIndex={isSameDay(d, focus) ? 0 : -1} disabled={dis}
                aria-pressed={!!(start || end)} aria-label={`${format(d, "EEEE d MMMM")}${mark ? `, ${markLabel[mark]}` : ""}${isToday(d) ? ", today" : ""}`}
                onClick={() => { setFocus(d); pick(d); }}
                className={cn("relative mx-auto flex size-9 items-center justify-center rounded-pill text-base tabular transition-colors duration-fast hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40",
                  off && "text-text-muted/60", (mark === "weekly_off" || mark === "holiday") && "text-text-muted",
                  isToday(d) && "font-semibold underline decoration-2 underline-offset-4",
                  (start || end) && "bg-accent text-on-accent hover:bg-accent-hover")}>
                {format(d, "d")}
                {mark && !(start || end) && (
                  <span aria-hidden className={cn("absolute bottom-1 size-1 rounded-pill",
                    mark === "holiday" ? "bg-chart-2" : mark === "weekly_off" ? "bg-border-strong" : "bg-chart-1")} />
                )}
              </button>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-3 text-xs text-text-muted" aria-hidden>
        <span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-pill bg-chart-2" />Holiday</span>
        <span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-pill bg-border-strong" />Weekly off</span>
        <span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-pill bg-chart-1" />Your leave</span>
      </div>
    </div>
  );
}
