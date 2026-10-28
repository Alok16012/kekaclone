"use client";
import * as React from "react";
import { Popover as P } from "radix-ui";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { controlBase, useField } from "./field";
import { Avatar } from "./avatar";

export type Person = { id: string; name: string; title?: string | null; department?: string | null };

/** Combobox for people: type to filter by name, title or department; arrow keys + Enter; multi-select shows removable chips. */
export function EmployeePicker({ people, value, onChange, multiple, placeholder = "Search people" }: {
  people: Person[]; value: string[]; onChange: (ids: string[]) => void; multiple?: boolean; placeholder?: string;
}) {
  const f = useField();
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [active, setActive] = React.useState(0);
  const listId = React.useId();
  const results = people.filter((p) => `${p.name} ${p.title ?? ""} ${p.department ?? ""}`.toLowerCase().includes(q.toLowerCase())).slice(0, 50);
  const chosen = people.filter((p) => value.includes(p.id));
  const toggle = (id: string) => {
    if (multiple) onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
    else { onChange([id]); setOpen(false); }
  };
  return (
    <P.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ(""); }}>
      <P.Trigger asChild>
        <button type="button" id={f?.id} aria-describedby={f?.describedBy} data-invalid={f?.invalid || undefined} aria-haspopup="listbox"
          className={cn(controlBase, "data-invalid:border-danger flex min-h-9 flex-wrap items-center gap-1.5 px-2 py-1 text-left")}>
          {chosen.length === 0 && <span className="px-1 text-text-placeholder">{placeholder}</span>}
          {chosen.map((p) => multiple ? (
            <span key={p.id} className="inline-flex items-center gap-1 rounded-pill bg-surface-hover py-0.5 pl-0.5 pr-1.5 text-sm">
              <Avatar name={p.name} size="xs" />{p.name}
              <span role="button" tabIndex={-1} aria-label={`Remove ${p.name}`} onClick={(e) => { e.stopPropagation(); toggle(p.id); }} className="rounded-pill text-text-muted hover:text-text"><X className="size-3" /></span>
            </span>
          ) : (
            <span key={p.id} className="inline-flex items-center gap-2 px-1"><Avatar name={p.name} size="xs" />{p.name}</span>
          ))}
          <ChevronDown className="ml-auto size-4 text-text-muted" />
        </button>
      </P.Trigger>
      <P.Portal>
        <P.Content align="start" sideOffset={4} className="z-40 w-(--radix-popover-trigger-width) min-w-64 rounded-md border border-border bg-surface shadow-pop animate-pop-in">
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-4 text-text-muted" aria-hidden />
            <input autoFocus role="combobox" aria-expanded aria-controls={listId} aria-activedescendant={results[active] ? `${listId}-${results[active].id}` : undefined}
              aria-label="Search people" value={q} placeholder="Type a name, title or team"
              onChange={(e) => { setQ(e.target.value); setActive(0); }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
                if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
                if (e.key === "Enter" && results[active]) { e.preventDefault(); toggle(results[active].id); }
              }}
              className="h-10 w-full bg-transparent text-base outline-none placeholder:text-text-placeholder" />
          </div>
          <ul id={listId} role="listbox" aria-multiselectable={multiple} className="max-h-64 overflow-y-auto p-1">
            {results.length === 0 && <li className="px-3 py-6 text-center text-base text-text-muted">No one matches “{q}”</li>}
            {results.map((p, i) => (
              <li key={p.id} id={`${listId}-${p.id}`} role="option" aria-selected={value.includes(p.id)}
                onMouseEnter={() => setActive(i)} onClick={() => toggle(p.id)}
                className={cn("flex cursor-default items-center gap-2.5 rounded-sm px-2 py-1.5", i === active && "bg-surface-hover")}>
                <Avatar name={p.name} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base">{p.name}</span>
                  {(p.title || p.department) && <span className="block truncate text-sm text-text-muted">{[p.title, p.department].filter(Boolean).join(" · ")}</span>}
                </span>
                {value.includes(p.id) && <Check className="size-4 text-accent-text" aria-hidden />}
              </li>
            ))}
          </ul>
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}
