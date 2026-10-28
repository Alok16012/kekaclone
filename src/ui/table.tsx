"use client";
import * as React from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { Checkbox } from "./choice";
import { Skeleton } from "./feedback";

export type Column<T> = {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  sortValue?: (row: T) => string | number;
  align?: "left" | "right";
  width?: string;
  hideBelow?: "md" | "lg";
};

/**
 * Admin table: sticky header, sortable columns (aria-sort), row selection with a bulk bar,
 * loading skeleton rows, empty state, keyboard reachable row actions. Rows are clickable when onRowClick is set.
 */
export function DataTable<T>({
  rows, columns, rowKey, loading, empty, selectable, bulkActions, onRowClick, caption,
}: {
  rows: T[]; columns: Column<T>[]; rowKey: (r: T) => string; loading?: boolean; empty?: React.ReactNode;
  selectable?: boolean; bulkActions?: (selected: string[], clear: () => void) => React.ReactNode; onRowClick?: (r: T) => void; caption: string;
}) {
  const [sort, setSort] = React.useState<{ key: string; dir: "asc" | "desc" } | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const sorted = React.useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const v = col.sortValue;
    return [...rows].sort((a, b) => (v(a) < v(b) ? -1 : v(a) > v(b) ? 1 : 0) * (sort.dir === "asc" ? 1 : -1));
  }, [rows, sort, columns]);
  const allIds = sorted.map(rowKey);
  const allChecked = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someChecked = !allChecked && allIds.some((id) => selected.has(id));
  const hide = (c: Column<T>) => c.hideBelow === "md" ? "hidden md:table-cell" : c.hideBelow === "lg" ? "hidden lg:table-cell" : "";

  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-surface">
      {selectable && selected.size > 0 && bulkActions && (
        <div className="flex items-center gap-3 border-b border-border bg-accent-soft px-4 py-2 text-base text-accent-text animate-fade-in">
          <span className="font-medium tabular">{selected.size} selected</span>
          <div className="ml-auto flex gap-2">{bulkActions([...selected], () => setSelected(new Set()))}</div>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-base">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 z-10 bg-surface-sunken">
            <tr className="border-b border-border">
              {selectable && (
                <th scope="col" className="w-10 px-4">
                  <Checkbox aria-label="Select all rows" checked={allChecked ? true : someChecked ? "indeterminate" : false}
                    onCheckedChange={(c) => setSelected(c ? new Set(allIds) : new Set())} />
                </th>
              )}
              {columns.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th key={c.key} scope="col" style={{ width: c.width }}
                    aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : c.sortValue ? "none" : undefined}
                    className={cn("h-10 px-4 text-left text-sm font-medium text-text-muted", c.align === "right" && "text-right", hide(c))}>
                    {c.sortValue ? (
                      <button type="button" className={cn("inline-flex items-center gap-1 hover:text-text", c.align === "right" && "flex-row-reverse")}
                        onClick={() => setSort(active && sort!.dir === "asc" ? { key: c.key, dir: "desc" } : active ? null : { key: c.key, dir: "asc" })}>
                        {c.header}
                        {active ? (sort!.dir === "asc" ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />) : <ChevronsUpDown className="size-3.5 opacity-50" />}
                      </button>
                    ) : c.header}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b border-border last:border-0">
                    {selectable && <td className="px-4"><Skeleton className="size-4" /></td>}
                    {columns.map((c) => <td key={c.key} className={cn("h-12 px-4", hide(c))}><Skeleton className="h-4 w-3/4" /></td>)}
                  </tr>
                ))
              : sorted.map((r) => {
                  const id = rowKey(r);
                  return (
                    <tr key={id} onClick={onRowClick ? () => onRowClick(r) : undefined}
                      className={cn("border-b border-border transition-colors duration-fast last:border-0 hover:bg-surface-sunken",
                        onRowClick && "cursor-pointer", selected.has(id) && "bg-accent-soft/40")}>
                      {selectable && (
                        <td className="px-4" onClick={(e) => e.stopPropagation()}>
                          <Checkbox aria-label={`Select row ${id}`} checked={selected.has(id)}
                            onCheckedChange={(c) => setSelected((s) => { const n = new Set(s); if (c) n.add(id); else n.delete(id); return n; })} />
                        </td>
                      )}
                      {columns.map((c) => (
                        <td key={c.key} className={cn("h-12 px-4 text-text", c.align === "right" && "text-right tabular", hide(c))}>{c.cell(r)}</td>
                      ))}
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>
      {!loading && rows.length === 0 && empty}
    </div>
  );
}
